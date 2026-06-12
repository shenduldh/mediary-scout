import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  episodeCode,
  SQLiteWorkflowRepository,
  type AgentDecision,
  type EpisodeState,
  type MediaTitle,
  type NotificationEvent,
  type ResourceSnapshot,
  type TrackedSeason,
  type TransferAttempt,
  type WorkflowRun,
} from "../src/index.js";

describe("SQLiteWorkflowRepository", () => {
  let database: DatabaseSync | null = null;

  afterEach(() => {
    database?.close();
    database = null;
  });

  it("persists and loads a workflow run snapshot through SQLite tables", async () => {
    database = new DatabaseSync(":memory:");
    const repository = new SQLiteWorkflowRepository(database);
    const snapshot = workflowPersistenceFixture();

    await repository.saveWorkflowRunSnapshot(snapshot);

    const loaded = await repository.getWorkflowRunSnapshot("run_1");

    expect(loaded).toMatchObject({
      title: { id: "title_1" },
      season: { id: "season_1" },
      workflowRun: { id: "run_1", status: "succeeded" },
      obtainedEpisodes: ["S01E01"],
      providerAheadEpisodes: [],
    });
    expect(loaded?.resourceSnapshots[0]?.candidates[0]?.id).toBe("snapshot_1_candidate_1");
    expect(loaded?.decisions[0]?.selectedCandidateIds).toEqual(["snapshot_1_candidate_1"]);
    expect(loaded?.transferAttempts[0]?.materializedFileIds).toEqual(["file_1"]);
    expect(loaded?.notifications[0]?.kind).toBe("tracking_initialized");

    expect(countRows(database, "media_titles")).toBe(1);
    expect(countRows(database, "tracked_seasons")).toBe(1);
    expect(countRows(database, "workflow_runs")).toBe(1);
    expect(countRows(database, "episode_states")).toBe(2);
    expect(countRows(database, "resource_snapshots")).toBe(1);
    expect(countRows(database, "agent_decisions")).toBe(1);
    expect(countRows(database, "transfer_attempts")).toBe(1);
    expect(countRows(database, "notifications")).toBe(1);
  });

  it("keeps stored state isolated from caller mutations", async () => {
    database = new DatabaseSync(":memory:");
    const repository = new SQLiteWorkflowRepository(database);
    const snapshot = workflowPersistenceFixture();

    await repository.saveWorkflowRunSnapshot(snapshot);
    snapshot.episodes[0]!.obtained = false;

    const loaded = await repository.getWorkflowRunSnapshot("run_1");
    loaded!.resourceSnapshots[0]!.candidates[0]!.title = "mutated after load";

    const loadedAgain = await repository.getWorkflowRunSnapshot("run_1");

    expect(loadedAgain?.episodes[0]).toMatchObject({
      episodeCode: "S01E01",
      obtained: true,
    });
    expect(loadedAgain?.resourceSnapshots[0]?.candidates[0]?.title).toBe("Show S01E01");
  });

  it("rejects invalid snapshots without partially replacing an existing run", async () => {
    database = new DatabaseSync(":memory:");
    const repository = new SQLiteWorkflowRepository(database);
    const validSnapshot = workflowPersistenceFixture();
    await repository.saveWorkflowRunSnapshot(validSnapshot);

    const invalidSnapshot = workflowPersistenceFixture({
      workflowRun: {
        ...validSnapshot.workflowRun,
        status: "failed",
      },
      transferAttempts: [
        {
          ...validSnapshot.transferAttempts[0]!,
          candidateId: "snapshot_99_candidate_1",
        },
      ],
    });

    await expect(repository.saveWorkflowRunSnapshot(invalidSnapshot)).rejects.toThrow(
      "Transfer attempt transfer_1 referenced an unknown candidate",
    );

    const loaded = await repository.getWorkflowRunSnapshot("run_1");
    expect(loaded?.workflowRun.status).toBe("succeeded");
    expect(loaded?.transferAttempts[0]?.candidateId).toBe("snapshot_1_candidate_1");
  });

  it("replaces an existing workflow run snapshot without foreign key failures", async () => {
    database = new DatabaseSync(":memory:");
    const repository = new SQLiteWorkflowRepository(database);
    const snapshot = workflowPersistenceFixture();
    await repository.saveWorkflowRunSnapshot(snapshot);

    const replacement = workflowPersistenceFixture({
      workflowRun: {
        ...snapshot.workflowRun,
        status: "partial",
        finishedAt: "2026-06-11T00:02:00.000Z",
      },
      episodes: [
        ...snapshot.episodes,
        {
          trackedSeasonId: snapshot.season.id,
          episodeCode: "S01E03",
          airDate: null,
          title: "Episode 3",
          airStatus: "unknown",
          obtained: true,
          metadataStatus: "provider_ahead",
          verifiedFileIds: ["file_3"],
        },
      ],
      notifications: [
        {
          ...snapshot.notifications[0]!,
          body: "replacement saved",
        },
      ],
    });

    await repository.saveWorkflowRunSnapshot(replacement);

    const loaded = await repository.getWorkflowRunSnapshot("run_1");
    expect(loaded?.workflowRun.status).toBe("partial");
    expect(loaded?.episodes.map((episode) => episode.episodeCode)).toEqual(["S01E01", "S01E02", "S01E03"]);
    expect(loaded?.providerAheadEpisodes).toEqual(["S01E03"]);
    expect(loaded?.notifications).toHaveLength(1);
    expect(loaded?.notifications[0]?.body).toBe("replacement saved");
    expect(countRows(database, "resource_snapshots")).toBe(1);
    expect(countRows(database, "agent_decisions")).toBe(1);
  });

  it("lists episode state for a tracked season", async () => {
    database = new DatabaseSync(":memory:");
    const repository = new SQLiteWorkflowRepository(database);
    const snapshot = workflowPersistenceFixture();
    await repository.saveWorkflowRunSnapshot(snapshot);

    await expect(repository.listEpisodeStates("season_1")).resolves.toEqual(snapshot.episodes);
    await expect(repository.listEpisodeStates("missing")).resolves.toEqual([]);
  });

  it("lists tracked season states and claims the oldest queued workflow run", async () => {
    database = new DatabaseSync(":memory:");
    const repository = new SQLiteWorkflowRepository(database);
    const queuedOld = workflowPersistenceFixture({
      workflowRun: {
        ...workflowPersistenceFixture().workflowRun,
        id: "run_queued_old",
        status: "queued",
        startedAt: "2026-06-11T00:00:00.000Z",
        finishedAt: null,
      },
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    const queuedNew = workflowPersistenceFixture({
      title: {
        ...workflowPersistenceFixture().title,
        id: "title_2",
        title: "Other Show",
      },
      season: {
        ...workflowPersistenceFixture().season,
        id: "season_2",
        mediaTitleId: "title_2",
      },
      workflowRun: {
        ...workflowPersistenceFixture().workflowRun,
        id: "run_queued_new",
        status: "queued",
        trackedSeasonId: "season_2",
        startedAt: "2026-06-11T00:01:00.000Z",
        finishedAt: null,
      },
      episodes: workflowPersistenceFixture().episodes.map((episode) => ({
        ...episode,
        trackedSeasonId: "season_2",
      })),
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    await repository.saveWorkflowRunSnapshot(queuedNew);
    await repository.saveWorkflowRunSnapshot(queuedOld);

    await expect(repository.listTrackedSeasonStates()).resolves.toMatchObject([
      {
        season: { id: "season_2" },
      },
      {
        season: { id: "season_1" },
      },
    ]);

    const claimed = await repository.claimNextQueuedWorkflowRun({
      kind: "type2_init",
      now: "2026-06-11T00:02:00.000Z",
    });

    expect(claimed).toMatchObject({
      workflowRun: {
        id: "run_queued_old",
        status: "running",
        auditEvents: [
          { type: "resource_snapshot_created" },
          { type: "workflow_claimed" },
        ],
      },
    });
    await expect(repository.getWorkflowRunSnapshot("run_queued_old")).resolves.toMatchObject({
      workflowRun: {
        status: "running",
      },
    });
  });

  it("finds the latest active workflow run for a tracked season and kind", async () => {
    database = new DatabaseSync(":memory:");
    const repository = new SQLiteWorkflowRepository(database);
    const succeeded = workflowPersistenceFixture({
      workflowRun: {
        ...workflowPersistenceFixture().workflowRun,
        id: "run_succeeded",
        status: "succeeded",
        startedAt: "2026-06-11T00:00:00.000Z",
      },
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    const oldActive = workflowPersistenceFixture({
      workflowRun: {
        ...workflowPersistenceFixture().workflowRun,
        id: "run_old_active",
        status: "queued",
        startedAt: "2026-06-11T00:01:00.000Z",
        finishedAt: null,
      },
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    const latestActive = workflowPersistenceFixture({
      workflowRun: {
        ...workflowPersistenceFixture().workflowRun,
        id: "run_latest_active",
        status: "running",
        startedAt: "2026-06-11T00:02:00.000Z",
        finishedAt: null,
      },
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });

    await repository.saveWorkflowRunSnapshot(succeeded);
    await repository.saveWorkflowRunSnapshot(oldActive);
    await repository.saveWorkflowRunSnapshot(latestActive);

    const active = await repository.findActiveWorkflowRun({
      trackedSeasonId: "season_1",
      kind: "type2_init",
    });

    expect(active?.workflowRun.id).toBe("run_latest_active");
    expect(active?.workflowRun.status).toBe("running");
    await expect(
      repository.findActiveWorkflowRun({
        trackedSeasonId: "season_1",
        kind: "type3_monitor",
      }),
    ).resolves.toBeNull();
  });

  it("reserves a workflow run only when there is no active run or tracked state", async () => {
    database = new DatabaseSync(":memory:");
    const repository = new SQLiteWorkflowRepository(database);
    const active = workflowPersistenceFixture({
      workflowRun: {
        ...workflowPersistenceFixture().workflowRun,
        id: "run_active",
        status: "running",
        finishedAt: null,
      },
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    const competing = workflowPersistenceFixture({
      workflowRun: {
        ...workflowPersistenceFixture().workflowRun,
        id: "run_competing",
        status: "running",
        finishedAt: null,
      },
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    await repository.saveWorkflowRunSnapshot(active);

    await expect(
      repository.reserveWorkflowRun({
        ...competing,
        blockIfEpisodeStatesExist: true,
      }),
    ).resolves.toMatchObject({
      status: "already_active",
      snapshot: {
        workflowRun: { id: "run_active" },
      },
    });
    await expect(repository.getWorkflowRunSnapshot("run_competing")).resolves.toBeNull();

    database.close();
    database = new DatabaseSync(":memory:");
    const trackedRepository = new SQLiteWorkflowRepository(database);
    await trackedRepository.saveWorkflowRunSnapshot(workflowPersistenceFixture());
    const trackedResult = await trackedRepository.reserveWorkflowRun({
      ...competing,
      blockIfEpisodeStatesExist: true,
    });
    expect(trackedResult.status).toBe("already_has_episode_state");
    expect(trackedResult.status === "already_has_episode_state" ? trackedResult.episodes[0]?.episodeCode : null).toBe(
      "S01E01",
    );
    await expect(trackedRepository.getWorkflowRunSnapshot("run_competing")).resolves.toBeNull();

    database.close();
    database = new DatabaseSync(":memory:");
    const emptyRepository = new SQLiteWorkflowRepository(database);
    await expect(
      emptyRepository.reserveWorkflowRun({
        ...competing,
        blockIfEpisodeStatesExist: true,
      }),
    ).resolves.toMatchObject({
      status: "reserved",
      snapshot: {
        workflowRun: { id: "run_competing" },
      },
    });
    await expect(emptyRepository.getWorkflowRunSnapshot("run_competing")).resolves.toMatchObject({
      workflowRun: { status: "running" },
    });
  });

  it("expires stale active workflow runs during reservation", async () => {
    database = new DatabaseSync(":memory:");
    const repository = new SQLiteWorkflowRepository(database);
    const stale = workflowPersistenceFixture({
      workflowRun: {
        ...workflowPersistenceFixture().workflowRun,
        id: "run_stale",
        status: "running",
        startedAt: "2026-06-11T00:00:00.000Z",
        finishedAt: null,
      },
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    const competing = workflowPersistenceFixture({
      workflowRun: {
        ...workflowPersistenceFixture().workflowRun,
        id: "run_competing",
        status: "running",
        startedAt: "2026-06-11T01:00:00.000Z",
        finishedAt: null,
      },
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });

    await repository.saveWorkflowRunSnapshot(stale);

    await expect(
      repository.reserveWorkflowRun({
        ...competing,
        blockIfEpisodeStatesExist: true,
        staleActiveRunStartedBefore: "2026-06-11T00:30:00.000Z",
        staleFinishedAt: "2026-06-11T01:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      status: "reserved",
      snapshot: {
        workflowRun: { id: "run_competing" },
      },
    });

    await expect(repository.getWorkflowRunSnapshot("run_stale")).resolves.toMatchObject({
      workflowRun: {
        status: "failed",
        finishedAt: "2026-06-11T01:00:00.000Z",
        auditEvents: [
          { type: "resource_snapshot_created" },
          { type: "workflow_expired" },
        ],
      },
    });
  });
});

function countRows(database: DatabaseSync, tableName: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get();
  return Number(row?.["count"]);
}

function workflowPersistenceFixture(
  overrides: Partial<{
    title: MediaTitle;
    season: TrackedSeason;
    workflowRun: WorkflowRun;
    episodes: EpisodeState[];
    resourceSnapshots: ResourceSnapshot[];
    decisions: AgentDecision[];
    transferAttempts: TransferAttempt[];
    notifications: NotificationEvent[];
  }> = {},
) {
  const title: MediaTitle = {
    id: "title_1",
    tmdbId: 100,
    type: "tv",
    title: "Show",
    originalTitle: "Show",
    year: 2026,
    aliases: [],
  };
  const season: TrackedSeason = {
    id: "season_1",
    mediaTitleId: title.id,
    seasonNumber: 1,
    status: "active",
    qualityPreference: "4K",
    storageDirectoryId: "dir_1",
    totalEpisodes: 2,
    latestAiredEpisode: 1,
    latestAiredSource: "metadata",
  };
  const workflowRun: WorkflowRun = {
    id: "run_1",
    kind: "type2_init",
    status: "succeeded",
    trackedSeasonId: season.id,
    startedAt: "2026-06-11T00:00:00.000Z",
    finishedAt: "2026-06-11T00:01:00.000Z",
    auditEvents: [
      {
        type: "resource_snapshot_created",
        message: "Created resource snapshot snapshot_1",
      },
    ],
  };
  const episodes: EpisodeState[] = [
    {
      trackedSeasonId: season.id,
      episodeCode: episodeCode(1, 1),
      airDate: null,
      title: "Episode 1",
      airStatus: "aired",
      obtained: true,
      metadataStatus: "confirmed",
      verifiedFileIds: ["file_1"],
    },
    {
      trackedSeasonId: season.id,
      episodeCode: episodeCode(1, 2),
      airDate: null,
      title: "Episode 2",
      airStatus: "unaired",
      obtained: false,
      metadataStatus: "confirmed",
      verifiedFileIds: [],
    },
  ];
  const resourceSnapshots: ResourceSnapshot[] = [
    {
      id: "snapshot_1",
      provider: "fake",
      keyword: "Show 4K",
      createdAt: "2026-06-11T00:00:00.000Z",
      candidates: [
        {
          id: "snapshot_1_candidate_1",
          snapshotId: "snapshot_1",
          index: 0,
          title: "Show S01E01",
          type: "115",
          source: "fake",
          episodeHints: ["S01E01"],
          qualityHints: ["4K"],
          providerPayload: {},
        },
      ],
    },
  ];
  const decisions: AgentDecision[] = [
    {
      node: "fake_episode_coverage",
      snapshotId: "snapshot_1",
      selectedCandidateIds: ["snapshot_1_candidate_1"],
      episodeMapping: {
        snapshot_1_candidate_1: ["S01E01"],
      },
      providerAheadEpisodeMapping: {},
      rejectedCandidateIds: [],
      confidence: "high",
      reason: "Selected fake candidate",
    },
  ];
  const transferAttempts: TransferAttempt[] = [
    {
      id: "transfer_1",
      workflowRunId: workflowRun.id,
      candidateId: "snapshot_1_candidate_1",
      status: "succeeded",
      providerMessage: "",
      materializedFileIds: ["file_1"],
    },
  ];
  const notifications: NotificationEvent[] = [
    {
      id: "notification_1",
      workflowRunId: workflowRun.id,
      kind: "tracking_initialized",
      title: "Show tracking initialized",
      body: "1 episodes obtained",
      createdAt: "2026-06-11T00:01:00.000Z",
    },
  ];

  return {
    title,
    season,
    workflowRun,
    episodes,
    resourceSnapshots,
    decisions,
    transferAttempts,
    notifications,
    ...overrides,
  };
}

describe("app settings", () => {
  it("round-trips settings in sqlite and in-memory repositories", async () => {
    const { SQLiteWorkflowRepository, InMemoryWorkflowRepository } = await import("../src/index.js");
    const { DatabaseSync } = await import("node:sqlite");
    for (const repository of [
      new SQLiteWorkflowRepository(new DatabaseSync(":memory:")),
      new InMemoryWorkflowRepository(),
    ]) {
      expect(await repository.getSetting("pan115.cookie")).toBeNull();
      await repository.setSetting("pan115.cookie", "UID=a; CID=b; SEID=c");
      expect(await repository.getSetting("pan115.cookie")).toBe("UID=a; CID=b; SEID=c");
      await repository.setSetting("pan115.cookie", "UID=new");
      expect(await repository.getSetting("pan115.cookie")).toBe("UID=new");
    }
  });
});
