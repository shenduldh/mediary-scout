import {
  createEpisodeStates,
  reconcileVerifiedFiles,
  type AcquisitionFailureEvidence,
  type AgentDecision,
  type AuditEvent,
  type EpisodeState,
  type MediaTitle,
  type NotificationEvent,
  type ResourceSnapshot,
  type TrackedSeason,
  type TransferAttempt,
  type VerifiedFile,
  type WorkflowStatus,
} from "./domain.js";
import { buildConfirmedDedupPlan } from "./dedup.js";
import {
  buildAgentAssistedPackageNormalizationPlan,
  type PackageMoveAction,
} from "./package-normalizer.js";
import {
  deriveAgentDecision,
  validateAcquisitionPlan,
  type SelectedTransferCandidate,
} from "./plan-validation.js";
import type {
  AcquisitionPlanningResult,
  AgentNodes,
  ResourceProvider,
  StorageExecutor,
} from "./ports.js";

const TYPE2_WORKFLOW_RUN_ID = "run_type2";
const TYPE3_WORKFLOW_RUN_ID = "run_type3";
const FIXED_CREATED_AT = "2026-01-01T00:00:00.000Z";
const DEFAULT_MAX_PLANNING_PASSES = 2;

export interface WorkflowResult {
  status: WorkflowStatus;
  /** The tracked season, updated when the workflow created its landing directory. */
  season: TrackedSeason;
  episodes: EpisodeState[];
  obtainedEpisodes: string[];
  providerAheadEpisodes: string[];
  resourceSnapshots: ResourceSnapshot[];
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
  workflowRunId?: string;
  maxPlanningPasses?: number;
  storageParentDirectoryId?: string;
}): Promise<WorkflowResult> {
  const workflowRunId = input.workflowRunId ?? TYPE2_WORKFLOW_RUN_ID;
  const auditEvents: AuditEvent[] = [];
  const landing = await ensureLandingDirectory({
    title: input.title,
    season: input.season,
    storage: input.storage,
    storageParentDirectoryId: input.storageParentDirectoryId,
    auditEvents,
  });
  const season = landing.season;
  const stagingParentDirectoryId = landing.showDirectoryId ?? input.storageParentDirectoryId;
  if (stagingParentDirectoryId === undefined) {
    throw new Error(
      "MEDIA_TRACK_STAGING_PARENT_REQUIRED: provide storageParentDirectoryId so staging directories can live outside the season directory",
    );
  }
  const episodes = createEpisodeStates({
    trackedSeasonId: season.id,
    seasonNumber: season.seasonNumber,
    totalEpisodes: season.totalEpisodes,
    latestAiredEpisode: season.latestAiredEpisode,
  });
  const missingEpisodes = actionableMissingEpisodes(episodes);

  const outcome =
    missingEpisodes.length === 0
      ? emptyAcquisitionOutcome()
      : await acquireMissingEpisodes({
          title: input.title,
          seasons: [
            {
              seasonNumber: season.seasonNumber,
              totalEpisodes: season.totalEpisodes,
              latestAiredEpisode: season.latestAiredEpisode,
            },
          ],
          seasonDirectoryIds: { [season.seasonNumber]: season.storageDirectoryId },
          ...(landing.showDirectoryId === undefined ? {} : { showDirectoryId: landing.showDirectoryId }),
          stagingParentDirectoryId,
          qualityPreference: season.qualityPreference,
          keyword: input.keyword,
          missingEpisodes,
          resourceProvider: input.resourceProvider,
          storage: input.storage,
          agents: input.agents,
          workflowRunId,
          auditEvents,
          maxPlanningPasses: input.maxPlanningPasses ?? DEFAULT_MAX_PLANNING_PASSES,
        });

  const verifiedFiles = await dedupeLandingDirectory({
    storage: input.storage,
    directoryId: season.storageDirectoryId,
    auditEvents,
    title: input.title,
    seasonNumber: season.seasonNumber,
    agents: input.agents,
  });
  const reconciledEpisodes = reconcileVerifiedFiles({
    season,
    episodes,
    files: verifiedFiles,
  });
  const obtainedEpisodes = obtainedEpisodeCodes(reconciledEpisodes);
  const providerAheadEpisodes = collectProviderAheadEpisodes(reconciledEpisodes);
  const status = resolveAcquisitionStatus({
    missingBefore: missingEpisodes,
    stillMissingAfter: actionableMissingEpisodes(reconciledEpisodes),
  });
  const notification: NotificationEvent =
    status === "no_coverage"
      ? {
          id: `notification_${workflowRunId}`,
          workflowRunId,
          kind: "no_coverage",
          title: `${input.title.title} no covering resource yet`,
          body: `no covering resource found yet; ${obtainedEpisodes.length} episodes obtained`,
          createdAt: FIXED_CREATED_AT,
        }
      : {
          id: `notification_${workflowRunId}`,
          workflowRunId,
          kind: "tracking_initialized",
          title: `${input.title.title} tracking initialized`,
          body: `${obtainedEpisodes.length} episodes obtained`,
          createdAt: FIXED_CREATED_AT,
        };

  return {
    status,
    season,
    episodes: reconciledEpisodes,
    obtainedEpisodes,
    providerAheadEpisodes,
    resourceSnapshots: outcome.resourceSnapshots,
    transferAttempts: outcome.transferAttempts,
    decisions: outcome.decisions,
    notification,
    notifications: [notification],
    auditEvents,
  };
}

