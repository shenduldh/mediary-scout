import { describe, expect, it } from "vitest";
import {
  FakeAgentNodes,
  FakeResourceProvider,
  FakeStorageExecutor,
  runType2Initialization,
  type AcquisitionPlanningInput,
  type AcquisitionPlanningResult,
  type MediaTitle,
  type ResourceCandidate,
  type StorageExecutor,
  type TrackedSeason,
  type TransferAttempt,
} from "../src/index.js";

describe("runType2Initialization", () => {
  it("initializes tracking and marks only verified current episodes obtained", async () => {
    const title: MediaTitle = {
      id: "title_qiaochu",
      tmdbId: 289271,
      type: "tv",
      title: "翘楚",
      originalTitle: "翘楚",
      year: 2026,
      aliases: ["Ashes to Crown"],
    };
    const season: TrackedSeason = {
      id: "season_qiaochu_1",
      mediaTitleId: title.id,
      seasonNumber: 1,
      status: "active",
      qualityPreference: "4K",
      storageDirectoryId: "dir_qiaochu_s1",
      totalEpisodes: 24,
      latestAiredEpisode: 14,
      latestAiredSource: "metadata",
    };

    const resourceProvider = new FakeResourceProvider({
      keywordResults: {
        "翘楚 4K": Array.from({ length: 14 }, (_, index) => ({
          title: `翘楚 S01E${String(index + 1).padStart(2, "0")} 4K`,
          episodeHints: [`S01E${String(index + 1).padStart(2, "0")}`],
          qualityHints: ["4K"],
        })),
      },
    });
    const storage = new FakeStorageExecutor({
      directories: { dir_qiaochu_s1: [] },
      transferOutcomes: Object.fromEntries(
        Array.from({ length: 14 }, (_, index) => {
          const episode = `S01E${String(index + 1).padStart(2, "0")}`;
          const candidateId = `snapshot_1_candidate_${index + 1}`;
          return [
            candidateId,
            {
              status: "succeeded",
              providerMessage: "",
              files: [
                {
                  id: `file_${episode}`,
                  storageDirectoryId: "dir_qiaochu_s1",
                  name: `翘楚.${episode}.mkv`,
                  sizeBytes: 1_000_000_000,
                  episodeCode: episode,
                  providerFileId: `provider_${episode}`,
                },
              ],
            },
          ];
        }),
      ),
    });

    const result = await runType2Initialization({
      title,
      season,
      keyword: "翘楚 4K",
      storageParentDirectoryId: "library_root",
      resourceProvider,
      storage,
      agents: new FakeAgentNodes(),
    });

    expect(result.status).toBe("succeeded");
    expect(result.obtainedEpisodes).toEqual(
      Array.from({ length: 14 }, (_, index) => `S01E${String(index + 1).padStart(2, "0")}`),
    );
    expect(result.episodes.filter((episode) => episode.obtained)).toHaveLength(14);
    expect(result.episodes.find((episode) => episode.episodeCode === "S01E15")).toMatchObject({
      obtained: false,
      airStatus: "unaired",
    });
    // Airing season: obtained up to the latest aired episode; the unaired
    // E15 is NOT a gap, so the report reads "airing" with no missing.
    expect(result.notification.trigger).toBe("user");
    expect(result.notification.report?.status).toBe("airing");
    expect(result.notification.report?.realMissing).toEqual([]);
    expect(result.notification.body).toContain("已获取至最新第 14 集");
    expect(result.notifications).toEqual([result.notification]);
  });

  it("records provider-ahead episodes during initialization when selected resources materialize them", async () => {
    const title: MediaTitle = {
      id: "title_qiaochu",
      tmdbId: 289271,
      type: "tv",
      title: "翘楚",
      originalTitle: "翘楚",
      year: 2026,
      aliases: ["Ashes to Crown"],
    };
    const season: TrackedSeason = {
      id: "season_qiaochu_1",
      mediaTitleId: title.id,
      seasonNumber: 1,
      status: "active",
      qualityPreference: "4K",
      storageDirectoryId: "dir_qiaochu_s1",
      totalEpisodes: 24,
      latestAiredEpisode: 14,
      latestAiredSource: "metadata",
    };
    const resourceProvider = new FakeResourceProvider({
      keywordResults: {
        "翘楚 4K": [
          {
            title: "翘楚 S01E14-S01E15 4K",
            episodeHints: ["S01E14", "S01E15"],
            qualityHints: ["4K"],
          },
        ],
      },
    });
    const storage = new FakeStorageExecutor({
      directories: { dir_qiaochu_s1: [] },
      transferOutcomes: {
        snapshot_1_candidate_1: {
          status: "succeeded",
          providerMessage: "",
          files: [
            {
              id: "file_S01E14",
              storageDirectoryId: "dir_qiaochu_s1",
              name: "翘楚.S01E14.mkv",
              sizeBytes: 1_000_000_000,
              episodeCode: "S01E14",
              providerFileId: "provider_S01E14",
            },
            {
              id: "file_S01E15",
              storageDirectoryId: "dir_qiaochu_s1",
              name: "翘楚.S01E15.mkv",
              sizeBytes: 1_000_000_000,
              episodeCode: "S01E15",
              providerFileId: "provider_S01E15",
            },
          ],
        },
      },
    });

    const result = await runType2Initialization({
      title,
      season,
      keyword: "翘楚 4K",
      storageParentDirectoryId: "library_root",
      resourceProvider,
      storage,
      agents: new FakeAgentNodes(),
    });

    expect(result.obtainedEpisodes).toEqual(["S01E14", "S01E15"]);
    expect(result.providerAheadEpisodes).toEqual(["S01E15"]);
    expect(result.episodes.find((episode) => episode.episodeCode === "S01E15")).toMatchObject({
      airStatus: "unaired",
      obtained: true,
      metadataStatus: "provider_ahead",
      verifiedFileIds: ["file_S01E15"],
    });
  });

  it("recovers from a failed initial keyword through the planning agent's alternates", async () => {
    const title: MediaTitle = {
      id: "title_show",
      tmdbId: 1,
      type: "tv",
      title: "Show",
      originalTitle: "Show",
      year: 2026,
      aliases: ["The Show"],
    };
    const season: TrackedSeason = {
      id: "season_show_1",
      mediaTitleId: title.id,
      seasonNumber: 1,
      status: "active",
      qualityPreference: "4K",
      storageDirectoryId: "dir_show_s1",
      totalEpisodes: 1,
      latestAiredEpisode: 1,
      latestAiredSource: "metadata",
    };
    const resourceProvider = new FakeResourceProvider({
      keywordErrors: {
        "Show 4K": "PanSou rejected the initial keyword",
      },
      keywordResults: {
        "The Show": [
          {
            title: "The Show S01E01 4K",
            episodeHints: ["S01E01"],
            qualityHints: ["4K"],
          },
        ],
      },
    });

    const result = await runType2Initialization({
      title,
      season,
      keyword: "Show 4K",
      storageParentDirectoryId: "library_root",
      resourceProvider,
      storage: new FakeStorageExecutor({ directories: { dir_show_s1: [] } }),
      agents: new FakeAgentNodes(),
    });

    const selectedSnapshot = result.resourceSnapshots.find(
      (snapshot) => snapshot.id === result.decisions[0]?.snapshotId,
    );
    expect(selectedSnapshot?.keyword).toBe("The Show");
    expect(result.auditEvents.map((event) => event.type)).toContain("keyword_search_failed");
    expect(result.auditEvents.map((event) => event.type)).toContain("acquisition_plan_created");
  });

  it("transfers only candidates the planning agent judged as the right target", async () => {
    const title: MediaTitle = {
      id: "title_show",
      tmdbId: 1,
      type: "tv",
      title: "Show",
      originalTitle: "Show",
      year: 2026,
      aliases: ["The Show"],
    };
    const season: TrackedSeason = {
      id: "season_show_1",
      mediaTitleId: title.id,
      seasonNumber: 1,
      status: "active",
      qualityPreference: "4K",
      storageDirectoryId: "dir_show_s1",
      totalEpisodes: 1,
      latestAiredEpisode: 1,
      latestAiredSource: "metadata",
    };
    const storage = new RecordingCandidateStorage();

    await runType2Initialization({
      title,
      season,
      keyword: "Show 4K",
      storageParentDirectoryId: "library_root",
      resourceProvider: new FakeResourceProvider({
        keywordResults: {
          "Show 4K": [
            {
              title: "Different Show S01E01 4K",
              episodeHints: ["S01E01"],
              qualityHints: ["4K"],
            },
            {
              title: "Show S01E01 4K",
              episodeHints: ["S01E01"],
              qualityHints: ["4K"],
            },
          ],
        },
      }),
      storage,
      agents: new TargetFilteringAgentNodes(),
      workflowRunId: "run_candidate_match",
    });

    expect(storage.transfers.map((transfer) => transfer.candidate.id)).toEqual([
      "snapshot_1_candidate_2",
      "snapshot_2_candidate_2",
    ]);
    expect(storage.transfers.map((transfer) => transfer.candidate.title)).not.toContain(
      "Different Show S01E01 4K",
    );
  });

  it("passes the selected resource candidate payload to storage transfer", async () => {
    const title: MediaTitle = {
      id: "title_show",
      tmdbId: 1,
      type: "tv",
      title: "Show",
      originalTitle: "Show",
      year: 2026,
      aliases: [],
    };
    const season: TrackedSeason = {
      id: "season_show_1",
      mediaTitleId: title.id,
      seasonNumber: 1,
      status: "active",
      qualityPreference: "4K",
      storageDirectoryId: "dir_show_s1",
      totalEpisodes: 1,
      latestAiredEpisode: 1,
      latestAiredSource: "metadata",
    };
    const storage = new RecordingCandidateStorage();

    await runType2Initialization({
      title,
      season,
      keyword: "Show 4K",
      storageParentDirectoryId: "library_root",
      resourceProvider: new FakeResourceProvider({
        keywordResults: {
          "Show 4K": [
            {
              title: "Show S01E01 4K",
              episodeHints: ["S01E01"],
              qualityHints: ["4K"],
              providerPayload: {
                url: "https://115.com/s/abc123?password=pw",
                rawType: "115",
                password: "pw",
              },
            },
          ],
        },
      }),
      storage,
      agents: new FakeAgentNodes(),
      workflowRunId: "run_candidate_payload",
    });

    expect(storage.transfers[0]?.candidate).toMatchObject({
      id: "snapshot_1_candidate_1",
      providerPayload: {
        url: "https://115.com/s/abc123?password=pw",
        rawType: "115",
        password: "pw",
      },
    });
  });
});

