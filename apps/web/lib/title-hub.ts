import {
  createTmdbMetadataProviderFromEnv,
  getTrackedSeasonStatusView,
  prepareSeriesTarget,
  queueSeriesInitialization,
  queueTrackingInitialization,
  type EpisodeStatusCell,
  type MediaTitle,
  type PreparedSeriesTarget,
} from "@media-track/workflow";
import { findDemoCandidateByTmdbId } from "./demo-candidates";
import {
  ensureDemoSeeded,
  getWorkflowRepository,
  queueCandidateTracking,
  type CandidateTrackingRequestResult,
} from "./workflow-runtime";

export interface TitleHubSeason {
  seasonNumber: number;
  totalEpisodes: number;
  latestAiredEpisode: number;
  tracked: boolean;
  /** TrackedSeason status when tracked. */
  status: "active" | "completed" | null;
  obtainedCount: number;
  missingAiredCount: number;
  trackedSeasonId: string | null;
  episodes: EpisodeStatusCell[];
}

export type TitleAggregateState = "untracked" | "tracking" | "partial" | "complete";

export interface TitleHubView {
  tmdbId: number;
  title: string;
  originalTitle: string;
  year: number;
  overview: string;
  posterPath: string | null;
  backdropPath: string | null;
  aggregate: TitleAggregateState;
  seasons: TitleHubSeason[];
  untrackedSeasonNumbers: number[];
  /** A queued/running acquisition for this title — disables all acquire buttons. */
  acquiring: boolean;
}

const SERIES_TARGET_TTL_MS = 6 * 60 * 60 * 1000;
const seriesTargetCache = new Map<number, { value: PreparedSeriesTarget; expiresAt: number }>();

/**
 * Season metadata + artwork for a title, independent of tracking state.
 * Live TMDB when configured (cached 6h per title), demo candidates otherwise,
 * null when the title is unknown to both.
 */
