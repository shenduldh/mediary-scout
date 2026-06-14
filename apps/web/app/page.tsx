import Link from "next/link";
import { Suspense } from "react";
import { CheckCircle2, Clock3, Library, LoaderCircle, Search, TriangleAlert } from "lucide-react";
import { AcquiringPoller } from "../components/acquiring-poller";
import { AppSidebar } from "../components/app-sidebar";
import { RequestTrackButton } from "../components/request-track-button";
import { RememberQuery } from "../components/search-memory";
import { SeasonRequestMenu } from "../components/season-request-menu";
import { getSearchView } from "../lib/search-page";
import {
  getInProgressTitles,
  getLibraryWall,
  type InProgressTitle,
  type LibraryWallEntry,
} from "../lib/title-hub";
import { ensureDemoSeeded, getWorkflowRepository } from "../lib/workflow-runtime";
import type { SearchCandidateCard, TrackedSeasonState } from "@media-track/workflow";

export default async function Page({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) ?? {};
  const query = stringParam(params.q);
  const activeTab = stringParam(params.tab) === "library" ? "library" : "search";
  const mediaType = stringParam(params.type) || "all";
  const filter = stringParam(params.filter) || "all";

  return (
    <div className="app-shell">
      <AppSidebar active={activeTab} searchQuery={query} />

      <main className="main product-main">
        {activeTab === "search" ? (
          <section className="search-surface">
            <RememberQuery query={query} />
            <div className="search-hero">
              <div>
                <h1>搜索</h1>
                <p>找到目标后发起获取，后台会处理资源判断、转存和验证。</p>
              </div>
              <form className="search-form" action="/" role="search">
                <input type="hidden" name="tab" value="search" />
                <label className="search-box search-box-large">
                  <Search size={18} aria-hidden />
                  <input name="q" aria-label="搜索媒体" placeholder="片名 / 剧名" defaultValue={query} />
                </label>
                <button className="primary-button" type="submit">
                  <Search size={16} aria-hidden />
                  搜索
                </button>
              </form>
            </div>
            <Suspense key={`search-${query}`} fallback={<SearchResultsSkeleton />}>
              <SearchResults query={query} />
            </Suspense>
          </section>
        ) : (
          <Suspense fallback={<LibrarySurfaceSkeleton />}>
            <LibrarySurface mediaType={mediaType} filter={filter} />
          </Suspense>
        )}
      </main>
    </div>
  );
}

async function SearchResults({ query }: { query: string }) {
  const searchView = await getSearchView(query);
  // Library awareness on results: a tracked title shows WHICH seasons are
  // obtained and routes to the same title page as the library — search must
  // anticipate re-searching something already obtained.
  const repository = getWorkflowRepository();
  await ensureDemoSeeded(repository);
  const trackedByTmdbId = new Map<number, TrackedSeasonState[]>();
  for (const state of await repository.listTrackedSeasonStates()) {
    // Season-awareness covers anything tracked with seasons — TV AND anime
    // (anime is a TV-shaped title routed to its own library). Only movies, which
    // have no season menu, are excluded. (Was `!== "tv"`, which wrongly hid every
    // acquired anime's tracked state on the search card.)
    if (state.title.type === "movie") {
      continue;
    }
    const list = trackedByTmdbId.get(state.title.tmdbId) ?? [];
    list.push(state);
    trackedByTmdbId.set(state.title.tmdbId, list);
  }

  return (
    <>
      {searchView.state === "empty" ? (
        <div className="quiet-state">
          <Search size={24} aria-hidden />
          <strong>输入目标名称</strong>
          <span>搜索后才会请求元数据。</span>
        </div>
      ) : (
        <section className="search-results" aria-label="搜索结果">
          <div className="section-heading">
            <div>
              <h2>结果</h2>
              <p>
                {searchView.candidates.length} 个候选
                {searchView.cacheStatus === "hit" ? "，来自缓存" : ""}
              </p>
            </div>
          </div>
          {searchView.candidates.length > 0 ? (
            <div className="candidate-grid">
              {searchView.candidates.map((candidate) => (
                <CandidateCard
                  candidate={candidate}
                  trackedLabel={
                    // The per-season summary ("第 N 季已获取/追更中") is a TV concept.
                    // A movie has no seasons — let it fall through to its own
                    // 已获取/已追踪 action label instead of an invented "第 1 季".
                    candidate.mediaType === "tv"
                      ? trackedSummaryLabel(
                          trackedByTmdbId.get(candidate.tmdbId) ?? [],
                          candidate.seasonNumbers.length,
                        )
                      : null
                  }
                  trackedSeasonNumbers={(trackedByTmdbId.get(candidate.tmdbId) ?? []).map(
                    (state) => state.season.seasonNumber,
                  )}
                  key={`${candidate.mediaType}_${candidate.tmdbId}`}
                />
              ))}
            </div>
          ) : (
            <div className="quiet-state compact">
              <TriangleAlert size={22} aria-hidden />
              <strong>没有匹配结果</strong>
              <span>{searchView.query}</span>
            </div>
          )}
        </section>
      )}
    </>
  );
}

