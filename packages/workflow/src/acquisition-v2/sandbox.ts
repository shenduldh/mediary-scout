import {
  MAX_DISTINCT_PLANNING_SEARCHES,
  decideSearchGate,
  normalizeSearchKeyword,
} from "../planning-search-gate.js";
import type { ResourceProviderV2, ResourceSnapshotV2 } from "./fake-provider.js";
import type { SimTreeFile, StorageV2, TransferAttemptResult } from "./storage-115-simulator.js";

/**
 * The task sandbox for the Acquisition V2 rebuild — the permission cage the
 * strong agent runs inside. It owns the budgets, the scope, the observed
 * snapshots, and (later) the storage handles, and exposes the agent's tools.
 * The agent drives its own observe-act-verify loop through these tools; the
 * sandbox only makes the documented mistakes impossible — it does NOT plan.
 *
 * This file grows one tool at a time (TDD). First tool: searchResources.
 */
export interface TaskSandboxOptions {
  provider: ResourceProviderV2;
  /** Max distinct PanSou searches per task (the system's search budget). */
  searchBudget?: number;
  /** Scoped storage + the staging handle this task may transfer into. */
  storage?: StorageV2;
  stagingDirectoryId?: string;
  /** TV/anime: season number -> scoped Season directory. A multi-season / complete-
   *  series pack's files are distributed across these per season (§2 targetSeasons +
   *  moveToSeason(fileIds, season); architecture §Multi-season; permission-audit 105/209). */
  targetSeasonDirectoryIds?: Record<number, string>;
  /** Movie: the single scoped movie directory (§2 targetMovieDir). */
  targetMovieDirectoryId?: string;
  /** Back-compat single-season handle: a task whose need is one season may pass
   *  this instead of the map; moveToSeason then defaults to it. */
  targetSeasonDirectoryId?: string;
  /** Coverage need: the missing episode codes — which MAY span multiple seasons,
   *  e.g. ["S01E13","S04E07"] — or ["MOVIE"]. Coverage is met when every token
   *  has a markObtained-confirmed entry. Drives the §3 "no more side effects once
   *  satisfied" gate. The need is just "what's still missing"; sync computes it. */
  need?: string[];
}

export interface SearchToolResult {
  /** Present on a fresh search and on a dedup (the prior snapshot). */
  snapshot?: ResourceSnapshotV2;
  /** True when the keyword was already searched — returned without re-hitting the provider. */
  deduped?: boolean;
  /** Set when the search budget is exhausted; the agent must decide from what it has. */
  refused?: string;
}

export interface TransferToolResult {
  attempt: TransferAttemptResult;
  /** The TRUE staging contents after a forced reread — the only evidence the
   *  agent should trust about what actually landed. */
  staging: SimTreeFile[];
}

export class TaskSandbox {
  private readonly provider: ResourceProviderV2;
  private readonly searchBudget: number;
  private readonly storage: StorageV2 | undefined;
  private readonly stagingDirectoryId: string | undefined;
  /** TV: season number -> scoped Season directory (multi-season distribution). */
  private readonly seasonDirs: Map<number, string>;
  /** A single-season or movie task's one target directory (back-compat / movie). */
  private readonly defaultTargetDir: string | undefined;
  private readonly need: readonly string[];
  private readonly seenKeywords = new Set<string>();
  private readonly snapshotByKeyword = new Map<string, ResourceSnapshotV2>();
  private readonly observedSnapshots = new Map<string, ResourceSnapshotV2>();
  private readonly obtainedCodes = new Set<string>();

  constructor(options: TaskSandboxOptions) {
    this.provider = options.provider;
    this.searchBudget = options.searchBudget ?? MAX_DISTINCT_PLANNING_SEARCHES;
    this.storage = options.storage;
    this.stagingDirectoryId = options.stagingDirectoryId;
    this.seasonDirs = new Map(
      Object.entries(options.targetSeasonDirectoryIds ?? {}).map(([season, id]) => [Number(season), id]),
    );
    this.defaultTargetDir = options.targetSeasonDirectoryId ?? options.targetMovieDirectoryId;
    this.need = options.need ?? [];
  }

