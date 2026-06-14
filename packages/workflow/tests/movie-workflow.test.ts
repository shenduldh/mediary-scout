import { describe, expect, it } from "vitest";
import {
  convergeMovieDirectory,
  FakeAgentNodes,
  FakeResourceProvider,
  FakeStorageExecutor,
  runMovieAcquisition,
  type MediaTitle,
  type VerifiedFile,
} from "../src/index.js";

describe("convergeMovieDirectory", () => {
  function vf(id: string, name: string, sizeBytes: number): VerifiedFile {
    return { id, storageDirectoryId: "movie_dir", name, sizeBytes, episodeCode: null, providerFileId: id };
  }

  it("keeps the agent's best-quality master and deletes the rest (the 别留多份 safety net)", async () => {
    const storage = new FakeStorageExecutor({
      directories: {
        movie_dir: [vf("hd", "Movie.2023.1080p.mkv", 6_000_000_000), vf("uhd", "Movie.2023.2160p.mkv", 16_000_000_000)],
      },
    });
    const agents = new FakeAgentNodes({ movieMasterKeepFileId: "uhd" });

    const result = await convergeMovieDirectory({
      storage,
      agents,
      movieDirectoryId: "movie_dir",
      title: "Movie",
      year: 2023,
    });

    expect(result.kept).toBe("uhd");
    expect(result.deleted).toEqual(["hd"]);
    const remaining = await storage.listVideoFiles("movie_dir");
    expect(remaining.map((file) => file.name)).toEqual(["Movie.2023.2160p.mkv"]);
  });

  it("is a no-op (no agent call) when the directory already holds a single master", async () => {
    const storage = new FakeStorageExecutor({ directories: { movie_dir: [vf("only", "Movie.2023.2160p.mkv", 16_000_000_000)] } });
    const agents = new FakeAgentNodes();
    agents.selectMovieMasterFile = async () => {
      throw new Error("selectMovieMasterFile must not be called for a single file");
    };

    const result = await convergeMovieDirectory({ storage, agents, movieDirectoryId: "movie_dir", title: "Movie", year: 2023 });

    expect(result).toEqual({ kept: "only", deleted: [] });
  });

  it("deletes nothing (fail-safe) when the agent cannot pick a valid master", async () => {
    const storage = new FakeStorageExecutor({
      directories: {
        movie_dir: [vf("a", "Movie.2023.2160p.mkv", 16_000_000_000), vf("b", "Movie.2023.1080p.mkv", 6_000_000_000)],
      },
    });
    const agents = new FakeAgentNodes();
    agents.selectMovieMasterFile = async () => ({ node: "fake", keepFileId: "ghost", reason: "hallucinated" });

    const result = await convergeMovieDirectory({ storage, agents, movieDirectoryId: "movie_dir", title: "Movie", year: 2023 });

    expect(result.deleted).toEqual([]);
    const remaining = await storage.listVideoFiles("movie_dir");
    expect(remaining.length).toBe(2); // nothing deleted on agent uncertainty
  });
});

const fixedNow = () => "2026-06-13T00:00:00.000Z";

function movieTitle(): MediaTitle {
  return {
    id: "tmdb_movie_872585",
    tmdbId: 872585,
    type: "movie",
    title: "奥本海默",
    originalTitle: "Oppenheimer",
    year: 2023,
    aliases: ["Oppenheimer"],
  };
}

function videoFile(id: string, name: string): VerifiedFile {
  return {
    id,
    storageDirectoryId: "assigned_by_fake",
    name,
    sizeBytes: 8_000_000_000,
    episodeCode: "S01E01",
    providerFileId: id,
  };
}

