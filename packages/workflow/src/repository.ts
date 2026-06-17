import type {
  AgentDecision,
  EpisodeState,
  MediaTitle,
  NotificationEvent,
  ResourceSnapshot,
  TrackedSeason,
  TransferAttempt,
  WorkflowKind,
  WorkflowRun,
  WorkflowRunProgress,
  WorkflowStatus,
} from "./domain.js";
import { MAGNET_DEAD_LINK_TTL_MS } from "./acquisition-v2/dead-links.js";
import type { DeadLink, DeadLinkStore } from "./acquisition-v2/dead-links.js";

export interface PersistWorkflowRunSnapshotInput {
  title: MediaTitle;
  season: TrackedSeason;
  workflowRun: WorkflowRun;
  episodes: EpisodeState[];
  resourceSnapshots: ResourceSnapshot[];
  decisions: AgentDecision[];
  transferAttempts: TransferAttempt[];
  notifications: NotificationEvent[];
}

export interface PersistedWorkflowRunSnapshot extends PersistWorkflowRunSnapshotInput {
  obtainedEpisodes: string[];
  providerAheadEpisodes: string[];
}

export interface TrackedSeasonState {
  title: MediaTitle;
  season: TrackedSeason;
  episodes: EpisodeState[];
}

export interface ReserveWorkflowRunInput extends PersistWorkflowRunSnapshotInput {
  blockIfEpisodeStatesExist?: boolean;
  /**
   * Title-level mutual exclusion: refuse the reservation if ANY run for the
   * same media title is already active, regardless of season or kind. All
   * seasons of a title share one `Title (Year)/` show directory and staging
   * parent, so two concurrent acquisition runs would race on directory
   * creation, staging, and dedup. User-triggered acquisitions set this so a
   * user clicking "get S1", "get S2", "get S3" in quick succession can never
   * spawn overlapping writers on the same title.
   */
  blockIfTitleHasActiveRun?: boolean;
  staleActiveRunStartedBefore?: string;
  staleFinishedAt?: string;
}

export type WorkflowRunReservationResult =
  | {
      status: "reserved";
      snapshot: PersistedWorkflowRunSnapshot;
    }
  | {
      status: "already_active";
      snapshot: PersistedWorkflowRunSnapshot;
    }
  | {
      status: "already_has_episode_state";
      episodes: EpisodeState[];
    };

export interface WorkflowRepository extends DeadLinkStore {
  saveWorkflowRunSnapshot(input: PersistWorkflowRunSnapshotInput): Promise<void>;
  reserveWorkflowRun(input: ReserveWorkflowRunInput): Promise<WorkflowRunReservationResult>;
  getWorkflowRunSnapshot(workflowRunId: string): Promise<PersistedWorkflowRunSnapshot | null>;
  claimNextQueuedWorkflowRun(input: {
    kind: WorkflowKind;
    now: string;
  }): Promise<PersistedWorkflowRunSnapshot | null>;
  /**
   * Reset every "running" workflow run back to "queued". For the single-instance
   * in-process worker this is crash recovery: only that worker executes runs, so
   * any run still "running" when the process (re)starts is orphaned by a dead
   * worker and must be re-claimed, not left stuck forever. Returns how many were
   * requeued.
   */
  requeueRunningWorkflowRuns(): Promise<number>;
  findActiveWorkflowRun(input: {
    trackedSeasonId: string;
    kind: WorkflowKind;
  }): Promise<PersistedWorkflowRunSnapshot | null>;
  /** Every queued/running run, newest first — drives the library "获取中" placeholders. */
  listActiveWorkflowRuns(): Promise<PersistedWorkflowRunSnapshot[]>;
  /** Lightweight mid-run update of the live agent progress shown on the activity
   *  page; `percent` is clamped monotonic so retries never rewind the bar. No-op
   *  for an unknown run. */
  updateWorkflowRunProgress(workflowRunId: string, progress: WorkflowRunProgress): Promise<void>;
  getTrackedSeasonState(trackedSeasonId: string): Promise<TrackedSeasonState | null>;
  listTrackedSeasonStates(): Promise<TrackedSeasonState[]>;
  listEpisodeStates(trackedSeasonId: string): Promise<EpisodeState[]>;
  /** Most-recent-first notification feed across all workflow runs. */
  listNotifications(input?: { limit?: number }): Promise<NotificationEvent[]>;
  /** Generic app settings (e.g. the 115 cookie obtained via QR login). */
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  // recordDeadLink + listDeadLinkKeys come from DeadLinkStore.
}

