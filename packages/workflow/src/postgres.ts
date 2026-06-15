import pg from "pg";
import type { Pool, PoolClient } from "pg";
import {
  episodeNumberFromCode,
  type AgentDecision,
  type EpisodeState,
  type MediaTitle,
  type NotificationEvent,
  type ResourceSnapshot,
  type TrackedSeason,
  type TransferAttempt,
  type WorkflowKind,
  type WorkflowRun,
} from "./domain.js";
import {
  claimWorkflowRun,
  cloneWorkflowValue,
  compareTrackedSeasonStates,
  expireWorkflowRun,
  isActiveWorkflowStatus,
  type PersistedWorkflowRunSnapshot,
  type PersistWorkflowRunSnapshotInput,
  type ReserveWorkflowRunInput,
  type TrackedSeasonState,
  validateWorkflowRunSnapshot,
  withDerivedEpisodeSummaries,
  workflowSnapshotFromReservation,
  type WorkflowRunReservationResult,
  type WorkflowRepository,
} from "./repository.js";

type Queryable = Pool | PoolClient;

// Same coherent model as the SQLite repo: each table is id (+ scope cols) plus a
// jsonb `payload` holding the domain object. node-postgres returns jsonb columns
// already parsed, and `$n::jsonb` casts a JSON.stringify'd text param on insert.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS media_titles (
    id text PRIMARY KEY,
    payload jsonb NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tracked_seasons (
    id text PRIMARY KEY,
    media_title_id text NOT NULL,
    payload jsonb NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workflow_runs (
    id text PRIMARY KEY,
    tracked_season_id text NOT NULL,
    payload jsonb NOT NULL
  );
  CREATE TABLE IF NOT EXISTS episode_states (
    tracked_season_id text NOT NULL,
    episode_code text NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (tracked_season_id, episode_code)
  );
  CREATE TABLE IF NOT EXISTS resource_snapshots (
    id text PRIMARY KEY,
    workflow_run_id text NOT NULL,
    ordinal int NOT NULL,
    payload jsonb NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_decisions (
    workflow_run_id text NOT NULL,
    ordinal int NOT NULL,
    snapshot_id text NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (workflow_run_id, ordinal)
  );
  CREATE TABLE IF NOT EXISTS transfer_attempts (
    id text PRIMARY KEY,
    workflow_run_id text NOT NULL,
    ordinal int NOT NULL,
    candidate_id text NOT NULL,
    payload jsonb NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id text PRIMARY KEY,
    workflow_run_id text NOT NULL,
    ordinal int NOT NULL,
    payload jsonb NOT NULL
  );
  CREATE TABLE IF NOT EXISTS app_settings (
    key text PRIMARY KEY,
    value text NOT NULL
  );
`;

export async function initializeWorkflowPostgresSchema(pool: Pool): Promise<void> {
  await pool.query(SCHEMA);
}

export async function createPostgresWorkflowRepository(options: {
  connectionString: string;
}): Promise<PostgresWorkflowRepository> {
  const pool = new pg.Pool({ connectionString: options.connectionString });
  await initializeWorkflowPostgresSchema(pool);
  return new PostgresWorkflowRepository(pool, Promise.resolve());
}

/**
 * Synchronous construction for callers that can't await (e.g. the web app's
 * cached `getWorkflowRepository()` getter). The schema is created lazily on
 * first use.
 */
export function createPostgresWorkflowRepositorySync(options: {
  connectionString: string;
}): PostgresWorkflowRepository {
  return new PostgresWorkflowRepository(new pg.Pool({ connectionString: options.connectionString }));
}

export class PostgresWorkflowRepository implements WorkflowRepository {
  private schemaReady: Promise<void> | undefined;

  constructor(
    private readonly pool: Pool,
    alreadyInitialized?: Promise<void>,
  ) {
    this.schemaReady = alreadyInitialized;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Create the schema once, memoized — lets the repo be constructed without
   *  awaiting yet still self-initialize on first query. */
  private ensureSchema(): Promise<void> {
    return (this.schemaReady ??= initializeWorkflowPostgresSchema(this.pool));
  }

  async saveWorkflowRunSnapshot(input: PersistWorkflowRunSnapshotInput): Promise<void> {
    validateWorkflowRunSnapshot(input);
    const snapshot = cloneWorkflowValue(input);
    await this.withTransaction((client) => this.replaceWorkflowRunSnapshot(client, snapshot));
  }

  async reserveWorkflowRun(input: ReserveWorkflowRunInput): Promise<WorkflowRunReservationResult> {
    const snapshot = cloneWorkflowValue(workflowSnapshotFromReservation(input));
    validateWorkflowRunSnapshot(snapshot);

    return this.withTransaction(async (client) => {
      await this.expireStaleActiveWorkflowRuns(client, input);

      if (input.blockIfTitleHasActiveRun === true) {
        const titleActive = (await this.selectWorkflowRunsForTitle(client, snapshot.season.mediaTitleId))
          .filter((workflowRun) => isActiveWorkflowStatus(workflowRun.status))
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
        if (titleActive) {
          const activeSnapshot = await this.loadWorkflowRunSnapshot(client, titleActive.id);
          if (!activeSnapshot) {
            throw new Error(`Missing active workflow run ${titleActive.id}`);
          }
          return { status: "already_active", snapshot: activeSnapshot };
        }
      }

      const activeRun = (await this.selectWorkflowRuns(client, snapshot.season.id))
        .filter(
          (workflowRun) =>
            workflowRun.kind === snapshot.workflowRun.kind && isActiveWorkflowStatus(workflowRun.status),
        )
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
      if (activeRun) {
        const activeSnapshot = await this.loadWorkflowRunSnapshot(client, activeRun.id);
        if (!activeSnapshot) {
          throw new Error(`Missing active workflow run ${activeRun.id}`);
        }
        return { status: "already_active", snapshot: activeSnapshot };
      }

      const existingEpisodes = await this.selectEpisodeStates(client, snapshot.season.id);
      if (input.blockIfEpisodeStatesExist === true && existingEpisodes.length > 0) {
        return { status: "already_has_episode_state", episodes: existingEpisodes };
      }

      await this.replaceWorkflowRunSnapshot(client, snapshot);
      return {
        status: "reserved",
        snapshot: withDerivedEpisodeSummaries(cloneWorkflowValue(snapshot)),
      };
    });
  }

  async getWorkflowRunSnapshot(workflowRunId: string): Promise<PersistedWorkflowRunSnapshot | null> {
    return this.loadWorkflowRunSnapshot(this.pool, workflowRunId);
  }

  async claimNextQueuedWorkflowRun(input: {
    kind: WorkflowKind;
    now: string;
  }): Promise<PersistedWorkflowRunSnapshot | null> {
    const claimedRunId = await this.withTransaction(async (client) => {
      const queuedRun = (await this.allWorkflowRuns(client))
        .filter((workflowRun) => workflowRun.kind === input.kind && workflowRun.status === "queued")
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
      if (!queuedRun) {
        return null;
      }
      const claimedRun = claimWorkflowRun(queuedRun, input.now);
      await this.upsertWorkflowRun(client, claimedRun);
      return claimedRun.id;
    });
    return claimedRunId ? this.getWorkflowRunSnapshot(claimedRunId) : null;
  }

  async requeueRunningWorkflowRuns(): Promise<number> {
    return this.withTransaction(async (client) => {
      const running = (await this.allWorkflowRuns(client)).filter(
        (workflowRun) => workflowRun.status === "running",
      );
      for (const workflowRun of running) {
        await this.upsertWorkflowRun(client, { ...workflowRun, status: "queued", finishedAt: null });
      }
      return running.length;
    });
  }

  async findActiveWorkflowRun(input: {
    trackedSeasonId: string;
    kind: WorkflowKind;
  }): Promise<PersistedWorkflowRunSnapshot | null> {
    const latest = (await this.selectWorkflowRuns(this.pool, input.trackedSeasonId))
      .filter((workflowRun) => workflowRun.kind === input.kind && isActiveWorkflowStatus(workflowRun.status))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    return latest ? this.getWorkflowRunSnapshot(latest.id) : null;
  }

  async listActiveWorkflowRuns(): Promise<PersistedWorkflowRunSnapshot[]> {
    const runs = (await this.allWorkflowRuns(this.pool))
      .filter((workflowRun) => isActiveWorkflowStatus(workflowRun.status))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const snapshots: PersistedWorkflowRunSnapshot[] = [];
    for (const run of runs) {
      try {
        const snapshot = await this.getWorkflowRunSnapshot(run.id);
        if (snapshot) {
          snapshots.push(snapshot);
        }
      } catch {
        // Orphaned/inconsistent run — skip rather than crash callers.
      }
    }
    return snapshots;
  }

  async getTrackedSeasonState(trackedSeasonId: string): Promise<TrackedSeasonState | null> {
    const season = await this.selectOne<TrackedSeason>(
      this.pool,
      "SELECT payload FROM tracked_seasons WHERE id = $1",
      [trackedSeasonId],
    );
    if (!season) {
      return null;
    }
    const title = await this.requireTitle(this.pool, season);
    return { title, season, episodes: await this.selectEpisodeStates(this.pool, season.id) };
  }

  async listTrackedSeasonStates(): Promise<TrackedSeasonState[]> {
    const seasons = await this.selectMany<TrackedSeason>(this.pool, "SELECT payload FROM tracked_seasons", []);
    const states: TrackedSeasonState[] = [];
    for (const season of seasons) {
      states.push({
        title: await this.requireTitle(this.pool, season),
        season,
        episodes: await this.selectEpisodeStates(this.pool, season.id),
      });
    }
    return states.sort(compareTrackedSeasonStates);
  }

  async listEpisodeStates(trackedSeasonId: string): Promise<EpisodeState[]> {
    return this.selectEpisodeStates(this.pool, trackedSeasonId);
  }

  async listNotifications(input?: { limit?: number }): Promise<NotificationEvent[]> {
    const all = await this.selectMany<NotificationEvent>(this.pool, "SELECT payload FROM notifications", []);
    all.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return all.slice(0, input?.limit ?? 100);
  }

  async getSetting(key: string): Promise<string | null> {
    await this.ensureSchema();
    const result = await this.pool.query("SELECT value FROM app_settings WHERE key = $1", [key]);
    return result.rows[0]?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      "INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [key, value],
    );
  }

  // ---- private ----

  private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadWorkflowRunSnapshot(
    executor: Queryable,
    workflowRunId: string,
  ): Promise<PersistedWorkflowRunSnapshot | null> {
    const workflowRun = await this.selectOne<WorkflowRun>(
      executor,
      "SELECT payload FROM workflow_runs WHERE id = $1",
      [workflowRunId],
    );
    if (!workflowRun) {
      return null;
    }
    const season = await this.selectOne<TrackedSeason>(
      executor,
      "SELECT payload FROM tracked_seasons WHERE id = $1",
      [workflowRun.trackedSeasonId],
    );
    if (!season) {
      throw new Error(`Missing tracked season ${workflowRun.trackedSeasonId} for workflow run ${workflowRun.id}`);
    }
    const title = await this.requireTitle(executor, season);
    return withDerivedEpisodeSummaries({
      title,
      season,
      workflowRun,
      episodes: await this.selectEpisodeStates(executor, season.id),
      resourceSnapshots: await this.selectMany<ResourceSnapshot>(
        executor,
        "SELECT payload FROM resource_snapshots WHERE workflow_run_id = $1 ORDER BY ordinal",
        [workflowRun.id],
      ),
      decisions: await this.selectMany<AgentDecision>(
        executor,
        "SELECT payload FROM agent_decisions WHERE workflow_run_id = $1 ORDER BY ordinal",
        [workflowRun.id],
      ),
      transferAttempts: await this.selectMany<TransferAttempt>(
        executor,
        "SELECT payload FROM transfer_attempts WHERE workflow_run_id = $1 ORDER BY ordinal",
        [workflowRun.id],
      ),
      notifications: await this.selectMany<NotificationEvent>(
        executor,
        "SELECT payload FROM notifications WHERE workflow_run_id = $1 ORDER BY ordinal",
        [workflowRun.id],
      ),
    });
  }

  private async replaceWorkflowRunSnapshot(
    client: PoolClient,
    snapshot: PersistWorkflowRunSnapshotInput,
  ): Promise<void> {
    await this.upsert(client, "media_titles", "(id, payload)", [snapshot.title.id, json(snapshot.title)], "$1, $2::jsonb");
    await this.upsertTrackedSeason(client, snapshot.season);
    await this.upsertWorkflowRun(client, snapshot.workflowRun);
    await this.deleteWorkflowRunChildren(client, snapshot.workflowRun.id, snapshot.season.id);

    for (const [ordinal, episode] of snapshot.episodes.entries()) {
      void ordinal;
      await client.query(
        "INSERT INTO episode_states (tracked_season_id, episode_code, payload) VALUES ($1, $2, $3::jsonb)",
        [snapshot.season.id, episode.episodeCode, json(episode)],
      );
    }
    // Snapshot ids are content-addressed and can legitimately recur; keep
    // persistence idempotent on the id instead of crashing on a duplicate.
    for (const [ordinal, resourceSnapshot] of snapshot.resourceSnapshots.entries()) {
      await client.query(
        "INSERT INTO resource_snapshots (id, workflow_run_id, ordinal, payload) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (id) DO NOTHING",
        [resourceSnapshot.id, snapshot.workflowRun.id, ordinal, json(resourceSnapshot)],
      );
    }
    for (const [ordinal, decision] of snapshot.decisions.entries()) {
      await client.query(
        "INSERT INTO agent_decisions (workflow_run_id, ordinal, snapshot_id, payload) VALUES ($1, $2, $3, $4::jsonb)",
        [snapshot.workflowRun.id, ordinal, decision.snapshotId, json(decision)],
      );
    }
    for (const [ordinal, attempt] of snapshot.transferAttempts.entries()) {
      await client.query(
        "INSERT INTO transfer_attempts (id, workflow_run_id, ordinal, candidate_id, payload) VALUES ($1, $2, $3, $4, $5::jsonb)",
        [attempt.id, snapshot.workflowRun.id, ordinal, attempt.candidateId, json(attempt)],
      );
    }
    for (const [ordinal, notification] of snapshot.notifications.entries()) {
      await client.query(
        "INSERT INTO notifications (id, workflow_run_id, ordinal, payload) VALUES ($1, $2, $3, $4::jsonb)",
        [notification.id, snapshot.workflowRun.id, ordinal, json(notification)],
      );
    }
  }

  private async upsertTrackedSeason(client: PoolClient, season: TrackedSeason): Promise<void> {
    await client.query(
      "INSERT INTO tracked_seasons (id, media_title_id, payload) VALUES ($1, $2, $3::jsonb) " +
        "ON CONFLICT (id) DO UPDATE SET media_title_id = EXCLUDED.media_title_id, payload = EXCLUDED.payload",
      [season.id, season.mediaTitleId, json(season)],
    );
  }

  private async upsertWorkflowRun(client: PoolClient, workflowRun: WorkflowRun): Promise<void> {
    await client.query(
      "INSERT INTO workflow_runs (id, tracked_season_id, payload) VALUES ($1, $2, $3::jsonb) " +
        "ON CONFLICT (id) DO UPDATE SET tracked_season_id = EXCLUDED.tracked_season_id, payload = EXCLUDED.payload",
      [workflowRun.id, workflowRun.trackedSeasonId, json(workflowRun)],
    );
  }

  private async upsert(
    client: PoolClient,
    table: string,
    columns: string,
    params: unknown[],
    placeholders: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO ${table} ${columns} VALUES (${placeholders}) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload`,
      params,
    );
  }

  private async deleteWorkflowRunChildren(
    client: PoolClient,
    workflowRunId: string,
    trackedSeasonId: string,
  ): Promise<void> {
    await client.query("DELETE FROM notifications WHERE workflow_run_id = $1", [workflowRunId]);
    await client.query("DELETE FROM transfer_attempts WHERE workflow_run_id = $1", [workflowRunId]);
    await client.query("DELETE FROM agent_decisions WHERE workflow_run_id = $1", [workflowRunId]);
    await client.query("DELETE FROM resource_snapshots WHERE workflow_run_id = $1", [workflowRunId]);
    await client.query("DELETE FROM episode_states WHERE tracked_season_id = $1", [trackedSeasonId]);
  }

  private async expireStaleActiveWorkflowRuns(
    client: PoolClient,
    input: ReserveWorkflowRunInput,
  ): Promise<void> {
    if (!input.staleActiveRunStartedBefore) {
      return;
    }
    const snapshot = workflowSnapshotFromReservation(input);
    const staleRuns = (await this.selectWorkflowRuns(client, snapshot.season.id)).filter(
      (workflowRun) =>
        workflowRun.kind === snapshot.workflowRun.kind &&
        isActiveWorkflowStatus(workflowRun.status) &&
        workflowRun.startedAt < input.staleActiveRunStartedBefore!,
    );
    for (const staleRun of staleRuns) {
      const expiredRun = expireWorkflowRun(staleRun, input.staleFinishedAt ?? snapshot.workflowRun.startedAt);
      await this.upsertWorkflowRun(client, expiredRun);
      await client.query("DELETE FROM episode_states WHERE tracked_season_id = $1", [snapshot.season.id]);
    }
  }

  private async requireTitle(executor: Queryable, season: TrackedSeason): Promise<MediaTitle> {
    const title = await this.selectOne<MediaTitle>(
      executor,
      "SELECT payload FROM media_titles WHERE id = $1",
      [season.mediaTitleId],
    );
    if (!title) {
      throw new Error(`Missing media title ${season.mediaTitleId} for tracked season ${season.id}`);
    }
    return title;
  }

  private async selectEpisodeStates(executor: Queryable, trackedSeasonId: string): Promise<EpisodeState[]> {
    const episodes = await this.selectMany<EpisodeState>(
      executor,
      "SELECT payload FROM episode_states WHERE tracked_season_id = $1",
      [trackedSeasonId],
    );
    return episodes.sort((a, b) => episodeNumberFromCode(a.episodeCode) - episodeNumberFromCode(b.episodeCode));
  }

  private async selectWorkflowRuns(executor: Queryable, trackedSeasonId: string): Promise<WorkflowRun[]> {
    return this.selectMany<WorkflowRun>(
      executor,
      "SELECT payload FROM workflow_runs WHERE tracked_season_id = $1",
      [trackedSeasonId],
    );
  }

  private async selectWorkflowRunsForTitle(executor: Queryable, mediaTitleId: string): Promise<WorkflowRun[]> {
    return this.selectMany<WorkflowRun>(
      executor,
      "SELECT wr.payload AS payload FROM workflow_runs wr " +
        "JOIN tracked_seasons ts ON wr.tracked_season_id = ts.id WHERE ts.media_title_id = $1",
      [mediaTitleId],
    );
  }

  private async allWorkflowRuns(executor: Queryable): Promise<WorkflowRun[]> {
    return this.selectMany<WorkflowRun>(executor, "SELECT payload FROM workflow_runs", []);
  }

  private async selectOne<T>(executor: Queryable, sql: string, params: unknown[]): Promise<T | null> {
    await this.ensureSchema();
    const result = await executor.query(sql, params);
    return (result.rows[0]?.payload as T) ?? null;
  }

  private async selectMany<T>(executor: Queryable, sql: string, params: unknown[]): Promise<T[]> {
    await this.ensureSchema();
    const result = await executor.query(sql, params);
    return result.rows.map((row) => row.payload as T);
  }
}

function json(value: unknown): string {
  return JSON.stringify(value);
}
