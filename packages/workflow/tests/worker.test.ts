import { describe, expect, it } from "vitest";
import {
  episodeCode,
  FakeAgentNodes,
  FakeResourceProvider,
  FakeStorageExecutor,
  InMemoryWorkflowRepository,
  queueTrackingInitialization,
  runQueuedType2Workflow,
  type MediaTitle,
  type TrackedSeason,
  type VerifiedFile,
} from "../src/index.js";

describe("runQueuedType2Workflow", () => {
  it("returns idle when no queued type2 run exists", async () => {
    const result = await runQueuedType2Workflow({
      repository: new InMemoryWorkflowRepository(),
      resourceProvider: new FakeResourceProvider({ keywordResults: {} }),
      storage: new FakeStorageExecutor(),
      agents: new FakeAgentNodes(),
      storageParentDirectoryId: "library_root",
      now: fixedNow,
    });

    expect(result).toEqual({ status: "idle" });
  });

  it("claims one queued type2 run, executes it, and persists the result", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = trackedFixture();
    await queueTrackingInitialization({
      title,
      season,
      keyword: "Show 4K",
      repository,
      createWorkflowRunId: () => "run_queued_type2",
      now: fixedNow,
    });

    const result = await runQueuedType2Workflow({
      repository,
      resourceProvider: new FakeResourceProvider({
        keywordResults: {
          "Show 4K": [{ title: "Show S01E01 4K", episodeHints: ["S01E01"], qualityHints: ["4K"] }],
        },
      }),
      storage: new FakeStorageExecutor({
        directories: { [season.storageDirectoryId]: [] },
        transferOutcomes: {
          snapshot_1_candidate_1: {
            status: "succeeded",
            providerMessage: "",
            files: [verifiedFile(season, "file_S01E01", "S01E01")],
          },
        },
      }),
      agents: new FakeAgentNodes(),
      storageParentDirectoryId: "library_root",
      now: fixedNow,
    });

    expect(result).toMatchObject({
      status: "ran",
      workflowRunId: "run_queued_type2",
      workflowStatus: "succeeded",
    });
    await expect(repository.getWorkflowRunSnapshot("run_queued_type2")).resolves.toMatchObject({
      workflowRun: {
        id: "run_queued_type2",
        status: "succeeded",
      },
      obtainedEpisodes: ["S01E01"],
    });
  });

  it("marks a claimed queued run as failed and clears initial episode state when execution fails", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = trackedFixture();
    await queueTrackingInitialization({
      title,
      season,
      keyword: "Show 4K",
      repository,
      createWorkflowRunId: () => "run_failing_type2",
      now: fixedNow,
    });

    const result = await runQueuedType2Workflow({
      repository,
      resourceProvider: new FakeResourceProvider({
        keywordResults: {},
        keywordErrors: { "Show 4K": "provider unavailable" },
      }),
      storage: new FakeStorageExecutor(),
      agents: new FakeAgentNodes(),
      storageParentDirectoryId: "library_root",
      now: fixedNow,
    });

    expect(result).toMatchObject({
      status: "failed",
      workflowRunId: "run_failing_type2",
      errorMessage: "provider unavailable",
    });
    await expect(repository.getWorkflowRunSnapshot("run_failing_type2")).resolves.toMatchObject({
      workflowRun: {
        status: "failed",
        auditEvents: [
          { type: "workflow_reserved" },
          { type: "tracking_request_queued" },
          { type: "workflow_claimed" },
          { type: "workflow_failed" },
        ],
      },
      episodes: [],
    });
    await expect(repository.listEpisodeStates(season.id)).resolves.toEqual([]);
  });
});

function trackedFixture(): { title: MediaTitle; season: TrackedSeason } {
  const title: MediaTitle = {
    id: "title_show",
    tmdbId: 123,
    type: "tv",
    title: "Show",
    originalTitle: "Show",
    year: 2026,
    aliases: [],
  };
  return {
    title,
    season: {
      id: "season_show_1",
      mediaTitleId: title.id,
      seasonNumber: 1,
      status: "active",
      qualityPreference: "4K",
      storageDirectoryId: "dir_show_s1",
      totalEpisodes: 2,
      latestAiredEpisode: 1,
      latestAiredSource: "metadata",
    },
  };
}

function fixedNow(): string {
  return "2026-06-11T00:00:00.000Z";
}

function verifiedFile(season: TrackedSeason, id: string, code: string): VerifiedFile {
  return {
    id,
    storageDirectoryId: season.storageDirectoryId,
    name: `Show.${episodeCode(season.seasonNumber, Number(code.slice(-2)))}.mkv`,
    sizeBytes: 1_000_000_000,
    episodeCode: code,
    providerFileId: `provider_${id}`,
  };
}