/**
 * The canonical landing shape (`Title (Year)/Season N`) is created by the
 * workflow itself, never improvised by callers — the flatten safety rule
 * accepts exactly this shape.
 */
async function ensureLandingDirectory(input: {
  title: MediaTitle;
  season: TrackedSeason;
  storage: StorageExecutor;
  storageParentDirectoryId: string | undefined;
  auditEvents: AuditEvent[];
}): Promise<{ season: TrackedSeason; showDirectoryId?: string }> {
  if (input.season.storageDirectoryId !== "") {
    return { season: input.season };
  }
  if (!input.storageParentDirectoryId) {
    throw new Error(
      "MEDIA_TRACK_STORAGE_PARENT_REQUIRED: tracked season has no storage directory and no storageParentDirectoryId was provided",
    );
  }
  const showName = `${input.title.title} (${input.title.year})`;
  const showDirectoryId = await input.storage.createDirectory({
    name: showName,
    parentId: input.storageParentDirectoryId,
  });
  const seasonDirectoryId = await input.storage.createDirectory({
    name: `Season ${input.season.seasonNumber}`,
    parentId: showDirectoryId,
  });
  input.auditEvents.push({
    type: "landing_directory_created",
    message: `Created canonical landing directory ${showName}/Season ${input.season.seasonNumber}`,
    data: { showDirectoryId, seasonDirectoryId },
  });
  return { season: { ...input.season, storageDirectoryId: seasonDirectoryId }, showDirectoryId };
}