export class InMemoryWorkflowRepository implements WorkflowRepository {
  private readonly workflowRuns = new Map<string, PersistWorkflowRunSnapshotInput>();
  private readonly episodesBySeason = new Map<string, EpisodeState[]>();
  private readonly settings = new Map<string, string>();
  private readonly deadLinks = new Map<string, DeadLink>();

  async getSetting(key: string): Promise<string | null> {
    return this.settings.get(key) ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.settings.set(key, value);
  }

  async recordDeadLink(input: {
    key: string;
    kind: DeadLink["kind"];
    reason: string;
    permanent: boolean;
    ttlMs?: number;
    now?: string;
  }): Promise<void> {
    // Idempotent: keep the first record (when it was first proven dead).
    if (this.deadLinks.has(input.key)) {
      return;
    }
    const recordedAt = input.now ?? new Date().toISOString();
    this.deadLinks.set(input.key, {
      key: input.key,
      kind: input.kind,
      reason: input.reason,
      permanent: input.permanent,
      recordedAt,
      expiresAt: input.permanent
        ? null
        : new Date(new Date(recordedAt).getTime() + (input.ttlMs ?? MAGNET_DEAD_LINK_TTL_MS)).toISOString(),
    });
  }

  async listDeadLinkKeys(options?: { now?: string }): Promise<string[]> {
    const now = options?.now ?? new Date().toISOString();
    return [...this.deadLinks.values()]
      .filter((link) => link.expiresAt === null || link.expiresAt > now)
      .map((link) => link.key);
  }

  async saveWorkflowRunSnapshot(input: PersistWorkflowRunSnapshotInput): Promise<void> {
    validateWorkflowRunSnapshot(input);

    const cloned = cloneWorkflowValue(input);
    this.workflowRuns.set(cloned.workflowRun.id, cloned);
    this.episodesBySeason.set(cloned.season.id, cloneWorkflowValue(cloned.episodes));
  }

  async reserveWorkflowRun(input: ReserveWorkflowRunInput): Promise<WorkflowRunReservationResult> {
    const snapshot = workflowSnapshotFromReservation(input);
    validateWorkflowRunSnapshot(snapshot);
    this.expireStaleActiveWorkflowRuns(input);

    if (input.blockIfTitleHasActiveRun === true) {
      const titleActive = Array.from(this.workflowRuns.values())
        .filter(
          (stored) =>
            stored.season.mediaTitleId === snapshot.season.mediaTitleId &&
            isActiveWorkflowStatus(stored.workflowRun.status),
        )
        .sort((a, b) => b.workflowRun.startedAt.localeCompare(a.workflowRun.startedAt))[0];
      if (titleActive) {
        return {
          status: "already_active",
          snapshot: withDerivedEpisodeSummaries(cloneWorkflowValue(titleActive)),
        };
      }
    }

    const activeRun = await this.findActiveWorkflowRun({
      trackedSeasonId: snapshot.season.id,
      kind: snapshot.workflowRun.kind,
    });
    if (activeRun) {
      return {
        status: "already_active",
        snapshot: activeRun,
      };
    }

    const existingEpisodes = this.episodesBySeason.get(snapshot.season.id) ?? [];
    if (input.blockIfEpisodeStatesExist === true && existingEpisodes.length > 0) {
      return {
        status: "already_has_episode_state",
        episodes: cloneWorkflowValue(existingEpisodes),
      };
    }

    const cloned = cloneWorkflowValue(snapshot);
    this.workflowRuns.set(cloned.workflowRun.id, cloned);
    this.episodesBySeason.set(cloned.season.id, cloneWorkflowValue(cloned.episodes));

    return {
      status: "reserved",
      snapshot: withDerivedEpisodeSummaries(cloneWorkflowValue(cloned)),
    };
  }

