import { DatabaseSync } from "node:sqlite";
import {
  createPanSouResourceProviderFromEnv,
  createProtectedPan115CookieStorageExecutorFromEnv,
  createTmdbMetadataProviderFromEnv,
  episodeCode,
  FakeAgentNodes,
  FakeResourceProvider,
  FakeStorageExecutor,
  createNotifyChannelsFromEnv,
  createXiaomiMimoAgentNodesFromEnv,
  dispatchNotifications,
  getTrackedSeasonStatusView,
  importForeignWorkAsMovie,
  assertWorkflowAgentAdapterPolicy,
  prepareSeriesTarget,
  prepareTrackingTarget,
  queueSeriesInitialization,
  queueTrackingInitialization,
  runQueuedSeriesInitialization,
  runQueuedType2Workflow,
  runScheduledType3Monitoring,
  SQLiteWorkflowRepository,
  type AgentNodes,
  type MediaSearchCandidate,
  type MediaTitle,
  type ResourceProvider,
  type StorageExecutor,
  type TrackedSeason,
  type TrackedSeasonStatusView,
  type VerifiedFile,
  type WorkflowRepository,
} from "@media-track/workflow";
import { findDemoCandidateById } from "./demo-candidates";
import { seedDemoWorkflowRepository } from "./demo-workflow";

export type CandidateTrackingRequestResult =
  | {
      status: "queued" | "already_running" | "already_tracked";
      workflowRunId: string | null;
      trackedSeasonId: string;
    }
  | {
      status: "unsupported";
      message: string;
    };

let database: DatabaseSync | null = null;
let repository: SQLiteWorkflowRepository | null = null;
let demoSeedPromise: Promise<void> | null = null;
let fakeResourceProvider: ResourceProvider | null = null;
let fakeStorageExecutor: StorageExecutor | null = null;
let agentNodes: { adapter: "fake" | "vercel-ai"; nodes: AgentNodes } | null = null;

export function getWebDatabase(): DatabaseSync {
  if (!database) {
    database = new DatabaseSync(webDatabasePath());
  }
  return database;
}

export function getWorkflowRepository(): SQLiteWorkflowRepository {
  if (!repository) {
    repository = new SQLiteWorkflowRepository(getWebDatabase());
  }
  return repository;
}

export async function ensureDemoSeeded(targetRepository: WorkflowRepository): Promise<void> {
  if (process.env.MEDIA_TRACK_DEMO_SEED === "0") {
    return;
  }
  demoSeedPromise ??= seedDemoIfEmpty(targetRepository);
  await demoSeedPromise;
}

export async function getWorkflowStatusView(
  targetRepository: WorkflowRepository,
): Promise<TrackedSeasonStatusView | null> {
  const trackedStates = await targetRepository.listTrackedSeasonStates();
  // The spotlight is the season that still needs attention: prefer an
  // actively-airing season over completed ones.
  const firstTracked =
    trackedStates.find((state) => state.season.status === "active") ?? trackedStates[0];
  if (!firstTracked) {
    return null;
  }
  return getTrackedSeasonStatusView({
    repository: targetRepository,
    trackedSeasonId: firstTracked.season.id,
  });
}

export async function queueCandidateTracking(candidateId: string): Promise<CandidateTrackingRequestResult> {
  const target = await trackingTargetFromCandidateId(candidateId);
  if (!target) {
    return {
      status: "unsupported",
      message: "暂时只支持剧集第 1 季的后台获取。",
    };
  }

  const request = await queueTrackingInitialization({
    title: target.title,
    season: target.season,
    keyword: target.keyword,
    repository: getWorkflowRepository(),
  });
  const status = request.status === "completed" ? "queued" : request.status;

  return {
    status,
    workflowRunId: request.workflowRunId,
    trackedSeasonId: request.trackedSeasonId,
  };
}