class RecordingCandidateStorage implements StorageExecutor {
  readonly transfers: Array<{
    workflowRunId: string;
    directoryId: string;
    candidate: ResourceCandidate;
  }> = [];

  async createDirectory(): Promise<string> {
    return "dir_created";
  }

  async listVideoFiles() {
    return [];
  }

  async listUnparsedVideoFiles() {
    return [];
  }

  async listSubdirectories(): Promise<Array<{ id: string; path: string }>> {
    return [];
  }

  async renameFile(): Promise<void> {}

  async transfer(input: {
    workflowRunId: string;
    directoryId: string;
    candidate: ResourceCandidate;
  }): Promise<TransferAttempt> {
    this.transfers.push(input);
    return {
      id: "transfer_1",
      workflowRunId: input.workflowRunId,
      candidateId: input.candidate.id,
      status: "succeeded",
      providerMessage: "",
      materializedFileIds: [],
    };
  }

  async flattenDirectory(): Promise<{ moved: string[]; removed: string[] }> {
    return { moved: [], removed: [] };
  }

  async deleteFiles(): Promise<{ deleted: string[] }> {
    return { deleted: [] };
  }

  async removeDirectory(): Promise<{ removed: boolean }> {
    return { removed: true };
  }

  async listTree(): Promise<never[]> {
    return [];
  }