async function seriesTargetFor(tmdbId: number): Promise<PreparedSeriesTarget | null> {
  if (process.env.MEDIA_TRACK_SEARCH_PROVIDER === "tmdb" && process.env.TMDB_READ_TOKEN) {
    const cached = seriesTargetCache.get(tmdbId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    try {
      const value = await prepareSeriesTarget({
        tmdbId,
        qualityPreference: process.env.MEDIA_TRACK_DEFAULT_QUALITY ?? "4K",
        metadataProvider: createTmdbMetadataProviderFromEnv(),
      });
      seriesTargetCache.set(tmdbId, { value, expiresAt: Date.now() + SERIES_TARGET_TTL_MS });
      return value;
    } catch {
      return seriesTargetCache.get(tmdbId)?.value ?? null;
    }
  }

  const candidate = findDemoCandidateByTmdbId(tmdbId);
  if (!candidate || candidate.mediaType !== "tv") {
    return null;
  }
  const title: MediaTitle = {
    id: `tmdb_tv_${candidate.tmdbId}`,
    tmdbId: candidate.tmdbId,
    type: "tv",
    title: candidate.title,
    originalTitle: candidate.originalTitle,
    year: candidate.year,
    aliases:
      candidate.originalTitle && candidate.originalTitle !== candidate.title
        ? [candidate.originalTitle]
        : [],
    posterPath: candidate.posterPath,
    backdropPath: candidate.backdropPath,
    overview: candidate.overview,
  };
  return {
    title,
    seasons: candidate.seasons.map((season) => ({
      seasonNumber: season.seasonNumber,
      totalEpisodes: season.episodeCount,
      latestAiredEpisode: season.latestAiredEpisode,
    })),
    keyword: `${candidate.title} ${process.env.MEDIA_TRACK_DEFAULT_QUALITY ?? "4K"}`.trim(),
  };
}

export async function getTitleHubView(tmdbId: number): Promise<TitleHubView | null> {
  const repository = getWorkflowRepository();
  await ensureDemoSeeded(repository);
  const trackedStates = (await repository.listTrackedSeasonStates()).filter(
    // tv AND anime are season-shaped detail pages; only movies are excluded.
    (state) => state.title.tmdbId === tmdbId && state.title.type !== "movie",
  );
  const target = await seriesTargetFor(tmdbId);
  if (trackedStates.length === 0 && target === null) {
    return null;
  }

  const dbTitle = trackedStates[0]?.title;
  const meta = {
    title: dbTitle?.title ?? target?.title.title ?? `TMDB ${tmdbId}`,
    originalTitle: dbTitle?.originalTitle ?? target?.title.originalTitle ?? "",
    year: dbTitle?.year ?? target?.title.year ?? 0,
    overview: dbTitle?.overview ?? target?.title.overview ?? "",
    posterPath: dbTitle?.posterPath ?? target?.title.posterPath ?? null,
    backdropPath: dbTitle?.backdropPath ?? target?.title.backdropPath ?? null,
  };

  const trackedBySeason = new Map(trackedStates.map((state) => [state.season.seasonNumber, state]));
  const seasonNumbers = [
    ...new Set([
      ...(target?.seasons.map((season) => season.seasonNumber) ?? []),
      ...trackedStates.map((state) => state.season.seasonNumber),
    ]),
  ].sort((a, b) => a - b);

  const seasons: TitleHubSeason[] = [];
  for (const seasonNumber of seasonNumbers) {
    const tracked = trackedBySeason.get(seasonNumber);
    const targetSeason = target?.seasons.find((season) => season.seasonNumber === seasonNumber);
    if (tracked) {
      const view = await getTrackedSeasonStatusView({
        repository,
        trackedSeasonId: tracked.season.id,
      });
      seasons.push({
        seasonNumber,
        totalEpisodes: tracked.season.totalEpisodes,
        latestAiredEpisode: tracked.season.latestAiredEpisode,
        tracked: true,
        status: tracked.season.status === "completed" ? "completed" : "active",
        obtainedCount: view?.obtainedCount ?? 0,
        missingAiredCount: view?.missingAiredCount ?? 0,
        trackedSeasonId: tracked.season.id,
        episodes: view?.episodes ?? [],
      });
    } else if (targetSeason) {
      seasons.push({
        seasonNumber,
        totalEpisodes: targetSeason.totalEpisodes,
        latestAiredEpisode: targetSeason.latestAiredEpisode,
        tracked: false,
        status: null,
        obtainedCount: 0,
        missingAiredCount: 0,
        trackedSeasonId: null,
        episodes: [],
      });
    }
  }

  const untrackedSeasonNumbers = seasons
    .filter((season) => !season.tracked)
    .map((season) => season.seasonNumber);
  const anyTracked = seasons.some((season) => season.tracked);
  const anyActive = seasons.some((season) => season.tracked && season.status === "active");
  const anyMissing = seasons.some((season) => season.tracked && season.missingAiredCount > 0);
  const aggregate: TitleAggregateState = !anyTracked
    ? "untracked"
    : untrackedSeasonNumbers.length > 0 || anyMissing
      ? "partial"
      : anyActive
        ? "tracking"
        : "complete";

  const acquiring = (await repository.listActiveWorkflowRuns()).some(
    (snapshot) => snapshot.title.tmdbId === tmdbId,
  );

  return {
    tmdbId,
    ...meta,
    aggregate,
    seasons,
    untrackedSeasonNumbers,
    acquiring,
  };
}

export async function queueSeasonTracking(
  tmdbId: number,
  seasonNumber: number,
): Promise<CandidateTrackingRequestResult> {
  return queueCandidateTracking(`tmdb_tv_${tmdbId}_s${seasonNumber}`);
}

/**
 * "获取剩余": series initialization scoped to the seasons that have no
 * tracking state yet. Already-tracked seasons stay owned by their own
 * lifecycle (Type 3 for active ones); the reconcile step makes any
 * resource overlap harmless.
 */
export async function queueRemainingSeasons(
  tmdbId: number,
): Promise<CandidateTrackingRequestResult> {
  const repository = getWorkflowRepository();
  await ensureDemoSeeded(repository);
  const target = await seriesTargetFor(tmdbId);
  if (!target) {
    return { status: "unsupported", message: "无法获取该剧的季信息。" };
  }
  const trackedSeasonNumbers = new Set(
    (await repository.listTrackedSeasonStates())
      .filter((state) => state.title.tmdbId === tmdbId && state.title.type !== "movie")
      .map((state) => state.season.seasonNumber),
  );
  const remaining = target.seasons.filter(
    (season) => !trackedSeasonNumbers.has(season.seasonNumber),
  );
  if (remaining.length === 0) {
    return {
      status: "already_tracked",
      workflowRunId: null,
      trackedSeasonId: `tmdb_tv_${tmdbId}_s${target.seasons[0]?.seasonNumber ?? 1}`,
    };
  }
  const request = await queueSeriesInitialization({
    title: target.title,
    seasons: remaining,
    keyword: target.keyword,
    repository,
  });
  return {
    status: request.status === "queued" ? "queued" : request.status,
    workflowRunId: request.workflowRunId,
    trackedSeasonId: `tmdb_tv_${tmdbId}_s${remaining[0]?.seasonNumber ?? 1}`,
  };
}

export interface LibraryWallEntry {
  tmdbId: number;
  title: string;
  year: number;
  type: "movie" | "tv" | "anime";
  posterPath: string | null;
  seasonCount: number;
  obtainedEpisodes: number;
  totalAiredEpisodes: number;
  state: "tracking" | "complete" | "partial";
}

export interface LibraryTypeCounts {
  movie: number;
  tv: number;
  anime: number;
}

/** Poster-wall view of every tracked title. */
export async function getLibraryWall(): Promise<LibraryWallEntry[]> {
  const repository = getWorkflowRepository();
  await ensureDemoSeeded(repository);
  const states = await repository.listTrackedSeasonStates();
  const byTitle = new Map<number, typeof states>();
  for (const state of states) {
    const list = byTitle.get(state.title.tmdbId) ?? [];
    list.push(state);
    byTitle.set(state.title.tmdbId, list);
  }

  const entries: LibraryWallEntry[] = [];
  for (const [tmdbId, titleStates] of byTitle) {
    const title = titleStates[0]!.title;
    let posterPath = title.posterPath ?? null;
    if (posterPath === null) {
      // Titles tracked before artwork persistence landed: enrich lazily
      // (cached 6h); future runs persist the poster with the title itself.
      posterPath = (await seriesTargetFor(tmdbId))?.title.posterPath ?? null;
    }
    let obtained = 0;
    let aired = 0;
    let anyActive = false;
    for (const state of titleStates) {
      aired += Math.min(state.season.latestAiredEpisode, state.season.totalEpisodes);
      obtained += state.episodes.filter((episode) => episode.obtained).length;
      if (state.season.status === "active") {
        anyActive = true;
      }
    }
    entries.push({
      tmdbId,
      title: title.title,
      year: title.year,
      type: title.type,
      posterPath,
      seasonCount: titleStates.length,
      obtainedEpisodes: obtained,
      totalAiredEpisodes: aired,
      state: obtained < aired ? "partial" : anyActive ? "tracking" : "complete",
    });
  }
  return entries.sort((a, b) => a.title.localeCompare(b.title, "zh-Hans-CN"));
}

export interface InProgressTitle {
  tmdbId: number;
  title: string;
  year: number;
  type: "movie" | "tv" | "anime";
  posterPath: string | null;
}

/**
 * Titles with an acquisition run still queued/running — they surface in the
 * library as non-clickable "获取中" poster placeholders until the run finishes
 * and the title materializes as a real card.
 */
export async function getInProgressTitles(): Promise<InProgressTitle[]> {
  const repository = getWorkflowRepository();
  const active = await repository.listActiveWorkflowRuns();
  const byTmdb = new Map<number, InProgressTitle>();
  for (const snapshot of active) {
    const title = snapshot.title;
    if (byTmdb.has(title.tmdbId)) {
      continue;
    }
    let posterPath = title.posterPath ?? null;
    if (posterPath === null) {
      posterPath = (await seriesTargetFor(title.tmdbId))?.title.posterPath ?? null;
    }
    byTmdb.set(title.tmdbId, {
      tmdbId: title.tmdbId,
      title: title.title,
      year: title.year,
      type: title.type,
      posterPath,
    });
  }
  return [...byTmdb.values()];
}

/** Get count of each media type in the library. */
export function getLibraryTypeCounts(entries: LibraryWallEntry[]): LibraryTypeCounts {
  return {
    movie: entries.filter((entry) => entry.type === "movie").length,
    tv: entries.filter((entry) => entry.type === "tv").length,
    anime: entries.filter((entry) => entry.type === "anime").length,
  };
}