/**
 * Concrete library awareness for a result card: not just "tracked", but
 * WHICH seasons are obtained / airing / missing.
 */
function trackedSummaryLabel(states: TrackedSeasonState[], totalSeasonCount: number): string | null {
  if (states.length === 0) {
    return null;
  }
  const seasonNumber = (state: TrackedSeasonState) => state.season.seasonNumber;
  const obtainedCount = (state: TrackedSeasonState) =>
    state.episodes.filter((episode) => episode.obtained).length;
  const complete = states
    .filter(
      (state) =>
        state.season.status === "completed" && obtainedCount(state) >= state.season.totalEpisodes,
    )
    .map(seasonNumber)
    .sort((a, b) => a - b);
  const active = states
    .filter((state) => state.season.status === "active")
    .map(seasonNumber)
    .sort((a, b) => a - b);
  if (totalSeasonCount > 0 && complete.length === totalSeasonCount) {
    return `全 ${totalSeasonCount} 季已获取`;
  }
  const parts: string[] = [];
  if (complete.length > 0) {
    parts.push(`第 ${complete.join("、")} 季已获取`);
  }
  if (active.length > 0) {
    parts.push(`第 ${active.join("、")} 季追更中`);
  }
  const rest = states.length - complete.length - active.length;
  if (rest > 0) {
    parts.push(`${rest} 季有缺集`);
  }
  return parts.join(" · ") || "已追踪";
}

function CandidateCard({
  candidate,
  trackedLabel,
  trackedSeasonNumbers,
}: {
  candidate: SearchCandidateCard;
  trackedLabel: string | null;
  trackedSeasonNumbers: number[];
}) {
  const isTv = candidate.mediaType === "tv";
  const trackedSet = new Set(trackedSeasonNumbers);
  // Only seasons NOT yet tracked are offered as acquisition scopes.
  const untrackedSeasons = candidate.seasonNumbers.filter(
    (seasonNumber) => !trackedSet.has(seasonNumber),
  );
  return (
    <article className="candidate-card">
      <Link className="candidate-poster" href={`/show/${candidate.tmdbId}?from=search`} aria-hidden tabIndex={-1}>
        {candidate.posterPath ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`https://image.tmdb.org/t/p/w342${candidate.posterPath}`} alt="" loading="lazy" />
        ) : (
          <span>{candidate.title.slice(0, 4)}</span>
        )}
      </Link>
      <div className="candidate-body">
        <div className="candidate-title-row">
          <div>
            <h3>
              <Link href={`/show/${candidate.tmdbId}?from=search`}>{candidate.title}</Link>
            </h3>
            <p>
              {candidate.year} · {isTv ? "剧集" : "电影"}
            </p>
          </div>
          <div className="candidate-actions">
            {isTv && untrackedSeasons.length > 0 ? (
              <SeasonRequestMenu
                tmdbId={candidate.tmdbId}
                seasonNumbers={untrackedSeasons}
                totalSeasonCount={candidate.seasonNumbers.length}
                allLabel={
                  trackedLabel !== null ? `获取剩余 ${untrackedSeasons.length} 季` : "获取所有季"
                }
              />
            ) : null}
            {/* The clickable title is the detail entry already. Only surface an
                explicit 查看详情 when the show is FULLY tracked (no 获取 action
                left) — never crammed next to a 获取 button. */}
            {isTv && trackedLabel !== null && untrackedSeasons.length === 0 ? (
              <Link className="primary-button" href={`/show/${candidate.tmdbId}?from=search`}>
                查看详情
              </Link>
            ) : null}
            {!isTv && trackedLabel === null ? (
              <RequestTrackButton
                candidateId={candidate.id}
                actionState={candidate.action.state}
                disabled={candidate.action.disabled}
                label={candidate.action.label}
              />
            ) : null}
          </div>
        </div>
        {candidate.overview ? (
          <p className="candidate-overview">{candidate.overview}</p>
        ) : null}
        <div className="candidate-meta">
          {isTv && candidate.seasonNumbers.length > 0 ? (
            <span>共 {candidate.seasonNumbers.length} 季</span>
          ) : null}
          {trackedLabel !== null ? (
            <span className="hub-badge tone-green">{trackedLabel}</span>
          ) : null}
        </div>
      </div>
    </article>
  );
}

