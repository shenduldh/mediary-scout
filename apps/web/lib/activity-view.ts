import {
  landedSize,
  type MediaType,
  type NotificationReportStatus,
  type WorkflowRepository,
  type WorkflowRunProgress,
} from "@media-track/workflow";

/** One title currently in the pipeline (queued or running). */
export interface ActivityActiveRun {
  runId: string;
  tmdbId: number;
  title: string;
  year: number | null;
  type: MediaType;
  posterPath: string | null;
  seasonNumber: number | null;
  status: "queued" | "running";
  /** 1-based position among queued items; null for the running one. */
  queuePosition: number | null;
  /** Aired-but-not-obtained episodes still needed. */
  missingCount: number;
  /** Live agent progress (running only). */
  progress: WorkflowRunProgress | null;
}

/** A run that finished during this browser session (session-scoped via `since`). */
export interface ActivityCompletedItem {
  workflowRunId: string;
  title: string;
  seasonLabel: string | null;
  status: NotificationReportStatus;
  posterPath: string | null;
  /** "每集 约 410 MB" / "体积 1.4 GB"; null when unknown. */
  sizeText: string | null;
  createdAt: string;
}

export interface ActivityView {
  active: ActivityActiveRun[];
  justCompleted: ActivityCompletedItem[];
}

/**
 * Assemble the activity page view. `active` is the live queue+running set;
 * `justCompleted` is runs that finished AFTER `since` — the caller passes its
 * last-poll time (a freshly opened browser passes ~now and so sees nothing), which
 * is exactly the session-scoped "已完成" semantics (history lives in 通知).
 */
export async function getActivityView(input: {
  repository: Pick<WorkflowRepository, "listActiveWorkflowRuns" | "listNotifications">;
  since: string;
}): Promise<ActivityView> {
  const activeRuns = await input.repository.listActiveWorkflowRuns();

  // Queue positions: oldest-queued is position 1 (FIFO, matching the worker).
  const queuedOrder = activeRuns
    .filter((snapshot) => snapshot.workflowRun.status === "queued")
    .sort((a, b) => a.workflowRun.startedAt.localeCompare(b.workflowRun.startedAt))
    .map((snapshot) => snapshot.workflowRun.id);

  const active: ActivityActiveRun[] = activeRuns.map((snapshot) => {
    const status = snapshot.workflowRun.status === "running" ? "running" : "queued";
    const missingCount = snapshot.episodes.filter(
      (episode) => episode.airStatus === "aired" && !episode.obtained,
    ).length;
    const queueIndex = queuedOrder.indexOf(snapshot.workflowRun.id);
    return {
      runId: snapshot.workflowRun.id,
      tmdbId: snapshot.title.tmdbId,
      title: snapshot.title.title,
      year: snapshot.title.year ?? null,
      type: snapshot.title.type,
      posterPath: snapshot.title.posterPath ?? null,
      seasonNumber: snapshot.season.seasonNumber ?? null,
      status,
      queuePosition: status === "queued" && queueIndex >= 0 ? queueIndex + 1 : null,
      missingCount,
      progress: snapshot.workflowRun.progress ?? null,
    };
  });

  // justCompleted = notifications created after `since` (one per finished run),
  // skipping no-op patrol checks. Reuses the report (status + landed size).
  const notifications = await input.repository.listNotifications({ limit: 50 });
  const justCompleted: ActivityCompletedItem[] = notifications
    .filter(
      (notification) =>
        notification.createdAt > input.since &&
        notification.kind !== "already_current" &&
        notification.report !== undefined,
    )
    .map((notification) => {
      const report = notification.report!;
      const size = landedSize(report);
      return {
        workflowRunId: notification.workflowRunId,
        title: report.titleName,
        seasonLabel: report.seasonLabel,
        status: report.status,
        posterPath: report.posterPath ?? null,
        sizeText: size ? `${size.label} ${size.value}` : null,
        createdAt: notification.createdAt,
      };
    });

  return { active, justCompleted };
}
