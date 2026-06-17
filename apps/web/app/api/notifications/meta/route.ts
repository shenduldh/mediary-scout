import { NextResponse } from "next/server";
import { ensureDemoSeeded, getWorkflowRepository } from "../../../../lib/workflow-runtime";

/**
 * Lightweight feed metadata for the 通知 nav unread badge: the recent notification
 * timestamps, newest first. The client compares them against its localStorage
 * lastSeen to compute the unread count + mark NEW items — no server-side per-user
 * read state (the "按浏览器消费" model).
 */
export async function GET() {
  const repository = getWorkflowRepository();
  await ensureDemoSeeded(repository);
  const notifications = await repository.listNotifications({ limit: 50 });
  return NextResponse.json({ createdAts: notifications.map((notification) => notification.createdAt) });
}