export async function runNextQueuedWorkflow() {
  const repository = getWorkflowRepository();
  await hydratePan115CookieFromDb();
  const startedAt = new Date().toISOString();
  const type2 = await runQueuedType2Workflow({
    repository,
    resourceProvider: getWorkerResourceProvider(),
    storage: getWorkerStorageExecutor(),
    agents: getAgentNodes(),
    storageParentDirectoryId: storageParentDirectoryId(),
  });
  if (type2.status !== "idle") {
    await pushNotificationsSince(repository, startedAt);
    return type2;
  }
  const series = await runQueuedSeriesInitialization({
    repository,
    resourceProvider: getWorkerResourceProvider(),
    storage: getWorkerStorageExecutor(),
    agents: getAgentNodes(),
    storageParentDirectoryId: storageParentDirectoryId(),
  });
  if (series.status !== "idle") {
    await pushNotificationsSince(repository, startedAt);
  }
  return series;
}

/**
 * Outbound push rides on the feed: whatever notifications a run persisted
 * are delivered to every user-configured channel. Delivery failures are
 * logged, never thrown — the run already succeeded.
 */
async function pushNotificationsSince(
  targetRepository: WorkflowRepository,
  sinceIso: string,
): Promise<void> {
  const channels = createNotifyChannelsFromEnv();
  if (channels.length === 0) {
    return;
  }
  try {
    const recent = (await targetRepository.listNotifications({ limit: 20 })).filter(
      (notification) => notification.createdAt >= sinceIso,
    );
    if (recent.length === 0) {
      return;
    }
    const result = await dispatchNotifications({ channels, notifications: recent });
    for (const failure of result.failures) {
      console.error(
        `[media-track] push via ${failure.channelId} failed for ${failure.notificationId}: ${failure.error}`,
      );
    }
  } catch (error) {
    console.error(`[media-track] notification push failed: ${String(error)}`);
  }
}

export async function queueCandidateSeries(candidateId: string): Promise<CandidateTrackingRequestResult> {
  const parsed = parseTvCandidateId(candidateId);
  if (!parsed) {
    return { status: "unsupported", message: "暂时只支持剧集的全剧获取。" };
  }
  if (process.env.MEDIA_TRACK_SEARCH_PROVIDER === "tmdb" && process.env.TMDB_READ_TOKEN) {
    const target = await prepareSeriesTarget({
      tmdbId: parsed.tmdbId,
      qualityPreference: defaultQuality(),
      metadataProvider: createTmdbMetadataProviderFromEnv(),
    });
    const request = await queueSeriesInitialization({
      title: target.title,
      seasons: target.seasons,
      keyword: target.keyword,
      repository: getWorkflowRepository(),
    });
    return {
      status: request.status === "queued" ? "queued" : request.status,
      workflowRunId: request.workflowRunId,
      trackedSeasonId: `${target.title.id}_s${target.seasons[0]?.seasonNumber ?? 1}`,
    };
  }

  const candidate = findDemoCandidateById(candidateId);
  if (!candidate || candidate.mediaType !== "tv") {
    return { status: "unsupported", message: "暂时只支持剧集的全剧获取。" };
  }
  const request = await queueSeriesInitialization({
    title: {
      id: `tmdb_tv_${candidate.tmdbId}`,
      tmdbId: candidate.tmdbId,
      type: "tv",
      title: candidate.title,
      originalTitle: candidate.originalTitle,
      year: candidate.year,
      aliases:
        candidate.originalTitle && candidate.originalTitle !== candidate.title ? [candidate.originalTitle] : [],
    },
    seasons: candidate.seasons.map((season) => ({
      seasonNumber: season.seasonNumber,
      totalEpisodes: season.episodeCount,
      latestAiredEpisode: season.latestAiredEpisode,
    })),
    keyword: `${candidate.title} ${defaultQuality()}`.trim(),
    repository: getWorkflowRepository(),
  });
  return {
    status: request.status === "queued" ? "queued" : request.status,
    workflowRunId: request.workflowRunId,
    trackedSeasonId: `tmdb_tv_${candidate.tmdbId}_s1`,
  };
}

