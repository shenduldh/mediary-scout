"use client";

import { useEffect, useState } from "react";
import { getLastSeen } from "../lib/notifications-seen";

/** Unread count on the 通知 nav: notifications newer than this browser's last-seen
 *  watermark. Clears when the 通知 page is opened (which advances the watermark). */
export function NotificationsNavBadge() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch("/api/notifications/meta", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { createdAts?: string[] };
        const lastSeen = getLastSeen();
        const unread = (data.createdAts ?? []).filter((createdAt) => createdAt > lastSeen).length;
        if (alive) setCount(unread);
      } catch {
        // transient
      }
    };
    poll();
    const id = setInterval(poll, 8000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (count === 0) {
    return null;
  }
  return <span className="nav-badge nav-badge-alert">{count}</span>;
}