export async function runType3Monitoring(input: {
  title: MediaTitle;
  season: TrackedSeason;
  episodes: EpisodeState[];
  keyword: string;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  agents: AgentNodes;
  workflowRunId?: string;
  maxPlanningPasses?: number;
  storageParentDirectoryId?: string;
}): Promise<WorkflowResult> {
  const workflowRunId = input.workflowRunId ?? TYPE3_WORKFLOW_RUN_ID;
  if (input.season.storageDirectoryId === "") {
    throw new Error(
      "MEDIA_TRACK_TRACKING_NOT_INITIALIZED: tracked season has no storage directory; run Type 2 initialization first",
    );
  }
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
  const missingBefore = actionableMissingEpisodes(episodes);

  if (missingBefore.length === 0) {
    const notification: NotificationEvent = {
      id: `notification_${workflowRunId}_noop`,
      workflowRunId,
      kind: "already_current",
      title: `${input.title.title} already current`,
      body: "0 episodes restored",
      createdAt: FIXED_CREATED_AT,
    };
    return {
      status: "succeeded",
      season: input.season,
      episodes,
      obtainedEpisodes: obtainedEpisodeCodes(episodes),
      providerAheadEpisodes: collectProviderAheadEpisodes(episodes),
      resourceSnapshots: [],
      transferAttempts: [],
      decisions: [],
      notification,
      notifications: [notification],
      auditEvents,
    };
  }

  if (input.storageParentDirectoryId === undefined) {
    throw new Error(
      "MEDIA_TRACK_STAGING_PARENT_REQUIRED: provide storageParentDirectoryId so staging directories can live outside the season directory",
    );
  }
  const outcome = await acquireMissingEpisodes({
    title: input.title,
    seasons: [
      {
        seasonNumber: input.season.seasonNumber,
        totalEpisodes: input.season.totalEpisodes,
        latestAiredEpisode: input.season.latestAiredEpisode,
      },
    ],
    seasonDirectoryIds: { [input.season.seasonNumber]: input.season.storageDirectoryId },
    stagingParentDirectoryId: input.storageParentDirectoryId,
    qualityPreference: input.season.qualityPreference,
    keyword: input.keyword,
    missingEpisodes: missingBefore,
    resourceProvider: input.resourceProvider,
    storage: input.storage,
    agents: input.agents,
    workflowRunId,
    auditEvents,
    maxPlanningPasses: input.maxPlanningPasses ?? DEFAULT_MAX_PLANNING_PASSES,
  });

  const finalFiles = await dedupeLandingDirectory({
    storage: input.storage,
    directoryId: input.season.storageDirectoryId,
    auditEvents,
    title: input.title,
    seasonNumber: input.season.seasonNumber,
    agents: input.agents,
  });
  episodes = reconcileVerifiedFiles({
    season: input.season,
    // Rebuild from the post-dedup listing: verifiedFileIds reflect current
    // storage truth, not the history of files that once existed.
    episodes: episodes.map((episode) => {
      const matchingFiles = finalFiles.filter((file) => file.episodeCode === episode.episodeCode);
      return {
        ...episode,
        obtained: matchingFiles.length > 0,
        verifiedFileIds: matchingFiles.map((file) => file.id),
      };
    }),
    files: finalFiles,
  });
  const obtainedEpisodes = obtainedEpisodeCodes(episodes);
  const providerAheadEpisodes = collectProviderAheadEpisodes(episodes);
  const stillMissingAfter = actionableMissingEpisodes(episodes);
  const restoredCount = missingBefore.length - stillMissingAfter.length;
  const status = resolveAcquisitionStatus({ missingBefore, stillMissingAfter });
  const notification: NotificationEvent =
    status === "no_coverage"
      ? {
          id: `notification_${workflowRunId}`,
          workflowRunId,
          kind: "no_coverage",
          title: `${input.title.title} no covering resource yet`,
          body: `no covering resource found yet; ${restoredCount} episodes restored`,
          createdAt: FIXED_CREATED_AT,
        }
      : {
          id: `notification_${workflowRunId}`,
          workflowRunId,
          kind: "episodes_restored",
          title: `${input.title.title} episodes restored`,
          body: `${restoredCount} episodes restored`,
          createdAt: FIXED_CREATED_AT,
        };

  return {
    status,
    season: input.season,
    episodes,
    obtainedEpisodes,
    providerAheadEpisodes,
    resourceSnapshots: outcome.resourceSnapshots,
    transferAttempts: outcome.transferAttempts,
    decisions: outcome.decisions,
    notification,
    notifications: [notification],
    auditEvents,
  };
}

interface AcquisitionOutcome {
  resourceSnapshots: ResourceSnapshot[];
  decisions: AgentDecision[];
  transferAttempts: TransferAttempt[];
}

export interface AcquisitionSeasonScope {
  seasonNumber: number;
  totalEpisodes: number;
  latestAiredEpisode: number;
}

function emptyAcquisitionOutcome(): AcquisitionOutcome {
  return { resourceSnapshots: [], decisions: [], transferAttempts: [] };
}

/**
 * The deterministic acquisition harness. The planning agent owns every
 * semantic choice (keywords, target matching, episode mapping, selection);
 * this loop owns every side effect and every verification.
 *
 * Unified staging path: every selected candidate transfers into its own
 * staging directory first — never directly into a season directory — then
 * package normalization distributes the materialized tree into canonical
 * per-season directories. A candidate's claimed coverage is evidence; the
 * landed tree is the truth. Files the normalization plan rejects stay
 * quarantined in staging. Recovery from a transfer that materializes nothing
 * is a fresh agent pass that sees the failure evidence — never mechanical
 * iteration over provider candidates.
 */
