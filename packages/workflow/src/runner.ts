import type {
  EpisodeState,
  MediaTitle,
  TrackedSeason,
  WorkflowKind,
  WorkflowRun,
} from "./domain.js";
import type { AgentNodes, ResourceProvider, StorageExecutor } from "./ports.js";
import type { WorkflowRepository } from "./repository.js";
import {
  runType2Initialization,
  runType3Monitoring,
  type WorkflowResult,
} from "./workflow.js";

export interface WorkflowRunMetadata {
  id: string;
  startedAt: string;
  finishedAt: string | null;
}

export async function runType2InitializationAndPersist(input: {
  title: MediaTitle;
  season: TrackedSeason;
  keyword: string;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  agents: AgentNodes;
  repository: WorkflowRepository;
  workflowRun: WorkflowRunMetadata;
  storageParentDirectoryId?: string;
}): Promise<WorkflowResult> {
  const result = await runType2Initialization({
    title: input.title,
    season: input.season,
    keyword: input.keyword,
    resourceProvider: input.resourceProvider,
    storage: input.storage,
    agents: input.agents,
    workflowRunId: input.workflowRun.id,
    ...(input.storageParentDirectoryId === undefined
      ? {}
      : { storageParentDirectoryId: input.storageParentDirectoryId }),
  });

  await persistWorkflowResult({
    title: input.title,
    season: result.season,
    workflowRun: toWorkflowRun("type2_init", input.season.id, input.workflowRun, result),
    result,
    repository: input.repository,
  });

  return result;
}

export async function runType3MonitoringAndPersist(input: {
  title: MediaTitle;
  season: TrackedSeason;
  episodes: EpisodeState[];
  keyword: string;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  agents: AgentNodes;
  repository: WorkflowRepository;
  workflowRun: WorkflowRunMetadata;
  storageParentDirectoryId?: string;
}): Promise<WorkflowResult> {
  const result = await runType3Monitoring({
    title: input.title,
    season: input.season,
    episodes: input.episodes,
    keyword: input.keyword,
    resourceProvider: input.resourceProvider,
    storage: input.storage,
    agents: input.agents,
    workflowRunId: input.workflowRun.id,
    ...(input.storageParentDirectoryId === undefined
      ? {}
      : { storageParentDirectoryId: input.storageParentDirectoryId }),
  });

  await persistWorkflowResult({
    title: input.title,
    season: result.season,
    workflowRun: toWorkflowRun("type3_monitor", input.season.id, input.workflowRun, result),
    result,
    repository: input.repository,
  });

  return result;
}

async function persistWorkflowResult(input: {
  title: MediaTitle;
  season: TrackedSeason;
  workflowRun: WorkflowRun;
  result: WorkflowResult;
  repository: WorkflowRepository;
}): Promise<void> {
  await input.repository.saveWorkflowRunSnapshot({
    title: input.title,
    season: input.season,
    workflowRun: input.workflowRun,
    episodes: input.result.episodes,
    resourceSnapshots: input.result.resourceSnapshots,
    decisions: input.result.decisions,
    transferAttempts: input.result.transferAttempts,
    notifications: input.result.notifications,
  });
}

function toWorkflowRun(
  kind: WorkflowKind,
  trackedSeasonId: string,
  metadata: WorkflowRunMetadata,
  result: WorkflowResult,
): WorkflowRun {
  return {
    id: metadata.id,
    kind,
    status: result.status,
    trackedSeasonId,
    startedAt: metadata.startedAt,
    finishedAt: metadata.finishedAt,
    auditEvents: result.auditEvents,
  };
}
