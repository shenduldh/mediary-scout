import { connection, NextResponse, type NextRequest } from "next/server";
import { getActivityView } from "../../../lib/activity-view";
import { ensureDemoSeeded, getWorkflowRepository, resolveGlobalWorkspace } from "../../../lib/workflow-runtime";

/**
 * Live activity feed for the /activity page: the queue+running set + recent
 * completed runs, scoped to the active drive via `?w`. The client session-scopes
 * 已完成 by matching against the runIds it observed active.
 */
export async function GET(request: NextRequest) {
  // Request-time only: keep this out of build-time prerender (it reads the DB).
  await connection();
  const repository = getWorkflowRepository();
  await ensureDemoSeeded(repository);
  const { accountId, connectedStorageId } = await resolveGlobalWorkspace(
    request.nextUrl.searchParams.get("w") ?? undefined,
  );
  const view = await getActivityView({ repository, accountId, connectedStorageId });
  return NextResponse.json(view);
}
