import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { runMovieAcquisitionV2 } from "../src/movie-workflow-v2.js";
import { FakeStorageExecutor } from "../src/fakes.js";
import type { ResourceProvider } from "../src/ports.js";
import type { MediaTitle, ResourceSnapshot } from "../src/domain.js";

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;

function emptyProvider(): ResourceProvider {
  return {
    search: async ({ keyword }): Promise<ResourceSnapshot> => ({
      id: "snap_empty",
      provider: "pansou",
      keyword,
      candidates: [],
      createdAt: "2026-06-14T00:00:00.000Z",
    }),
  };
}

function searchThenReportModel() {
  let i = 0;
  const tool = (name: string, input: unknown) => ({
    content: [{ type: "tool-call" as const, toolCallId: `c${i}`, toolName: name, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
    usage: USAGE,
    warnings: [],
  });
  return new MockLanguageModelV3({
    doGenerate: async () => {
      i += 1;
      if (i === 1) return tool("searchResources", { keyword: "盗梦空间" });
      if (i === 2) return tool("reportNoCoverage", { reason: "no candidates" });
      return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: USAGE, warnings: [] };
    },
  });
}

const title = {
  id: "tmdb_movie_27205",
  title: "盗梦空间",
  year: 2010,
  aliases: ["Inception"],
  type: "movie",
} as unknown as MediaTitle;

describe("runMovieAcquisitionV2 — movie on the V2 engine → MovieWorkflowResult", () => {
  it("no coverage → status no_coverage, the synthetic movie episode is not obtained, honest notification", async () => {
    const executor = new FakeStorageExecutor();
    const result = await runMovieAcquisitionV2({
      title,
      resourceProvider: emptyProvider(),
      storage: executor,
      model: searchThenReportModel(),
      workflowRunId: "run-m1",
      stagingParentDirectoryId: "movies_root",
      moviesParentDirectoryId: "movies_root",
      now: () => "2026-06-14T00:00:00.000Z",
    });

    expect(result.status).toBe("no_coverage");
    expect(result.title.title).toBe("盗梦空间");
    expect(result.episodes).toHaveLength(1); // the single synthetic movie episode
    expect(result.episodes[0]!.obtained).toBe(false);
    expect(result.notification.kind).toBe("no_coverage");
    expect(result.season.storageDirectoryId).toContain("movies_root"); // movie dir verify-or-created
  });
});
