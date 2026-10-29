/**
 * @fileoverview Atomic mirror lifecycle and immutable read-only request leases.
 * @module services/airmen/airmen-mirror
 */
import { randomUUID } from 'node:crypto';
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import type { ServerConfig } from '../../config/server-config.js';
import {
  importArchive,
  inspectDatabase,
  REFERENCE_VERSION,
  reserve,
  SCHEMA_VERSION,
} from './importer.js';
import {
  errorCode,
  MIRROR_STAGES,
  MirrorError,
  type MirrorStage,
  safeMirrorError,
} from './mirror-error.js';
import { acquireSource } from './source.js';
import type {
  GenerationSummary,
  MirrorStatus,
  OperatorStatus,
  Provenance,
  PruneResult,
  RefreshRecord,
  RefreshState,
  SnapshotDatabase,
  SnapshotLease,
  SnapshotMetadata,
  Verification,
} from './types.js';

interface ReadonlyConnection extends SnapshotDatabase {
  close(): void;
}
interface BunDatabase extends SnapshotDatabase {
  close(throwOnError?: boolean): void;
}
interface Current {
  generation: string;
  sha256: string;
}
interface GenerationEntry {
  name: string;
  real: boolean;
}

/** The only directory name a writer stages or publishes. */
const GENERATION = /^generation-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMPTY_SUMMARY: GenerationSummary = { count: 0, bytes: 0, unmeasured: 0 };

/** Apparent bytes below a directory, read with lstat so links are counted, never followed. */
async function treeBytes(path: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    bytes += entry.isDirectory() ? await treeBytes(child) : (await lstat(child)).size;
  }
  return bytes;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}
function isMissing(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}
function notInitialized(): MirrorError {
  return new MirrorError(
    'missing',
    'Local mirror is not initialized; run faa-airmen-registry-mirror init.',
  );
}

async function openReadonly(path: string): Promise<ReadonlyConnection> {
  const moduleName: string = 'bun:sqlite';
  if ('Bun' in globalThis) {
    const module: {
      Database: new (path: string, options: { readonly: boolean; create: boolean }) => BunDatabase;
    } = await import(moduleName);
    const db = new module.Database(path, { readonly: true, create: false });
    return { prepare: db.prepare.bind(db), close: () => db.close(true) };
  }
  const { default: Database } = await import('better-sqlite3');
  const db: BetterSqlite3.Database = new Database(path, { readonly: true, fileMustExist: true });
  return {
    prepare: <T>(sql: string) => {
      const statement = db.prepare<unknown[], T>(sql);
      return {
        all: (...bindings) => statement.all(...bindings),
        get: (...bindings) => statement.get(...bindings),
      };
    },
    close: () => db.close(),
  };
}

async function fsync(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform !== 'win32') await fsync(path);
}

async function atomicJson(directory: string, name: string, value: unknown): Promise<void> {
  const temporary = join(directory, `.${name}-${randomUUID()}.tmp`);
  let renamed = false;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(directory, name));
    renamed = true;
  } finally {
    if (!renamed) await rm(temporary, { force: true });
  }
}

function validateMetadata(value: unknown, current: Current): SnapshotMetadata {
  if (typeof value !== 'object' || value === null)
    throw new MirrorError('unavailable', 'Published mirror metadata is invalid.');
  const metadata = value as SnapshotMetadata;
  if (
    metadata.complete !== true ||
    metadata.generationId !== current.generation ||
    metadata.sha256 !== current.sha256 ||
    metadata.schemaVersion !== SCHEMA_VERSION ||
    metadata.referenceVersion !== REFERENCE_VERSION ||
    typeof metadata.includeLocation !== 'boolean' ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(metadata.snapshotMonth) ||
    !Number.isFinite(Date.parse(metadata.importedAt)) ||
    !Number.isFinite(Date.parse(metadata.downloadedAt)) ||
    (metadata.publishedAt !== undefined && !Number.isFinite(Date.parse(metadata.publishedAt))) ||
    !metadata.counts ||
    Object.values(metadata.counts).some((count) => !Number.isSafeInteger(count) || count < 0) ||
    !metadata.fileCounts ||
    Object.keys(metadata.fileCounts).length !== 4 ||
    Object.values(metadata.fileCounts).some((count) => !Number.isSafeInteger(count) || count < 1)
  ) {
    throw new MirrorError(
      'unavailable',
      'Published mirror is incomplete or incompatible; rebuild it with the lifecycle CLI.',
    );
  }
  return metadata;
}

