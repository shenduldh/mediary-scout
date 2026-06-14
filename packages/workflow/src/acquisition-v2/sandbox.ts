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
  /** The scoped Season N directory this task may move target files into. */
  targetSeasonDirectoryId?: string;
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
  private readonly targetSeasonDirectoryId: string | undefined;
  private readonly seenKeywords = new Set<string>();
  private readonly snapshotByKeyword = new Map<string, ResourceSnapshotV2>();
  private readonly observedSnapshots = new Map<string, ResourceSnapshotV2>();

  constructor(options: TaskSandboxOptions) {
    this.provider = options.provider;
    this.searchBudget = options.searchBudget ?? MAX_DISTINCT_PLANNING_SEARCHES;
    this.storage = options.storage;
    this.stagingDirectoryId = options.stagingDirectoryId;
    this.targetSeasonDirectoryId = options.targetSeasonDirectoryId;
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

  /** Read-only full raw tree of the scoped target (Season/movie) dir — the
   *  ground truth for what has actually landed. */
  async inspectTargetDir(): Promise<SimTreeFile[]> {
    if (!this.storage || !this.targetSeasonDirectoryId) {
      throw new Error("SANDBOX: no storage/season handle configured");
    }
    return this.storage.listTree({ directoryId: this.targetSeasonDirectoryId });
  }

  /** Transfer ONE candidate into the task's staging handle, then force-reread
   *  staging and return the TRUE contents. The candidate must come from a
   *  snapshot observed in THIS task (no stale/raw ids) — the agent can never
   *  transfer-and-run; the real landing is handed back for it to judge. */
  async transferCandidate(input: { snapshotId: string; candidateId: string }): Promise<TransferToolResult> {
    if (!this.storage || !this.stagingDirectoryId) {
      throw new Error("SANDBOX: no storage/staging handle configured for transfers");
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

  /** Move the agent-selected files out of staging into the scoped Season dir
   *  (the 挖取/extract). Scope guard: every file must currently be in THIS
   *  task's staging — the agent can't move arbitrary ids. Rereads both dirs. */
  async moveToSeason(input: { fileIds: string[] }): Promise<{ season: SimTreeFile[]; staging: SimTreeFile[] }> {
    if (!this.storage || !this.stagingDirectoryId || !this.targetSeasonDirectoryId) {
      throw new Error("SANDBOX: no storage/staging/season handle configured");
    }
    const stagingIds = new Set(
      (await this.storage.listTree({ directoryId: this.stagingDirectoryId })).map((file) => file.id),
    );
    const outOfScope = input.fileIds.filter((fileId) => !stagingIds.has(fileId));
    if (outOfScope.length > 0) {
      throw new Error(`SANDBOX_FILES_NOT_IN_STAGING: ${outOfScope.join(",")}`);
    }
    await this.storage.moveFiles({
      fileIds: input.fileIds,
      targetDirectoryId: this.targetSeasonDirectoryId,
    });
    return {
      season: await this.storage.listTree({ directoryId: this.targetSeasonDirectoryId }),
      staging: await this.storage.listTree({ directoryId: this.stagingDirectoryId }),
    };
  }

  /** Delete agent-chosen files from a named scoped directory (the dedup
   *  keep-larger execution, or residue cleanup). Scope guard: every id must
   *  currently be in that directory — no deleting arbitrary/raw ids. Rereads. */
  async deleteFiles(input: {
    directory: "staging" | "season";
    fileIds: string[];
  }): Promise<{ deleted: string[]; directory: SimTreeFile[] }> {
    if (!this.storage) {
      throw new Error("SANDBOX: no storage configured");
    }
    const directoryId = input.directory === "season" ? this.targetSeasonDirectoryId : this.stagingDirectoryId;
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
    const { deleted } = await this.storage.deleteFiles({ fileIds: input.fileIds });
    return { deleted, directory: await this.storage.listTree({ directoryId }) };
  }

  /** Mark episodes obtained — but ONLY after a fresh reread confirms each
   *  episode's backing file is in the season dir RIGHT NOW (§12). The DB must
   *  never claim an episode the storage can't back. No persistent fileId↔episode
   *  mapping: the agent asserts the pairing, the sandbox verifies it live. */
  async markObtained(input: {
    episodes: Array<{ code: string; fileId: string }>;
  }): Promise<{ confirmed: Array<{ code: string; fileId: string }> }> {
    if (!this.storage || !this.targetSeasonDirectoryId) {
      throw new Error("SANDBOX: no storage/season handle configured");
    }
    const present = new Set(
      (await this.storage.listTree({ directoryId: this.targetSeasonDirectoryId })).map((file) => file.id),
    );
    const missing = input.episodes.filter((episode) => !present.has(episode.fileId));
    if (missing.length > 0) {
      throw new Error(
        `SANDBOX_MARK_FILE_NOT_PRESENT: ${missing.map((e) => `${e.code}->${e.fileId}`).join(",")}`,
      );
    }
    return { confirmed: input.episodes };
  }
}