  async moveFiles(): Promise<{ moved: string[] }> {
    return { moved: [] };
  }
}

class TargetFilteringAgentNodes extends FakeAgentNodes {
  override async planAcquisition(input: AcquisitionPlanningInput): Promise<AcquisitionPlanningResult> {
    const snapshot = await input.searchResources({ keyword: input.initialKeyword });
    return {
      plan: {
        node: "target_filtering",
        selectedSnapshotId: snapshot.id,
        searchedKeywords: [input.initialKeyword],
        candidateDispositions: snapshot.candidates.map((candidate) =>
          candidate.title === "Show S01E01 4K"
            ? {
                candidateId: candidate.id,
                disposition: "selected" as const,
                episodes: [...candidate.episodeHints],
                reason: "Exact target title.",
              }
            : {
                candidateId: candidate.id,
                disposition: "rejected" as const,
                episodes: [],
                reason: "Wrong target title.",
              },
        ),
        confidence: "high",
        reason: "Only the exact target title should be transferred.",
      },
      snapshots: [snapshot],
      trace: [],
    };
  }
}

describe("runType2Initialization canonical landing directory", () => {
  it("creates Title (Year)/Season N under the parent when the season has no directory", async () => {
    const title: MediaTitle = {
      id: "title_show",
      tmdbId: 1,
      type: "tv",
      title: "Show",
      originalTitle: "Show",
      year: 2026,
      aliases: [],
    };
    const season: TrackedSeason = {
      id: "season_show_1",
      mediaTitleId: title.id,
      seasonNumber: 1,
      status: "active",
      qualityPreference: "4K",
      storageDirectoryId: "",
      totalEpisodes: 1,
      latestAiredEpisode: 1,
      latestAiredSource: "metadata",
    };
    const storage = new FakeStorageExecutor({
      transferOutcomes: {
        snapshot_1_candidate_1: {
          status: "succeeded",
          providerMessage: "",
          files: [
            {
              id: "file_S01E01",
              storageDirectoryId: "overridden_by_fake",
              name: "Show.S01E01.mkv",
              sizeBytes: 1_000_000_000,
              episodeCode: "S01E01",
              providerFileId: "provider_S01E01",
            },
          ],
        },
      },
    });

    const result = await runType2Initialization({
      title,
      season,
      keyword: "Show 4K",
      storageParentDirectoryId: "library_root",
      resourceProvider: new FakeResourceProvider({
        keywordResults: {
          "Show 4K": [{ title: "Show S01E01 4K", episodeHints: ["S01E01"] }],
        },
      }),
      storage,
      agents: new FakeAgentNodes(),
    });

    expect(result.season.storageDirectoryId).toBe("library_root_Show (2026)_1_Season 1_2");
    expect(result.status).toBe("succeeded");
    expect(result.obtainedEpisodes).toEqual(["S01E01"]);
    expect(result.auditEvents.map((event) => event.type)).toContain("landing_directory_created");
    const files = await storage.listVideoFiles(result.season.storageDirectoryId);
    expect(files.map((file) => file.episodeCode)).toEqual(["S01E01"]);
  });

  it("throws a config error when the season has no directory and no parent is given", async () => {
    const title: MediaTitle = {
      id: "title_show",
      tmdbId: 1,
      type: "tv",
      title: "Show",
      originalTitle: "Show",
      year: 2026,
      aliases: [],
    };
    const season: TrackedSeason = {
      id: "season_show_1",
      mediaTitleId: title.id,
      seasonNumber: 1,
      status: "active",
      qualityPreference: "4K",
      storageDirectoryId: "",
      totalEpisodes: 1,
      latestAiredEpisode: 1,
      latestAiredSource: "metadata",
    };

    await expect(
      runType2Initialization({
        title,
        season,
        keyword: "Show 4K",
        resourceProvider: new FakeResourceProvider({ keywordResults: {} }),
        storage: new FakeStorageExecutor(),
        agents: new FakeAgentNodes(),
      }),
    ).rejects.toThrow("MEDIA_TRACK_STORAGE_PARENT_REQUIRED");
  });
});

