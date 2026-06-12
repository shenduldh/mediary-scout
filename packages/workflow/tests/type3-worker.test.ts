import { describe, expect, it } from "vitest";
import {
  createEpisodeStates,
  FakeAgentNodes,
  FakeResourceProvider,
  FakeStorageExecutor,
  InMemoryWorkflowRepository,
  reconcileVerifiedFiles,
  runScheduledType3Monitoring,
  type MediaTitle,
  type TrackedSeason,
  type VerifiedFile,
} from "../src/index.js";

const fixedNow = () => "2026-06-12T00:00:00.000Z";

function trackedFixture(suffix = "show") {
  const title: MediaTitle = {
    id: `title_${suffix}`,
    tmdbId: 1,
    type: "tv",
    title: "Show",
    originalTitle: "Show",
    year: 2026,
    aliases: [],
  };
  const season: TrackedSeason = {
    id: `season_${suffix}_1`,
    mediaTitleId: title.id,
    seasonNumber: 1,
    status: "active",
    qualityPreference: "4K",
    storageDirectoryId: `dir_${suffix}_s1`,
    totalEpisodes: 2,
    latestAiredEpisode: 2,
    latestAiredSource: "metadata",
  };
  return { title, season };
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

async function seedTrackedSeason(input: {
  repository: InMemoryWorkflowRepository;
  title: MediaTitle;
  season: TrackedSeason;
  obtainedCodes: string[];
}) {
  const files = input.obtainedCodes.map((code, index) => verifiedFile(input.season, `seed_${index}`, code));
  const episodes = reconcileVerifiedFiles({
    season: input.season,
    episodes: createEpisodeStates({
      trackedSeasonId: input.season.id,
      seasonNumber: input.season.seasonNumber,
      totalEpisodes: input.season.totalEpisodes,
      latestAiredEpisode: input.season.latestAiredEpisode,
    }),
    files,
  });
  await input.repository.saveWorkflowRunSnapshot({
    title: input.title,
    season: input.season,
    workflowRun: {
      id: `seed_${input.season.id}`,
      kind: "type2_init",
      status: "succeeded",
      trackedSeasonId: input.season.id,
      startedAt: fixedNow(),
      finishedAt: fixedNow(),
      auditEvents: [],
    },
    episodes,
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
  });
  return files;
}

describe("runScheduledType3Monitoring", () => {
  it("returns an empty outcome list when nothing is tracked", async () => {
    const outcomes = await runScheduledType3Monitoring({
      repository: new InMemoryWorkflowRepository(),
      resourceProvider: new FakeResourceProvider({ keywordResults: {} }),
      storage: new FakeStorageExecutor(),
      agents: new FakeAgentNodes(),
      storageParentDirectoryId: "library_root",
      now: fixedNow,
    });

    expect(outcomes).toEqual([]);
  });

  it("repairs a tracked season with missing episodes and persists the run", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = trackedFixture();
    await seedTrackedSeason({ repository, title, season, obtainedCodes: ["S01E01", "S01E02"] });
    // external mutation: storage only has E01
    const storage = new FakeStorageExecutor({
      directories: { [season.storageDirectoryId]: [verifiedFile(season, "kept_e01", "S01E01")] },
      transferOutcomes: {
        snapshot_1_candidate_1: {
          status: "succeeded",
          providerMessage: "",
          files: [verifiedFile(season, "restored_e02", "S01E02")],
        },
      },
    });

    const outcomes = await runScheduledType3Monitoring({
      repository,
      resourceProvider: new FakeResourceProvider({
        keywordResults: {
          "Show 4K": [{ title: "Show S01E02 4K", episodeHints: ["S01E02"], qualityHints: ["4K"] }],
        },
      }),
      storage,
      agents: new FakeAgentNodes(),
      storageParentDirectoryId: "library_root",
      now: fixedNow,
      createWorkflowRunId: () => "run_sched_type3",
    });

    expect(outcomes).toEqual([
      {
        trackedSeasonId: season.id,
        status: "ran",
        workflowRunId: "run_sched_type3",
        workflowStatus: "succeeded",
      },
    ]);
    const saved = await repository.getWorkflowRunSnapshot("run_sched_type3");
    expect(saved?.workflowRun.kind).toBe("type3_monitor");
    expect(saved?.obtainedEpisodes).toEqual(["S01E01", "S01E02"]);
  });

  it("records a noop run when a tracked season is already current", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = trackedFixture();
    const files = await seedTrackedSeason({ repository, title, season, obtainedCodes: ["S01E01", "S01E02"] });
    const storage = new FakeStorageExecutor({
      directories: { [season.storageDirectoryId]: files },
    });

    const outcomes = await runScheduledType3Monitoring({
      repository,
      resourceProvider: new FakeResourceProvider({
        keywordErrors: { "Show 4K": "search must not happen for current seasons" },
        keywordResults: {},
      }),
      storage,
      agents: new FakeAgentNodes(),
      storageParentDirectoryId: "library_root",
      now: fixedNow,
      createWorkflowRunId: () => "run_noop_type3",
    });

    expect(outcomes).toEqual([
      {
        trackedSeasonId: season.id,
        status: "ran",
        workflowRunId: "run_noop_type3",
        workflowStatus: "succeeded",
      },
    ]);
  });

  it("skips a season that already has an active workflow run", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = trackedFixture();
    await seedTrackedSeason({ repository, title, season, obtainedCodes: [] });
    await repository.saveWorkflowRunSnapshot({
      title,
      season,
      workflowRun: {
        id: "active_run",
        kind: "type3_monitor",
        status: "running",
        trackedSeasonId: season.id,
        startedAt: fixedNow(),
        finishedAt: null,
        auditEvents: [],
      },
      episodes: createEpisodeStates({
        trackedSeasonId: season.id,
        seasonNumber: season.seasonNumber,
        totalEpisodes: season.totalEpisodes,
        latestAiredEpisode: season.latestAiredEpisode,
      }),
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });

    const outcomes = await runScheduledType3Monitoring({
      repository,
      resourceProvider: new FakeResourceProvider({ keywordResults: {} }),
      storage: new FakeStorageExecutor(),
      agents: new FakeAgentNodes(),
      storageParentDirectoryId: "library_root",
      now: fixedNow,
    });

    expect(outcomes).toEqual([
      {
        trackedSeasonId: season.id,
        status: "skipped_active",
      },
    ]);
  });

  it("isolates one season's failure and continues with the next", async () => {
    const repository = new InMemoryWorkflowRepository();
    const broken = trackedFixture("broken");
    const healthy = trackedFixture("healthy");
    await seedTrackedSeason({
      repository,
      title: broken.title,
      season: broken.season,
      obtainedCodes: ["S01E01"],
    });
    await seedTrackedSeason({
      repository,
      title: healthy.title,
      season: healthy.season,
      obtainedCodes: ["S01E01"],
    });
    const storage = new FakeStorageExecutor({
      directories: {
        [broken.season.storageDirectoryId]: [],
        [healthy.season.storageDirectoryId]: [
          verifiedFile(healthy.season, "h_e01", "S01E01"),
          verifiedFile(healthy.season, "h_e02", "S01E02"),
        ],
      },
    });
    let counter = 0;

    const outcomes = await runScheduledType3Monitoring({
      repository,
      // every search errors -> broken season's run fails as infrastructure error
      resourceProvider: new FakeResourceProvider({
        keywordResults: {},
        keywordErrors: {
          "Show 4K": "provider down",
          Show: "provider down",
          "Show 4K ": "provider down",
        },
      }),
      storage,
      agents: new FakeAgentNodes(),
      storageParentDirectoryId: "library_root",
      now: fixedNow,
      createWorkflowRunId: () => `run_multi_${(counter += 1)}`,
    });

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toMatchObject({
      trackedSeasonId: broken.season.id,
      status: "failed",
      errorMessage: "provider down",
    });
    expect(outcomes[1]).toMatchObject({
      trackedSeasonId: healthy.season.id,
      status: "ran",
      workflowStatus: "succeeded",
    });
    const failed = await repository.getWorkflowRunSnapshot("run_multi_1");
    expect(failed?.workflowRun.status).toBe("failed");
  });
});
