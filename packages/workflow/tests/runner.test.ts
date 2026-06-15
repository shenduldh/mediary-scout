import { describe, expect, it } from "vitest";
import {
  createEpisodeStates,
  FakeAgentNodes,
  FakeResourceProvider,
  FakeStorageExecutor,
  InMemoryWorkflowRepository,
  reconcileVerifiedFiles,
  runType2InitializationAndPersist,
  runType3MonitoringAndPersist,
  type MediaTitle,
  type TrackedSeason,
  type VerifiedFile,
} from "../src/index.js";

describe("persistent workflow runners", () => {
  it("persists a type2 initialization run with its resource evidence", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = trackedFixture();
    const resourceProvider = new FakeResourceProvider({
      keywordResults: {
        "Show 4K": [
          {
            title: "Show S01E01 4K",
            episodeHints: ["S01E01"],
            qualityHints: ["4K"],
          },
        ],
      },
    });
    const storage = new FakeStorageExecutor({
      directories: { [season.storageDirectoryId]: [] },
      transferOutcomes: {
        snapshot_1_candidate_1: {
          status: "succeeded",
          providerMessage: "",
          files: [verifiedFile(season, "file_S01E01", "S01E01")],
        },
      },
    });

    const result = await runType2InitializationAndPersist({
      title,
      season,
      keyword: "Show 4K",
      storageParentDirectoryId: "library_root",
      resourceProvider,
      storage,
      agents: new FakeAgentNodes(),
      repository,
      workflowRun: runMetadata("run_type2_persist"),
    });

    expect(result.resourceSnapshots).toHaveLength(1);
    const saved = await repository.getWorkflowRunSnapshot("run_type2_persist");
    expect(saved).toMatchObject({
      workflowRun: {
        id: "run_type2_persist",
        kind: "type2_init",
        status: "succeeded",
        trackedSeasonId: season.id,
      },
      obtainedEpisodes: ["S01E01"],
      providerAheadEpisodes: [],
    });
    expect(saved?.resourceSnapshots[0]?.id).toBe(result.resourceSnapshots[0]?.id);
    expect(saved?.decisions[0]?.snapshotId).toBe(result.resourceSnapshots[0]?.id);
    expect(saved?.transferAttempts[0]?.workflowRunId).toBe("run_type2_persist");
    expect(saved?.notifications[0]?.workflowRunId).toBe("run_type2_persist");
    await expect(repository.listEpisodeStates(season.id)).resolves.toEqual(saved?.episodes);
  });

  it("persists a type3 no-op run without forcing a provider search", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = trackedFixture();
    const existingFiles = [verifiedFile(season, "file_S01E01", "S01E01")];
    const episodes = reconcileVerifiedFiles({
      season,
      episodes: createEpisodeStates({
        trackedSeasonId: season.id,
        seasonNumber: season.seasonNumber,
        totalEpisodes: season.totalEpisodes,
        latestAiredEpisode: season.latestAiredEpisode,
      }),
      files: existingFiles,
    });
    const resourceProvider = new FakeResourceProvider({
      keywordResults: {},
      keywordErrors: { "Show 4K": "provider search should not run for current storage" },
    });
    const storage = new FakeStorageExecutor({
      directories: { [season.storageDirectoryId]: existingFiles },
    });

    const result = await runType3MonitoringAndPersist({
      title,
      season,
      episodes,
      keyword: "Show 4K",
      storageParentDirectoryId: "library_root",
      resourceProvider,
      storage,
      agents: new FakeAgentNodes(),
      repository,
      workflowRun: runMetadata("run_type3_noop_persist"),
    });

    expect(result.resourceSnapshots).toEqual([]);
    expect(result.transferAttempts).toEqual([]);
    const saved = await repository.getWorkflowRunSnapshot("run_type3_noop_persist");
    expect(saved).toMatchObject({
      workflowRun: {
        id: "run_type3_noop_persist",
        kind: "type3_monitor",
        status: "succeeded",
        trackedSeasonId: season.id,
      },
      obtainedEpisodes: ["S01E01"],
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
    });
    expect(saved?.notifications[0]?.kind).toBe("already_current");
  });

  it("persists a type3 repair run with resource evidence and transfer attempts", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = trackedFixture();
    const episodes = createEpisodeStates({
      trackedSeasonId: season.id,
      seasonNumber: season.seasonNumber,
      totalEpisodes: season.totalEpisodes,
      latestAiredEpisode: season.latestAiredEpisode,
    });
    const resourceProvider = new FakeResourceProvider({
      keywordResults: {
        "Show 4K": [
          {
            title: "Show S01E01 4K",
            episodeHints: ["S01E01"],
            qualityHints: ["4K"],
          },
        ],
      },
    });
    const storage = new FakeStorageExecutor({
      directories: { [season.storageDirectoryId]: [] },
      transferOutcomes: {
        snapshot_1_candidate_1: {
          status: "succeeded",
          providerMessage: "",
          files: [verifiedFile(season, "repair_S01E01", "S01E01")],
        },
      },
    });

    const result = await runType3MonitoringAndPersist({
      title,
      season,
      episodes,
      keyword: "Show 4K",
      storageParentDirectoryId: "library_root",
      resourceProvider,
      storage,
      agents: new FakeAgentNodes(),
      repository,
      workflowRun: runMetadata("run_type3_repair_persist"),
    });

    expect(result.resourceSnapshots).toHaveLength(1);
    expect(result.transferAttempts).toHaveLength(1);
    const saved = await repository.getWorkflowRunSnapshot("run_type3_repair_persist");
    expect(saved).toMatchObject({
      workflowRun: {
        id: "run_type3_repair_persist",
        kind: "type3_monitor",
        status: "succeeded",
        trackedSeasonId: season.id,
      },
      obtainedEpisodes: ["S01E01"],
    });
    expect(saved?.resourceSnapshots[0]?.id).toBe(result.resourceSnapshots[0]?.id);
    expect(saved?.decisions[0]?.snapshotId).toBe(result.resourceSnapshots[0]?.id);
    expect(saved?.transferAttempts[0]).toMatchObject({
      workflowRunId: "run_type3_repair_persist",
      candidateId: result.resourceSnapshots[0]?.candidates[0]?.id,
      materializedFileIds: ["repair_S01E01"],
    });
    expect(saved?.notifications[0]?.workflowRunId).toBe("run_type3_repair_persist");
    expect(saved?.notifications[0]?.kind).toBe("episodes_restored");
  });
});

function trackedFixture(): { title: MediaTitle; season: TrackedSeason } {
  const title: MediaTitle = {
    id: "title_show",
    tmdbId: 123,
    type: "tv",
    title: "Show",
    originalTitle: "Show",
    year: 2026,
    aliases: [],
  };
  return {
    title,
    season: {
      id: "season_show_1",
      mediaTitleId: title.id,
      seasonNumber: 1,
      status: "active",
      qualityPreference: "4K",
      storageDirectoryId: "dir_show_s1",
      totalEpisodes: 2,
      latestAiredEpisode: 1,
      latestAiredSource: "metadata",
    },
  };
}

function runMetadata(id: string) {
  return {
    id,
    startedAt: "2026-06-11T00:00:00.000Z",
    finishedAt: "2026-06-11T00:01:00.000Z",
  };
}

function verifiedFile(season: TrackedSeason, id: string, code: string): VerifiedFile {
  return {
    id,
    storageDirectoryId: season.storageDirectoryId,
    name: `Show.${code}.mkv`,
    sizeBytes: 1_000_000_000,
    episodeCode: code,
    providerFileId: `provider_${id}`,
  };
}