async function acquireMissingEpisodes(input: {
  title: MediaTitle;
  seasons: AcquisitionSeasonScope[];
  /** seasonNumber -> existing season directory id; missing entries are find-or-created under showDirectoryId. */
  seasonDirectoryIds: Record<number, string>;
  showDirectoryId?: string;
  stagingParentDirectoryId: string;
  qualityPreference: string;
  keyword: string;
  missingEpisodes: string[];
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  agents: AgentNodes;
  workflowRunId: string;
  auditEvents: AuditEvent[];
  maxPlanningPasses: number;
}): Promise<AcquisitionOutcome> {
  const resourceSnapshots: ResourceSnapshot[] = [];
  const decisions: AgentDecision[] = [];
  const transferAttempts: TransferAttempt[] = [];
  const seasonNumbers = input.seasons.map((season) => season.seasonNumber);
  const latestAiredBySeason = Object.fromEntries(
    input.seasons.map((season) => [season.seasonNumber, season.latestAiredEpisode]),
  );
  let stillMissing = [...input.missingEpisodes];
  let failureEvidence: AcquisitionFailureEvidence[] = [];

  for (let pass = 1; pass <= input.maxPlanningPasses && stillMissing.length > 0; pass += 1) {
    const planning = await input.agents.planAcquisition({
      title: input.title.title,
      aliases: input.title.aliases,
      seasons: input.seasons,
      qualityPreference: input.qualityPreference,
      missingEpisodes: stillMissing,
      initialKeyword: input.keyword,
      failureEvidence,
      searchResources: async ({ keyword }) => input.resourceProvider.search({ keyword }),
    });
    resourceSnapshots.push(...planning.snapshots);
    recordPlanningAudit({ auditEvents: input.auditEvents, planning, pass });

    const validated = validateAcquisitionPlan({
      plan: planning.plan,
      snapshots: planning.snapshots,
      missingEpisodes: stillMissing,
      seasonNumbers,
    });

    if (validated.selectedSnapshot === null || validated.selectedCandidates.length === 0) {
      // "No coverage" is an honest conclusion only when the agent saw real
      // provider evidence. If searches errored and the successful ones all
      // came back empty, the evidence is incomplete — that is an
      // infrastructure failure to retry later, not a "no resource" verdict.
      const searchErrors = planning.trace
        .filter((event) => event.type === "tool_result" && isSearchErrorOutput(event.output))
        .map((event) => (event as { output: { error: string } }).output.error);
      const observedCandidateCount = planning.snapshots.reduce(
        (count, snapshot) => count + snapshot.candidates.length,
        0,
      );
      if (planning.snapshots.length === 0 || (searchErrors.length > 0 && observedCandidateCount === 0)) {
        throw new Error(searchErrors[0] ?? "Planning agent produced no search observations");
      }
      input.auditEvents.push({
        type: "acquisition_no_coverage",
        message: `Planning pass ${pass} found no covering resource`,
        data: { pass, reason: planning.plan.reason, stillMissing },
      });
      break;
    }

    decisions.push(
      deriveAgentDecision({
        plan: planning.plan,
        missingEpisodes: stillMissing,
        latestAiredBySeason,
      }),
    );

    const passAttempts: TransferAttempt[] = [];
    for (const [index, selected] of validated.selectedCandidates.entries()) {
      const stagingDirectoryId = await input.storage.createDirectory({
        name: `staging-${input.workflowRunId}-p${pass}-c${index + 1}`,
        parentId: input.stagingParentDirectoryId,
      });
      const attempt = await input.storage.transfer({
        workflowRunId: input.workflowRunId,
        directoryId: stagingDirectoryId,
        candidate: selected.candidate,
      });
      passAttempts.push(attempt);
      transferAttempts.push(attempt);
      await normalizeStagingDirectory({
        title: input.title,
        seasons: input.seasons,
        seasonDirectoryIds: input.seasonDirectoryIds,
        showDirectoryId: input.showDirectoryId,
        stagingDirectoryId,
        storage: input.storage,
        agents: input.agents,
        auditEvents: input.auditEvents,
      });
    }

    stillMissing = await stillMissingAcrossSeasons({
      missingEpisodes: stillMissing,
      seasonDirectoryIds: input.seasonDirectoryIds,
      storage: input.storage,
    });

    if (stillMissing.length > 0) {
      failureEvidence = buildFailureEvidence({
        selectedCandidates: validated.selectedCandidates,
        attempts: passAttempts,
        stillMissing,
      });
      input.auditEvents.push({
        type: "acquisition_pass_incomplete",
        message: `Planning pass ${pass} left ${stillMissing.length} episodes missing`,
        data: { pass, stillMissing, failureEvidence },
      });
    }
  }

  return { resourceSnapshots, decisions, transferAttempts };
}

/**
 * Distribute one staging directory's landed tree into canonical season
 * directories. Out-of-scope seasons and plan-rejected files stay quarantined
 * in staging — never moved, never deleted.
 */