  async getWorkflowRunSnapshot(workflowRunId: string): Promise<PersistedWorkflowRunSnapshot | null> {
    const stored = this.workflowRuns.get(workflowRunId);
    if (!stored) {
      return null;
    }

    return withDerivedEpisodeSummaries(cloneWorkflowValue(stored));
  }

  async claimNextQueuedWorkflowRun(input: {
    kind: WorkflowKind;
    now: string;
  }): Promise<PersistedWorkflowRunSnapshot | null> {
    const queuedRun = Array.from(this.workflowRuns.values())
      .filter((snapshot) => snapshot.workflowRun.kind === input.kind && snapshot.workflowRun.status === "queued")
      .sort((a, b) => a.workflowRun.startedAt.localeCompare(b.workflowRun.startedAt))[0];
    if (!queuedRun) {
      return null;
    }

    const claimed = cloneWorkflowValue({
      ...queuedRun,
      workflowRun: claimWorkflowRun(queuedRun.workflowRun, input.now),
    });
    this.workflowRuns.set(claimed.workflowRun.id, claimed);

    return withDerivedEpisodeSummaries(cloneWorkflowValue(claimed));
  }

  async requeueRunningWorkflowRuns(): Promise<number> {
    let requeued = 0;
    for (const [id, snapshot] of this.workflowRuns) {
      if (snapshot.workflowRun.status !== "running") {
        continue;
      }
      this.workflowRuns.set(id, {
        ...snapshot,
        workflowRun: { ...snapshot.workflowRun, status: "queued", finishedAt: null },
      });
      requeued += 1;
    }
    return requeued;
  }

  async findActiveWorkflowRun(input: {
    trackedSeasonId: string;
    kind: WorkflowKind;
  }): Promise<PersistedWorkflowRunSnapshot | null> {
    const activeRuns = Array.from(this.workflowRuns.values())
      .filter(
        (snapshot) =>
          snapshot.workflowRun.trackedSeasonId === input.trackedSeasonId &&
          snapshot.workflowRun.kind === input.kind &&
          isActiveWorkflowStatus(snapshot.workflowRun.status),
      )
      .sort((a, b) => b.workflowRun.startedAt.localeCompare(a.workflowRun.startedAt));
    const latest = activeRuns[0];
    return latest ? withDerivedEpisodeSummaries(cloneWorkflowValue(latest)) : null;
  }

  async listActiveWorkflowRuns(): Promise<PersistedWorkflowRunSnapshot[]> {
    return Array.from(this.workflowRuns.values())
      .filter((snapshot) => isActiveWorkflowStatus(snapshot.workflowRun.status))
      .sort((a, b) => b.workflowRun.startedAt.localeCompare(a.workflowRun.startedAt))
      .map((snapshot) => withDerivedEpisodeSummaries(cloneWorkflowValue(snapshot)));
  }

  async updateWorkflowRunProgress(workflowRunId: string, progress: WorkflowRunProgress): Promise<void> {
    const stored = this.workflowRuns.get(workflowRunId);
    if (!stored) {
      return;
    }
    const previousPercent = stored.workflowRun.progress?.percent ?? 0;
    this.workflowRuns.set(workflowRunId, {
      ...stored,
      workflowRun: {
        ...stored.workflowRun,
        progress: { ...progress, percent: Math.max(previousPercent, progress.percent) },
      },
    });
  }