describe("pre-acquisition reconcile of existing season content", () => {
  it("subtracts episodes already in the season directory from the planning need set", async () => {
    const title: MediaTitle = {
      id: "title_qiaochu",
      tmdbId: 289271,
      type: "tv",
      title: "翘楚",
      originalTitle: "翘楚",
      year: 2026,
      aliases: ["Ashes to Crown"],
    };
    const season: TrackedSeason = {
      id: "season_qiaochu_1",
      mediaTitleId: title.id,
      seasonNumber: 1,
      status: "active",
      qualityPreference: "4K",
      storageDirectoryId: "dir_qiaochu_s1",
      totalEpisodes: 24,
      latestAiredEpisode: 14,
      latestAiredSource: "metadata",
    };
    // A previous run already landed E01-E13; only E14 is genuinely missing.
    const existingFiles = Array.from({ length: 13 }, (_, index) => {
      const episode = `S01E${String(index + 1).padStart(2, "0")}`;
      return {
        id: `existing_${episode}`,
        storageDirectoryId: "dir_qiaochu_s1",
        name: `翘楚.${episode}.mkv`,
        sizeBytes: 1_000_000_000,
        episodeCode: episode,
        providerFileId: `existing_${episode}`,
      };
    });
    const recordedNeedSets: string[][] = [];
    const agents = new (class extends FakeAgentNodes {
      override async planAcquisition(input: AcquisitionPlanningInput): Promise<AcquisitionPlanningResult> {
        recordedNeedSets.push([...input.missingEpisodes]);
        return super.planAcquisition(input);
      }
    })();
    const storage = new FakeStorageExecutor({
      directories: { dir_qiaochu_s1: existingFiles },
      transferOutcomes: {
        snapshot_1_candidate_14: {
          status: "succeeded",
          providerMessage: "",
          files: [
            {
              id: "file_S01E14",
              storageDirectoryId: "set_by_fake",
              name: "翘楚.S01E14.mkv",
              sizeBytes: 1_000_000_000,
              episodeCode: "S01E14",
              providerFileId: "provider_S01E14",
            },
          ],
        },
      },
    });

    const result = await runType2Initialization({
      title,
      season,
      keyword: "翘楚 4K",
      storageParentDirectoryId: "library_root",
      resourceProvider: new FakeResourceProvider({
        keywordResults: {
          "翘楚 4K": Array.from({ length: 14 }, (_, index) => ({
            title: `翘楚 S01E${String(index + 1).padStart(2, "0")} 4K`,
            episodeHints: [`S01E${String(index + 1).padStart(2, "0")}`],
            qualityHints: ["4K"],
          })),
        },
      }),
      storage,
      agents,
    });

    expect(recordedNeedSets).toEqual([["S01E14"]]);
    expect(result.transferAttempts).toHaveLength(1);
    expect(result.status).toBe("succeeded");
    expect(result.obtainedEpisodes).toHaveLength(14);
    expect(result.auditEvents.map((event) => event.type)).toContain("existing_content_reconciled");
  });

  it("skips planning entirely when the season directory already covers every aired episode", async () => {
    const title: MediaTitle = {
      id: "title_show",
      tmdbId: 1,
      type: "tv",
      title: "Show",
      originalTitle: "Show",
      year: 2026,
      aliases: [],
    };
    const season: TrackedSeason = {
      id: "season_show_1",
      mediaTitleId: title.id,
      seasonNumber: 1,
      status: "active",
      qualityPreference: "4K",
      storageDirectoryId: "dir_show_s1",
      totalEpisodes: 1,
      latestAiredEpisode: 1,
      latestAiredSource: "metadata",
    };
    let planCalls = 0;
    const agents = new (class extends FakeAgentNodes {
      override async planAcquisition(input: AcquisitionPlanningInput): Promise<AcquisitionPlanningResult> {
        planCalls += 1;
        return super.planAcquisition(input);
      }
    })();

    const result = await runType2Initialization({
      title,
      season,
      keyword: "Show 4K",
      storageParentDirectoryId: "library_root",
      resourceProvider: new FakeResourceProvider({ keywordResults: {} }),
      storage: new FakeStorageExecutor({
        directories: {
          dir_show_s1: [
            {
              id: "existing_S01E01",
              storageDirectoryId: "dir_show_s1",
              name: "Show.S01E01.mkv",
              sizeBytes: 1_000_000_000,
              episodeCode: "S01E01",
              providerFileId: "existing_S01E01",
            },
          ],
        },
      }),
      agents,
    });

    expect(planCalls).toBe(0);
    expect(result.status).toBe("succeeded");
    expect(result.transferAttempts).toEqual([]);
    expect(result.obtainedEpisodes).toEqual(["S01E01"]);
  });
});

