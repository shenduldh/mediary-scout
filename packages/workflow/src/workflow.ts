import {
  createEpisodeStates,
  reconcileVerifiedFiles,
  type AgentDecision,
  type AuditEvent,
  type EpisodeState,
  type MediaTitle,
  type NotificationEvent,
  type TrackedSeason,
  type TransferAttempt,
  type WorkflowStatus,
} from "./domain.js";
import type { AgentNodes, ResourceProvider, StorageExecutor } from "./ports.js";

const TYPE2_WORKFLOW_RUN_ID = "run_type2";
const TYPE3_WORKFLOW_RUN_ID = "run_type3";
const FIXED_CREATED_AT = "2026-01-01T00:00:00.000Z";

export interface WorkflowResult {
  status: WorkflowStatus;
  episodes: EpisodeState[];
  obtainedEpisodes: string[];
  transferAttempts: TransferAttempt[];
  decisions: AgentDecision[];
  notification: NotificationEvent;
  notifications: NotificationEvent[];
  auditEvents: AuditEvent[];
}

export async function runType2Initialization(input: {
  title: MediaTitle;
  season: TrackedSeason;
  keyword: string;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  agents: AgentNodes;
}): Promise<WorkflowResult> {
  const episodes = createEpisodeStates({
    trackedSeasonId: input.season.id,
    seasonNumber: input.season.seasonNumber,
    totalEpisodes: input.season.totalEpisodes,
    latestAiredEpisode: input.season.latestAiredEpisode,
  });
  const missingEpisodes = episodes
    .filter((episode) => episode.airStatus === "aired" && !episode.obtained)
    .map((episode) => episode.episodeCode);

  const snapshot = await input.resourceProvider.search({ keyword: input.keyword });
  const auditEvents: AuditEvent[] = [
    {
      type: "resource_snapshot_created",
      message: `Created resource snapshot ${snapshot.id}`,
      data: {
        snapshotId: snapshot.id,
        keyword: snapshot.keyword,
        candidateCount: snapshot.candidates.length,
      },
    },
  ];

  const decision = await input.agents.selectEpisodeCoverage({
    snapshotId: snapshot.id,
    candidates: snapshot.candidates,
    missingEpisodes,
    latestAiredEpisode: input.season.latestAiredEpisode,
  });
  const transferAttempts: TransferAttempt[] = [];
  for (const candidateId of decision.selectedCandidateIds) {
    transferAttempts.push(
      await input.storage.transfer({
        workflowRunId: TYPE2_WORKFLOW_RUN_ID,
        directoryId: input.season.storageDirectoryId,
        candidateId,
      }),
    );
  }

  await input.storage.flattenDirectory(input.season.storageDirectoryId);
  const verifiedFiles = await input.storage.listVideoFiles(input.season.storageDirectoryId);
  const reconciledEpisodes = reconcileVerifiedFiles({
    season: input.season,
    episodes,
    files: verifiedFiles,
  });
  const obtainedEpisodes = reconciledEpisodes
    .filter((episode) => episode.obtained)
    .map((episode) => episode.episodeCode);
  const notification: NotificationEvent = {
    id: "notification_run_type2",
    workflowRunId: TYPE2_WORKFLOW_RUN_ID,
    kind: "tracking_initialized",
    title: `${input.title.title} tracking initialized`,
    body: `${obtainedEpisodes.length} episodes obtained`,
    createdAt: FIXED_CREATED_AT,
  };

  return {
    status: "succeeded",
    episodes: reconciledEpisodes,
    obtainedEpisodes,
    transferAttempts,
    decisions: [decision],
    notification,
    notifications: [notification],
    auditEvents,
  };
}