describe("runMovieAcquisition", () => {
  it("acquires a single film into Movies/Title (Year) and reports acquired", async () => {
    const title = movieTitle();
    const storage = new FakeStorageExecutor({
      transferOutcomes: {
        snapshot_1_candidate_1: {
          status: "succeeded",
          providerMessage: "",
          files: [videoFile("oppen_v", "Oppenheimer.2023.2160p.mkv")],
        },
      },
    });

    const result = await runMovieAcquisition({
      title,
      keyword: "奥本海默 4K",
      resourceProvider: new FakeResourceProvider({
        keywordResults: {
          "奥本海默 4K": [{ title: "奥本海默 2023 4K UHD", episodeHints: [], qualityHints: ["4K"] }],
        },
      }),
      storage,
      agents: new FakeAgentNodes(),
      workflowRunId: "run_movie",
      stagingParentDirectoryId: "movies_root",
      moviesParentDirectoryId: "movies_root",
      now: fixedNow,
    });

    expect(result.status).toBe("succeeded");
    expect(result.season.id).toBe("tmdb_movie_872585_movie");
    expect(result.episodes[0]?.obtained).toBe(true);
    expect(result.notification.kind).toBe("package_initialized");
    expect(result.notification.report?.status).toBe("acquired");
    // Landed under a Movies/Title (Year) directory, keeping its original name
    // (identity is the wrapper directory, not the filename).
    const landed = await storage.listVideoFiles(result.season.storageDirectoryId);
    expect(landed.map((f) => f.name)).toContain("Oppenheimer.2023.2160p.mkv");
  });

  it("lets the agent pick the main feature among flattened videos and deletes the extras", async () => {
    const title = movieTitle();
    // The 花絮 reel is LARGER than the feature — a mechanical "keep largest"
    // would pick it. The agent (configured) keeps the real feature instead.
    const feature: VerifiedFile = {
      id: "feature_v",
      storageDirectoryId: "assigned_by_fake",
      name: "Oppenheimer.2023.2160p.mkv",
      sizeBytes: 28_000_000_000,
      episodeCode: "S01E01",
      providerFileId: "feature_v",
    };
    const extra: VerifiedFile = {
      id: "extra_v",
      storageDirectoryId: "assigned_by_fake",
      name: "Oppenheimer.2023.Behind.The.Scenes.花絮.mkv",
      sizeBytes: 40_000_000_000,
      episodeCode: "S01E01",
      providerFileId: "extra_v",
    };
    const storage = new FakeStorageExecutor({
      transferOutcomes: {
        snapshot_1_candidate_1: { status: "succeeded", providerMessage: "", files: [feature, extra] },
      },
    });

    const result = await runMovieAcquisition({
      title,
      keyword: "奥本海默 4K",
      resourceProvider: new FakeResourceProvider({
        keywordResults: {
          "奥本海默 4K": [{ title: "奥本海默 2023 4K 蓝光原盘", episodeHints: [], qualityHints: ["4K"] }],
        },
      }),
      storage,
      agents: new FakeAgentNodes({ movieMasterKeepFileId: "feature_v" }),
      workflowRunId: "run_master",
      stagingParentDirectoryId: "movies_root",
      moviesParentDirectoryId: "movies_root",
      now: fixedNow,
    });

    expect(result.status).toBe("succeeded");
    const landed = await storage.listVideoFiles(result.season.storageDirectoryId);
    // Only the agent-chosen feature landed; the larger 花絮 reel was dropped.
    expect(landed.map((f) => f.name)).toEqual(["Oppenheimer.2023.2160p.mkv"]);
  });

  it("fails honestly instead of guessing by size when the agent never returns a valid master id", async () => {
    const title = movieTitle();
    const big = videoFile("big_v", "Oppenheimer.2023.2160p.mkv");
    const small = { ...videoFile("small_v", "Oppenheimer.2023.1080p.mkv"), sizeBytes: 5_000_000_000 };
    const storage = new FakeStorageExecutor({
      transferOutcomes: {
        snapshot_1_candidate_1: { status: "succeeded", providerMessage: "", files: [big, small] },
      },
    });
    const agents = new FakeAgentNodes();
    // The agent keeps hallucinating an id not among the staged videos — even on
    // the re-ask. The workflow must NOT silently keep the largest (mechanical).
    agents.selectMovieMasterFile = async () => ({
      node: "fake_movie_master_selection",
      keepFileId: "does-not-exist",
      reason: "hallucinated",
    });

    const result = await runMovieAcquisition({
      title,
      keyword: "奥本海默 4K",
      resourceProvider: new FakeResourceProvider({
        keywordResults: { "奥本海默 4K": [{ title: "奥本海默 2023 4K", episodeHints: [], qualityHints: ["4K"] }] },
      }),
      storage,
      agents,
      workflowRunId: "run_degrade",
      stagingParentDirectoryId: "movies_root",
      moviesParentDirectoryId: "movies_root",
      now: fixedNow,
    });

    // No mechanical fallback: it reports no_coverage rather than landing a
    // size-guessed master.
    expect(result.status).toBe("no_coverage");
    expect(result.episodes[0]?.obtained).toBe(false);
  });

  it("re-asks the agent (never a size fallback) and keeps its valid second pick", async () => {
    const title = movieTitle();
    // The 花絮 reel is LARGER than the feature — a size fallback would keep it.
    const feature = { ...videoFile("feature_v", "Oppenheimer.2023.2160p.mkv"), sizeBytes: 20_000_000_000 };
    const extra = {
      ...videoFile("extra_v", "Oppenheimer.Behind.The.Scenes.花絮.mkv"),
      sizeBytes: 40_000_000_000,
    };
    const storage = new FakeStorageExecutor({
      transferOutcomes: {
        snapshot_1_candidate_1: { status: "succeeded", providerMessage: "", files: [feature, extra] },
      },
    });
    const agents = new FakeAgentNodes();
    let calls = 0;
    let sawRejectedId: string | undefined;
    // First call hallucinates; the re-ask (with rejectedFileId set) returns the
    // real feature — NOT the larger 花絮.
    agents.selectMovieMasterFile = async (input) => {
      calls += 1;
      if (calls === 1) {
        return { node: "fake_movie_master_selection", keepFileId: "nope", reason: "typo" };
      }
      sawRejectedId = input.rejectedFileId;
      return { node: "fake_movie_master_selection", keepFileId: "feature_v", reason: "the feature" };
    };

    const result = await runMovieAcquisition({
      title,
      keyword: "奥本海默 4K",
      resourceProvider: new FakeResourceProvider({
        keywordResults: { "奥本海默 4K": [{ title: "奥本海默 2023 4K 蓝光原盘", episodeHints: [], qualityHints: ["4K"] }] },
      }),
      storage,
      agents,
      workflowRunId: "run_reask",
      stagingParentDirectoryId: "movies_root",
      moviesParentDirectoryId: "movies_root",
      now: fixedNow,
    });

    expect(result.status).toBe("succeeded");
    expect(calls).toBe(2); // re-asked exactly once
    expect(sawRejectedId).toBe("nope"); // the rejected id was fed back
    const landed = await storage.listVideoFiles(result.season.storageDirectoryId);
    // Kept the agent's valid pick (the feature), not the larger extra.
    expect(landed.map((file) => file.name)).toEqual(["Oppenheimer.2023.2160p.mkv"]);
  });

  it("retries the next-best candidate after a transfer fails to materialize", async () => {
    const title = movieTitle();
    // Only the second candidate (pass 2's snapshot) has a healthy outcome; the
    // first selection materializes nothing (unconfigured → failed transfer).
    const storage = new FakeStorageExecutor({
      transferOutcomes: {
        snapshot_2_candidate_2: {
          status: "succeeded",
          providerMessage: "",
          files: [videoFile("good_v", "Oppenheimer.2023.2160p.mkv")],
        },
      },
    });

    const result = await runMovieAcquisition({
      title,
      keyword: "奥本海默 4K",
      resourceProvider: new FakeResourceProvider({
        keywordResults: {
          "奥本海默 4K": [
            { title: "奥本海默 旧分享(已过期)", episodeHints: [] },
            { title: "奥本海默 4K 好货", episodeHints: [] },
          ],
        },
      }),
      storage,
      agents: new FakeAgentNodes(),
      workflowRunId: "run_movie_retry",
      stagingParentDirectoryId: "movies_root",
      moviesParentDirectoryId: "movies_root",
      now: fixedNow,
    });

    expect(result.status).toBe("succeeded");
    expect(result.episodes[0]?.obtained).toBe(true);
    // It did not give up after the first failed transfer.
    expect(result.transferAttempts.length).toBeGreaterThanOrEqual(2);
    const landed = await storage.listVideoFiles(result.season.storageDirectoryId);
    expect(landed.map((f) => f.name)).toContain("Oppenheimer.2023.2160p.mkv");
  });

  it("returns no_coverage honestly when nothing matches", async () => {
    const result = await runMovieAcquisition({
      title: movieTitle(),
      keyword: "奥本海默 4K",
      resourceProvider: new FakeResourceProvider({ keywordResults: {} }),
      storage: new FakeStorageExecutor(),
      agents: new FakeAgentNodes(),
      workflowRunId: "run_movie_empty",
      stagingParentDirectoryId: "movies_root",
      moviesParentDirectoryId: "movies_root",
      now: fixedNow,
    });
    expect(result.status).toBe("no_coverage");
    expect(result.notification.kind).toBe("no_coverage");
    expect(result.episodes[0]?.obtained).toBe(false);
  });
});
