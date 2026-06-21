import type { ActivityCompletedItem } from "./activity-view";

export interface DemoAcquisitionEntry {
  tmdbId: number;
  title: string;
  year: number;
  type: "movie" | "tv" | "anime";
  posterPath: string | null;
}

const KEY = "mediary-demo-acquired";
const MAX = 20;

/** Fired on the window whenever an acquisition is recorded, so every mounted
 *  surface (search cards, activity, library) refreshes from the session store. */
export const DEMO_ACQUIRED_EVENT = "mediary-demo-acquired";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function isEntry(value: unknown): value is DemoAcquisitionEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const e = value as Record<string, unknown>;
  return (
    typeof e.tmdbId === "number" &&
    typeof e.title === "string" &&
    typeof e.year === "number" &&
    (e.type === "movie" || e.type === "tv" || e.type === "anime") &&
    (e.posterPath === null || typeof e.posterPath === "string")
  );
}

export function listDemoAcquisitions(
  storage: StorageLike | null = defaultStorage(),
): DemoAcquisitionEntry[] {
  if (!storage) {
    return [];
  }
  try {
    const raw = storage.getItem(KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isEntry);
  } catch {
    return [];
  }
}

export function recordDemoAcquisition(
  entry: DemoAcquisitionEntry,
  storage: StorageLike | null = defaultStorage(),
): DemoAcquisitionEntry[] {
  if (!storage) {
    return [];
  }
  const next = [entry, ...listDemoAcquisitions(storage).filter((e) => e.tmdbId !== entry.tmdbId)].slice(0, MAX);
  try {
    storage.setItem(KEY, JSON.stringify(next));
    if (typeof window !== "undefined") {
      try {
        window.dispatchEvent(new Event(DEMO_ACQUIRED_EVENT));
      } catch {
        // no DOM event support — non-fatal
      }
    }
  } catch {
    // storage full / unavailable — best-effort, demo only
  }
  return next;
}

/** Render the session's acquisitions as completed activity items (demo only —
 *  no DB run exists; the activity feed merges these into 已完成). */
export function demoCompletedItems(entries: DemoAcquisitionEntry[]): ActivityCompletedItem[] {
  return entries.map((e) => ({
    workflowRunId: `demo-${e.tmdbId}`,
    title: e.title,
    seasonLabel: null,
    status: "complete",
    posterPath: e.posterPath,
    sizeText: null,
    createdAt: "2026-06-12T08:00:00.000Z",
  }));
}
