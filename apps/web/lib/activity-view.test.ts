import { describe, expect, it } from "vitest";
import {
  InMemoryWorkflowRepository,
  type MediaTitle,
  type PersistWorkflowRunSnapshotInput,
  type TrackedSeason,
  type WorkflowStatus,
} from "@media-track/workflow";
import { getActivityView } from "./activity-view";

function title(tmdbId: number, name: string): MediaTitle {
  return { id: `t${tmdbId}`, tmdbId, type: "tv", title: name, originalTitle: name, year: 2026, aliases: [], posterPath: `/p${tmdbId}.jpg` };
}
function season(titleId: string, seasonNumber: number): TrackedSeason {
  return {
    id: `${titleId}_s${seasonNumber}`,
    mediaTitleId: titleId,
    seasonNumber,
    status: "active",
    qualityPreference: "4K",
    storageDirectoryId: "d",
    totalEpisodes: 12,
    latestAiredEpisode: 6,
    latestAiredSource: "metadata",
  };
}
function run(input: {
  id: string;
  tmdbId: number;
  name: string;
  status: WorkflowStatus;
  startedAt: string;
  finishedAt?: string;
}): PersistWorkflowRunSnapshotInput {
  const t = title(input.tmdbId, input.name);
  const s = season(t.id, 1);
  return {
    title: t,
    season: s,
    workflowRun: {
      id: input.id,
      kind: "type2_init",
      status: input.status,
      trackedSeasonId: s.id,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt ?? null,
      auditEvents: [],
    },
    episodes: [],
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications:
      input.finishedAt !== undefined
        ? [
            {
              id: `n_${input.id}`,
              workflowRunId: input.id,
              kind: "tracking_initialized",
              title: input.name,
              body: "done",
              createdAt: input.finishedAt,
              report: {
                titleName: input.name,
                seasonLabel: "第 1 季",
                status: "complete",
                lines: [],
                newlyObtained: [],
                realMissing: [],
                posterPath: `/p${input.tmdbId}.jpg`,
                fileCount: 12,
                totalBytes: 12 * 410 * 1024 * 1024,
              },
            },
          ]
        : [],
  };
}

describe("getActivityView", () => {
  it("returns active queued+running runs with queue positions; running carries progress", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.saveWorkflowRunSnapshot(run({ id: "r_run", tmdbId: 1, name: "Running", status: "running", startedAt: "2026-06-17T00:00:00Z" }));
    await repo.saveWorkflowRunSnapshot(run({ id: "r_q1", tmdbId: 2, name: "Queue1", status: "queued", startedAt: "2026-06-17T00:00:01Z" }));
    await repo.saveWorkflowRunSnapshot(run({ id: "r_q2", tmdbId: 3, name: "Queue2", status: "queued", startedAt: "2026-06-17T00:00:02Z" }));
    await repo.updateWorkflowRunProgress("r_run", { activity: "正在转存到网盘…", phase: "transfer", percent: 40, updatedAt: "t" });

    const view = await getActivityView({ repository: repo, since: "2026-06-17T00:00:00Z" });

    const running = view.active.find((r) => r.runId === "r_run")!;
    expect(running.status).toBe("running");
    expect(running.progress?.activity).toBe("正在转存到网盘…");
    expect(running.queuePosition).toBeNull();
    const q1 = view.active.find((r) => r.runId === "r_q1")!;
    const q2 = view.active.find((r) => r.runId === "r_q2")!;
    expect(q1.queuePosition).toBe(1);
    expect(q2.queuePosition).toBe(2);
  });

  it("justCompleted only includes runs finished AFTER `since` (session-scoping)", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.saveWorkflowRunSnapshot(run({ id: "r_old", tmdbId: 1, name: "Old", status: "succeeded", startedAt: "2026-06-17T00:00:00Z", finishedAt: "2026-06-17T00:00:05Z" }));
    await repo.saveWorkflowRunSnapshot(run({ id: "r_new", tmdbId: 2, name: "New", status: "succeeded", startedAt: "2026-06-17T00:01:00Z", finishedAt: "2026-06-17T00:01:30Z" }));

    const view = await getActivityView({ repository: repo, since: "2026-06-17T00:01:00Z" });

    expect(view.justCompleted.map((c) => c.title)).toEqual(["New"]);
    expect(view.justCompleted[0]!.sizeText).toBe("每集 约 410 MB");
  });

  it("a freshly opened browser (since = now) sees no completed items", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.saveWorkflowRunSnapshot(run({ id: "r_done", tmdbId: 1, name: "Done", status: "succeeded", startedAt: "2026-06-17T00:00:00Z", finishedAt: "2026-06-17T00:00:05Z" }));

    const view = await getActivityView({ repository: repo, since: "2026-06-17T01:00:00Z" });
    expect(view.justCompleted).toEqual([]);
  });
});
