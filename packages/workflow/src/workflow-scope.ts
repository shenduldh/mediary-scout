import { DEFAULT_ACCOUNT_ID } from "./domain.js";

/** The data partition key for the multi-drive tree model: an account (identity)
 *  plus the specific connected storage (workspace). `connectedStorageId` may be
 *  null for unscoped/legacy reads — before backfill, and for the cross-(account,
 *  storage) daily patrol that must see every drive's shows. A non-null value
 *  means "only this drive" (fail-closed isolation). */
export interface WorkflowScope {
  accountId: string;
  connectedStorageId: string | null;
}

export function scopeFromAccount(
  accountId: string,
  connectedStorageId: string | null,
): WorkflowScope {
  return { accountId, connectedStorageId };
}

/** Read methods accept either a bare accountId (legacy, account-only — no storage
 *  filter) or a full WorkflowScope. `undefined` → the default account, no filter. */
export type ScopeArg = string | WorkflowScope | undefined;

export function normalizeScope(arg: ScopeArg): WorkflowScope {
  if (arg === undefined) {
    return { accountId: DEFAULT_ACCOUNT_ID, connectedStorageId: null };
  }
  if (typeof arg === "string") {
    return { accountId: arg, connectedStorageId: null };
  }
  return arg;
}

/** Thrown when a request targets a /w/<storageId> workspace the current account
 *  does not own (or that doesn't exist) — the route layer maps it to a 404. */
export class WorkspaceNotFoundError extends Error {
  constructor(storageId: string) {
    super(`Workspace not found: ${storageId}`);
    this.name = "WorkspaceNotFoundError";
  }
}

/**
 * Resolve which drive a request's workspace targets, from the account's drives:
 * - no `storageIdParam` (root route) → the earliest-created (primary) drive id,
 *   or null when the account has no drive yet (single-user fresh — root works
 *   account-only).
 * - explicit `storageIdParam` that the account owns → that id.
 * - explicit `storageIdParam` the account does NOT own → throw (→ 404).
 * Pure: takes the already-loaded drive list, so it's testable without a DB.
 */
export function pickWorkspaceStorageId(
  storages: ReadonlyArray<{ id: string; createdAt: string }>,
  storageIdParam: string | undefined,
): string | null {
  if (storageIdParam === undefined) {
    if (storages.length === 0) {
      return null;
    }
    return [...storages].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]!.id;
  }
  const owned = storages.some((storage) => storage.id === storageIdParam);
  if (!owned) {
    throw new WorkspaceNotFoundError(storageIdParam);
  }
  return storageIdParam;
}

export interface WorkspaceSwitcherItem {
  id: string;
  href: string;
  label: string;
  isActive: boolean;
  frozen: boolean;
}

/**
 * Build the workspace switcher tabs (pure, testable). The earliest-created drive
 * is primary and routes to "/"; the rest route to /w/<id>. The active tab is the
 * one matching the current pathname (/w/<id>), else the primary (root and any
 * non-workspace page like /settings). Label falls back to a uid tail.
 * The caller renders nothing when fewer than 2 drives exist.
 */
export function switcherItems(
  storages: ReadonlyArray<{
    id: string;
    label: string | null;
    provider?: string;
    providerUid: string;
    createdAt: string;
    status: "active" | "frozen";
  }>,
  pathname: string,
): WorkspaceSwitcherItem[] {
  const sorted = [...storages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const activeWorkspaceId = (() => {
    const match = /^\/w\/([^/]+)/.exec(pathname);
    return match ? match[1]! : null;
  })();
  return sorted.map((storage, index) => {
    const isPrimary = index === 0;
    const href = isPrimary ? "/" : `/w/${storage.id}`;
    const isActive = activeWorkspaceId
      ? storage.id === activeWorkspaceId
      : isPrimary; // root / non-workspace page → primary is active
    return {
      id: storage.id,
      href,
      label:
        storage.label?.trim() ||
        `${storage.provider === "quark" ? "夸克" : "115"} …${storage.providerUid.slice(-4)}`,
      isActive,
      frozen: storage.status === "frozen",
    };
  });
}

/** True when a stored row belongs to the scope: account must match; storage only
 *  filters when the scope pins one (connectedStorageId != null). fail-closed. */
export function scopeMatches(
  scope: WorkflowScope,
  rowAccountId: string | null | undefined,
  rowStorageId: string | null | undefined,
): boolean {
  if ((rowAccountId ?? DEFAULT_ACCOUNT_ID) !== scope.accountId) {
    return false;
  }
  if (scope.connectedStorageId != null && (rowStorageId ?? null) !== scope.connectedStorageId) {
    return false;
  }
  return true;
}

/** Build a global-page link (通知/活动/设置) that carries the active drive as a
 *  `?w` query param. Primary drive is represented by `activeStorageId === undefined`
 *  → bare base (mirrors how the primary library is "/" not "/w/<id>"). */
export function globalNavHref(base: string, activeStorageId: string | undefined): string {
  return activeStorageId ? `${base}?w=${encodeURIComponent(activeStorageId)}` : base;
}

/** Resolve a global page's active workspace from its `?w` param + the account's
 *  drives. A stale/unknown `w` gracefully falls back to primary (NOT a 404 —
 *  unlike the /w/<id> route). The primary drive is canonicalized to a bare path
 *  with `activeStorageId: undefined` so its global links stay `?w`-free. */
export function resolveWorkspaceFromParam(
  storages: ReadonlyArray<{ id: string; createdAt: string }>,
  w: string | undefined,
): { connectedStorageId: string | null; basePath: string; activeStorageId: string | undefined } {
  const primaryId = pickWorkspaceStorageId(storages, undefined); // never throws (undefined param)
  const owned = w != null && storages.some((storage) => storage.id === w);
  const resolved = owned ? w! : primaryId;
  const isPrimary = resolved == null || resolved === primaryId;
  return {
    connectedStorageId: resolved,
    basePath: isPrimary ? "/" : `/w/${resolved}`,
    activeStorageId: isPrimary ? undefined : resolved!,
  };
}
