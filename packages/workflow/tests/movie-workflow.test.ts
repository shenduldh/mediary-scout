import { describe, expect, it } from "vitest";
import {
  FakeAgentNodes,
  FakeResourceProvider,
  FakeStorageExecutor,
  runMovieAcquisition,
  type MediaTitle,
  type VerifiedFile,
} from "../src/index.js";

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
    // Landed under a Movies/Title (Year) directory, renamed canonically.
    const landed = await storage.listVideoFiles(result.season.storageDirectoryId);
    expect(landed.map((f) => f.name)).toContain("奥本海默 (2023).mkv");
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
    expect(landed.map((f) => f.name)).toContain("奥本海默 (2023).mkv");
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
