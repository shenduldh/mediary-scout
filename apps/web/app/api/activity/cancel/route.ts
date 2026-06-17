import { NextResponse, type NextRequest } from "next/server";
import { getWorkflowRepository } from "../../../../lib/workflow-runtime";

/**
 * Cancel a still-QUEUED acquisition (user action from the activity page). Deletes
 * the run + the tracking it created, so the title also leaves the library. Returns
 * { status: "cancelled" | "not_cancellable" } — not_cancellable when the worker
 * already claimed it (the UI then refreshes to show it running).
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { runId?: unknown };
  const runId = typeof body.runId === "string" ? body.runId : null;
  if (!runId) {
    return NextResponse.json({ error: "runId required" }, { status: 400 });
  }
  const result = await getWorkflowRepository().cancelQueuedWorkflowRun(runId);
  return NextResponse.json(result);
}
