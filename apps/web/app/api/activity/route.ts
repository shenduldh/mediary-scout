import { NextResponse, type NextRequest } from "next/server";
import { getActivityView } from "../../../lib/activity-view";
import { ensureDemoSeeded, getWorkflowRepository } from "../../../lib/workflow-runtime";

/**
 * Live activity feed for the /activity page. `since` (the client's last-poll time)
 * scopes 已完成 to this browser session — omitted → defaults to now, so a first
 * poll surfaces no stale completions.
 */
export async function GET(request: NextRequest) {
  const repository = getWorkflowRepository();
  await ensureDemoSeeded(repository);
  const since = request.nextUrl.searchParams.get("since") ?? new Date().toISOString();
  const view = await getActivityView({ repository, since });
  return NextResponse.json(view);
}