  /** Every scoped target directory (all seasons + the movie/default) — the union
   *  used for presence checks and full-target inspection. */
  private allTargetDirIds(): string[] {
    const ids = [...this.seasonDirs.values()];
    if (this.defaultTargetDir !== undefined) ids.push(this.defaultTargetDir);
    return ids;
  }

  /** Resolve which scoped target directory a move/inspect/delete addresses. With an
   *  explicit season it must be a configured season handle; without one it falls
   *  back to the single-season/movie default (or the sole season if there is one). */
  private resolveTargetDir(season?: number): string | undefined {
    if (season !== undefined) return this.seasonDirs.get(season);
    if (this.defaultTargetDir !== undefined) return this.defaultTargetDir;
    return this.seasonDirs.size === 1 ? [...this.seasonDirs.values()][0] : undefined;
  }

  /** Whether every needed token has been confirmed obtained — the gate that
   *  stops the agent from acquiring past the point of coverage (莉可丽丝 scar). */
  isCoverageMet(): boolean {
    return this.need.length > 0 && this.need.every((token) => this.obtainedCodes.has(token));
  }

  private missingNeed(): string[] {
    return this.need.filter((token) => !this.obtainedCodes.has(token));
  }

  /** Search one keyword. Repeats are deduped (no extra provider hit); distinct
   *  searches are capped by the budget. Every observed snapshot is recorded so a
   *  later transferCandidate can be bound to a snapshot seen in THIS task. */
  async searchResources(keyword: string): Promise<SearchToolResult> {
    const normalized = normalizeSearchKeyword(keyword);
    const decision = decideSearchGate({
      normalizedKeyword: normalized,
      seenKeywords: this.seenKeywords,
      maxDistinctSearches: this.searchBudget,
    });
    if (decision === "duplicate") {
      const prior = this.snapshotByKeyword.get(normalized);
      return prior ? { snapshot: prior, deduped: true } : { deduped: true };
    }
    if (decision === "exhausted") {
      return {
        refused: `search budget exhausted (${this.searchBudget} distinct searches); decide from the evidence already gathered`,
      };
    }
    this.seenKeywords.add(normalized);
    const snapshot = await this.provider.search(keyword);
    this.snapshotByKeyword.set(normalized, snapshot);
    this.observedSnapshots.set(snapshot.id, snapshot);
    return { snapshot };
  }

  /** Whether a snapshot id was actually observed in this task — the gate for
   *  snapshot-bound transfers (no acting on stale/unseen ids). */
  hasObservedSnapshot(snapshotId: string): boolean {
    return this.observedSnapshots.has(snapshotId);
  }

  /** Read-only full raw tree of THIS task's staging handle — the agent's
   *  "看现场" surface. Returns everything (no top-N slicing, §11) so the agent
   *  judges identity/dupes/extras from real files, not a summary. */
  async inspectStaging(): Promise<SimTreeFile[]> {
    if (!this.storage || !this.stagingDirectoryId) {
      throw new Error("SANDBOX: no storage/staging handle configured");
    }
    return this.storage.listTree({ directoryId: this.stagingDirectoryId });
  }

  /** Read-only list of the wrapper subdirectories currently in staging — the
   *  source of the handle the agent passes to flattenPack. */
  async inspectStagingDirs(): Promise<Array<{ id: string; path: string }>> {
    if (!this.storage || !this.stagingDirectoryId) {
      throw new Error("SANDBOX: no storage/staging handle configured");
    }
    return this.storage.listSubdirectories({ directoryId: this.stagingDirectoryId });
  }

  /** Read-only full raw tree of a scoped target directory — ground truth for what
   *  has landed. With a season, that season's dir (so the agent sees what season N
   *  already holds before deciding what to move/dedup); without one, the union of
   *  all target dirs (every season + movie) for the whole picture. */
  async inspectTargetDir(input: { season?: number } = {}): Promise<SimTreeFile[]> {
    if (!this.storage) {
      throw new Error("SANDBOX: no storage configured");
    }
    if (input.season !== undefined) {
      const dir = this.resolveTargetDir(input.season);
      if (!dir) {
        throw new Error(`SANDBOX: no target directory for season ${input.season}`);
      }
      return this.storage.listTree({ directoryId: dir });
    }
    const trees = await Promise.all(
      this.allTargetDirIds().map((directoryId) => this.storage!.listTree({ directoryId })),
    );
    return trees.flat();
  }