describe("canonical rename of landed files", () => {
  it("renames agent-recognized staging files so the landed name itself exposes the episode", async () => {
    const title: MediaTitle = {
      id: "title_show",
      tmdbId: 1,
      type: "tv",
      title: "Show",
      originalTitle: "Show",
      year: 2026,
      aliases: [],
    };
    const season: TrackedSeason = {
      id: "season_show_1",
      mediaTitleId: title.id,
      seasonNumber: 1,
      status: "active",
      qualityPreference: "4K",
      storageDirectoryId: "dir_show_s1",
      totalEpisodes: 1,
      latestAiredEpisode: 1,
      latestAiredSource: "metadata",
    };
    const storage = new FakeStorageExecutor({
      directories: { dir_show_s1: [] },
      transferOutcomes: {
        snapshot_1_candidate_1: {
          status: "succeeded",
          providerMessage: "",
          files: [
            {
              id: "landed_weird",
              storageDirectoryId: "set_by_fake",
              name: "Episode 01.mkv",
              sizeBytes: 1_000_000_000,
              episodeCode: "S01E01",
              providerFileId: "landed_weird",
            },
          ],
        },
      },
    });

    const result = await runType2Initialization({
      title,
      season,
      keyword: "Show 4K",
      storageParentDirectoryId: "library_root",
      resourceProvider: new FakeResourceProvider({
        keywordResults: {
          "Show 4K": [{ title: "Show S01E01 4K", episodeHints: ["S01E01"] }],
        },
      }),
      storage,
      agents: new FakeAgentNodes({
        packageRecognition: {
          node: "test_recognition",
          fileMappings: [
            {
              providerFileId: "landed_weird",
              seasonNumber: 1,
              episodeNumber: 1,
              confidence: "high",
              reason: "single episode file in a single-episode resource",
            },
          ],
          rejectedProviderFileIds: [],
          confidence: "high",
          reason: "episode 1",
        },
      }),
    });

    expect(result.status).toBe("succeeded");
    const files = await storage.listVideoFiles("dir_show_s1");
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("Show.S01E01.mkv");
    expect(result.auditEvents.map((event) => event.type)).toContain("landed_file_renamed");
  });
});