async function LibrarySurface({ mediaType, filter }: { mediaType: string; filter: string }) {
  const [rawWall, inProgress] = await Promise.all([getLibraryWall(), getInProgressTitles()]);
  const inProgressIds = new Set(inProgress.map((title) => title.tmdbId));
  // A title still being fetched shows as a 获取中 placeholder, not (yet) a card.
  const wall = rawWall.filter((entry) => !inProgressIds.has(entry.tmdbId));

  if (wall.length === 0 && inProgress.length === 0) {
    return (
      <section className="library-surface">
        <div className="quiet-state">
          <Library size={24} aria-hidden />
          <strong>媒体库还是空的</strong>
          <span>去搜索页发起第一次获取吧。</span>
        </div>
      </section>
    );
  }

  // Homepage: every type as a horizontal row, with in-progress titles shown
  // inline (as 获取中 cards) alongside the landed ones — plus the dedicated
  // 获取中 row at the very top.
  if (mediaType === "all") {
    const byType = (type: "movie" | "tv" | "anime") => ({
      inProgressTitles: inProgress.filter((title) => title.type === type),
      wallEntries: wall.filter((entry) => entry.type === type),
    });
    return (
      <section className="library-surface">
        <div className="section-heading library-heading">
          <div>
            <h1>我的媒体库</h1>
          </div>
        </div>

        {inProgress.length > 0 ? <AcquiringPoller /> : null}
        <InProgressRow titles={inProgress} />

        <CategoryRow label="电影" type="movie" {...byType("movie")} />
        <CategoryRow label="电视剧" type="tv" {...byType("tv")} />
        <CategoryRow label="动漫" type="anime" {...byType("anime")} />
      </section>
    );
  }

  // Category detail page
  const filteredWall = wall.filter((entry) => {
    // Type filter
    if (mediaType === "movie" && entry.type !== "movie") return false;
    if (mediaType === "tv" && entry.type !== "tv") return false;
    if (mediaType === "anime" && entry.type !== "anime") return false;
    // State filter
    if (filter === "complete") return entry.state === "complete";
    if (filter === "tracking") return entry.state === "tracking";
    if (filter === "partial") return entry.state === "partial";
    return true;
  });

  const typeLabel = mediaType === "movie" ? "电影" : mediaType === "tv" ? "电视剧" : "动漫";
  const trackingCount = wall
    .filter((entry) => entry.type === mediaType)
    .filter((entry) => entry.state === "tracking" || entry.state === "partial").length;

  return (
    <section className="library-surface">
      <div className="section-heading library-heading">
        <div>
          <h1>
            <Link href="/?tab=library" style={{ marginRight: 12, opacity: 0.6 }}>
              ‹
            </Link>
            {typeLabel}
          </h1>
          <p>{trackingCount > 0 && `${trackingCount} 部正在追踪`}</p>
        </div>
      </div>

      <div style={{ marginBottom: 16, display: "flex", gap: 8 }}>
        <Link
          className={`filter-pill ${filter === "all" ? "is-active" : ""}`}
          href={`/?tab=library&type=${mediaType}&filter=all`}
        >
          全部
        </Link>
        <Link
          className={`filter-pill ${filter === "complete" ? "is-active" : ""}`}
          href={`/?tab=library&type=${mediaType}&filter=complete`}
        >
          已完结
        </Link>
        <Link
          className={`filter-pill ${filter === "tracking" ? "is-active" : ""}`}
          href={`/?tab=library&type=${mediaType}&filter=tracking`}
        >
          追更中
        </Link>
        <Link
          className={`filter-pill ${filter === "partial" ? "is-active" : ""}`}
          href={`/?tab=library&type=${mediaType}&filter=partial`}
        >
          有缺集
        </Link>
      </div>

      {inProgress.length > 0 ? <AcquiringPoller /> : null}
      <InProgressRow titles={inProgress.filter((title) => title.type === mediaType)} />

      <div className="poster-wall">
        {filteredWall.map((entry) => (
          <PosterCard entry={entry} key={entry.tmdbId} />
        ))}
      </div>
    </section>
  );
}