export async function runScheduledType3() {
  const repository = getWorkflowRepository();
  await hydratePan115CookieFromDb();
  const startedAt = new Date().toISOString();
  const result = await runScheduledType3Monitoring({
    repository,
    resourceProvider: getWorkerResourceProvider(),
    storage: getWorkerStorageExecutor(),
    agents: getAgentNodes(),
    storageParentDirectoryId: storageParentDirectoryId(),
    staleActiveRunTimeoutMs: 30 * 60 * 1000,
  });
  await pushNotificationsSince(repository, startedAt);
  return result;
}

async function seedDemoIfEmpty(targetRepository: WorkflowRepository): Promise<void> {
  const tracked = await targetRepository.listTrackedSeasonStates();
  if (tracked.length > 0) {
    return;
  }
  await seedDemoWorkflowRepository(targetRepository);
}

async function trackingTargetFromCandidateId(candidateId: string): Promise<{
  title: MediaTitle;
  season: TrackedSeason;
  keyword: string;
} | null> {
  const parsed = parseTvCandidateId(candidateId);
  if (!parsed) {
    return null;
  }

  if (process.env.MEDIA_TRACK_SEARCH_PROVIDER === "tmdb" && process.env.TMDB_READ_TOKEN) {
    return prepareTrackingTarget({
      tmdbId: parsed.tmdbId,
      mediaType: "tv",
      seasonNumber: parsed.seasonNumber,
      qualityPreference: defaultQuality(),
      storageDirectoryId: storageDirectoryIdForCandidate(candidateId),
      metadataProvider: createTmdbMetadataProviderFromEnv(),
    });
  }

  const candidate = findDemoCandidateById(candidateId);
  if (!candidate || candidate.mediaType !== "tv") {
    return null;
  }
  return targetFromSearchCandidate(candidate, parsed.seasonNumber, candidateId);
}

function targetFromSearchCandidate(
  candidate: MediaSearchCandidate,
  seasonNumber: number,
  candidateId: string,
): {
  title: MediaTitle;
  season: TrackedSeason;
  keyword: string;
} | null {
  const season = candidate.seasons.find((item) => item.seasonNumber === seasonNumber);
  if (!season) {
    return null;
  }
  const titleId = `tmdb_tv_${candidate.tmdbId}`;
  const title: MediaTitle = {
    id: titleId,
    tmdbId: candidate.tmdbId,
    type: "tv",
    title: candidate.title,
    originalTitle: candidate.originalTitle,
    year: candidate.year,
    aliases: candidate.originalTitle && candidate.originalTitle !== candidate.title ? [candidate.originalTitle] : [],
  };
  const trackedSeason: TrackedSeason = {
    id: candidateId,
    mediaTitleId: title.id,
    seasonNumber,
    status: season.latestAiredEpisode >= season.episodeCount ? "completed" : "active",
    qualityPreference: defaultQuality(),
    storageDirectoryId: storageDirectoryIdForCandidate(candidateId),
    totalEpisodes: season.episodeCount,
    latestAiredEpisode: season.latestAiredEpisode,
    latestAiredSource: "metadata",
  };
  return {
    title,
    season: trackedSeason,
    keyword: `${candidate.title} ${trackedSeason.qualityPreference}`.trim(),
  };
}

function parseTvCandidateId(candidateId: string): { tmdbId: number; seasonNumber: number } | null {
  const match = /^tmdb_tv_(\d+)_s(\d+)$/.exec(candidateId);
  if (!match) {
    return null;
  }
  return {
    tmdbId: Number(match[1]),
    seasonNumber: Number(match[2]),
  };
}

function getWorkerResourceProvider(): ResourceProvider {
  if (process.env.MEDIA_TRACK_WORKFLOW_ADAPTER === "pansou") {
    return createPanSouResourceProviderFromEnv();
  }
  fakeResourceProvider ??= new FakeResourceProvider({
    keywordResults: {
      "翘楚 4K": [
        {
          title: "翘楚 S01E01-S01E12 4K",
          episodeHints: episodeCodes(1, 12),
          qualityHints: ["4K"],
        },
      ],
      "绝命毒师 4K": [
        {
          title: "绝命毒师 S01E01-S01E07 4K",
          episodeHints: episodeCodes(1, 7),
          qualityHints: ["4K"],
        },
      ],
    },
  });
  return fakeResourceProvider;
}

