import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { runAcquisitionAgent } from "../src/acquisition-v2/agent-loop.js";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { Storage115Simulator } from "../src/acquisition-v2/storage-115-simulator.js";

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;

/** A model scripted by a queue of step outputs: each is either a tool call or
 *  final text. The AI SDK feeds tool results back between steps automatically. */
function scriptedModel(steps: Array<{ tool: string; input: unknown } | { text: string }>) {
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const step = steps[i++]!;
      if ("text" in step) {
        return { content: [{ type: "text" as const, text: step.text }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: USAGE, warnings: [] };
      }
      return {
        content: [{ type: "tool-call" as const, toolCallId: `c${i}`, toolName: step.tool, input: JSON.stringify(step.input) }],
        finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
        usage: USAGE,
        warnings: [],
      };
    },
  });
}

async function setup(need: string[]) {
  const provider = new FakeResourceProviderV2({
    results: { "lycoris recoil": [{ id: "full_pack", title: "Lycoris Recoil S01 全集", episodeHints: [], qualityHints: [] }] },
  });
  const storage = new Storage115Simulator({
    packs: { full_pack: { files: [{ path: "[Grp] LR/LR - 01.mkv", sizeBytes: 100 }] } },
  });
  const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
  const targetSeasonDirectoryId = await storage.createDirectory({ name: "Season 1", parentId: "root" });
  const sandbox = new TaskSandbox({ provider, storage, stagingDirectoryId, targetSeasonDirectoryIds: { 1: targetSeasonDirectoryId }, need });
  return { sandbox, storage, targetSeasonDirectoryId };
}

describe("runAcquisitionAgent — the real AI SDK tool-loop over the sandbox", () => {
  it("drives a full search→transfer→extract→mark→finish loop and reads honest coverage", async () => {
    const { sandbox, storage, targetSeasonDirectoryId } = await setup(["S01E01"]);

    // A statically-scripted model can't read ids that the loop discovers at
    // runtime, so we pre-roll the storage into the post-extract state to learn
    // the real season file id, then let the model drive a fresh sandbox over
    // that same storage (inspect → mark → finish).
    const search = await sandbox.searchResources("lycoris recoil");
    const transfer = await sandbox.transferCandidate({ snapshotId: search.snapshot!.id, candidateId: "full_pack" });
    const stagingFileId = transfer.staging[0]!.id;
    const moved = await sandbox.moveToSeason({ fileIds: [stagingFileId], season: 1 });
    const seasonFileId = moved.season[0]!.id;
    // Now a fresh sandbox over the SAME storage state, driven purely by the model.
    const liveSandbox = new TaskSandbox({
      provider: new FakeResourceProviderV2({ results: {} }),
      storage,
      stagingDirectoryId: (await storage.listSubdirectories({ directoryId: "root" })).find((d) => d.path === "staging")!.id,
      targetSeasonDirectoryIds: { 1: targetSeasonDirectoryId },
      need: ["S01E01"],
    });

    const model = scriptedModel([
      { tool: "inspectTargetDir", input: {} },
      { tool: "markObtained", input: { episodes: [{ code: "S01E01", fileId: seasonFileId }] } },
      { tool: "finish", input: {} },
      { text: "Covered S01E01 from the existing season file." },
    ]);

    const result = await runAcquisitionAgent({
      sandbox: liveSandbox,
      model,
      system: "You acquire media into the scoped sandbox.",
      prompt: "Ensure S01E01 is obtained.",
      maxSteps: 10,
    });

    expect(result.coverage.coverageMet).toBe(true);
    expect(result.coverage.obtained).toEqual(["S01E01"]);
    expect(result.text).toMatch(/Covered/);
    expect(result.steps).toBeGreaterThanOrEqual(3);
  });

  it("the cage still bites inside the loop: a bad markObtained comes back as error evidence, not a crash", async () => {
    const { sandbox } = await setup(["S01E01"]);
    const model = scriptedModel([
      { tool: "markObtained", input: { episodes: [{ code: "S01E01", fileId: "ghost" }] } },
      { text: "I could not find a backing file for S01E01." },
    ]);

    const result = await runAcquisitionAgent({
      sandbox,
      model,
      system: "You acquire media into the scoped sandbox.",
      prompt: "Ensure S01E01 is obtained.",
      maxSteps: 10,
    });

    // The loop completed (no throw); coverage honestly unmet.
    expect(result.coverage.coverageMet).toBe(false);
    expect(result.coverage.missing).toEqual(["S01E01"]);
  });
});
