/** Per-browser "last seen notifications" watermark (the 按浏览器消费 model). A
 *  single timestamp drives both the 通知 nav unread badge and the per-card NEW
 *  marks; opening the 通知 page advances it, clearing both. */
export const LAST_SEEN_KEY = "mt_notifications_last_seen";

export function getLastSeen(): string {
  try {
    return localStorage.getItem(LAST_SEEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setLastSeen(value: string): void {
  try {
    localStorage.setItem(LAST_SEEN_KEY, value);
  } catch {
    // storage unavailable (private mode) — degrade silently
  }
}