describe("snapshot id dedupe", () => {
  it("keeps one copy when the provider content-hashes identical results to the same snapshot id", async () => {
    const title: MediaTitle = {
      id: "title_show", tmdbId: 1, type: "tv", title: "Show", originalTitle: "Show", year: 2026, aliases: [],
    };
    const season: TrackedSeason = {
      id: "season_show_1", mediaTitleId: title.id, seasonNumber: 1, status: "active",
      qualityPreference: "4K", storageDirectoryId: "dir_show_s1", totalEpisodes: 1,
      latestAiredEpisode: 1, latestAiredSource: "metadata",
    };
    const hashedSnapshot = (id: string) => ({
      id, provider: "pansou", keyword: "Show", candidates: [{
        id: `${id}_candidate_1`, snapshotId: id, index: 0, title: "Show S01E01 4K",
        type: "115" as const, source: "pansou", episodeHints: ["S01E01"], qualityHints: [], providerPayload: {},
      }], createdAt: "2026-01-01T00:00:00.000Z",
    });
    const agents = new (class extends FakeAgentNodes {
      override async planAcquisition(input: AcquisitionPlanningInput): Promise<AcquisitionPlanningResult> {
        // model searched twice; provider content-hashed both to the same id
        const snapshot = hashedSnapshot("pansou_samehash");
        void input;
        return {
          plan: {
            node: "stub", selectedSnapshotId: snapshot.id, searchedKeywords: ["Show", "Show 4K"],
            candidateDispositions: [{ candidateId: `${snapshot.id}_candidate_1`, disposition: "selected", episodes: ["S01E01"], reason: "covers" }],
            confidence: "high", reason: "ok",
          },
          snapshots: [snapshot, hashedSnapshot("pansou_samehash")],
          trace: [],
        };
      }
    })();
    const storage = new FakeStorageExecutor({
      transferOutcomes: {
        pansou_samehash_candidate_1: {
          status: "succeeded", providerMessage: "",
          files: [{ id: "f1", storageDirectoryId: "x", name: "Show.S01E01.mkv", sizeBytes: 1, episodeCode: "S01E01", providerFileId: "f1" }],
        },
      },
    });

    const result = await runType2Initialization({
      title, season, keyword: "Show 4K",
      storageParentDirectoryId: "library_root",
      resourceProvider: new FakeResourceProvider({ keywordResults: {} }),
      storage, agents,
    });

    expect(result.resourceSnapshots.map((snapshot) => snapshot.id)).toEqual(["pansou_samehash"]);
  });
});
