/**
 * @fileoverview Persistent mirror metadata and read-only snapshot contracts.
 * @module services/airmen/types
 */
import type { SqlValue } from '@cyanheads/mcp-ts-core/mirror';

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

/** Safe lifecycle state stored separately from published generations. */
export interface RefreshState {
  finishedAt?: string;
  stage?: string;
  startedAt: string;
  status: 'in_progress' | 'complete' | 'failed';
}

/** Missing mirrors are a normal status; corrupt published generations are unavailable. */
export interface MirrorStatus {
  importPolicy: { includeLocation: boolean } | null;
  provenance: Provenance | null;
  ready: boolean;
  refresh: RefreshState | null;
  status: 'missing' | 'ready' | 'unavailable';
}

/** Integrity verification never repairs or modifies a generation. */
export interface Verification {
  counts: SnapshotMetadata['counts'] | null;
  issues: string[];
  ok: boolean;
}
