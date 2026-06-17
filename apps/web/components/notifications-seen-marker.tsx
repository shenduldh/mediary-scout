"use client";

import { useEffect } from "react";
import { getLastSeen, setLastSeen } from "../lib/notifications-seen";

/**
 * On the 通知 page: tag cards newer than the last-seen watermark with NEW (this
 * visit only), then advance the watermark to the newest — clearing the nav badge
 * and stopping future re-marking unless something newer arrives. Mounted in the
 * page's static shell (reliable hydration), it retries briefly for the cards,
 * which stream in from the Suspense'd feed after mount. Pure progressive
 * enhancement: toggles a class via each card's data-created-at.
 */
export function NotificationsSeenMarker() {
  useEffect(() => {
    const previous = getLastSeen();
    let tries = 0;

    const mark = () => {
      const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-created-at]"));
      if (cards.length === 0 && tries < 20) {
        tries += 1;
        window.setTimeout(mark, 150);
        return;
      }
      let newest = previous;
      for (const card of cards) {
        const createdAt = card.dataset.createdAt ?? "";
        if (createdAt && createdAt > previous) {
          card.classList.add("is-new");
        }
        if (createdAt > newest) {
          newest = createdAt;
        }
      }
      if (newest && newest !== previous) {
        setLastSeen(newest);
      }
    };

    mark();
  }, []);

  return null;
}