function getWorkerStorageExecutor(): StorageExecutor {
  const adapter = process.env.MEDIA_TRACK_STORAGE_ADAPTER ?? "fake";
  if (adapter === "115") {
    return createProtectedPan115CookieStorageExecutorFromEnv({ env: process.env });
  }
  if (adapter !== "fake") {
    throw new Error(`MEDIA_TRACK_STORAGE_ADAPTER_UNSUPPORTED: ${adapter}`);
  }
  fakeStorageExecutor ??= new FakeStorageExecutor({
    transferOutcomes: fakeTransferOutcomes(),
  });
  return fakeStorageExecutor;
}

function getAgentNodes(): AgentNodes {
  assertWorkflowAgentAdapterPolicy(process.env);
  const adapter = process.env.MEDIA_TRACK_AGENT_ADAPTER === "vercel-ai" ? "vercel-ai" : "fake";
  if (agentNodes?.adapter === adapter) {
    return agentNodes.nodes;
  }
  agentNodes = {
    adapter,
    nodes: adapter === "vercel-ai" ? createXiaomiMimoAgentNodesFromEnv(process.env) : new FakeAgentNodes(),
  };
  return agentNodes.nodes;
}

function fakeTransferOutcomes() {
  const outcomes: Record<string, { status: "succeeded"; providerMessage: string; files: VerifiedFile[] }> = {};
  for (let snapshotNumber = 1; snapshotNumber <= 20; snapshotNumber += 1) {
    const candidateId = `snapshot_${snapshotNumber}_candidate_1`;
    outcomes[candidateId] = {
      status: "succeeded",
      providerMessage: "fake transfer completed",
      files: episodeCodes(1, 24).map((code) => fakeVerifiedFile(candidateId, code)),
    };
  }
  return outcomes;
}

function fakeVerifiedFile(candidateId: string, code: string): VerifiedFile {
  return {
    id: `${candidateId}_${code}`,
    storageDirectoryId: "assigned_by_fake_storage",
    name: `Demo.${code}.mkv`,
    sizeBytes: 1_000_000_000,
    episodeCode: code,
    providerFileId: `provider_${candidateId}_${code}`,
  };
}

function episodeCodes(seasonNumber: number, count: number): string[] {
  return Array.from({ length: count }, (_, index) => episodeCode(seasonNumber, index + 1));
}

function storageDirectoryIdForCandidate(_candidateId: string): string {
  // Empty means "let the Type 2 workflow create the canonical
  // `Title (Year)/Season N` directory under the configured parent".
  return process.env.MEDIA_TRACK_DEFAULT_TV_STORAGE_DIRECTORY_ID ?? "";
}

function storageParentDirectoryId(): string {
  return (
    process.env.MEDIA_TRACK_TV_PARENT_CID ??
    process.env.MEDIA_TRACK_115_TEST_ROOT_CID ??
    "fake_library_root"
  );
}

function defaultQuality(): string {
  return process.env.MEDIA_TRACK_DEFAULT_QUALITY ?? "4K";
}

function webDatabasePath(): string {
  return process.env.MEDIA_TRACK_WEB_DB_PATH ?? ".media-track-web.sqlite";
}

export interface ForeignWorkFinding {
  stagingDirectoryId: string;
  files: Array<{ providerFileId: string; sourcePath: string }>;
}

export interface ForeignWorkReview {
  workflowRunId: string;
  titleName: string;
  findings: ForeignWorkFinding[];
}

/** Foreign-work findings recorded by a run, for the user-confirmation page. */
export async function getForeignWorkReview(workflowRunId: string): Promise<ForeignWorkReview | null> {
  const repository = getWorkflowRepository();
  const snapshot = await repository.getWorkflowRunSnapshot(workflowRunId);
  if (!snapshot) {
    return null;
  }
  const findings = snapshot.workflowRun.auditEvents
    .filter((event) => event.type === "foreign_work_detected")
    .map((event) => event.data as unknown as ForeignWorkFinding)
    .filter((finding) => Array.isArray(finding?.files) && finding.files.length > 0);
  return { workflowRunId, titleName: snapshot.title.title, findings };
}

