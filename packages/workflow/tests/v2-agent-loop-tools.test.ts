import { describe, expect, it } from "vitest";
import { buildSandboxToolSet } from "../src/acquisition-v2/agent-loop.js";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { Storage115Simulator } from "../src/acquisition-v2/storage-115-simulator.js";

async function setup(need: string[] = ["S01E01"]) {
  const provider = new FakeResourceProviderV2({
    results: { show: [{ id: "cand", title: "Show", episodeHints: [], qualityHints: [] }] },
  });
  const storage = new Storage115Simulator({ packs: { cand: { files: [{ path: "Show - 01.mkv", sizeBytes: 9 }] } } });
  const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
  const targetSeasonDirectoryId = await storage.createDirectory({ name: "Season 1", parentId: "root" });
  const sandbox = new TaskSandbox({ provider, storage, stagingDirectoryId, targetSeasonDirectoryIds: { 1: targetSeasonDirectoryId }, need });
  return { sandbox };
}

async function call(
  tool: { execute?: (args: unknown, opts: unknown) => PromiseLike<unknown> } | undefined,
  args: unknown,
) {
  if (!tool?.execute) {
    throw new Error("Expected sandbox tool to expose execute()");
  }
  return tool.execute(args, { toolCallId: "t", messages: [] }) as PromiseLike<Record<string, unknown>>;
}

describe("buildSandboxToolSet — the agent's tool surface over the cage", () => {
  it("exposes exactly the sandbox tools the loop drives", async () => {
    const { sandbox } = await setup();
    const tools = buildSandboxToolSet(sandbox);
    expect(Object.keys(tools).sort()).toEqual(
      [
        "deleteFiles",
        "finish",
        "flattenPack",
        "inspectStaging",
        "inspectStagingDirs",
        "inspectTargetDir",
        "markObtained",
        "moveToSeason",
        "reportNoCoverage",
        "searchResources",
        "transferCandidate",
      ].sort(),
    );
  });

  it("drives the sandbox: search → transfer returns forced-reread evidence", async () => {
    const { sandbox } = await setup();
    const tools = buildSandboxToolSet(sandbox);

    const search = await call(tools.searchResources, { keyword: "show" });
    const snapshotId = (search.snapshot as { id: string }).id;
    const transfer = await call(tools.transferCandidate, { snapshotId, candidateId: "cand" });

    expect((transfer.attempt as { status: string }).status).toBe("succeeded");
    expect((transfer.staging as unknown[]).length).toBe(1);
  });

  it("surfaces a guard refusal as {error} the agent can read and adapt to (no loop crash)", async () => {
    const { sandbox } = await setup();
    const tools = buildSandboxToolSet(sandbox);

    // markObtained against a file that does not exist must come back as an error
    // string, not throw out of the tool loop.
    const result = await call(tools.markObtained, { episodes: [{ code: "S01E01", fileId: "ghost" }] });

    expect(result.error).toMatch(/FILE_NOT_PRESENT/);
  });

  it("finish returns the honest coverage summary through the tool surface", async () => {
    const { sandbox } = await setup(["S01E01", "S01E02"]);
    const tools = buildSandboxToolSet(sandbox);
    const search = await call(tools.searchResources, { keyword: "show" });
    const snapshotId = (search.snapshot as { id: string }).id;
    const transfer = await call(tools.transferCandidate, { snapshotId, candidateId: "cand" });
    const staging = transfer.staging as Array<{ id: string }>;
    const moved = await call(tools.moveToSeason, { fileIds: staging.map((f) => f.id), season: 1 });
    const season = moved.season as Array<{ id: string }>;
    await call(tools.markObtained, { episodes: [{ code: "S01E01", fileId: season[0]!.id }] });

    const summary = await call(tools.finish, {});
    expect(summary.coverageMet).toBe(false);
    expect(summary.missing).toEqual(["S01E02"]);
  });
});