  async getTrackedSeasonState(trackedSeasonId: string): Promise<TrackedSeasonState | null> {
    const latestSnapshot = Array.from(this.workflowRuns.values())
      .filter((snapshot) => snapshot.season.id === trackedSeasonId)
      .sort((a, b) => b.workflowRun.startedAt.localeCompare(a.workflowRun.startedAt))[0];
    if (!latestSnapshot) {
      return null;
    }

    return cloneWorkflowValue({
      title: latestSnapshot.title,
      season: latestSnapshot.season,
      episodes: this.episodesBySeason.get(trackedSeasonId) ?? latestSnapshot.episodes,
    });
  }

  async listTrackedSeasonStates(): Promise<TrackedSeasonState[]> {
    const latestBySeason = new Map<string, PersistWorkflowRunSnapshotInput>();
    const snapshots = Array.from(this.workflowRuns.values()).sort((a, b) =>
      b.workflowRun.startedAt.localeCompare(a.workflowRun.startedAt),
    );
    for (const snapshot of snapshots) {
      if (!latestBySeason.has(snapshot.season.id)) {
        latestBySeason.set(snapshot.season.id, snapshot);
      }
    }

    return Array.from(latestBySeason.values())
      .map((snapshot) =>
        cloneWorkflowValue({
          title: snapshot.title,
          season: snapshot.season,
          episodes: this.episodesBySeason.get(snapshot.season.id) ?? snapshot.episodes,
        }),
      )
      .sort(compareTrackedSeasonStates);
  }

  async listEpisodeStates(trackedSeasonId: string): Promise<EpisodeState[]> {
    return cloneWorkflowValue(this.episodesBySeason.get(trackedSeasonId) ?? []);
  }

  async listNotifications(input?: { limit?: number }): Promise<NotificationEvent[]> {
    const all = [...this.workflowRuns.values()].flatMap((snapshot) =>
      snapshot.notifications.map((notification) => ({ ...notification })),
    );
    all.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return all.slice(0, input?.limit ?? 100);
  }

  private expireStaleActiveWorkflowRuns(input: ReserveWorkflowRunInput): void {
    if (!input.staleActiveRunStartedBefore) {
      return;
    }
    const reservationSnapshot = workflowSnapshotFromReservation(input);
    const staleRuns = Array.from(this.workflowRuns.values()).filter(
      (stored) =>
        stored.workflowRun.trackedSeasonId === reservationSnapshot.season.id &&
        stored.workflowRun.kind === reservationSnapshot.workflowRun.kind &&
        isActiveWorkflowStatus(stored.workflowRun.status) &&
        stored.workflowRun.startedAt < input.staleActiveRunStartedBefore!,
    );

    for (const staleRun of staleRuns) {
      const expired = cloneWorkflowValue({
        ...staleRun,
        workflowRun: expireWorkflowRun(
          staleRun.workflowRun,
          input.staleFinishedAt ?? reservationSnapshot.workflowRun.startedAt,
        ),
        episodes: [],
      });
      this.workflowRuns.set(expired.workflowRun.id, expired);
      this.episodesBySeason.set(expired.season.id, []);
    }
  }
}