  /** Transfer ONE candidate into the task's staging handle, then force-reread
   *  staging and return the TRUE contents. The candidate must come from a
   *  snapshot observed in THIS task (no stale/raw ids) — the agent can never
   *  transfer-and-run; the real landing is handed back for it to judge. */
  async transferCandidate(input: { snapshotId: string; candidateId: string }): Promise<TransferToolResult> {
    if (!this.storage || !this.stagingDirectoryId) {
      throw new Error("SANDBOX: no storage/staging handle configured for transfers");
    }
    if (this.isCoverageMet()) {
      throw new Error(
        `SANDBOX_COVERAGE_ALREADY_MET: every needed item (${this.need.join(",")}) is obtained; no further transfers`,
      );
    }
    const snapshot = this.observedSnapshots.get(input.snapshotId);
    if (!snapshot) {
      throw new Error(`SANDBOX_SNAPSHOT_NOT_OBSERVED: ${input.snapshotId} was not seen in this task`);
    }
    if (!snapshot.candidates.some((candidate) => candidate.id === input.candidateId)) {
      throw new Error(`SANDBOX_CANDIDATE_NOT_IN_SNAPSHOT: ${input.candidateId} is not in ${input.snapshotId}`);
    }
    const attempt = await this.storage.transferCandidate({
      candidateId: input.candidateId,
      intoDirectoryId: this.stagingDirectoryId,
    });
    const staging = await this.storage.listTree({ directoryId: this.stagingDirectoryId });
    return { attempt, staging };
  }

  /** Move the agent-selected files out of staging into the scoped Season dir for
   *  the given season (the 挖取/extract). A multi-season / complete-series pack is
   *  distributed by calling this once per season with that season's files — the
   *  agent judges which file is which season/episode and only moves what's still
   *  missing (already-present seasons are NOT recopied). `season` is required when
   *  the task spans multiple seasons; a single-season/movie task may omit it.
   *  Scope guard: every file must currently be in THIS task's staging. Rereads. */
  async moveToSeason(input: {
    fileIds: string[];
    season?: number;
  }): Promise<{ season: SimTreeFile[]; staging: SimTreeFile[] }> {
    if (!this.storage || !this.stagingDirectoryId) {
      throw new Error("SANDBOX: no storage/staging handle configured");
    }
    const targetDir = this.resolveTargetDir(input.season);
    if (!targetDir) {
      throw new Error(
        input.season === undefined
          ? "SANDBOX_SEASON_REQUIRED: this task spans multiple seasons; pass the season for each move"
          : `SANDBOX_NO_SEASON_DIR: no scoped directory for season ${input.season}`,
      );
    }
    const stagingIds = new Set(
      (await this.storage.listTree({ directoryId: this.stagingDirectoryId })).map((file) => file.id),
    );
    const outOfScope = input.fileIds.filter((fileId) => !stagingIds.has(fileId));
    if (outOfScope.length > 0) {
      throw new Error(`SANDBOX_FILES_NOT_IN_STAGING: ${outOfScope.join(",")}`);
    }
    await this.storage.moveFiles({ fileIds: input.fileIds, targetDirectoryId: targetDir });
    return {
      season: await this.storage.listTree({ directoryId: targetDir }),
      staging: await this.storage.listTree({ directoryId: this.stagingDirectoryId }),
    };
  }

  /** Delete agent-chosen files from a named scoped directory (the dedup
   *  keep-larger execution, or residue cleanup). Scope guard: every id must
   *  currently be in that directory — no deleting arbitrary/raw ids. Rereads. */
  async deleteFiles(input: {
    directory: "staging" | "season";
    season?: number;
    fileIds: string[];
  }): Promise<{ deleted: string[]; directory: SimTreeFile[] }> {
    if (!this.storage) {
      throw new Error("SANDBOX: no storage configured");
    }
    const directoryId =
      input.directory === "season" ? this.resolveTargetDir(input.season) : this.stagingDirectoryId;
    if (!directoryId) {
      throw new Error(`SANDBOX: no ${input.directory} handle configured`);
    }
    const present = new Set(
      (await this.storage.listTree({ directoryId })).map((file) => file.id),
    );
    const outOfScope = input.fileIds.filter((fileId) => !present.has(fileId));
    if (outOfScope.length > 0) {
      throw new Error(`SANDBOX_FILES_NOT_IN_${input.directory.toUpperCase()}: ${outOfScope.join(",")}`);
    }
    const { deleted } = await this.storage.deleteFiles({ directoryId, fileIds: input.fileIds });
    return { deleted, directory: await this.storage.listTree({ directoryId }) };
  }

