import { LoaderCircle } from "lucide-react";
import type { RequestTrackingActionResult } from "../app/actions";

/**
 * A request is "locked" once it has been queued, is already tracked, or has an
 * active workflow — in every case the acquire control should stop offering to
 * re-queue. Shared so the four acquire components agree on the exact set of
 * terminal/in-flight statuses instead of each re-listing them.
 */
export function isLockedResult(result: RequestTrackingActionResult | null): boolean {
  return (
    result?.status === "requested" ||
    result?.status === "already_tracked" ||
    result?.status === "active_workflow"
  );
}

/** The standalone "已请求" pill shown after a request is queued (spinner — it is
 *  NOT done, only accepted). Shared by the badge-style acquire controls. */
export function RequestedBadge({ title }: { title?: string | undefined }) {
  return (
    <span className="hub-badge tone-green" title={title}>
      <LoaderCircle size={12} className="spin" aria-hidden />
      已请求
    </span>
  );
}
