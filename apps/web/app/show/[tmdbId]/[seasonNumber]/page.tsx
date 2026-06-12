import Link from "next/link";
import { Suspense } from "react";
import { ArrowLeft, CheckCircle2, Clock3, DownloadCloud, TriangleAlert } from "lucide-react";
import { getTrackedSeasonStatusView } from "@media-track/workflow";
import { ensureDemoSeeded, getWorkflowRepository } from "../../../../lib/workflow-runtime";

const displayLabels = {
  obtained: "已获取",
  provider_ahead: "超前",
  missing_aired: "缺集",
  unaired: "未播",
  unknown: "未知",
} as const;

const episodeTone = {
  obtained: "episode-cell obtained",
  provider_ahead: "episode-cell provider-ahead",
  missing_aired: "episode-cell missing-aired",
  unaired: "episode-cell unaired",
  unknown: "episode-cell unknown",
} as const;

export default async function ShowPage({
  params,
}: {
  params: Promise<{ tmdbId: string; seasonNumber: string }>;
}) {
  return (
    <div className="app-shell">
      <main className="main product-main">
        <Link className="nav-item" href="/" style={{ display: "inline-flex", marginBottom: 16 }}>
          <ArrowLeft size={16} aria-hidden />
          返回
        </Link>
        <Suspense fallback={<ShowSkeleton />}>
          <ShowDetail params={params} />
        </Suspense>
      </main>
    </div>
  );
}

async function ShowDetail({ params }: { params: Promise<{ tmdbId: string; seasonNumber: string }> }) {
  const { tmdbId, seasonNumber } = await params;
  const trackedSeasonId = `tmdb_tv_${tmdbId}_s${seasonNumber}`;
  const repository = getWorkflowRepository();
  await ensureDemoSeeded(repository);
  const view =
    (await getTrackedSeasonStatusView({ repository, trackedSeasonId })) ??
    (await firstTrackedFallback(repository, tmdbId));

  if (!view) {
    return (
      <div className="quiet-state">
        <TriangleAlert size={24} aria-hidden />
        <strong>尚未追踪</strong>
        <span>回到搜索页发起获取后，这里会展示集数状态。</span>
      </div>
    );
  }

  const seasonCode = `S${String(view.seasonNumber).padStart(2, "0")}`;
  const obtainedPercent = Math.round((view.obtainedCount / view.totalEpisodes) * 100);
  const airedPercent = Math.round((view.latestAiredEpisode / view.totalEpisodes) * 100);

  return (
    <section className="library-surface">
      <section className="overview-grid">
        <article className="title-stage">
          <div className="poster-tile" aria-hidden>
            <span>{view.title}</span>
            <small>{seasonCode}</small>
          </div>
          <div className="stage-content">
            <div className="stage-kicker">
              <span className="live-dot" />
              正在追踪
            </div>
            <h2>
              {view.title} 第 {view.seasonNumber} 季
            </h2>
            <div className="stage-meta">
              <span>TMDB 已播 {view.latestAiredEpisode}</span>
              <span>总集数 {view.totalEpisodes}</span>
              <span>TMDB {tmdbId}</span>
            </div>
            <div className="season-progress" aria-label={`已获取 ${obtainedPercent}%`}>
              <div className="progress-track">
                <span className="aired-track" style={{ width: `${airedPercent}%` }} />
                <span className="obtained-track" style={{ width: `${obtainedPercent}%` }} />
              </div>
              <div className="progress-copy">
                <span>{view.obtainedCount} 集可看</span>
                <span>
                  {view.missingAiredEpisodes.length
                    ? `缺 ${view.missingAiredEpisodes.join("、")}`
                    : "无缺集"}
                </span>
              </div>
            </div>
          </div>
        </article>

        <div className="metric-strip">
          <Metric icon={CheckCircle2} label="已获取" value={view.obtainedCount} tone="green" />
          <Metric icon={TriangleAlert} label="已播缺集" value={view.missingAiredCount} tone="coral" />
          <Metric
            icon={Clock3}
            label="未播出"
            value={view.totalEpisodes - view.latestAiredEpisode}
            tone="amber"
          />
          <Metric icon={DownloadCloud} label="资源超前" value={view.providerAheadEpisodes.length} tone="blue" />
        </div>
      </section>

      <article className="panel episode-panel">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">集数状态</h2>
            <p className="panel-note">
              {seasonCode}E01 至 {seasonCode}E{String(view.totalEpisodes).padStart(2, "0")}
            </p>
          </div>
          <div className="legend-row" aria-label="状态图例">
            <span className="legend-item obtained">已获取</span>
            <span className="legend-item missing">缺集</span>
            <span className="legend-item unaired">未播</span>
          </div>
        </div>
        <div className="episode-grid">
          {view.episodes.map((episode) => (
            <div className={episodeTone[episode.displayState]} key={episode.episodeCode}>
              <strong>
                {episode.episodeCode.startsWith(seasonCode)
                  ? episode.episodeCode.slice(seasonCode.length)
                  : episode.episodeCode}
              </strong>
              <span>{displayLabels[episode.displayState]}</span>
            </div>
          ))}
        </div>
      </article>
    </section>
  );
}

async function firstTrackedFallback(
  repository: ReturnType<typeof getWorkflowRepository>,
  tmdbId: string,
) {
  // Demo-seeded seasons use non-tmdb ids; match by title id when possible.
  const states = await repository.listTrackedSeasonStates();
  const match = states.find((state) => String(state.title.tmdbId) === tmdbId);
  if (!match) {
    return null;
  }
  return getTrackedSeasonStatusView({ repository, trackedSeasonId: match.season.id });
}

function Metric({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof CheckCircle2;
  label: string;
  value: number;
  tone: "green" | "coral" | "amber" | "blue";
}) {
  return (
    <div className={`metric-tile tone-${tone}`}>
      <span className="metric-icon">
        <Icon size={18} aria-hidden />
      </span>
      <span>
        <span className="metric-label">{label}</span>
        <strong className="metric-value">{value}</strong>
      </span>
    </div>
  );
}

function ShowSkeleton() {
  return (
    <section className="library-surface">
      <div className="overview-grid">
        <div className="skeleton skeleton-stage" />
        <div className="metric-strip">
          <div className="skeleton skeleton-metric" />
          <div className="skeleton skeleton-metric" />
          <div className="skeleton skeleton-metric" />
          <div className="skeleton skeleton-metric" />
        </div>
      </div>
    </section>
  );
}