  /** Mark episodes obtained — but ONLY after a fresh reread confirms each
   *  episode's backing file is in the season dir RIGHT NOW (§12). The DB must
   *  never claim an episode the storage can't back. No persistent fileId↔episode
   *  mapping: the agent asserts the pairing, the sandbox verifies it live. */
  async markObtained(input: {
    episodes: Array<{ code: string; fileId: string }>;
  }): Promise<{ confirmed: Array<{ code: string; fileId: string }> }> {
    if (!this.storage) {
      throw new Error("SANDBOX: no storage configured");
    }
    // Presence is checked across EVERY target directory (all seasons + movie), so a
    // multi-season task can mark episodes that the agent moved into their own season
    // dirs. The episode code carries the season; the file must exist somewhere in
    // the task's target scope right now (§12 fresh-reread, no DB lying).
    const trees = await Promise.all(
      this.allTargetDirIds().map((directoryId) => this.storage!.listTree({ directoryId })),
    );
    const present = new Set(trees.flat().map((file) => file.id));
    const missing = input.episodes.filter((episode) => !present.has(episode.fileId));
    if (missing.length > 0) {
      throw new Error(
        `SANDBOX_MARK_FILE_NOT_PRESENT: ${missing.map((e) => `${e.code}->${e.fileId}`).join(",")}`,
      );
    }
    for (const episode of input.episodes) {
      this.obtainedCodes.add(episode.code);
    }
    return { confirmed: input.episodes };
  }

  /** Peel off a wrapper resource directory after its target files were extracted
   *  into the Season dir (the original skill's clean flatten — no leftover shell).
   *  Scope guard: the directory MUST be a subdirectory currently inside THIS
   *  task's staging handle. Never the staging root, never root/parent/category
   *  (`_assert_safe_flatten_target` scar). Rereads staging. */
  async flattenPack(input: { directoryId: string }): Promise<{ removed: string[]; staging: SimTreeFile[] }> {
    if (!this.storage || !this.stagingDirectoryId) {
      throw new Error("SANDBOX: no storage/staging handle configured");
    }
    const inScope = (await this.storage.listSubdirectories({ directoryId: this.stagingDirectoryId })).some(
      (dir) => dir.id === input.directoryId,
    );
    if (!inScope) {
      throw new Error(`SANDBOX_FLATTEN_NOT_IN_STAGING: ${input.directoryId} is not a subdir of this task's staging`);
    }
    const { removed } = await this.storage.removeDirectory({ directoryId: input.directoryId });
    return { removed, staging: await this.storage.listTree({ directoryId: this.stagingDirectoryId }) };
  }

  /** The agent declares it is done. Returns the honest coverage picture from the
   *  obtained marks — the workflow decides what to persist. */
  async finish(): Promise<{ coverageMet: boolean; obtained: string[]; missing: string[] }> {
    return {
      coverageMet: this.isCoverageMet(),
      obtained: this.need.filter((token) => this.obtainedCodes.has(token)),
      missing: this.missingNeed(),
    };
  }

  /** The agent honestly reports it cannot cover the target. This is only valid
   *  when a real provider search actually ran (§9): reporting no-coverage without
   *  ever searching is an infrastructure failure, not an honest result. */
  async reportNoCoverage(reason: string): Promise<{ reason: string; searchesPerformed: number }> {
    if (this.seenKeywords.size === 0) {
      throw new Error(
        "SANDBOX_NO_PROVIDER_EVIDENCE: cannot report no-coverage before any real search ran (§9 infrastructure failure)",
      );
    }
    return { reason, searchesPerformed: this.seenKeywords.size };
  }
}