async function normalizeStagingDirectory(input: {
  title: MediaTitle;
  seasons: AcquisitionSeasonScope[];
  seasonDirectoryIds: Record<number, string>;
  showDirectoryId: string | undefined;
  stagingDirectoryId: string;
  storage: StorageExecutor;
  agents: AgentNodes;
  auditEvents: AuditEvent[];
}): Promise<void> {
  const tree = await input.storage.listTree({ directoryId: input.stagingDirectoryId });
  if (tree.length === 0) {
    return;
  }
  const plan = await buildAgentAssistedPackageNormalizationPlan({
    title: input.title.title,
    year: input.title.year,
    files: tree,
    totalSeasons: input.seasons.length,
    agents: input.agents,
  });
  if (plan.rejectedFiles.length > 0) {
    input.auditEvents.push({
      type: "package_files_rejected",
      message: `${plan.rejectedFiles.length} files stay quarantined in staging ${input.stagingDirectoryId}`,
      data: { stagingDirectoryId: input.stagingDirectoryId, rejectedFiles: plan.rejectedFiles },
    });
  }

  const inScope = new Set(input.seasons.map((season) => season.seasonNumber));
  const actionsBySeason = new Map<number, PackageMoveAction[]>();
  for (const action of plan.actions) {
    const group = actionsBySeason.get(action.targetSeasonNumber) ?? [];
    group.push(action);
    actionsBySeason.set(action.targetSeasonNumber, group);
  }

  for (const [seasonNumber, actions] of actionsBySeason) {
    if (!inScope.has(seasonNumber)) {
      input.auditEvents.push({
        type: "package_out_of_scope_season",
        message: `Staging ${input.stagingDirectoryId} contains season ${seasonNumber} files outside this acquisition's scope; left in staging`,
        data: { stagingDirectoryId: input.stagingDirectoryId, seasonNumber, fileCount: actions.length },
      });
      continue;
    }
    let seasonDirectoryId = input.seasonDirectoryIds[seasonNumber];
    if (seasonDirectoryId === undefined) {
      if (input.showDirectoryId === undefined) {
        input.auditEvents.push({
          type: "package_out_of_scope_season",
          message: `No directory known for season ${seasonNumber} and no show directory to create one; files left in staging`,
          data: { stagingDirectoryId: input.stagingDirectoryId, seasonNumber, fileCount: actions.length },
        });
        continue;
      }
      seasonDirectoryId = await input.storage.createDirectory({
        name: `Season ${seasonNumber}`,
        parentId: input.showDirectoryId,
      });
      input.seasonDirectoryIds[seasonNumber] = seasonDirectoryId;
      input.auditEvents.push({
        type: "landing_directory_created",
        message: `Created canonical landing directory ${input.title.title} (${input.title.year})/Season ${seasonNumber}`,
        data: { showDirectoryId: input.showDirectoryId, seasonDirectoryId },
      });
    }
    await input.storage.moveFiles({
      fileIds: actions.map((action) => action.providerFileId),
      targetDirectoryId: seasonDirectoryId,
    });
  }
}

async function stillMissingAcrossSeasons(input: {
  missingEpisodes: string[];
  seasonDirectoryIds: Record<number, string>;
  storage: StorageExecutor;
}): Promise<string[]> {
  const obtained = new Set<string>();
  for (const directoryId of Object.values(input.seasonDirectoryIds)) {
    for (const file of await input.storage.listVideoFiles(directoryId)) {
      obtained.add(file.episodeCode);
    }
  }
  return input.missingEpisodes.filter((code) => !obtained.has(code));
}

/**
 * Verification-first duplicate cleanup. The plan is built from one verified
 * snapshot, deletion is the only side effect, and the directory is re-read
 * afterwards: a dedup is complete only when the re-read shows one file per
 * episode.
 */
async function dedupeLandingDirectory(input: {
  storage: StorageExecutor;
  directoryId: string;
  auditEvents: AuditEvent[];
  title: MediaTitle;
  seasonNumber: number;
  agents: AgentNodes;
}): Promise<VerifiedFile[]> {
  const files = await input.storage.listVideoFiles(input.directoryId);
  const plan = await buildConfirmedDedupPlan({
    title: input.title,
    seasonNumber: input.seasonNumber,
    files,
    agents: input.agents,
  });
  if (plan.unconfirmedFileIds.length > 0) {
    input.auditEvents.push({
      type: "dedup_unconfirmed_kept",
      message: `Kept ${plan.unconfirmedFileIds.length} files whose episode mapping was not agent-confirmed`,
      data: { unconfirmedFileIds: plan.unconfirmedFileIds },
    });
  }
  if (plan.deleteFileIds.length === 0) {
    return files;
  }

  input.auditEvents.push({
    type: "dedup_plan_created",
    message: `Deleting ${plan.deleteFileIds.length} smaller duplicate files (agent-confirmed groups only)`,
    data: {
      duplicateGroups: plan.duplicateGroups,
      deleteFileIds: plan.deleteFileIds,
      keepFileIds: plan.keepFileIds,
      unconfirmedFileIds: plan.unconfirmedFileIds,
    },
  });
  await input.storage.deleteFiles({ directoryId: input.directoryId, fileIds: plan.deleteFileIds });

  const filesAfter = await input.storage.listVideoFiles(input.directoryId);
  const remaining = new Set(filesAfter.map((file) => file.id));
  const undeleted = plan.deleteFileIds.filter((fileId) => remaining.has(fileId));
  if (undeleted.length > 0) {
    input.auditEvents.push({
      type: "dedup_verification_failed",
      message: `Files scheduled for deletion still exist: ${undeleted.join(", ")}`,
      data: { undeleted },
    });
  } else {
    input.auditEvents.push({
      type: "dedup_verified",
      message: "Agent-confirmed duplicates removed and verified by re-read",
      data: { deletedCount: plan.deleteFileIds.length },
    });
  }
  return filesAfter;
}