export async function importForeignWorkFiles(input: {
  providerFileIds: string[];
  movieTitle: string;
  year: number;
}): Promise<{ movieDirectoryId: string; movedFileIds: string[]; renamedTo: string | null }> {
  return importForeignWorkAsMovie({
    storage: getWorkerStorageExecutor(),
    providerFileIds: input.providerFileIds,
    movieTitle: input.movieTitle,
    year: input.year,
    moviesParentDirectoryId: moviesParentDirectoryId(),
  });
}

function moviesParentDirectoryId(): string {
  return (
    process.env.MEDIA_TRACK_MOVIES_PARENT_CID ??
    process.env.MEDIA_TRACK_115_TEST_ROOT_CID ??
    "fake_movies_root"
  );
}

// ---------------------------------------------------------------------------
// 115 connection (QR login) — cookie lives in the DB once connected; the
// repo-root .env PAN115_COOKIE remains the bootstrap fallback.

const PAN115_COOKIE_KEY = "pan115.cookie";
const PAN115_META_KEY = "pan115.cookieMeta";

let pan115CookieHydrated = false;

/** DB cookie (newer truth from QR connect) wins over the .env bootstrap. */
export async function hydratePan115CookieFromDb(): Promise<void> {
  if (pan115CookieHydrated) {
    return;
  }
  pan115CookieHydrated = true;
  try {
    const cookie = await getWorkflowRepository().getSetting(PAN115_COOKIE_KEY);
    if (cookie) {
      process.env.PAN115_COOKIE = cookie;
    }
  } catch (error) {
    console.error(`[media-track] failed to hydrate 115 cookie from DB: ${String(error)}`);
  }
}

export interface Pan115ConnectionStatus {
  connected: boolean;
  source: "qr" | "env" | "none";
  userName: string | null;
  app: string | null;
  connectedAt: string | null;
}

export async function getPan115ConnectionStatus(): Promise<Pan115ConnectionStatus> {
  const repository = getWorkflowRepository();
  const cookie = await repository.getSetting(PAN115_COOKIE_KEY);
  if (cookie) {
    const metaRaw = await repository.getSetting(PAN115_META_KEY);
    let meta: { userName?: string; app?: string; connectedAt?: string } = {};
    try {
      meta = metaRaw ? (JSON.parse(metaRaw) as typeof meta) : {};
    } catch {
      meta = {};
    }
    return {
      connected: true,
      source: "qr",
      userName: meta.userName ?? null,
      app: meta.app ?? null,
      connectedAt: meta.connectedAt ?? null,
    };
  }
  if (process.env.PAN115_COOKIE) {
    return { connected: true, source: "env", userName: null, app: null, connectedAt: null };
  }
  return { connected: false, source: "none", userName: null, app: null, connectedAt: null };
}

export async function completePan115QrLogin(input: {
  session: { uid: string; time: number; sign: string; qrcodeContent: string };
  app?: string;
}): Promise<{ userName: string; app: string }> {
  const { Pan115QrLoginClient, PAN115_QR_LOGIN_APPS } = await import("@media-track/workflow");
  const app = (PAN115_QR_LOGIN_APPS as readonly string[]).includes(input.app ?? "")
    ? (input.app as (typeof PAN115_QR_LOGIN_APPS)[number])
    : "alipaymini";
  const client = new Pan115QrLoginClient();
  const result = await client.exchangeCookie(input.session, app);
  const repository = getWorkflowRepository();
  await repository.setSetting(PAN115_COOKIE_KEY, result.cookie);
  await repository.setSetting(
    PAN115_META_KEY,
    JSON.stringify({
      userName: result.userName,
      app: result.app,
      connectedAt: new Date().toISOString(),
    }),
  );
  // Take effect immediately: the 115 executor is built from process.env per call.
  process.env.PAN115_COOKIE = result.cookie;
  pan115CookieHydrated = true;
  return { userName: result.userName, app: result.app };
}
