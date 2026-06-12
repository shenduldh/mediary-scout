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
    expect(result.notification.body).toContain("14 episodes obtained");
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
