import { describe, expect, it } from "vitest";
import { DEFAULT_ACCOUNT_ID } from "../src/domain.js";
import {
  globalNavHref,
  resolveWorkspaceFromParam,
  scopeFromAccount,
  type WorkflowScope,
} from "../src/workflow-scope.js";

describe("WorkflowScope", () => {
  it("scopeFromAccount fills account + storage", () => {
    const s: WorkflowScope = scopeFromAccount(DEFAULT_ACCOUNT_ID, "cs_1");
    expect(s).toEqual({ accountId: DEFAULT_ACCOUNT_ID, connectedStorageId: "cs_1" });
  });
  it("scopeFromAccount allows null storage (pre-migration / unscoped reads)", () => {
    expect(scopeFromAccount(DEFAULT_ACCOUNT_ID, null)).toEqual({
      accountId: DEFAULT_ACCOUNT_ID,
      connectedStorageId: null,
    });
  });
});

describe("globalNavHref", () => {
  it("returns bare base when no active drive (primary/undefined)", () => {
    expect(globalNavHref("/notifications", undefined)).toBe("/notifications");
  });
  it("appends ?w for a non-primary drive", () => {
    expect(globalNavHref("/activity", "cs_quark_AA")).toBe("/activity?w=cs_quark_AA");
  });
  it("encodes the drive id", () => {
    expect(globalNavHref("/settings", "a b/c")).toBe("/settings?w=a%20b%2Fc");
  });
});

describe("resolveWorkspaceFromParam", () => {
  const drives = [
    { id: "cs_primary", createdAt: "2026-01-01T00:00:00Z" },
    { id: "cs_quark", createdAt: "2026-02-01T00:00:00Z" },
  ];
  it("no w → primary (earliest), bare basePath, undefined active", () => {
    expect(resolveWorkspaceFromParam(drives, undefined)).toEqual({
      connectedStorageId: "cs_primary",
      basePath: "/",
      activeStorageId: undefined,
    });
  });
  it("w of a non-primary owned drive → that drive, /w/<id>, active set", () => {
    expect(resolveWorkspaceFromParam(drives, "cs_quark")).toEqual({
      connectedStorageId: "cs_quark",
      basePath: "/w/cs_quark",
      activeStorageId: "cs_quark",
    });
  });
  it("w equal to primary id → canonical primary (bare, undefined active)", () => {
    expect(resolveWorkspaceFromParam(drives, "cs_primary")).toEqual({
      connectedStorageId: "cs_primary",
      basePath: "/",
      activeStorageId: undefined,
    });
  });
  it("unknown/stale w → falls back to primary (no throw)", () => {
    expect(resolveWorkspaceFromParam(drives, "cs_gone")).toEqual({
      connectedStorageId: "cs_primary",
      basePath: "/",
      activeStorageId: undefined,
    });
  });
  it("no drives → null connectedStorageId, bare basePath", () => {
    expect(resolveWorkspaceFromParam([], "cs_x")).toEqual({
      connectedStorageId: null,
      basePath: "/",
      activeStorageId: undefined,
    });
  });
});
