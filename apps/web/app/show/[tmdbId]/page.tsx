import { connection } from "next/server";
import { Suspense } from "react";
import { TriangleAlert } from "lucide-react";
import { AcquiringPoller } from "../../../components/acquiring-poller";
import { AcquisitionLockProvider } from "../../../components/acquisition-lock";
import { AppSidebar } from "../../../components/app-sidebar";
import { BackLink } from "../../../components/back-link";
import {
  RequestRemainingButton,
  RequestSeasonButton,
} from "../../../components/title-action-buttons";
import {
  getDetailView,
  type MovieHubView,
  type TitleHubSeason,
  type TitleHubView,
} from "../../../lib/title-hub";
import { seasonBadgeState } from "../../../lib/title-aggregate";

const aggregateBadge = {
  untracked: null,
  tracking: { label: "追更中", tone: "indigo" },
  partial: { label: "部分入库", tone: "amber" },
  complete: { label: "已全部入库", tone: "green" },
} as const;

const seasonBadge = {
  untracked: null,
  missing: { label: "缺集", tone: "amber" },
  airing: { label: "追更中", tone: "indigo" },
  complete: { label: "已完结", tone: "green" },
} as const;

export default async function ShowPage({
  params,
  searchParams,
}: {
  params: Promise<{ tmdbId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  // 搜索是搜索，媒体库是媒体库: the title page belongs to whichever surface
  // the user came FROM. Entry links carry ?from=search|library; back keeps
  // the previous list state (history.back preserves the search query).
  const fromParam = ((await searchParams) ?? {})["from"];
  const from = fromParam === "library" ? "library" : fromParam === "search" ? "search" : null;

  return (
    <div className="app-shell">
      <AppSidebar active={from ?? "none"} />
      <main className="main product-main">
        <BackLink
          label={from === "search" ? "返回搜索" : from === "library" ? "返回媒体库" : "返回"}
          fallbackHref={from === "library" ? "/?tab=library" : "/?tab=search"}
        />
        {/* Contextual skeleton for the genuine first render (the data itself is a
            fast DB read; this covers the dev/cold render + transport). A re-visit
            within the staleTimes window is served from the client Router Cache, so
            it renders instantly without this. NOT the global search skeleton — that
            was the wrong shape on /show and was removed with app/loading.tsx. */}
        <Suspense fallback={<HubSkeleton />}>
          <TitleHub params={params} />
        </Suspense>
      </main>
    </div>
  );
}

async function TitleHub({ params }: { params: Promise<{ tmdbId: string }> }) {
  await connection();
  const { tmdbId: tmdbIdParam } = await params;
  const tmdbId = Number(tmdbIdParam);
  const view = Number.isInteger(tmdbId) ? await getDetailView(tmdbId) : null;

  if (!view) {
    return (
      <div className="quiet-state">
        <TriangleAlert size={24} aria-hidden />
        <strong>没有找到这部影片</strong>
        <span>回到搜索页重新查找。</span>
      </div>
    );
  }

  return view.kind === "movie" ? <MovieHub view={view} /> : <TvHub view={view} />;
}

function TvHub({ view }: { view: TitleHubView }) {
  const badge = aggregateBadge[view.aggregate];
  return (
    <AcquisitionLockProvider>
    {view.acquiring ? <AcquiringPoller /> : null}
    <section className="title-hub">
      {view.backdropPath ? (
        <div
          className="hub-backdrop"
          style={{ backgroundImage: `url(https://image.tmdb.org/t/p/w1280${view.backdropPath})` }}
          aria-hidden
        />
      ) : null}

      <header className="hub-header">
        <div className="hub-poster">
          {view.posterPath ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`https://image.tmdb.org/t/p/w342${view.posterPath}`}
              alt={`${view.title} 海报`}
            />
          ) : (
            <span className="poster-fallback">{view.title.slice(0, 4)}</span>
          )}
        </div>
        <div className="hub-title-block">
          {badge ? <span className={`hub-badge tone-${badge.tone}`}>{badge.label}</span> : null}
          <h1>
            {view.title} <span className="hub-year">({view.year})</span>
          </h1>
          <p className="hub-attributes">
            {view.seasons.length} 季
            {view.originalTitle && view.originalTitle !== view.title
              ? ` · ${view.originalTitle}`
              : ""}
          </p>
          {view.overview ? <p className="hub-overview">{view.overview}</p> : null}
          <div className="hub-actions">
            {/* Single-season titles get their button on the season row. */}
            {view.untrackedSeasonNumbers.length > 0 && view.seasons.length > 1 ? (
              <RequestRemainingButton
                tmdbId={view.tmdbId}
                titleAcquiring={view.acquiring}
                label={
                  view.aggregate === "untracked"
                    ? "获取所有季"
                    : `获取剩余 ${view.untrackedSeasonNumbers.length} 季`
                }
              />
            ) : null}
          </div>
        </div>
      </header>

      <section className="hub-seasons" aria-label="季列表">
        <div className="section-heading">
          <div>
            <h2>季</h2>
            <p>每季独立验证与监控；点击已追踪的季展开集数状态</p>
          </div>
        </div>
        <ul className="hub-season-list">
          {view.seasons.map((season) => (
            <SeasonRow
              key={season.seasonNumber}
              season={season}
              tmdbId={view.tmdbId}
              acquiring={view.acquiring}
            />
          ))}
        </ul>
      </section>
    </section>
    </AcquisitionLockProvider>
  );
}

