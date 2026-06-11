import { describe, expect, it } from "vitest";
import {
  createEpisodeStates,
  FakeAgentNodes,
  FakeResourceProvider,
  FakeStorageExecutor,
  reconcileVerifiedFiles,
  runType3Monitoring,
  type MediaTitle,
  type TrackedSeason,
  type VerifiedFile,
} from "../src/index.js";

function qiaochuFixture() {
  const title: MediaTitle = {
    id: "title_qiaochu",
    tmdbId: 289271,
    type: "tv",
    title: "翘楚",
    originalTitle: "翘楚",
    year: 2026,
    aliases: ["Ashes to Crown"],
  };
  const season: TrackedSeason = {
    id: "season_qiaochu_1",
    mediaTitleId: title.id,
    seasonNumber: 1,
    status: "active",
    qualityPreference: "4K",
    storageDirectoryId: "dir_qiaochu_s1",
    totalEpisodes: 24,
    latestAiredEpisode: 14,
    latestAiredSource: "metadata",
  };
  return { title, season };
}

describe("runType3Monitoring", () => {
  it("repairs externally deleted episodes and uses fallback when primary transfer does not materialize", async () => {
    const { title, season } = qiaochuFixture();
    const existingFiles: VerifiedFile[] = Array.from({ length: 12 }, (_, index) => {
      const episode = `S01E${String(index + 1).padStart(2, "0")}`;
      return {
        id: `file_${episode}`,
        storageDirectoryId: season.storageDirectoryId,
        name: `翘楚.${episode}.mkv`,
        sizeBytes: 1_000_000_000,
        episodeCode: episode,
        providerFileId: `provider_${episode}`,
      };
    });
    const initialEpisodes = reconcileVerifiedFiles({
      season,
      episodes: createEpisodeStates({
        trackedSeasonId: season.id,
        seasonNumber: season.seasonNumber,
        totalEpisodes: season.totalEpisodes,
        latestAiredEpisode: season.latestAiredEpisode,
      }),
      files: [
        ...existingFiles,
        {
          id: "missing_old_13",
          storageDirectoryId: season.storageDirectoryId,
          name: "old.S01E13.mkv",
          sizeBytes: 1,
          episodeCode: "S01E13",
          providerFileId: "old_13",
        },
        {
          id: "missing_old_14",
          storageDirectoryId: season.storageDirectoryId,
          name: "old.S01E14.mkv",
          sizeBytes: 1,
          episodeCode: "S01E14",
          providerFileId: "old_14",
        },
      ],
    });
    const storage = new FakeStorageExecutor({
      directories: { [season.storageDirectoryId]: existingFiles },
      transferOutcomes: {
        snapshot_1_candidate_1: {
          status: "no_target_change",
          providerMessage: "already transferred elsewhere",
          files: [],
        },
        snapshot_1_candidate_2: {
          status: "succeeded",
          providerMessage: "",
          files: [
            {
              id: "restored_13",
              storageDirectoryId: season.storageDirectoryId,
              name: "翘楚.S01E13.restored.mkv",
              sizeBytes: 5_000_000_000,
              episodeCode: "S01E13",
              providerFileId: "restored_provider_13",
            },
          ],
        },
        snapshot_1_candidate_3: {
          status: "succeeded",
          providerMessage: "",
          files: [
            {
              id: "restored_14",
              storageDirectoryId: season.storageDirectoryId,
              name: "翘楚.S01E14.restored.mkv",
              sizeBytes: 5_000_000_000,
              episodeCode: "S01E14",
              providerFileId: "restored_provider_14",
            },
          ],
        },
      },
    });
    const resourceProvider = new FakeResourceProvider({
      keywordResults: {
        "翘楚 4K": [
          { title: "翘楚 S01E13 primary", episodeHints: ["S01E13"] },
          { title: "翘楚 S01E13 fallback", episodeHints: ["S01E13"] },
          { title: "翘楚 S01E14 fallback", episodeHints: ["S01E14"] },
        ],
      },
    });

    const result = await runType3Monitoring({
      title,
      season,
      episodes: initialEpisodes,
      keyword: "翘楚 4K",
      resourceProvider,
      storage,
      agents: new FakeAgentNodes(),
    });

    expect(result.status).toBe("succeeded");
    expect(result.transferAttempts.map((attempt) => attempt.status)).toEqual([
      "no_target_change",
      "succeeded",
      "succeeded",
    ]);
    expect(result.obtainedEpisodes).toContain("S01E13");
    expect(result.obtainedEpisodes).toContain("S01E14");
    expect(result.notification.body).toContain("2 episodes restored");
    expect(result.notifications).toEqual([result.notification]);
  });
});
