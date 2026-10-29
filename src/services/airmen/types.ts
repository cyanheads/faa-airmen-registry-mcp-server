/**
 * @fileoverview Persistent mirror metadata and read-only snapshot contracts.
 * @module services/airmen/types
 */
import type { SqlValue } from '@cyanheads/mcp-ts-core/mirror';
import type { MirrorStage } from './mirror-error.js';

/** FAA source family, independent of certificate type. */
export type SourceFamily = 'pilot' | 'nonpilot';

/** Read-only statements deliberately exclude run/exec and driver handles. */
export interface SnapshotDatabase {
  prepare<T = Record<string, unknown>>(
    sql: string,
  ): {
    all(...bindings: SqlValue[]): T[];
    get(...bindings: SqlValue[]): T | undefined;
  };
}

/** Persisted metadata contains only source provenance and aggregate counts. */
export interface SnapshotMetadata {
  archiveUrl: string;
  complete: true;
  counts: { airmen: number; certificates: number; ratings: number; medicalRecords: number };
  downloadedAt: string;
  fileCounts: Record<string, number>;
  generationId: string;
  importedAt: string;
  includeLocation: boolean;
  publishedAt?: string;
  referenceVersion: number;
  schemaVersion: number;
  sha256: string;
  snapshotMonth: string;
  sourceName: string;
  sourcePageUrl: string;
  warnings: { unknownCodes: number; malformedDates: number; malformedRatings: number };
}

/** Source age is measured from publication, never from the import clock. */
export interface Provenance extends SnapshotMetadata {
  ageBasis: 'published_at' | 'snapshot_month_start';
  ageDays: number;
  stale: boolean;
  staleAfterDays: number;
}

/** One immutable generation, owned until release or disposal. */
export interface SnapshotLease extends Disposable {
  readonly db: SnapshotDatabase;
  readonly metadata: SnapshotMetadata;
  readonly provenance: Provenance;
  release(): void;
}

/** Safe lifecycle record a writer stores in REFRESH.json, separately from published generations. */
export interface RefreshRecord {
  finishedAt?: string;
  stage?: MirrorStage;
  startedAt: string;
  status: 'in_progress' | 'complete' | 'failed';
}

/**
 * The last refresh as readers see it: a validated record, or `unreadable` when REFRESH.json exists
 * but cannot be read, parsed, or validated. It records only the last refresh outcome, so it never
 * decides whether the published generation is served.
 */
export type RefreshState = RefreshRecord | { status: 'unreadable' };

/** Missing mirrors are a normal status; corrupt published generations are unavailable. */
export interface MirrorStatus {
  importPolicy: { includeLocation: boolean } | null;
  provenance: Provenance | null;
  ready: boolean;
  refresh: RefreshState | null;
  status: 'missing' | 'ready' | 'unavailable';
}

/** Generations other than the published one, for operator housekeeping; never on `mirror_status`. */
export interface GenerationSummary {
  /** Apparent bytes of their files; sizes never descend through links. */
  bytes: number;
  count: number;
  /** Generations whose size could not be read; `bytes` excludes them. */
  unmeasured: number;
}

/** CLI `status`: readiness plus the superseded generations prune would remove. */
export interface OperatorStatus extends MirrorStatus {
  /** Null when the mirror directory exists but cannot be listed. */
  supersededGenerations: GenerationSummary | null;
}

/** Outcome of pruning; names are generation basenames, never paths. */
export interface PruneResult {
  bytesFreed: number;
  /** Generations whose deletion failed; they are not counted as freed. */
  failed: string[];
  kept: string;
  ok: boolean;
  removed: { bytes: number; generation: string }[];
  /** Entries named `generation-*` that are not real `generation-<uuid>` directories; never followed. */
  skipped: string[];
}

/** Integrity verification never repairs or modifies a generation. */
export interface Verification {
  counts: SnapshotMetadata['counts'] | null;
  issues: string[];
  ok: boolean;
}