export function validateWorkflowRunSnapshot(input: PersistWorkflowRunSnapshotInput): void {
  if (input.season.mediaTitleId !== input.title.id) {
    throw new Error("Tracked season does not belong to media title");
  }
  if (input.workflowRun.trackedSeasonId !== input.season.id) {
    throw new Error("Workflow run does not belong to tracked season");
  }

  for (const episode of input.episodes) {
    if (episode.trackedSeasonId !== input.season.id) {
      throw new Error(`Episode ${episode.episodeCode} does not belong to tracked season`);
    }
  }

  for (const transferAttempt of input.transferAttempts) {
    if (transferAttempt.workflowRunId !== input.workflowRun.id) {
      throw new Error(`Transfer attempt ${transferAttempt.id} does not belong to workflow run`);
    }
  }

  for (const notification of input.notifications) {
    if (notification.workflowRunId !== input.workflowRun.id) {
      throw new Error(`Notification ${notification.id} does not belong to workflow run`);
    }
  }

  const candidateIdsBySnapshot = new Map<string, Set<string>>();
  const allCandidateIds = new Set<string>();
  for (const snapshot of input.resourceSnapshots) {
    const snapshotCandidateIds = new Set<string>();
    for (const candidate of snapshot.candidates) {
      if (candidate.snapshotId !== snapshot.id) {
        throw new Error(`Resource candidate ${candidate.id} does not belong to snapshot ${snapshot.id}`);
      }
      snapshotCandidateIds.add(candidate.id);
      allCandidateIds.add(candidate.id);
    }
    candidateIdsBySnapshot.set(snapshot.id, snapshotCandidateIds);
  }

  for (const decision of input.decisions) {
    const candidateIds = candidateIdsBySnapshot.get(decision.snapshotId);
    if (!candidateIds) {
      throw new Error(`Agent decision referenced unknown resource snapshot ${decision.snapshotId}`);
    }

    const decisionCandidateIds = [
      ...decision.selectedCandidateIds,
      ...decision.rejectedCandidateIds,
      ...Object.keys(decision.episodeMapping),
      ...Object.keys(decision.providerAheadEpisodeMapping),
    ];
    if (decisionCandidateIds.some((candidateId) => !candidateIds.has(candidateId))) {
      throw new Error("Agent decision referenced candidates outside persisted resource snapshots");
    }
  }

  for (const transferAttempt of input.transferAttempts) {
    if (!allCandidateIds.has(transferAttempt.candidateId)) {
      throw new Error(`Transfer attempt ${transferAttempt.id} referenced an unknown candidate`);
    }
  }
}

export function withDerivedEpisodeSummaries(input: PersistWorkflowRunSnapshotInput): PersistedWorkflowRunSnapshot {
  return {
    ...input,
    obtainedEpisodes: input.episodes
      .filter((episode) => episode.obtained)
      .map((episode) => episode.episodeCode),
    providerAheadEpisodes: input.episodes
      .filter((episode) => episode.obtained && episode.metadataStatus === "provider_ahead")
      .map((episode) => episode.episodeCode),
  };
}

export function cloneWorkflowValue<T>(value: T): T {
  return structuredClone(value);
}

export function isActiveWorkflowStatus(status: WorkflowStatus): boolean {
  return status === "queued" || status === "running";
}

export function workflowSnapshotFromReservation(input: ReserveWorkflowRunInput): PersistWorkflowRunSnapshotInput {
  const {
    blockIfEpisodeStatesExist: _blockIfEpisodeStatesExist,
    staleActiveRunStartedBefore: _staleActiveRunStartedBefore,
    staleFinishedAt: _staleFinishedAt,
    ...snapshot
  } = input;
  return snapshot;
}

export function expireWorkflowRun(workflowRun: WorkflowRun, finishedAt: string): WorkflowRun {
  return {
    ...workflowRun,
    status: "failed",
    finishedAt,
    auditEvents: [
      ...workflowRun.auditEvents,
      {
        type: "workflow_expired",
        message: `Expired stale active workflow run ${workflowRun.id}`,
      },
    ],
  };
}

export function claimWorkflowRun(workflowRun: WorkflowRun, claimedAt: string): WorkflowRun {
  return {
    ...workflowRun,
    status: "running",
    finishedAt: null,
    auditEvents: [
      ...workflowRun.auditEvents,
      {
        type: "workflow_claimed",
        message: `Claimed queued workflow run ${workflowRun.id}`,
        data: { claimedAt },
      },
    ],
  };
}

export function compareTrackedSeasonStates(a: TrackedSeasonState, b: TrackedSeasonState): number {
  return (
    a.title.title.localeCompare(b.title.title) ||
    a.season.seasonNumber - b.season.seasonNumber ||
    a.season.id.localeCompare(b.season.id)
  );
}
