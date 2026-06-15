import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import {
  buildMovieSystemPrompt,
  buildTvAnimeSystemPrompt,
  needForMovie,
  needForTvTarget,
  runMovieTaskAgent,
  runTvAnimeTaskAgent,
} from "../src/acquisition-v2/task-agents.js";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { Storage115Simulator } from "../src/acquisition-v2/storage-115-simulator.js";

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;

function finishImmediatelyModel() {
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      if (i++ === 0) {
        return {
          content: [{ type: "tool-call" as const, toolCallId: "c1", toolName: "reportNoCoverage", input: JSON.stringify({ reason: "test stub: nothing covers it" }) }],
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
          usage: USAGE,
          warnings: [],
        };
      }
      return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: USAGE, warnings: [] };
    },
  });
}

async function sandboxFor(need: string[]) {
  const provider = new FakeResourceProviderV2({ results: { x: [] } });
  const storage = new Storage115Simulator({ packs: {} });
  const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
  const targetSeasonDirectoryId = await storage.createDirectory({ name: "Season 1", parentId: "root" });
  return new TaskSandbox({ provider, storage, stagingDirectoryId, targetSeasonDirectoryIds: { 1: targetSeasonDirectoryId }, need });
}

describe("need derivation", () => {
  it("movie coverage is the single MOVIE token", () => {
    expect(needForMovie()).toEqual(["MOVIE"]);
  });

  it("TV coverage is exactly the missing episode codes", () => {
    expect(needForTvTarget({ missingEpisodes: ["S01E11", "S01E12"] })).toEqual(["S01E11", "S01E12"]);
  });
});

describe("TV/anime system prompt carries the 字字泣血 invariants", () => {
  const prompt = buildTvAnimeSystemPrompt({});
  it.each([
    [/one (full-season|complete)[^.]*pack|transfer (just )?(it|one)/i, "full-season pack → one transfer"],
    [/re-?read|read back|forced reread|after (each|every) (write|transfer)/i, "force reread after writes"],
    [/keep the larger|larger file|保大|keep-larger/i, "dedup keep-larger"],
    [/flatten|wrapper (directory|dir)|peel/i, "flatten wrapper dir"],
    [/foreign work|different work|isolate|never (auto-?)?map/i, "isolate foreign works, never auto-map"],
    [/exists? (right )?now|present.*now|before you mark|only mark/i, "mark only when file present now"],
    [/stop|no (more|further).*(transfer|side effect)|once cover/i, "stop once coverage met"],
    [/do not rename|never rename|keep.*original name/i, "no renaming"],
    [/multi-season|complete-series|distribute.*season|moveToSeason\(fileIds, season\)/i, "multi-season pack distribution"],
    [/not recopied|already has|never recopy|leave the rest/i, "already-covered seasons not recopied"],
    [/unaired.*not missing|daily patrol|leave that gap|never fabricate/i, "ongoing/unobtainable honesty"],
    [/silently fail|magnet can|trust the staging reread|秒传/i, "magnet silent-fail / trust the reread"],
    [/never transfer a random|non-covering|clean the staging mess|never be left polluted/i, "no lucky-dip transfer; clean staging"],
    [/black-box|opaque|publish time|last resort/i, "black-box last resort + publish time"],
  ])("mentions %s (%s)", (re) => {
    expect(prompt).toMatch(re);
  });
});

describe("Movie system prompt carries movie-specific invariants", () => {
  const prompt = buildMovieSystemPrompt({});
  it.each([
    [/remake|same work|identity|year/i, "identity / year / no remake"],
    [/single (video )?file|one file|not a pack|reject.*pack/i, "single video file"],
    [/exists? (right )?now|present.*now|before you mark|only mark/i, "mark only when present"],
  ])("mentions %s (%s)", (re) => {
    expect(prompt).toMatch(re);
  });
});

describe("run wiring", () => {
  it("runTvAnimeTaskAgent drives the loop with the TV need and reports honest coverage", async () => {
    const need = needForTvTarget({ missingEpisodes: ["S01E01"] });
    const sandbox = await sandboxFor(need);
    const result = await runTvAnimeTaskAgent({
      sandbox,
      model: finishImmediatelyModel(),
      target: { title: "Show", aliases: [], seasons: [1], missingEpisodes: ["S01E01"], qualityPreference: "1080p" },
    });
    expect(result.coverage.missing).toEqual(["S01E01"]);
  });

  it("runMovieTaskAgent drives the loop with the MOVIE need", async () => {
    const sandbox = await sandboxFor(needForMovie());
    const result = await runMovieTaskAgent({
      sandbox,
      model: finishImmediatelyModel(),
      target: { title: "Some Film", aliases: [], year: 2025, qualityPreference: "1080p" },
    });
    expect(result.coverage.missing).toEqual(["MOVIE"]);
  });
});