/** Writers store `Date#toISOString()`; `Date.parse` alone also accepts `"1"`, `"0"`, or `"May 5"`. */
function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function isStage(value: unknown): value is MirrorStage {
  return MIRROR_STAGES.some((stage) => stage === value);
}

/** Parse REFRESH.json into its known fields; undefined when it is not a refresh record. */
function parseRefreshRecord(value: unknown): RefreshRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { status, startedAt, finishedAt, stage } = value as Record<string, unknown>;
  if (
    (status !== 'in_progress' && status !== 'complete' && status !== 'failed') ||
    !isTimestamp(startedAt) ||
    (finishedAt !== undefined && !isTimestamp(finishedAt)) ||
    (stage !== undefined && !isStage(stage))
  )
    return undefined;
  return {
    status,
    startedAt,
    ...(finishedAt !== undefined && { finishedAt }),
    ...(stage !== undefined && { stage }),
  };
}

/** Overall deadline of one init or refresh; an older in-progress record cannot belong to a live writer. */
export const REFRESH_DEADLINE_MS = 2_400_000;
/** Deadline of the archive import inside one init or refresh. */
export const IMPORT_DEADLINE_MS = 1_800_000;

/** The overall-deadline failure, whether its timer fired or the wall clock passed it. */
function overallTimeout(mode: 'init' | 'refresh'): MirrorError {
  return new MirrorError(
    'timeout',
    `Mirror ${mode} exceeded its ${REFRESH_DEADLINE_MS / 60_000}-minute deadline; no new snapshot was published.`,
  );
}

/**
 * Classify a failed init or refresh. Once CURRENT names the new generation readers serve it, so a
 * later failure (the directory sync, the refresh record) is a storage fault after publication,
 * whatever signal fired meanwhile. Before that, which signal fired decides cancellation versus
 * timeout: abort errors carry the same name for both, and the importer may have wrapped them.
 */
function writeFailure(
  error: unknown,
  mode: 'init' | 'refresh',
  run: {
    published: boolean;
    externalSignal: AbortSignal | undefined;
    deadline: AbortSignal;
    importDeadline: AbortSignal | undefined;
  },
): MirrorError {
  if (run.published)
    return new MirrorError(
      'disk',
      `Mirror ${mode} published a new snapshot, which readers now serve, but a storage step after publishing failed; check free space and directory permissions.`,
    );
  if (run.externalSignal?.aborted)
    return new MirrorError(
      'cancelled',
      `Mirror ${mode} was cancelled before it finished; no new snapshot was published.`,
    );
  if (run.deadline.aborted) return overallTimeout(mode);
  if (run.importDeadline?.aborted)
    return new MirrorError(
      'timeout',
      `FAA archive import exceeded its ${IMPORT_DEADLINE_MS / 60_000}-minute deadline; no new snapshot was published.`,
    );
  return safeMirrorError(error, 'disk');
}

/** Lifecycle dependencies are limited to acquisition and source-age clocks. */
export interface MirrorDependencies {
  clock?: () => Date;
  fetch?: typeof fetch;
}

/** Owns no writable handle on the serving path; each request leases one generation. */
export class AirmenMirror {
  private readonly fetcher: typeof fetch;
  private readonly clock: () => Date;

  constructor(
    readonly config: ServerConfig,
    dependencies: MirrorDependencies = {},
  ) {
    this.fetcher = dependencies.fetch ?? fetch;
    this.clock = dependencies.clock ?? (() => new Date());
  }

  private provenance(metadata: SnapshotMetadata): Provenance {
    const basis = metadata.publishedAt ?? `${metadata.snapshotMonth}-01T00:00:00.000Z`;
    const ageDays = Math.max(
      0,
      Math.floor((this.clock().getTime() - Date.parse(basis)) / 86_400_000),
    );
    return {
      ...metadata,
      ageDays,
      ageBasis: metadata.publishedAt ? 'published_at' : 'snapshot_month_start',
      stale: ageDays > this.config.staleAfterDays,
      staleAfterDays: this.config.staleAfterDays,
    };
  }

