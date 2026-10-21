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
  readFile,
  realpath,
  rename,
  rm,
  statfs,
} from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import type { ServerConfig } from '../../config/server-config.js';
import { importArchive, inspectDatabase, REFERENCE_VERSION, SCHEMA_VERSION } from './importer.js';
import { MirrorError, safeMirrorError } from './mirror-error.js';
import { acquireSource } from './source.js';
import type {
  MirrorStatus,
  Provenance,
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

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
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

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
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

  /** Open exactly CURRENT, never creating a database or falling back to an older generation. */
  async acquire(): Promise<SnapshotLease> {
    let connection: ReadonlyConnection | undefined;
    try {
      let raw: unknown;
      try {
        raw = await readJson(join(this.config.mirrorDir, 'CURRENT'));
      } catch (error) {
        if (isMissing(error))
          throw new MirrorError(
            'missing',
            'Local mirror is not initialized; run faa-airmen-registry-mirror init.',
          );
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
      const current: Current = { generation: raw.generation, sha256: raw.sha256 };
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

  /** Read readiness, policy and last refresh state without creating any paths. */
  async status(): Promise<MirrorStatus> {
    let refresh: RefreshState | null = null;
    try {
      refresh = (await readJson(join(this.config.mirrorDir, 'REFRESH.json'))) as RefreshState;
    } catch (error) {
      if (!isMissing(error))
        return {
          ready: false,
          status: 'unavailable',
          provenance: null,
          importPolicy: null,
          refresh: null,
        };
    }
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
    const signal = AbortSignal.any([
      externalSignal ?? new AbortController().signal,
      AbortSignal.timeout(2_400_000),
    ]);
    await mkdir(this.config.mirrorDir, { recursive: true, mode: 0o700 });
    const lockPath = join(this.config.mirrorDir, 'WRITER.lock');
    let lock: FileHandle;
    try {
      lock = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')
        throw new MirrorError(
          'lock',
          'Another mirror writer owns WRITER.lock. Confirm its PID has exited before removing a stale lock.',
        );
      throw safeMirrorError(error, 'disk');
    }
    const generationId = `generation-${randomUUID()}`;
    const staging = join(this.config.mirrorDir, generationId);
    const archive = join(staging, 'download.zip');
    const startedAt = this.clock().toISOString();
    let published = false;
    try {
      await chmod(this.config.mirrorDir, 0o700);
      await lock.writeFile(JSON.stringify({ pid: process.pid, runId: generationId, startedAt }));
      await lock.sync();
      const current = await this.status();
      if (
        mode === 'init' &&
        current.ready &&
        current.importPolicy?.includeLocation === this.config.includeLocation
      )
        return current;
      await atomicJson(this.config.mirrorDir, 'REFRESH.json', {
        status: 'in_progress',
        startedAt,
      } satisfies RefreshState);
      const space = await statfs(this.config.mirrorDir);
      if (space.bavail * space.bsize < 1024 ** 3)
        throw new MirrorError(
          'disk',
          'Mirror import requires at least 1 GiB free storage reserve.',
        );
      await mkdir(staging, { mode: 0o700 });
      const source = await acquireSource(archive, this.fetcher, this.clock, signal);
      if (
        mode === 'refresh' &&
        current.ready &&
        current.provenance?.sha256 === source.sha256 &&
        current.importPolicy?.includeLocation === this.config.includeLocation
      ) {
        await atomicJson(this.config.mirrorDir, 'REFRESH.json', {
          status: 'complete',
          startedAt,
          finishedAt: this.clock().toISOString(),
        } satisfies RefreshState);
        return this.status();
      }
      const importSignal = AbortSignal.any([signal, AbortSignal.timeout(1_800_000)]);
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
      await rm(archive);
      for (const suffix of ['-wal', '-shm', '-journal']) {
        try {
          await lstat(`${database}${suffix}`);
          throw new MirrorError('integrity', 'Staging database still requires a SQLite sidecar.');
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      await chmod(database, 0o600);
      const file = await open(database, 'r');
      try {
        await file.sync();
      } finally {
        await file.close();
      }
      await syncDirectory(staging);
      signal.throwIfAborted();
      await atomicJson(this.config.mirrorDir, 'CURRENT', {
        generation: generationId,
        sha256: source.sha256,
      } satisfies Current);
      published = true;
      await syncDirectory(this.config.mirrorDir);
      await atomicJson(this.config.mirrorDir, 'REFRESH.json', {
        status: 'complete',
        startedAt,
        finishedAt: this.clock().toISOString(),
      } satisfies RefreshState);
      return this.status();
    } catch (error) {
      const safe = safeMirrorError(error, 'disk');
      await atomicJson(this.config.mirrorDir, 'REFRESH.json', {
        status: 'failed',
        startedAt,
        finishedAt: this.clock().toISOString(),
        stage: safe.stage,
      } satisfies RefreshState).catch(() => {});
      throw safe;
    } finally {
      await lock.close();
      await rm(lockPath);
      if (!published) await rm(staging, { recursive: true, force: true });
    }
  }
}
