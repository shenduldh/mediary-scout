import { describe, expect, it } from "vitest";
import {
  episodeCode,
  FakeAgentNodes,
  FakeResourceProvider,
  FakeStorageExecutor,
  InMemoryWorkflowRepository,
  requestTrackingFromTmdbSelection,
  TmdbMetadataProvider,
  type TrackedSeason,
  type VerifiedFile,
} from "../src/index.js";

describe("requestTrackingFromTmdbSelection", () => {
  it("prepares a TMDB TV target, executes type2 initialization, and returns a UI summary", async () => {
    const repository = new InMemoryWorkflowRepository();
    const metadataProvider = qiaochuMetadataProvider();
    const storage = new FakeStorageExecutor({
      directories: { dir_qiaochu_s1: [] },
      transferOutcomes: {
        snapshot_1_candidate_1: {
          status: "succeeded",
          providerMessage: "",
          files: [verifiedFile("file_S01E01", "S01E01")],
        },
      },
    });

    const result = await requestTrackingFromTmdbSelection({
      tmdbId: 289271,
      mediaType: "tv",
      seasonNumber: 1,
      qualityPreference: "4K",
      storageDirectoryId: "dir_qiaochu_s1",
      storageParentDirectoryId: "library_root",
      metadataProvider,
      resourceProvider: new FakeResourceProvider({
        keywordResults: {
          "翘楚 4K": [
            {
              title: "翘楚 S01E01 4K",
              episodeHints: ["S01E01"],
              qualityHints: ["4K"],
            },
          ],
        },
      }),
      storage,
      agents: new FakeAgentNodes(),
      repository,
      createWorkflowRunId: () => "run_qiaochu_init",
      now: fixedNow,
    });

    expect(result).toMatchObject({
      title: {
        id: "tmdb_tv_289271",
        title: "翘楚",
        year: 2026,
      },
      season: {
        id: "tmdb_tv_289271_s1",
        totalEpisodes: 24,
        latestAiredEpisode: 14,
      },
      keyword: "翘楚 4K",
      request: {
        status: "completed",
        workflowRunId: "run_qiaochu_init",
        workflowStatus: "partial",
        progress: {
          totalEpisodes: 24,
          latestAiredEpisode: 14,
          obtainedEpisodes: ["S01E01"],
          missingAiredEpisodes: [
            "S01E02",
            "S01E03",
            "S01E04",
            "S01E05",
            "S01E06",
            "S01E07",
            "S01E08",
            "S01E09",
            "S01E10",
            "S01E11",
            "S01E12",
            "S01E13",
            "S01E14",
          ],
        },
      },
    });

    const saved = await repository.getWorkflowRunSnapshot("run_qiaochu_init");
    expect(saved).toMatchObject({
      title: {
        id: "tmdb_tv_289271",
      },
      season: {
        id: "tmdb_tv_289271_s1",
      },
      obtainedEpisodes: ["S01E01"],
    });
  });

  it("returns already tracked for the same TMDB selection without searching resources again", async () => {
    const repository = new InMemoryWorkflowRepository();
    await requestTrackingFromTmdbSelection({
      tmdbId: 289271,
      mediaType: "tv",
      seasonNumber: 1,
      qualityPreference: "4K",
      storageDirectoryId: "dir_qiaochu_s1",
      storageParentDirectoryId: "library_root",
      metadataProvider: qiaochuMetadataProvider(),
      resourceProvider: new FakeResourceProvider({
        keywordResults: {
          "翘楚 4K": [{ title: "翘楚 S01E01 4K", episodeHints: ["S01E01"] }],
        },
      }),
      storage: new FakeStorageExecutor({
        transferOutcomes: {
          snapshot_1_candidate_1: {
            status: "succeeded",
            providerMessage: "",
            files: [verifiedFile("file_S01E01", "S01E01")],
          },
        },
      }),
      agents: new FakeAgentNodes(),
      repository,
      createWorkflowRunId: () => "run_first",
      now: fixedNow,
    });

    const result = await requestTrackingFromTmdbSelection({
      tmdbId: 289271,
      mediaType: "tv",
      seasonNumber: 1,
      qualityPreference: "4K",
      storageDirectoryId: "dir_qiaochu_s1",
      storageParentDirectoryId: "library_root",
      metadataProvider: qiaochuMetadataProvider(),
      resourceProvider: new FakeResourceProvider({
        keywordResults: {},
        keywordErrors: { "翘楚 4K": "resource provider should not be searched for already tracked target" },
      }),
      storage: new FakeStorageExecutor(),
      agents: new FakeAgentNodes(),
      repository,
      createWorkflowRunId: () => "run_should_not_start",
      now: fixedNow,
    });

    expect(result.request).toMatchObject({
      status: "already_tracked",
      workflowRunId: null,
      workflowStatus: null,
      progress: {
        obtainedEpisodes: ["S01E01"],
      },
    });
    await expect(repository.getWorkflowRunSnapshot("run_should_not_start")).resolves.toBeNull();
  });
});

function qiaochuMetadataProvider(): TmdbMetadataProvider {
  return new TmdbMetadataProvider({
    readToken: "token",
    fetchJson: async (url) => {
      if (url.includes("/tv/289271?")) {
        return {
          id: 289271,
          name: "翘楚",
          original_name: "翘楚",
          first_air_date: "2026-06-01",
          number_of_episodes: 24,
          last_episode_to_air: {
            season_number: 1,
            episode_number: 14,
          },
          seasons: [
            {
              season_number: 1,
              episode_count: 24,
            },
          ],
        };
      }
      if (url.includes("/tv/289271/season/1?")) {
        return {
          season_number: 1,
          episodes: Array.from({ length: 24 }, (_, index) => ({
            episode_number: index + 1,
            air_date: index < 14 ? `2026-06-${String(index + 1).padStart(2, "0")}` : null,
          })),
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    },
  });
}

function fixedNow(): string {
  return "2026-06-11T00:00:00.000Z";
}

function verifiedFile(id: string, code: string): VerifiedFile {
  const season: Pick<TrackedSeason, "seasonNumber" | "storageDirectoryId"> = {
    seasonNumber: 1,
    storageDirectoryId: "dir_qiaochu_s1",
  };
  return {
    id,
    storageDirectoryId: season.storageDirectoryId,
    name: `QiaoChu.${episodeCode(season.seasonNumber, Number(code.slice(-2)))}.mkv`,
    sizeBytes: 1_000_000_000,
    episodeCode: code,
    providerFileId: `provider_${id}`,
  };
}
