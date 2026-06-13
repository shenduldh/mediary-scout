import { importForeignWorkAsMovie } from "./commands.js";
import {
  createEpisodeStates,
  movieAnchorSeason,
  type AcquisitionFailureEvidence,
  type AgentDecision,
  type AuditEvent,
  type EpisodeState,
  type MediaTitle,
  type NotificationEvent,
  type ResourceSnapshot,
  type TrackedSeason,
  type TransferAttempt,
  type WorkflowStatus,
} from "./domain.js";
import { validateMoviePlan } from "./movie-plan-validation.js";
import { buildMovieReport, formatReportPushText } from "./notification-report.js";
import type { AgentNodes, ResourceProvider, StorageExecutor } from "./ports.js";

const VIDEO_EXTENSION = /\.(mkv|mp4|avi|mov|ts|m2ts|wmv|flv|webm|rmvb|iso)$/i;
const DEFAULT_MAX_MOVIE_PASSES = 4;
/** The movie's single synthetic episode (movie = one-episode season anchor). */
const MOVIE_EPISODE = "S01E01";

function defaultNowIso(): string {
  return new Date().toISOString();
}

export interface MovieWorkflowResult {
  status: WorkflowStatus;
  title: MediaTitle;
  season: TrackedSeason;
  episodes: EpisodeState[];
  resourceSnapshots: ResourceSnapshot[];
  transferAttempts: TransferAttempt[];
  decisions: AgentDecision[];
  notification: NotificationEvent;
  notifications: NotificationEvent[];
  auditEvents: AuditEvent[];
}

/**
 * Movie acquisition (Type 1, one-off — no tracking). Evidence-first: the agent
 * confirms identity (anti-remake) and picks ONE film, then the deterministic
 * harness transfers it (115 share OR magnet — both land immediately) and places
 * the single video under `Movies/Title (Year)/Title (Year).ext`.
 *
 * Transfers genuinely fail (a 115 share can be expired/cancelled or its
 * password mismatched). On failure the harness does NOT give up: it hands the
 * agent that failure evidence and re-plans, so the agent picks the next-best
 * covering candidate, up to maxPasses. Honest no_coverage only when nothing
 * covering remains.
 */