function CategoryRow({
  label,
  type,
  inProgressTitles,
  wallEntries,
}: {
  label: string;
  type: string;
  inProgressTitles: InProgressTitle[];
  wallEntries: LibraryWallEntry[];
}) {
  const count = inProgressTitles.length + wallEntries.length;
  if (count === 0) {
    return null;
  }
  return (
    <div className="category-section">
      <Link className="category-header" href={`/?tab=library&type=${type}&filter=all`}>
        <h2>
          {label} {count}
        </h2>
        <span className="category-arrow">›</span>
      </Link>
      <div className="poster-row">
        {inProgressTitles.map((title) => (
          <InProgressCard title={title} key={`ip_${title.tmdbId}`} />
        ))}
        {wallEntries.map((entry) => (
          <PosterCard entry={entry} key={entry.tmdbId} />
        ))}
      </div>
    </div>
  );
}

function InProgressRow({ titles }: { titles: InProgressTitle[] }) {
  if (titles.length === 0) {
    return null;
  }
  return (
    <div className="category-section">
      <div className="category-header is-static">
        <h2>获取中 {titles.length}</h2>
      </div>
      <div className="poster-row">
        {titles.map((title) => (
          <InProgressCard title={title} key={title.tmdbId} />
        ))}
      </div>
    </div>
  );
}

function InProgressCard({ title }: { title: InProgressTitle }) {
  return (
    <div className="wall-card is-loading" aria-disabled title="获取中，完成后可进入">
      <span className="wall-poster">
        {title.posterPath ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`https://image.tmdb.org/t/p/w342${title.posterPath}`} alt="" loading="lazy" />
        ) : (
          <span className="poster-fallback">{title.title.slice(0, 4)}</span>
        )}
        <span className="wall-loading-overlay">
          <LoaderCircle size={20} className="spin" aria-hidden />
          <span>获取中</span>
        </span>
      </span>
      <span className="wall-copy">
        <strong>{title.title}</strong>
        <span>{title.year} · 正在获取</span>
      </span>
    </div>
  );
}

function PosterCard({ entry }: { entry: LibraryWallEntry }) {
  const stateMeta =
    entry.state === "complete"
      ? { tone: "green", icon: CheckCircle2, label: "已全部入库" }
      : entry.state === "tracking"
        ? { tone: "indigo", icon: Clock3, label: "追更中" }
        : { tone: "amber", icon: TriangleAlert, label: "有缺集" };
  const StateIcon = stateMeta.icon;

  return (
    <Link className="wall-card" href={`/show/${entry.tmdbId}?from=library`}>
      <span className="wall-poster">
        {entry.posterPath ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`https://image.tmdb.org/t/p/w342${entry.posterPath}`} alt="" loading="lazy" />
        ) : (
          <span className="poster-fallback">{entry.title.slice(0, 4)}</span>
        )}
        <span className={`wall-state tone-${stateMeta.tone}`} title={stateMeta.label}>
          <StateIcon size={13} aria-hidden />
        </span>
      </span>
      <span className="wall-copy">
        <strong>{entry.title}</strong>
        <span>
          {/* A movie has no seasons/episodes — show only the year. */}
          {entry.type === "movie"
            ? entry.year
            : `${entry.year} · ${entry.seasonCount} 季 · ${entry.obtainedEpisodes}/${entry.totalAiredEpisodes} 集`}
        </span>
      </span>
    </Link>
  );
}

function SearchResultsSkeleton() {
  return (
    <div className="candidate-grid" style={{ marginTop: 24 }}>
      <div className="skeleton-card" />
      <div className="skeleton-card" />
    </div>
  );
}

function LibrarySurfaceSkeleton() {
  return (
    <section className="library-surface">
      <div className="skeleton skeleton-heading" />
      <div className="poster-wall">
        <div className="skeleton skeleton-poster" />
        <div className="skeleton skeleton-poster" />
        <div className="skeleton skeleton-poster" />
        <div className="skeleton skeleton-poster" />
      </div>
    </section>
  );
}

function stringParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}