const movieStateMeta = {
  acquired: { label: "已入库", tone: "green" },
  reserved: { label: "预定 · 未上映", tone: "blue" },
  acquiring: { label: "获取中", tone: "indigo" },
  missing: { label: "未获取", tone: "amber" },
  untracked: { label: "未追踪", tone: "muted" },
} as const;

/** A movie's detail page: a single status, no season grid. */
function MovieHub({ view }: { view: MovieHubView }) {
  const meta = movieStateMeta[view.state];
  const releaseLine =
    view.state === "reserved" && view.releaseDate ? `${formatMovieDate(view.releaseDate)} 上映` : null;
  return (
    <AcquisitionLockProvider>
      {view.acquiring ? <AcquiringPoller /> : null}
      <section className="title-hub">
        {view.backdropPath ? (
          <div
            className="hub-backdrop"
            style={{ backgroundImage: `url(https://image.tmdb.org/t/p/w1280${view.backdropPath})` }}
            aria-hidden
          />
        ) : null}
        <header className="hub-header">
          <div className="hub-poster">
            {view.posterPath ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`https://image.tmdb.org/t/p/w342${view.posterPath}`} alt={`${view.title} 海报`} />
            ) : (
              <span className="poster-fallback">{view.title.slice(0, 4)}</span>
            )}
          </div>
          <div className="hub-title-block">
            <span className={`hub-badge tone-${meta.tone}`}>{meta.label}</span>
            <h1>
              {view.title} <span className="hub-year">({view.year})</span>
            </h1>
            <p className="hub-attributes">
              电影
              {view.originalTitle && view.originalTitle !== view.title ? ` · ${view.originalTitle}` : ""}
              {releaseLine ? ` · ${releaseLine}` : ""}
            </p>
            {view.overview ? <p className="hub-overview">{view.overview}</p> : null}
          </div>
        </header>
      </section>
    </AcquisitionLockProvider>
  );
}

function formatMovieDate(releaseDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(releaseDate);
  return match ? `${match[1]}年${Number(match[2])}月${Number(match[3])}日` : releaseDate;
}

/** Contextual placeholder while the hub's first render streams in. */
function HubSkeleton() {
  return (
    <section className="title-hub">
      <div className="skeleton skeleton-stage" />
      <div className="skeleton skeleton-heading" />
      <div className="skeleton skeleton-metric" />
      <div className="skeleton skeleton-metric" />
    </section>
  );
}

function SeasonRow({
  season,
  tmdbId,
  acquiring,
}: {
  season: TitleHubSeason;
  tmdbId: number;
  acquiring: boolean;
}) {
  const total = season.totalEpisodes;
  const aired = Math.min(season.latestAiredEpisode, total);
  // Obtained never exceeds aired for bar purposes (resource-ahead caps at aired).
  const obtained = Math.min(season.obtainedCount, aired);
  const airedPct = total > 0 ? (aired / total) * 100 : 0;
  const obtainedPct = total > 0 ? (obtained / total) * 100 : 0;

  const badge = seasonBadge[seasonBadgeState(season)];

  const rowBody = (
    <>
      <span className="season-cell-name">第 {season.seasonNumber} 季</span>
      <span className="season-cell-count">{total} 集</span>
      {badge ? (
        <span className={`hub-badge tone-${badge.tone}`}>{badge.label}</span>
      ) : (
        <span className="hub-badge tone-muted">未追踪</span>
      )}
      <span className="season-cell-progress" aria-hidden>
        {season.tracked ? (
          <>
            <span className="seg-aired" style={{ width: `${airedPct}%` }} />
            <span className="seg-obtained" style={{ width: `${obtainedPct}%` }} />
          </>
        ) : null}
      </span>
      {/* 已获取 / 已播 / 总集数 — so 6/6 of a 9-ep season isn't read as complete. */}
      <span className="season-cell-obtained">
        {season.tracked ? `${season.obtainedCount}/${aired}/${total}` : "—"}
      </span>
    </>
  );

  if (!season.tracked) {
    return (
      <li className="hub-season-row untracked">
        {rowBody}
        <RequestSeasonButton
          tmdbId={tmdbId}
          seasonNumber={season.seasonNumber}
          titleAcquiring={acquiring}
        />
      </li>
    );
  }

  return (
    <li>
      <details className="hub-season-details">
        <summary className="hub-season-row">{rowBody}</summary>
        <div className="episode-grid hub-episode-grid">
          {season.episodes.map((episode) => (
            <div
              className={`episode-cell ${episode.displayState.replace("_", "-")}`}
              key={episode.episodeCode}
            >
              <strong>{episode.episodeCode.replace(/^S\d+/, "")}</strong>
              <span>
                {episode.displayState === "obtained"
                  ? "已获取"
                  : episode.displayState === "missing_aired"
                    ? "缺集"
                    : episode.displayState === "provider_ahead"
                      ? "超前"
                      : episode.displayState === "unaired"
                        ? "未播"
                        : "未知"}
              </span>
            </div>
          ))}
        </div>
      </details>
    </li>
  );
}