function buildFailureEvidence(input: {
  selectedCandidates: SelectedTransferCandidate[];
  attempts: TransferAttempt[];
  stillMissing: string[];
}): AcquisitionFailureEvidence[] {
  const stillMissing = new Set(input.stillMissing);
  return input.selectedCandidates.flatMap((selected, index) => {
    const attempt = input.attempts[index];
    if (attempt === undefined) {
      return [];
    }
    const episodesStillMissing = selected.episodes.filter((code) => stillMissing.has(code));
    if (episodesStillMissing.length === 0) {
      return [];
    }
    return [
      {
        candidateId: selected.candidate.id,
        candidateTitle: selected.candidate.title,
        transferStatus: attempt.status,
        providerMessage: attempt.providerMessage,
        episodesStillMissing,
      },
    ];
  });
}

function recordPlanningAudit(input: {
  auditEvents: AuditEvent[];
  planning: AcquisitionPlanningResult;
  pass: number;
}): void {
  input.auditEvents.push({
    type: "acquisition_plan_created",
    message: `Planning pass ${input.pass} produced plan from ${input.planning.plan.node}`,
    data: {
      pass: input.pass,
      plan: input.planning.plan,
      trace: input.planning.trace,
    },
  });
  for (const event of input.planning.trace) {
    if (event.type !== "tool_result" || !isSearchErrorOutput(event.output)) {
      continue;
    }
    input.auditEvents.push({
      type: "keyword_search_failed",
      message: `Search keyword failed: ${event.output.keyword}`,
      data: { keyword: event.output.keyword, error: event.output.error },
    });
  }
  for (const snapshot of input.planning.snapshots) {
    input.auditEvents.push({
      type: "resource_snapshot_created",
      message: `Created resource snapshot ${snapshot.id}`,
      data: {
        snapshotId: snapshot.id,
        keyword: snapshot.keyword,
        candidateCount: snapshot.candidates.length,
      },
    });
    if (snapshot.candidates.length === 0) {
      input.auditEvents.push({
        type: "keyword_search_empty",
        message: `Search keyword returned no candidates: ${snapshot.keyword}`,
        data: { keyword: snapshot.keyword },
      });
    }
  }
}

function isSearchErrorOutput(output: unknown): output is { keyword: string; error: string } {
  return (
    typeof output === "object" &&
    output !== null &&
    "keyword" in output &&
    "error" in output &&
    typeof output.keyword === "string" &&
    typeof output.error === "string"
  );
}

function resolveAcquisitionStatus(input: {
  missingBefore: string[];
  stillMissingAfter: string[];
}): WorkflowStatus {
  if (input.stillMissingAfter.length === 0) {
    return "succeeded";
  }
  if (input.stillMissingAfter.length < input.missingBefore.length) {
    return "partial";
  }
  return "no_coverage";
}

function actionableMissingEpisodes(episodes: EpisodeState[]): string[] {
  return episodes
    .filter((episode) => episode.airStatus === "aired" && !episode.obtained)
    .map((episode) => episode.episodeCode);
}

function obtainedEpisodeCodes(episodes: EpisodeState[]): string[] {
  return episodes.filter((episode) => episode.obtained).map((episode) => episode.episodeCode);
}

function collectProviderAheadEpisodes(episodes: EpisodeState[]): string[] {
  return episodes
    .filter((episode) => episode.obtained && episode.metadataStatus === "provider_ahead")
    .map((episode) => episode.episodeCode);
}
