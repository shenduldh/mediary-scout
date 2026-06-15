import { describe, expect, it } from "vitest";
import { CandidateRegistry } from "../src/acquisition-v2/candidate-registry.js";
import { RealResourceProviderV2 } from "../src/acquisition-v2/real-provider-adapter.js";
import type { ResourceProvider } from "../src/ports.js";
import type { ResourceSnapshot } from "../src/domain.js";

function realSnapshot(): ResourceSnapshot {
  return {
    id: "snap_real_1",
    provider: "pansou",
    keyword: "莉可丽丝 全集",
    createdAt: "2026-06-14T00:00:00.000Z",
    candidates: [
      {
        id: "cand_a",
        snapshotId: "snap_real_1",
        index: 0,
        title: "莉可丽丝 全集 1080p",
        type: "115",
        source: "pansou",
        episodeHints: ["1-13"],
        qualityHints: ["1080p"],
        providerPayload: { url: "https://115.com/s/abc", receiveCode: "x1" },
      },
    ],
  };
}

describe("RealResourceProviderV2 — pansou → ResourceProviderV2 adapter", () => {
  it("maps a real snapshot to the V2 shape and records candidates in the registry", async () => {
    const calls: Array<{ keyword: string; workflowRunId?: string }> = [];
    const provider: ResourceProvider = {
      search: async (input) => {
        calls.push(input);
        return realSnapshot();
      },
    };
    const registry = new CandidateRegistry();
    const adapter = new RealResourceProviderV2({ provider, registry, workflowRunId: "run-1" });

    const snapshot = await adapter.search("莉可丽丝 全集");

    // V2 shape: id/keyword/candidates with only the fields the agent judges from.
    expect(snapshot.id).toBe("snap_real_1");
    expect(snapshot.candidates).toEqual([
      { id: "cand_a", title: "莉可丽丝 全集 1080p", episodeHints: ["1-13"], qualityHints: ["1080p"] },
    ]);
    // The run id is threaded so content-addressed snapshots don't collide across runs.
    expect(calls[0]).toEqual({ keyword: "莉可丽丝 全集", workflowRunId: "run-1" });
    // The real candidate (with its share payload) is recorded so the storage
    // adapter can transfer it later by id — the agent never sees the raw url.
    const recorded = registry.get("cand_a");
    expect(recorded?.providerPayload).toEqual({ url: "https://115.com/s/abc", receiveCode: "x1" });
  });

  it("records every candidate across multiple searches (registry accumulates)", async () => {
    const provider: ResourceProvider = { search: async () => realSnapshot() };
    const registry = new CandidateRegistry();
    const adapter = new RealResourceProviderV2({ provider, registry, workflowRunId: "run-1" });

    await adapter.search("k1");
    expect(registry.get("cand_a")).toBeDefined();
    expect(registry.get("missing")).toBeUndefined();
  });
});