export async function runType3Monitoring(input: {
  title: MediaTitle;
  season: TrackedSeason;
  episodes: EpisodeState[];
  keyword: string;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  agents: AgentNodes;
}): Promise<WorkflowResult> {
  const auditEvents: AuditEvent[] = [];
  const currentFiles = await input.storage.listVideoFiles(input.season.storageDirectoryId);
  let episodes = reconcileVerifiedFiles({
    season: input.season,
    episodes: input.episodes.map((episode) => {
      const matchingFiles = currentFiles.filter((file) => file.episodeCode === episode.episodeCode);
      return {
        ...episode,
        obtained: matchingFiles.length > 0,
        verifiedFileIds: matchingFiles.map((file) => file.id),
      };
    }),
    files: currentFiles,
  });
  const actionableMissing = episodes
    .filter((episode) => episode.airStatus === "aired" && !episode.obtained)
    .map((episode) => episode.episodeCode);

  if (actionableMissing.length === 0) {
    const notification: NotificationEvent = {
      id: "notification_run_type3_noop",
      workflowRunId: TYPE3_WORKFLOW_RUN_ID,
      kind: "already_current",
      title: `${input.title.title} already current`,
      body: "0 episodes restored",
      createdAt: FIXED_CREATED_AT,
    };
    return {
      status: "succeeded",
      episodes,
      obtainedEpisodes: episodes.filter((episode) => episode.obtained).map((episode) => episode.episodeCode),
      transferAttempts: [],
      decisions: [],
      notification,
      notifications: [notification],
      auditEvents,
    };
  }

  const snapshot = await input.resourceProvider.search({ keyword: input.keyword });
  auditEvents.push({
    type: "resource_snapshot_created",
    message: `Created resource snapshot ${snapshot.id}`,
    data: {
      snapshotId: snapshot.id,
      keyword: snapshot.keyword,
      candidateCount: snapshot.candidates.length,
    },
  });

  const decision = await input.agents.selectEpisodeCoverage({
    snapshotId: snapshot.id,
    candidates: snapshot.candidates,
    missingEpisodes: actionableMissing,
    latestAiredEpisode: input.season.latestAiredEpisode,
  });

  const transferAttempts: TransferAttempt[] = [];
  const restored = new Set<string>();

  for (const candidateId of decision.selectedCandidateIds) {
    transferAttempts.push(
      await input.storage.transfer({
        workflowRunId: TYPE3_WORKFLOW_RUN_ID,
        directoryId: input.season.storageDirectoryId,
        candidateId,
      }),
    );
    addRestoredEpisodes(
      restored,
      actionableMissing,
      await input.storage.listVideoFiles(input.season.storageDirectoryId),
    );
  }

  for (const candidate of snapshot.candidates) {
    const stillMissing = actionableMissing.filter((episodeCode) => !restored.has(episodeCode));
    if (stillMissing.length === 0) {
      break;
    }
    if (
      decision.selectedCandidateIds.includes(candidate.id) ||
      !candidate.episodeHints.some((episodeCode) => stillMissing.includes(episodeCode))
    ) {
      continue;
    }

    transferAttempts.push(
      await input.storage.transfer({
        workflowRunId: TYPE3_WORKFLOW_RUN_ID,
        directoryId: input.season.storageDirectoryId,
        candidateId: candidate.id,
      }),
    );
    addRestoredEpisodes(
      restored,
      actionableMissing,
      await input.storage.listVideoFiles(input.season.storageDirectoryId),
    );
  }

  await input.storage.flattenDirectory(input.season.storageDirectoryId);
  const finalFiles = await input.storage.listVideoFiles(input.season.storageDirectoryId);
  episodes = reconcileVerifiedFiles({
    season: input.season,
    episodes,
    files: finalFiles,
  });
  const obtainedEpisodes = episodes.filter((episode) => episode.obtained).map((episode) => episode.episodeCode);
  const notification: NotificationEvent = {
    id: "notification_run_type3",
    workflowRunId: TYPE3_WORKFLOW_RUN_ID,
    kind: "episodes_restored",
    title: `${input.title.title} episodes restored`,
    body: `${restored.size} episodes restored`,
    createdAt: FIXED_CREATED_AT,
  };

  return {
    status: "succeeded",
    episodes,
    obtainedEpisodes,
    transferAttempts,
    decisions: [decision],
    notification,
    notifications: [notification],
    auditEvents,
  };
}

function addRestoredEpisodes(restored: Set<string>, missingEpisodes: string[], files: { episodeCode: string }[]): void {
  for (const file of files) {
    if (missingEpisodes.includes(file.episodeCode)) {
      restored.add(file.episodeCode);
    }
  }
}
