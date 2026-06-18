import { describe, expect, it } from "vitest";
import {
  getStorageBrand,
  parseQuarkUid,
  parsePan115Uid,
  STORAGE_BRANDS,
  isPan115AuthError,
  isQuarkAuthError,
  Pan115AuthError,
  QuarkAuthError,
} from "../src/index.js";

describe("storage brand registry", () => {
  it("registers exactly pan115 + quark", () => {
    expect(STORAGE_BRANDS.map((b) => b.provider).sort()).toEqual(["pan115", "quark"]);
  });

  it("getStorageBrand resolves quark with its label + resource kinds (no prowlarr)", () => {
    const q = getStorageBrand("quark");
    expect(q.provider).toBe("quark");
    expect(q.label).toBe("夸克网盘");
    expect(q.resourceProviderKinds).toContain("pansou-quark");
    expect(q.resourceProviderKinds).not.toContain("prowlarr"); // 磁力对夸克隐藏
    expect(q.parseUid).toBe(parseQuarkUid);
    expect(q.isAuthError(new QuarkAuthError("x"))).toBe(true);
    expect(q.isAuthError(new Pan115AuthError("y"))).toBe(false);
  });

  it("getStorageBrand resolves pan115 keeping magnet sources", () => {
    const p = getStorageBrand("pan115");
    expect(p.provider).toBe("pan115");
    expect(p.label).toBe("115 网盘");
    expect(p.resourceProviderKinds).toContain("pansou-115");
    expect(p.resourceProviderKinds).toContain("prowlarr");
    expect(p.parseUid).toBe(parsePan115Uid);
    expect(p.isAuthError).toBe(isPan115AuthError);
  });

  it("each brand's isAuthError only matches its own auth error", () => {
    // sanity: the registry wires the right classifier per brand
    expect(isQuarkAuthError(new QuarkAuthError("x"))).toBe(true);
    expect(getStorageBrand("quark").isAuthError(new Error("plain"))).toBe(false);
  });

  it("unknown provider throws", () => {
    expect(() => getStorageBrand("baidu")).toThrowError(/unknown storage brand/i);
  });
});