export async function runMovieAcquisition(input: {
  title: MediaTitle;
  keyword: string;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  agents: AgentNodes;
  workflowRunId?: string;
  stagingParentDirectoryId: string;
  moviesParentDirectoryId: string;
  maxPasses?: number;
  now?: () => string;
}): Promise<MovieWorkflowResult> {
  const workflowRunId = input.workflowRunId ?? "run_movie";
  const now = input.now ?? defaultNowIso;
  const maxPasses = input.maxPasses ?? DEFAULT_MAX_MOVIE_PASSES;
  const auditEvents: AuditEvent[] = [];
  const resourceSnapshots: ResourceSnapshot[] = [];
  const transferAttempts: TransferAttempt[] = [];
  const failureEvidence: AcquisitionFailureEvidence[] = [];

  const anchor = (storageDirectoryId: string): { season: TrackedSeason; episodes: EpisodeState[] } => {
    const season = movieAnchorSeason({
      titleId: input.title.id,
      qualityPreference: "4K",
      storageDirectoryId,
    });
    return {
      season,
      episodes: createEpisodeStates({
        trackedSeasonId: season.id,
        seasonNumber: 1,
        totalEpisodes: 1,
        latestAiredEpisode: 1,
      }),
    };
  };

  const finish = (input2: {
    status: WorkflowStatus;
    kind: string;
    storageDirectoryId: string;
    obtained: boolean;
    reportLines?: string[];
    reportStatus?: "acquired" | "no_coverage";
  }): MovieWorkflowResult => {
    const { season, episodes } = anchor(input2.storageDirectoryId);
    const finalEpisodes = episodes.map((episode) => ({ ...episode, obtained: input2.obtained }));
    const baseReport = buildMovieReport(input.title.title);
    const report =
      input2.reportStatus === "no_coverage"
        ? { ...baseReport, status: "no_coverage" as const, lines: input2.reportLines ?? baseReport.lines }
        : baseReport;
    const notification: NotificationEvent = {
      id: `notification_${workflowRunId}`,
      workflowRunId,
      kind: input2.kind,
      title: input.title.title,
      body: formatReportPushText(report),
      createdAt: now(),
      trigger: "user",
      report,
    };
    return {
      status: input2.status,
      title: input.title,
      season,
      episodes: finalEpisodes,
      resourceSnapshots,
      transferAttempts,
      decisions: [],
      notification,
      notifications: [notification],
      auditEvents,
    };
  };

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const planning = await input.agents.planMovieAcquisition({
      title: input.title.title,
      aliases: input.title.aliases,
      year: input.title.year,
      qualityPreference: "4K",
      initialKeyword: input.keyword,
      failureEvidence,
      searchResources: async ({ keyword }) => input.resourceProvider.search({ keyword }),
    });
    for (const snapshot of planning.snapshots) {
      if (!resourceSnapshots.some((existing) => existing.id === snapshot.id)) {
        resourceSnapshots.push(snapshot);
      }
    }

    const validated = validateMoviePlan({ plan: planning.plan, snapshots: planning.snapshots });
    if (validated.selectedCandidate === null) {
      // The agent found nothing covering this pass — stop and report honestly.
      auditEvents.push({
        type: "acquisition_no_coverage",
        message: `No covering movie resource for ${input.title.title} (pass ${pass + 1})`,
      });
      return finish({
        status: "no_coverage",
        kind: "no_coverage",
        storageDirectoryId: "",
        obtained: false,
        reportStatus: "no_coverage",
        reportLines: ["暂未找到可用资源 · 将持续尝试"],
      });
    }
    const candidate = validated.selectedCandidate;

    const stagingDirectoryId = await input.storage.createDirectory({
      name: `staging-${workflowRunId}-movie-p${pass + 1}`,
      parentId: input.stagingParentDirectoryId,
    });
    const attempt = await input.storage.transfer({
      workflowRunId,
      directoryId: stagingDirectoryId,
      candidate,
    });
    transferAttempts.push(attempt);

    const tree = await input.storage.listTree({ directoryId: stagingDirectoryId });
    const videos = tree
      .filter((file) => VIDEO_EXTENSION.test(file.path) && !/sample/i.test(file.path))
      .sort((left, right) => right.sizeBytes - left.sizeBytes);

    if (videos.length === 0) {
      // Transfer failed (expired/cancelled share, wrong password, dead magnet).
      // Record evidence and let the next pass pick a different covering resource.
      failureEvidence.push({
        candidateId: candidate.id,
        candidateTitle: candidate.title,
        transferStatus: attempt.status,
        providerMessage: attempt.providerMessage,
        episodesStillMissing: [MOVIE_EPISODE],
      });
      auditEvents.push({
        type: "acquisition_pass_incomplete",
        message: `Movie transfer pass ${pass + 1} did not materialize a video (${attempt.providerMessage || attempt.status})`,
        data: { candidateId: candidate.id, candidateTitle: candidate.title, status: attempt.status },
      });
      continue;
    }

    const imported = await importForeignWorkAsMovie({
      storage: input.storage,
      providerFileIds: [videos[0]!.providerFileId],
      movieTitle: input.title.title,
      year: input.title.year,
      moviesParentDirectoryId: input.moviesParentDirectoryId,
    });
    auditEvents.push({
      type: "movie_landed",
      message: `${input.title.title} (${input.title.year}) landed${imported.renamedTo ? ` as ${imported.renamedTo}` : ""}`,
      data: { movieDirectoryId: imported.movieDirectoryId, movedFileIds: imported.movedFileIds },
    });
    return finish({
      status: "succeeded",
      kind: "package_initialized",
      storageDirectoryId: imported.movieDirectoryId,
      obtained: true,
    });
  }

  // Every pass's selection failed to materialize.
  auditEvents.push({
    type: "acquisition_no_coverage",
    message: `All ${maxPasses} movie acquisition passes failed for ${input.title.title}`,
  });
  return finish({
    status: "no_coverage",
    kind: "no_coverage",
    storageDirectoryId: "",
    obtained: false,
    reportStatus: "no_coverage",
    reportLines: ["资源转存均未落地 · 将持续尝试"],
  });
}
