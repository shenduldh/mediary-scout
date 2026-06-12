import Link from "next/link";
import { Suspense } from "react";
import { CheckCircle2, Clock3, Library, Search, TriangleAlert } from "lucide-react";
import { AppSidebar } from "../components/app-sidebar";
import { RequestTrackButton } from "../components/request-track-button";
import { SeasonRequestMenu } from "../components/season-request-menu";
import { getSearchView } from "../lib/search-page";
import { getLibraryWall, type LibraryWallEntry } from "../lib/title-hub";
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

  return (
    <div className="app-shell">
      <AppSidebar active={activeTab} searchQuery={query} />

      <main className="main product-main">
        <div className="product-tabs" role="tablist" aria-label="媒体工作区">
          <Link className={activeTab === "search" ? "is-active" : ""} href={`/?tab=search&q=${encodeURIComponent(query)}`}>
            搜索获取
          </Link>
          <Link className={activeTab === "library" ? "is-active" : ""} href="/?tab=library">
            我的媒体库
          </Link>
        </div>

        {activeTab === "search" ? (
          <Suspense key={`search-${query}`} fallback={<SearchSurfaceSkeleton query={query} />}>
            <SearchSurface query={query} />
          </Suspense>
        ) : (
          <Suspense fallback={<LibrarySurfaceSkeleton />}>
            <LibrarySurface />
          </Suspense>
        )}
      </main>
    </div>
  );
}

async function SearchSurface({ query }: { query: string }) {
  const searchView = await getSearchView(query);
  // Library awareness on results: a tracked title shows WHICH seasons are
  // obtained and routes to the same title page as the library — search must
  // anticipate re-searching something already obtained.
  const repository = getWorkflowRepository();
  await ensureDemoSeeded(repository);
  const trackedByTmdbId = new Map<number, TrackedSeasonState[]>();
  for (const state of await repository.listTrackedSeasonStates()) {
    if (state.title.type !== "tv") {
      continue;
    }
    const list = trackedByTmdbId.get(state.title.tmdbId) ?? [];
    list.push(state);
    trackedByTmdbId.set(state.title.tmdbId, list);
  }

  return (
    <section className="search-surface">
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
                  trackedLabel={trackedSummaryLabel(
                    trackedByTmdbId.get(candidate.tmdbId) ?? [],
                    candidate.seasonNumbers.length,
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
    </section>
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
}: {
  candidate: SearchCandidateCard;
  trackedLabel: string | null;
}) {
  const isTv = candidate.mediaType === "tv";
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
            {trackedLabel !== null ? (
              <Link className="primary-button" href={`/show/${candidate.tmdbId}?from=search`}>
                查看详情
              </Link>
            ) : isTv ? (
              <SeasonRequestMenu tmdbId={candidate.tmdbId} seasonNumbers={candidate.seasonNumbers} />
            ) : (
              <RequestTrackButton
                candidateId={candidate.id}
                actionState={candidate.action.state}
                disabled={candidate.action.disabled}
                label={candidate.action.label}
              />
            )}
          </div>
        </div>
        <p className="candidate-overview">{candidate.overview}</p>
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

async function LibrarySurface() {
  const wall = await getLibraryWall();

  if (wall.length === 0) {
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

  return (
    <section className="library-surface">
      <div className="section-heading library-heading">
        <div>
          <h1>我的媒体库</h1>
          <p>{wall.length} 部剧正在自动追踪</p>
        </div>
      </div>
      <div className="poster-wall">
        {wall.map((entry) => (
          <PosterCard entry={entry} key={entry.tmdbId} />
        ))}
      </div>
    </section>
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
          {entry.year} · {entry.seasonCount} 季 · {entry.obtainedEpisodes}/{entry.totalAiredEpisodes} 集
        </span>
      </span>
    </Link>
  );
}

function SearchSurfaceSkeleton({ query }: { query: string }) {
  return (
    <section className="search-surface">
      <div className="search-hero">
        <div>
          <h1>搜索</h1>
          <p>正在准备搜索界面。</p>
        </div>
        <div className="search-form">
          <div className="skeleton skeleton-input">{query || "片名 / 剧名"}</div>
          <div className="skeleton skeleton-button" />
        </div>
      </div>
      <div className="candidate-grid">
        <div className="skeleton-card" />
        <div className="skeleton-card" />
      </div>
    </section>
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