  /** Read the CURRENT manifest; missing is `missing`, a malformed manifest `unavailable`. */
  private async readCurrent(): Promise<Current> {
    let raw: unknown;
    try {
      raw = await readJson(join(this.config.mirrorDir, 'CURRENT'));
    } catch (error) {
      if (isMissing(error)) throw notInitialized();
      throw error;
    }
    if (
      typeof raw !== 'object' ||
      raw === null ||
      !('generation' in raw) ||
      !('sha256' in raw) ||
      typeof raw.generation !== 'string' ||
      !/^generation-[a-f0-9-]{36}$/.test(raw.generation) ||
      typeof raw.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(raw.sha256)
    )
      throw new MirrorError('unavailable', 'Published mirror manifest is invalid.');
    return { generation: raw.generation, sha256: raw.sha256 };
  }

  /** Open exactly CURRENT, never creating a database or falling back to an older generation. */
  async acquire(): Promise<SnapshotLease> {
    let connection: ReadonlyConnection | undefined;
    try {
      const current = await this.readCurrent();
      const root = await realpath(this.config.mirrorDir);
      const generationPath = join(root, current.generation);
      const path = join(generationPath, 'mirror.sqlite');
      if ((await lstat(generationPath)).isSymbolicLink() || (await lstat(path)).isSymbolicLink())
        throw new MirrorError('unavailable', 'Published mirror paths must not be symbolic links.');
      const contained = relative(root, await realpath(path));
      if (contained.startsWith(`..${sep}`) || contained === '..')
        throw new MirrorError(
          'unavailable',
          'Published mirror path escapes its configured directory.',
        );
      connection = await openReadonly(path);
      const row = connection
        .prepare<{ metadata: string }>('SELECT metadata FROM snapshot_metadata WHERE id=1')
        .get();
      const metadata = validateMetadata(row ? JSON.parse(row.metadata) : null, current);
      const db = connection;
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          db.close();
        }
      };
      // The adapter does not expose driver run/exec methods, even via runtime casts.
      const readonlyDb: SnapshotDatabase = {
        prepare: <T>(sql: string) => {
          const statement = db.prepare<T>(sql);
          return { all: statement.all.bind(statement), get: statement.get.bind(statement) };
        },
      };
      return {
        db: readonlyDb,
        metadata,
        provenance: this.provenance(metadata),
        release,
        [Symbol.dispose]: release,
      };
    } catch (error) {
      connection?.close();
      throw safeMirrorError(error, 'unavailable');
    }
  }

  /**
   * Read the last recorded refresh state; null when no refresh has run, `unreadable` when
   * REFRESH.json exists but cannot be read, parsed, or validated. A record still in progress past
   * the refresh deadline belongs to a writer that ended without recording a result, on any host,
   * so it reads as interrupted. Reading never changes the record or lock.
   */
  async refreshState(): Promise<RefreshState | null> {
    let raw: unknown;
    try {
      raw = await readJson(join(this.config.mirrorDir, 'REFRESH.json'));
    } catch (error) {
      return isMissing(error) ? null : { status: 'unreadable' };
    }
    const record = parseRefreshRecord(raw);
    if (!record) return { status: 'unreadable' };
    if (
      record.status === 'in_progress' &&
      this.clock().getTime() - Date.parse(record.startedAt) > REFRESH_DEADLINE_MS
    )
      return { status: 'failed', stage: 'interrupted', startedAt: record.startedAt };
    return record;
  }

  /** Read readiness, policy and last refresh state without creating any paths. */
  async status(): Promise<MirrorStatus> {
    const refresh = await this.refreshState();
    try {
      using lease = await this.acquire();
      return {
        ready: true,
        status: 'ready',
        provenance: lease.provenance,
        importPolicy: { includeLocation: lease.metadata.includeLocation },
        refresh,
      };
    } catch (error) {
      return {
        ready: false,
        status:
          error instanceof MirrorError && error.stage === 'missing' ? 'missing' : 'unavailable',
        provenance: null,
        importPolicy: null,
        refresh,
      };
    }
  }

  /** Run read-only SQLite, relationship, metadata and FTS correspondence checks. */
  async verifyMirror(): Promise<Verification> {
    try {
      using lease = await this.acquire();
      const inspection = inspectDatabase(lease.db);
      if (JSON.stringify(inspection.counts) !== JSON.stringify(lease.metadata.counts))
        inspection.issues.push('metadata_counts');
      return { ok: inspection.issues.length === 0, ...inspection };
    } catch (error) {
      return { ok: false, issues: [safeMirrorError(error, 'integrity').stage], counts: null };
    }
  }

  /** CLI status: readiness plus a best-effort size of every generation besides CURRENT's. */
  async operatorStatus(): Promise<OperatorStatus> {
    const status = await this.status();
    // An unready snapshot has no provenance, yet CURRENT still names a generation to leave out.
    const kept =
      status.provenance?.generationId ??
      (await this.readCurrent().then(
        ({ generation }) => generation,
        () => undefined,
      ));
    let entries: GenerationEntry[];
    try {
      entries = await this.generationEntries();
    } catch (error) {
      return { ...status, supersededGenerations: isMissing(error) ? { ...EMPTY_SUMMARY } : null };
    }
    const summary = { ...EMPTY_SUMMARY };
    for (const entry of entries) {
      if (!entry.real || entry.name === kept) continue;
      summary.count++;
      try {
        summary.bytes += await treeBytes(join(this.config.mirrorDir, entry.name));
      } catch {
        summary.unmeasured++;
      }
    }
    return { ...status, supersededGenerations: summary };
  }

  /**
   * Delete every generation CURRENT does not name. Holds WRITER.lock for the whole run so no
   * refresh can stage or publish meanwhile. Readers lease generations per process, so every
   * server process using this mirror must be stopped first.
   */
  async prune(): Promise<PruneResult> {
    let release: () => Promise<void>;
    try {
      release = await this.takeLock('prune', this.clock().toISOString());
    } catch (error) {
      if (isMissing(error)) throw notInitialized();
      throw safeMirrorError(error, 'disk');
    }
    try {
      const current = await this.status();
      if (!current.provenance)
        throw new MirrorError(
          current.status === 'missing' ? 'missing' : 'unavailable',
          'Prune requires a ready published mirror; nothing was deleted. Check it with faa-airmen-registry-mirror verify.',
        );
      const kept = current.provenance.generationId;
      const result: PruneResult = {
        ok: true,
        kept,
        removed: [],
        bytesFreed: 0,
        skipped: [],
        failed: [],
      };
      for (const entry of await this.generationEntries()) {
        if (entry.name === kept) continue;
        if (!entry.real) {
          result.skipped.push(entry.name);
          continue;
        }
        const path = join(this.config.mirrorDir, entry.name);
        try {
          const bytes = await treeBytes(path);
          await rm(path, { recursive: true });
          result.removed.push({ generation: entry.name, bytes });
          result.bytesFreed += bytes;
        } catch {
          result.failed.push(entry.name);
        }
      }
      result.ok = result.failed.length === 0;
      return result;
    } finally {
      await release();
    }
  }

  /** Every top-level `generation-*` entry; only an lstat directory with a UUID name is real. */
  private async generationEntries(): Promise<GenerationEntry[]> {
    return (await readdir(this.config.mirrorDir, { withFileTypes: true }))
      .filter((entry) => entry.name.startsWith('generation-'))
      .map((entry) => ({
        name: entry.name,
        real: entry.isDirectory() && GENERATION.test(entry.name),
      }));
  }

  /** Take WRITER.lock exclusively; the returned function releases it. Never steals a lock. */
  private async takeLock(runId: string, startedAt: string): Promise<() => Promise<void>> {
    const path = join(this.config.mirrorDir, 'WRITER.lock');
    let lock: FileHandle;
    try {
      lock = await open(path, 'wx', 0o600);
    } catch (error) {
      if (errorCode(error) === 'EEXIST')
        throw new MirrorError(
          'lock',
          'Another mirror writer owns WRITER.lock. Confirm its PID has exited before removing a stale lock.',
        );
      throw error;
    }
    /**
     * Remove WRITER.lock only while it is still this run's file: its device and inode match the
     * open handle, which pins that inode until close. A lock removed or replaced meanwhile, or one
     * whose identity cannot be read, is left alone and never fails a finished run. Only a
     * replacement landing between the check and the removal escapes the check.
     */
    const release = async () => {
      const ours = await Promise.all([
        lock.stat({ bigint: true }),
        lstat(path, { bigint: true }),
      ]).then(
        ([held, named]) => held.dev === named.dev && held.ino === named.ino,
        () => false,
      );
      await lock.close();
      if (ours) await rm(path, { force: true });
    };
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, runId, startedAt }));
      await lock.sync();
    } catch (error) {
      await release();
      throw error;
    }
    return release;
  }

  /** Init is idempotent once a compatible generation exists. */
  initialize(signal?: AbortSignal): Promise<MirrorStatus> {
    return this.write('init', signal);
  }
  /** Refresh builds a replacement when source bytes or import policy change. */
  refresh(signal?: AbortSignal): Promise<MirrorStatus> {
    return this.write('refresh', signal);
  }

  private async write(
    mode: 'init' | 'refresh',
    externalSignal?: AbortSignal,
  ): Promise<MirrorStatus> {
    const deadline = AbortSignal.timeout(REFRESH_DEADLINE_MS);
    const signal = externalSignal ? AbortSignal.any([externalSignal, deadline]) : deadline;
    let importDeadline: AbortSignal | undefined;
    await mkdir(this.config.mirrorDir, { recursive: true, mode: 0o700 });
    const generationId = `generation-${randomUUID()}`;
    const staging = join(this.config.mirrorDir, generationId);
    const archive = join(staging, 'download.zip');
    const startedAt = this.clock().toISOString();
    const release = await this.takeLock(generationId, startedAt).catch((error: unknown) => {
      throw safeMirrorError(error, 'disk');
    });
    const finishRefresh = (status: 'complete' | 'failed', stage?: MirrorStage) =>
      atomicJson(this.config.mirrorDir, 'REFRESH.json', {
        status,
        startedAt,
        finishedAt: this.clock().toISOString(),
        ...(stage && { stage }),
      } satisfies RefreshRecord);
    let published = false;
    try {
      await chmod(this.config.mirrorDir, 0o700);
      const current = await this.status();
      const samePolicy = current.importPolicy?.includeLocation === this.config.includeLocation;
      if (mode === 'init' && current.ready && samePolicy) return current;
      await atomicJson(this.config.mirrorDir, 'REFRESH.json', {
        status: 'in_progress',
        startedAt,
      } satisfies RefreshRecord);
      await reserve(this.config.mirrorDir);
      await mkdir(staging, { mode: 0o700 });
      const source = await acquireSource(archive, this.fetcher, this.clock, signal);
      if (
        mode === 'refresh' &&
        current.ready &&
        current.provenance?.sha256 === source.sha256 &&
        samePolicy
      ) {
        await finishRefresh('complete');
        return this.status();
      }
      importDeadline = AbortSignal.timeout(IMPORT_DEADLINE_MS);
      const importSignal = AbortSignal.any([signal, importDeadline]);
      const database = join(staging, 'mirror.sqlite');
      await importArchive(
        archive,
        database,
        generationId,
        source,
        this.config,
        this.clock,
        importSignal,
      );
      // The import finished, so its deadline no longer explains a later failure.
      importDeadline = undefined;
      await rm(archive);
      for (const suffix of ['-wal', '-shm', '-journal']) {
        const sidecar = await lstat(`${database}${suffix}`).catch((error: unknown) => {
          if (isMissing(error)) return null;
          throw error;
        });
        if (sidecar)
          throw new MirrorError('integrity', 'Staging database still requires a SQLite sidecar.');
      }
      await chmod(database, 0o600);
      await fsync(database);
      await syncDirectory(staging);
      signal.throwIfAborted();
      /**
       * The deadline timer stops while the host sleeps, but status reads the wall clock: once
       * status may have reported this run interrupted, it must not publish.
       */
      if (this.clock().getTime() - Date.parse(startedAt) > REFRESH_DEADLINE_MS)
        throw overallTimeout(mode);
      await atomicJson(this.config.mirrorDir, 'CURRENT', {
        generation: generationId,
        sha256: source.sha256,
      } satisfies Current);
      published = true;
      await syncDirectory(this.config.mirrorDir);
      await finishRefresh('complete');
      return this.status();
    } catch (error) {
      const safe = writeFailure(error, mode, {
        published,
        externalSignal,
        deadline,
        importDeadline,
      });
      await finishRefresh('failed', safe.stage).catch(() => {});
      throw safe;
    } finally {
      /**
       * Staging goes before the lock, so the next lock holder never meets this run's leftovers. A
       * removal that fails leaves a superseded generation for prune and never changes the outcome.
       */
      if (!published) await rm(staging, { recursive: true, force: true }).catch(() => {});
      await release();
    }
  }
}
