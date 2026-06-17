// Live e2e trigger for the quality-preference feature. Sets quality_preference=high,
// then queues a MOVIE + a single-season SHOW via the REAL server-action logic
// (queueCandidateTracking — exactly what the 获取 button calls). The dev server's
// in-process worker (same Postgres) auto-consumes. We then watch /api/activity +
// logs. ONLY touches the TEST 115 roots (env MEDIA_TRACK_*_PARENT_CID).
//
//   npx tsx scripts/quality-live-queue.mts
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
for (const line of readFileSync(path.join(repoRoot, ".env"), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq === -1) continue;
  const k = t.slice(0, eq).trim();
  let v = t.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  process.env[k] ??= v;
}

const rt = await import(path.join(repoRoot, "apps/web/lib/workflow-runtime.ts"));

async function tmdbSearch(kind: "movie" | "tv", query: string): Promise<{ id: number; name: string; year: string } | null> {
  const url = `https://api.themoviedb.org/3/search/${kind}?query=${encodeURIComponent(query)}&language=zh-CN`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.TMDB_READ_TOKEN}` } });
  const json = (await res.json()) as { results?: Array<Record<string, unknown>> };
  const top = json.results?.[0];
  if (!top) return null;
  return {
    id: top.id as number,
    name: (top.title ?? top.name) as string,
    year: ((top.release_date ?? top.first_air_date ?? "") as string).slice(0, 4),
  };
}

// 1) Set quality preference = high
const repo = rt.getWorkflowRepository();
await repo.setSetting(rt.QUALITY_PREFERENCE_SETTING_KEY, "high");
const pref = await rt.getQualityPreference(repo);
console.log(`✅ quality_preference set → getQualityPreference()=${pref}`);

// 2) Resolve ids
const movie = await tmdbSearch("movie", "流浪地球2");
const show = await tmdbSearch("tv", "后翼弃兵");
console.log("movie:", movie);
console.log("show:", show);
if (!movie || !show) throw new Error("TMDB resolve failed");

// 3) Queue via the REAL server-action logic
const movieRes = await rt.queueCandidateTracking(`tmdb_movie_${movie.id}`);
console.log(`🎬 queued movie ${movie.name} (${movie.year}) →`, movieRes);

const showRes = await rt.queueCandidateTracking(`tmdb_tv_${show.id}_s1`);
console.log(`📺 queued show ${show.name} S1 →`, showRes);

console.log("\nDone queuing. Worker (dev server) will auto-consume. Watch /api/activity.");
process.exit(0);
