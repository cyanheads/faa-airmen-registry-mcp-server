/** Real SQLite importer/lifecycle tests against synthetic network bytes. */
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AirmenMirror,
  IMPORT_DEADLINE_MS,
  REFRESH_DEADLINE_MS,
} from '../../src/services/airmen/airmen-mirror.js';
import { AirmenRegistryService } from '../../src/services/airmen/airmen-registry-service.js';
import { importArchive } from '../../src/services/airmen/importer.js';
import { safeMirrorError } from '../../src/services/airmen/mirror-error.js';
import { ACQUISITION_DEADLINE_MS } from '../../src/services/airmen/source.js';
import {
  basicRow,
  certificateRow,
  sourceFetch,
  sourceFiles,
  zipSource,
} from '../helpers/airmen-source.js';

/** A distinct valid snapshot per person ID, so a refresh to another ID publishes a new generation. */
function snapshot(id: string) {
  return zipSource(
    sourceFiles({
      pilotBasic: [basicRow(id)],
      nonpilotBasic: [basicRow(id)],
      pilotCert: [certificateRow(id)],
      nonpilotCert: [certificateRow(id, false)],
    }),
  );
}

/** The generation CURRENT names. */
async function published(directory: string): Promise<string> {
  return (JSON.parse(await readFile(join(directory, 'CURRENT'), 'utf8')) as { generation: string })
    .generation;
}

/** Every top-level `generation-*` entry, sorted. */
async function generations(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.startsWith('generation-')).sort();
}

/** The outcome REFRESH.json records for the last write. */
async function refreshRecord(directory: string) {
  return JSON.parse(await readFile(join(directory, 'REFRESH.json'), 'utf8')) as {
    stage?: string;
    status: string;
  };
}

const RECORD_START = '2026-10-19T00:00:00.000Z';
/** Every way REFRESH.json can exist without holding a valid refresh record; each replaces the file at `path`. */
const UNREADABLE_RECORDS: [string, (path: string) => Promise<void>][] = [
  ['truncated JSON', (path) => writeFile(path, '{')],
  ['JSON null', (path) => writeFile(path, 'null')],
  ['an array', (path) => writeFile(path, '[]')],
  ['a number', (path) => writeFile(path, '42')],
  ['in_progress without startedAt', (path) => writeFile(path, '{"status":"in_progress"}')],
  [
    'in_progress with an unparseable startedAt',
    (path) => writeFile(path, '{"status":"in_progress","startedAt":"not-a-date"}'),
  ],
  [
    'in_progress with a startedAt Date.parse accepts but no writer emits',
    (path) => writeFile(path, '{"status":"in_progress","startedAt":"1"}'),
  ],
  [
    'an unknown status',
    (path) => writeFile(path, JSON.stringify({ status: 'running', startedAt: RECORD_START })),
  ],
  [
    'failed with a stage that is not a stage',
    (path) =>
      writeFile(
        path,
        JSON.stringify({
          status: 'failed',
          stage: 42,
          startedAt: RECORD_START,
          finishedAt: RECORD_START,
        }),
      ),
  ],
  [
    'complete with an unparseable finishedAt',
    (path) =>
      writeFile(
        path,
        JSON.stringify({ status: 'complete', startedAt: RECORD_START, finishedAt: 'later' }),
      ),
  ],
  ['a directory', (path) => mkdir(path)],
  [
    'a file without read permission',
    async (path) => {
      await writeFile(path, JSON.stringify({ status: 'complete', startedAt: RECORD_START }));
      await chmod(path, 0o000);
    },
  ],
];
/** Replace REFRESH.json in `directory` with the damaged form `damage` writes. */
async function damageRecord(directory: string, damage: (path: string) => Promise<void>) {
  const path = join(directory, 'REFRESH.json');
  await rm(path, { recursive: true, force: true });
  await damage(path);
  return path;
}
/** Identity of a directory entry: a rewrite, replacement, or mode change alters it. */
async function fingerprint(path: string) {
  const { ino, mode, size, mtimeMs } = await lstat(path);
  return { ino, mode, size, mtimeMs };
}

/** Network fake whose page or archive request never settles until its signal aborts. */
function hangingFetch(hang: 'page' | 'archive', entered: () => void = () => {}): typeof fetch {
  const inner = sourceFetch(zipSource());
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const isPage = String(input instanceof Request ? input.url : input).endsWith(
      'releasable_airmen_download',
    );
    if (isPage !== (hang === 'page')) return inner(input, init);
    const pending = new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
    entered();
    return pending;
  }) as typeof fetch;
}

/**
 * Write configuration whose `includeLocation` read calls `interrupt` once a staging import has
 * created its database. The importer reads `includeLocation` for every BASIC row, so the call
 * lands mid-import, deterministically and without a large archive.
 */
function interruptingImport(directory: string, interrupt: () => void) {
  const current = join(directory, 'CURRENT');
  const kept = existsSync(current)
    ? (JSON.parse(readFileSync(current, 'utf8')) as { generation: string }).generation
    : undefined;
  let fired = false;
  const config = {
    mirrorDir: directory,
    staleAfterDays: 10,
    redactPii: false,
    get includeLocation() {
      if (
        !fired &&
        readdirSync(directory).some(
          (name) =>
            name.startsWith('generation-') &&
            name !== kept &&
            existsSync(join(directory, name, 'mirror.sqlite')),
        )
      ) {
        fired = true;
        interrupt();
      }
      return false;
    },
  };
  return { config, fired: () => fired };
}

/** The FileHandle prototype, reached through a read-only handle on this test file. */
async function fileHandlePrototype(): Promise<FileHandle> {
  const probe = await open(new URL(import.meta.url));
  await probe.close();
  return Object.getPrototypeOf(probe);
}

/**
 * Run `atRelease` once, as a writer starts releasing WRITER.lock: release opens with a bigint stat
 * of the held lock handle, after the run's last step and before the lock file is removed.
 */
async function onLockRelease(atRelease: () => void | Promise<void>): Promise<() => boolean> {
  const prototype = await fileHandlePrototype();
  const original = prototype.stat;
  let fired = false;
  vi.spyOn(prototype, 'stat').mockImplementation(async function (
    this: FileHandle,
    ...args: Parameters<FileHandle['stat']>
  ) {
    if (!fired && args[0]?.bigint) {
      fired = true;
      await atRelease();
    }
    return original.apply(this, args);
  } as FileHandle['stat']);
  return () => fired;
}

/** Capture a run's value or rejection without leaving it unhandled while the test waits. */
function settle(run: Promise<unknown>): Promise<unknown> {
  return run.catch((error: unknown) => error);
}

const realTimeout = AbortSignal.timeout.bind(AbortSignal);
/** Replace exactly one lifecycle deadline; every other timeout stays real. */
function replaceDeadline(target: number, replacement: () => AbortSignal) {
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) =>
    ms === target ? replacement() : realTimeout(ms),
  );
}
const timedOut = () => new DOMException('The operation timed out.', 'TimeoutError');

describe('synthetic FAA mirror', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'faa-synthetic-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });
  function mirror(bytes = zipSource(), includeLocation = false, redactPii = false) {
    return new AirmenMirror(
      { mirrorDir: directory, includeLocation, staleAfterDays: 10, redactPii },
      { fetch: sourceFetch(bytes), clock: () => new Date('2026-10-20T00:00:00Z') },
    );
  }
  /** A writer whose network is `fetcher`, on the real clock. */
  function fetching(fetcher: typeof fetch) {
    return new AirmenMirror(
      { mirrorDir: directory, includeLocation: false, staleAfterDays: 45, redactPii: false },
      { fetch: fetcher },
    );
  }

  it('does not create paths for missing status, verification or acquisition', async () => {
    const missing = new AirmenMirror({
      mirrorDir: join(directory, 'absent'),
      includeLocation: false,
      staleAfterDays: 45,
      redactPii: false,
    });
    expect(await missing.status()).toMatchObject({ ready: false, status: 'missing' });
    expect(await missing.verifyMirror()).toEqual({ ok: false, issues: ['missing'], counts: null });
    await expect(missing.acquire()).rejects.toMatchObject({ stage: 'missing' });
    expect(await readdir(directory)).toEqual([]);
  });

  it('joins families, preserves variants, complete slots, real CSV quoting, and removes private fields', async () => {
    const first = 'SYNTHETIC, "QUOTED"\nSECOND LINE';
    const pilot = certificateRow(undefined, true, {
      1: first,
      6: 'P/ASEL',
      16: 'P/INST',
      115: 'P/TEST-99',
    });
    const service = mirror(
      zipSource(
        sourceFiles({
          pilotBasic: [basicRow(undefined, { 1: first, 10: '3', 11: 'bad-date' })],
          nonpilotBasic: [basicRow(undefined, { 1: 'ALTERNATIVE', 10: '2', 11: '102026' })],
          pilotCert: [pilot, pilot, certificateRow(undefined, true, { 4: 'C' })],
        }),
      ),
    );
    expect(await service.initialize()).toMatchObject({
      ready: true,
      provenance: {
        counts: { airmen: 1, certificates: 3, ratings: 3, medicalRecords: 2 },
        stale: true,
        ageDays: 19,
      },
    });
    using lease = await service.acquire();
    expect(
      lease.db.prepare('SELECT first_name,source_families,city,zip_code FROM airmen').get(),
    ).toEqual({
      first_name: first,
      source_families: '["pilot","nonpilot"]',
      city: null,
      zip_code: null,
    });
    expect(lease.db.prepare('SELECT ordinal,raw FROM ratings ORDER BY kind,ordinal').all()).toEqual(
      [
        { ordinal: 1, raw: 'P/ASEL' },
        { ordinal: 11, raw: 'P/INST' },
        { ordinal: 99, raw: 'P/TEST-99' },
      ],
    );
    expect(
      lease.db.prepare('SELECT count(*) n FROM identity_variants WHERE origin=?').get('basic'),
    ).toEqual({ n: 2 });
    expect(lease.metadata.warnings.malformedDates).toBe(1);
    const tables = lease.db
      .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .all();
    for (const { name } of tables) {
      const text = JSON.stringify(lease.db.prepare(`SELECT * FROM "${name}"`).all());
      expect(text).not.toContain('PRIVATE STREET SENTINEL');
      expect(text).not.toContain('PRIVATE UNIT SENTINEL');
      expect(text).not.toContain('TEST CITY SENTINEL');
      expect(text).not.toContain('"zip_code":"99999"');
    }
    expect(await service.verifyMirror()).toMatchObject({ ok: true, issues: [] });
  });

  it('counts undocumented level codes and not the 14 CFR SUAS rating, keeping reference version 1', async () => {
    const service = mirror(
      zipSource(
        sourceFiles({
          pilotCert: [
            certificateRow(undefined, true, { 4: 'Q' }),
            certificateRow(undefined, true, { 3: 'M', 4: 'Z' }),
            certificateRow(undefined, true, { 3: 'W', 4: 'U' }),
          ],
          nonpilotCert: [certificateRow(undefined, false, { 3: 'U', 4: '', 6: 'U/SUAS' })],
        }),
      ),
    );
    await service.initialize();
    using lease = await service.acquire();
    expect(lease.metadata.warnings).toEqual({
      unknownCodes: 2,
      malformedDates: 0,
      malformedRatings: 0,
    });
    expect(lease.metadata.referenceVersion).toBe(1);
  });

  it('merges exact certificates across families while retaining distinct same-type certificates', async () => {
    const service = mirror(
      zipSource(
        sourceFiles({
          pilotCert: [certificateRow(), certificateRow(undefined, true, { 4: 'C' })],
          nonpilotCert: [certificateRow(undefined, false)],
        }),
      ),
    );
    await service.initialize();
    using lease = await service.acquire();
    expect(
      lease.db.prepare('SELECT level,source_families FROM certificates ORDER BY level').all(),
    ).toEqual([
      { level: 'C', source_families: '["pilot"]' },
      { level: 'P', source_families: '["pilot","nonpilot"]' },
    ]);
  });

  it('accepts embedded quotes in unquoted discarded street fields without persisting them', async () => {
    const files = sourceFiles();
    files['NONPILOT_BASIC.csv'] = files['NONPILOT_BASIC.csv']!.replace(
      'PRIVATE STREET SENTINEL',
      '123 "SYNTHETIC" ROAD',
    );
    const service = mirror(zipSource(files));
    expect(await service.initialize()).toMatchObject({ ready: true });
    using lease = await service.acquire();
    expect(JSON.stringify(lease.db.prepare('SELECT * FROM airmen').all())).not.toContain(
      'SYNTHETIC" ROAD',
    );
    expect(await service.verifyMirror()).toMatchObject({ ok: true });
  });

  it('replaces omitted records atomically while held leases keep the old generation', async () => {
    const original = mirror();
    await original.initialize();
    using held = await original.acquire();
    const replacement = mirror(
      zipSource(
        sourceFiles({
          pilotBasic: [basicRow('C9999998')],
          nonpilotBasic: [basicRow('C9999998')],
          pilotCert: [certificateRow('C9999998')],
          nonpilotCert: [certificateRow('C9999998', false)],
        }),
      ),
    );
    await replacement.refresh();
    using fresh = await mirror().acquire();
    expect(fresh.metadata.generationId).not.toBe(held.metadata.generationId);
    expect(fresh.db.prepare('SELECT unique_id FROM airmen').all()).toEqual([
      { unique_id: 'C9999998' },
    ]);
    expect(held.db.prepare('SELECT unique_id FROM airmen').all()).toEqual([
      { unique_id: 'A9999999' },
    ]);
    held.release();
    held.release();
  });

  it('rebuilds identical bytes for a changed location policy and otherwise no-ops', async () => {
    const service = mirror();
    await service.initialize();
    const before = await readFile(join(directory, 'CURRENT'), 'utf8');
    await service.refresh();
    expect(await readFile(join(directory, 'CURRENT'), 'utf8')).toBe(before);
    await mirror(undefined, true).refresh();
    using lease = await service.acquire();
    expect(lease.metadata.includeLocation).toBe(true);
    expect(lease.db.prepare('SELECT city,zip_code FROM airmen').get()).toEqual({
      city: 'TEST CITY SENTINEL',
      zip_code: '99999',
    });
    await service.refresh();
    using disabled = await service.acquire();
    expect(disabled.db.prepare('SELECT city,zip_code FROM airmen').get()).toEqual({
      city: null,
      zip_code: null,
    });
  });

  it('imports and keeps city and ZIP under personal-data redaction, which only serving withholds', async () => {
    const redacted = (bytes = zipSource()) =>
      new AirmenRegistryService(
        { mirrorDir: directory, includeLocation: true, staleAfterDays: 10, redactPii: true },
        { fetch: sourceFetch(bytes), clock: () => new Date('2026-10-20T00:00:00Z') },
      );
    const service = redacted();
    await service.initialize();
    const before = await readFile(join(directory, 'CURRENT'), 'utf8');
    // Same bytes and the same import policy: a refresh with redaction on no-ops instead of rebuilding.
    await service.mirror.refresh();
    expect(await readFile(join(directory, 'CURRENT'), 'utf8')).toBe(before);
    expect((await service.mirror.status()).importPolicy).toEqual({ includeLocation: true });
    {
      using lease = await service.mirror.acquire();
      expect(lease.metadata.includeLocation).toBe(true);
      expect(lease.db.prepare('SELECT city,zip_code FROM airmen').get()).toEqual({
        city: 'TEST CITY SENTINEL',
        zip_code: '99999',
      });
    }
    const served = await service.verifyCertificates({ mode: 'id', uniqueId: 'A9999999' });
    expect(served.enrichment).toMatchObject({
      piiRedacted: true,
      provenance: { includeLocation: true },
    });
    expect(served.data.matches[0]!.airman).not.toHaveProperty('city');
    expect(served.data.matches[0]!.airman).not.toHaveProperty('zipCode');
    expect(JSON.stringify(served)).not.toContain('TEST CITY SENTINEL');
    // New source bytes rebuild under the same policy and still import location.
    const replacement = redacted(
      zipSource(sourceFiles({ pilotBasic: [basicRow(undefined, { 5: 'NEW CITY SENTINEL' })] })),
    );
    await replacement.mirror.refresh();
    expect(await readFile(join(directory, 'CURRENT'), 'utf8')).not.toBe(before);
    using fresh = await replacement.mirror.acquire();
    expect(fresh.metadata.includeLocation).toBe(true);
    expect(
      fresh.db
        .prepare("SELECT COUNT(*) n FROM identity_variants WHERE city='NEW CITY SENTINEL'")
        .get(),
    ).toEqual({ n: 1 });
  });

  it.each(['crc', 'missing_member', 'header', 'invalid_id', 'orphan'] as const)(
    'preserves CURRENT and cleans staging after %s failure',
    async (kind) => {
      await mirror().initialize();
      const before = await readFile(join(directory, 'CURRENT'), 'utf8');
      const files = sourceFiles();
      if (kind === 'missing_member') delete files['PILOT_CERT.csv'];
      if (kind === 'header')
        files['PILOT_BASIC.csv'] = files['PILOT_BASIC.csv']!.replace('FIRST NAME', 'GIVEN NAME');
      if (kind === 'invalid_id')
        Object.assign(files, sourceFiles({ pilotBasic: [basicRow('12345678')] }));
      if (kind === 'orphan')
        Object.assign(files, sourceFiles({ pilotCert: [certificateRow('C9999998')] }));
      await expect(mirror(zipSource(files, kind === 'crc')).refresh()).rejects.toMatchObject({
        stage: kind === 'header' ? 'schema' : 'validation',
      });
      expect(await readFile(join(directory, 'CURRENT'), 'utf8')).toBe(before);
      expect(await mirror().status()).toMatchObject({ ready: true, refresh: { status: 'failed' } });
      expect(
        (await readdir(directory)).filter((name) => name.startsWith('generation-')),
      ).toHaveLength(1);
      expect(await readdir(directory)).not.toContain('WRITER.lock');
    },
  );

  it('rejects competing writers and releases an aborted writer lock', async () => {
    await writeFile(join(directory, 'WRITER.lock'), 'synthetic-owner');
    await expect(mirror().initialize()).rejects.toMatchObject({ stage: 'lock' });
    expect(await readFile(join(directory, 'WRITER.lock'), 'utf8')).toBe('synthetic-owner');
    await rm(join(directory, 'WRITER.lock'));
    const controller = new AbortController();
    controller.abort();
    const error = await settle(mirror().initialize(controller.signal));
    expect(error).toMatchObject({
      stage: 'cancelled',
      message: expect.stringContaining('cancelled'),
    });
    // A cold init has no published snapshot, so the message must not claim one survived.
    expect((error as Error).message).not.toContain('preserved');
    expect(await readdir(directory)).toEqual(['REFRESH.json']);
    expect(await refreshRecord(directory)).toMatchObject({ status: 'failed', stage: 'cancelled' });
  });

  it('cancels an in-flight acquisition without publishing or retaining the writer lock', async () => {
    await mirror().initialize();
    const current = await readFile(join(directory, 'CURRENT'), 'utf8');
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const controller = new AbortController();
    const fetcher = (async (_input: unknown, init?: RequestInit) => {
      started();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }) as typeof fetch;
    const service = new AirmenMirror(
      { mirrorDir: directory, includeLocation: false, staleAfterDays: 45, redactPii: false },
      { fetch: fetcher },
    );
    const pending = service.refresh(controller.signal);
    await entered;
    await expect(mirror().refresh()).rejects.toMatchObject({ stage: 'lock' });
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      stage: 'cancelled',
      message: expect.stringContaining('cancelled'),
    });
    expect(await readFile(join(directory, 'CURRENT'), 'utf8')).toBe(current);
    expect(await readdir(directory)).not.toContain('WRITER.lock');
    expect(
      (await readdir(directory)).filter((name) => name.startsWith('generation-')),
    ).toHaveLength(1);
    expect(await refreshRecord(directory)).toMatchObject({ status: 'failed', stage: 'cancelled' });
    expect(await mirror().status()).toMatchObject({
      ready: true,
      refresh: { status: 'failed', stage: 'cancelled' },
    });
  });

  it.each(['page', 'archive'] as const)(
    'records a caller abort during the %s fetch as cancelled on a cold init',
    async (hang) => {
      const controller = new AbortController();
      const error = await settle(
        fetching(hangingFetch(hang, () => controller.abort())).initialize(controller.signal),
      );
      expect(error).toMatchObject({ stage: 'cancelled' });
      expect((error as Error).message).not.toContain('preserved');
      expect(await readdir(directory)).toEqual(['REFRESH.json']);
      expect(await refreshRecord(directory)).toMatchObject({
        status: 'failed',
        stage: 'cancelled',
      });
    },
  );

  it('records a caller abort during the import as cancelled and keeps CURRENT', async () => {
    await mirror().initialize();
    const current = await readFile(join(directory, 'CURRENT'), 'utf8');
    const kept = await published(directory);
    const controller = new AbortController();
    const run = interruptingImport(directory, () => controller.abort());
    const error = await settle(
      new AirmenMirror(run.config, {
        fetch: sourceFetch(snapshot('C9999998')),
        clock: () => new Date('2026-10-20T00:00:00Z'),
      }).refresh(controller.signal),
    );
    expect(run.fired()).toBe(true);
    expect(error).toMatchObject({ stage: 'cancelled' });
    expect(await readFile(join(directory, 'CURRENT'), 'utf8')).toBe(current);
    expect(await generations(directory)).toEqual([kept]);
    expect(await readdir(directory)).not.toContain('WRITER.lock');
    expect(await refreshRecord(directory)).toMatchObject({ status: 'failed', stage: 'cancelled' });
  });

  it('records the acquisition deadline as timeout', async () => {
    const deadline = new AbortController();
    replaceDeadline(ACQUISITION_DEADLINE_MS, () => deadline.signal);
    const error = await settle(
      fetching(hangingFetch('archive', () => deadline.abort(timedOut()))).initialize(),
    );
    expect(error).toMatchObject({
      stage: 'timeout',
      message: expect.stringContaining('10-minute'),
    });
    expect(await refreshRecord(directory)).toMatchObject({ status: 'failed', stage: 'timeout' });
    expect(await readdir(directory)).toEqual(['REFRESH.json']);
  });

  it('records the import deadline as timeout', async () => {
    replaceDeadline(IMPORT_DEADLINE_MS, () => AbortSignal.abort(timedOut()));
    const error = await settle(mirror().initialize());
    expect(error).toMatchObject({
      stage: 'timeout',
      message: expect.stringContaining('30-minute'),
    });
    expect((error as Error).message).not.toContain('preserved');
    expect(await refreshRecord(directory)).toMatchObject({ status: 'failed', stage: 'timeout' });
    expect(await readdir(directory)).toEqual(['REFRESH.json']);
  });

  it('attributes a failure after the import returns to its own stage, not the spent import deadline', async () => {
    const importDeadline = new AbortController();
    replaceDeadline(IMPORT_DEADLINE_MS, () => importDeadline.signal);
    let fired = false;
    /** The importer reads the clock once, for importedAt, after its last signal check. */
    const clock = () => {
      const staging = readdirSync(directory).find((name) => name.startsWith('generation-'));
      if (!fired && staging && existsSync(join(directory, staging, 'mirror.sqlite'))) {
        fired = true;
        importDeadline.abort(timedOut());
        // The run's next step removes the archive; removing it first makes that step fail.
        unlinkSync(join(directory, staging, 'download.zip'));
      }
      return new Date('2026-10-20T00:00:00Z');
    };
    const error = await settle(
      new AirmenMirror(
        { mirrorDir: directory, includeLocation: false, staleAfterDays: 10, redactPii: false },
        { fetch: sourceFetch(zipSource()), clock },
      ).initialize(),
    );
    expect(fired).toBe(true);
    expect(error).toMatchObject({
      name: 'MirrorError',
      stage: 'disk',
      message: 'Mirror operation failed; no new snapshot was published.',
    });
    expect(await refreshRecord(directory)).toMatchObject({ status: 'failed', stage: 'disk' });
    expect(await readdir(directory)).toEqual(['REFRESH.json']);
  });

  it('records the overall write deadline during the import as timeout', async () => {
    const deadline = new AbortController();
    replaceDeadline(REFRESH_DEADLINE_MS, () => deadline.signal);
    const run = interruptingImport(directory, () => deadline.abort(timedOut()));
    const error = await settle(
      new AirmenMirror(run.config, {
        fetch: sourceFetch(zipSource()),
        clock: () => new Date('2026-10-20T00:00:00Z'),
      }).initialize(),
    );
    expect(run.fired()).toBe(true);
    expect(error).toMatchObject({
      stage: 'timeout',
      message: expect.stringContaining('40-minute'),
    });
    expect(await refreshRecord(directory)).toMatchObject({ status: 'failed', stage: 'timeout' });
    expect(await readdir(directory)).toEqual(['REFRESH.json']);
  });

  it('records an FAA page link the URL parser rejects as acquisition', async () => {
    const fetcher = (async () =>
      new Response('<a href="https://[bad/CS102026.zip">CSV</a>')) as typeof fetch;
    const error = await settle(fetching(fetcher).initialize());
    expect(error).toMatchObject({ stage: 'acquisition' });
    expect((error as Error).message).not.toContain('preserved');
    expect(await refreshRecord(directory)).toMatchObject({
      status: 'failed',
      stage: 'acquisition',
    });
  });

  it('records a database the importer cannot create as disk', async () => {
    const archive = join(directory, 'download.zip');
    await writeFile(archive, zipSource());
    const staging = join(directory, 'read-only-staging');
    await mkdir(staging);
    await chmod(staging, 0o500);
    try {
      const source = {
        archiveUrl: 'https://registry.faa.gov/CS102026.zip',
        snapshotMonth: '2026-10',
        sha256: 'a'.repeat(64),
        downloadedAt: '2026-10-20T00:00:00.000Z',
      };
      await expect(
        importArchive(
          archive,
          join(staging, 'mirror.sqlite'),
          'generation-00000000-0000-4000-8000-000000000000',
          source,
          { mirrorDir: directory, includeLocation: false, staleAfterDays: 45, redactPii: false },
          () => new Date('2026-10-20T00:00:00Z'),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ stage: 'disk' });
    } finally {
      await chmod(staging, 0o700);
    }
  });

  it.each([
    ['SQLITE_CANTOPEN', 'disk'],
    ['SQLITE_FULL', 'disk'],
    ['SQLITE_IOERR', 'disk'],
    ['SQLITE_IOERR_WRITE', 'disk'],
    ['SQLITE_IOERR_SHORT_READ', 'disk'],
    ['SQLITE_READONLY', 'disk'],
    ['SQLITE_READONLY_DBMOVED', 'disk'],
    ['ENOSPC', 'disk'],
    ['EACCES', 'disk'],
    ['EDQUOT', 'disk'],
    ['EIO', 'disk'],
    ['SQLITE_CONSTRAINT', 'validation'],
    ['SQLITE_CANTOPENX', 'validation'],
    [undefined, 'validation'],
  ])('classifies driver code %s as %s, directly or wrapped as a cause', (code, stage) => {
    const raw = Object.assign(new Error('synthetic driver failure'), { code });
    const wrapped = new Error('synthetic wrapper', { cause: raw });
    for (const error of [raw, wrapped]) {
      const safe = safeMirrorError(error, 'validation');
      expect(safe.stage).toBe(stage);
      expect(safe.message).not.toContain('synthetic');
      expect(safe.message).not.toContain('preserved');
    }
  });

  it.each([
    [
      'older than the refresh deadline',
      REFRESH_DEADLINE_MS + 1,
      { status: 'failed', stage: 'interrupted' },
    ],
    ['exactly at the refresh deadline', REFRESH_DEADLINE_MS, { status: 'in_progress' }],
    ['younger than the refresh deadline', 60_000, { status: 'in_progress' }],
  ])(
    'reports an in-progress record %s without touching the lock or the record',
    async (_label, age, expected) => {
      await mirror().initialize();
      const now = Date.parse('2026-10-20T00:00:00Z');
      const record = JSON.stringify({
        status: 'in_progress',
        startedAt: new Date(now - age).toISOString(),
      });
      const lock = JSON.stringify({ pid: 999_999_999, runId: 'generation-synthetic' });
      await writeFile(join(directory, 'REFRESH.json'), record);
      await writeFile(join(directory, 'WRITER.lock'), lock);
      const status = await mirror().status();
      expect(status).toMatchObject({ ready: true, refresh: expected });
      expect(status.refresh).toMatchObject({ startedAt: new Date(now - age).toISOString() });
      if (expected.status === 'in_progress') expect(status.refresh).not.toHaveProperty('stage');
      expect(await readFile(join(directory, 'REFRESH.json'), 'utf8')).toBe(record);
      expect(await readFile(join(directory, 'WRITER.lock'), 'utf8')).toBe(lock);
    },
  );

  it.each(UNREADABLE_RECORDS)(
    'reports the published generation as ready and the refresh as unreadable when REFRESH.json is %s, changing neither file',
    async (_label, damage) => {
      await mirror().initialize();
      const generationId = await published(directory);
      const record = await damageRecord(directory, damage);
      const lock = join(directory, 'WRITER.lock');
      await writeFile(lock, 'synthetic-dead-owner');
      const before = { record: await fingerprint(record), lock: await fingerprint(lock) };
      const status = await mirror().status();
      expect(status).toMatchObject({
        ready: true,
        status: 'ready',
        provenance: { generationId },
        importPolicy: { includeLocation: false },
      });
      expect(status.refresh).toEqual({ status: 'unreadable' });
      expect(await mirror().verifyMirror()).toMatchObject({ ok: true, issues: [] });
      expect({ record: await fingerprint(record), lock: await fingerprint(lock) }).toEqual(before);
    },
  );

  it('reports missing with the unreadable refresh when CURRENT is absent', async () => {
    await mirror().initialize();
    await rm(join(directory, 'CURRENT'));
    await damageRecord(directory, (path) => writeFile(path, '{'));
    expect(await mirror().status()).toEqual({
      ready: false,
      status: 'missing',
      provenance: null,
      importPolicy: null,
      refresh: { status: 'unreadable' },
    });
  });

  it('reads a valid record as its known fields only, and an absent one as null', async () => {
    await mirror().initialize();
    const record = {
      status: 'failed',
      stage: 'disk',
      startedAt: RECORD_START,
      finishedAt: '2026-10-19T00:05:00.000Z',
    };
    await writeFile(join(directory, 'REFRESH.json'), JSON.stringify({ ...record, note: 'extra' }));
    expect((await mirror().status()).refresh).toEqual(record);
    await rm(join(directory, 'REFRESH.json'));
    expect((await mirror().status()).refresh).toBeNull();
  });

  it('init over a ready mirror with a malformed REFRESH.json builds nothing; an unchanged refresh rewrites it as complete', async () => {
    await mirror().initialize();
    const before = await generations(directory);
    const record = await damageRecord(directory, (path) => writeFile(path, '{'));
    expect(await mirror().initialize()).toMatchObject({
      ready: true,
      refresh: { status: 'unreadable' },
    });
    expect(await generations(directory)).toEqual(before);
    expect(await readFile(record, 'utf8')).toBe('{');
    expect(await mirror().refresh()).toMatchObject({
      ready: true,
      refresh: { status: 'complete' },
    });
    expect(await generations(directory)).toEqual(before);
    expect(await refreshRecord(directory)).toMatchObject({ status: 'complete' });
    expect(await readdir(directory)).not.toContain('WRITER.lock');
  });

  it.each([
    [
      'one millisecond past',
      REFRESH_DEADLINE_MS + 1,
      { status: 'failed', stage: 'interrupted' },
      {
        name: 'MirrorError',
        stage: 'timeout',
        message: 'Mirror refresh exceeded its 40-minute deadline; no new snapshot was published.',
      },
      { status: 'failed', stage: 'timeout' },
    ],
    [
      'exactly at',
      REFRESH_DEADLINE_MS,
      { status: 'in_progress' },
      { ready: true, refresh: { status: 'complete' } },
      { status: 'complete' },
    ],
  ] as const)(
    'a refresh whose wall clock moves %s the refresh deadline (host sleep) publishes only while status reads it as running',
    async (_label, elapsed, seen, outcome, record) => {
      await mirror().initialize();
      const current = await readFile(join(directory, 'CURRENT'), 'utf8');
      const config = {
        mirrorDir: directory,
        includeLocation: false,
        staleAfterDays: 10,
        redactPii: false,
      };
      let now = Date.parse('2026-10-20T00:00:00Z');
      const clock = () => new Date(now);
      const inner = sourceFetch(snapshot('C9999998'));
      let during: unknown;
      const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.endsWith('releasable_airmen_download')) {
          // The host sleeps mid-download: wall time moves, the monotonic deadline timer does not.
          now += elapsed;
          during = (await new AirmenMirror(config, { clock }).status()).refresh;
        }
        return inner(input, init);
      }) as typeof fetch;
      const result = await settle(new AirmenMirror(config, { fetch: fetcher, clock }).refresh());
      expect(during).toMatchObject(seen);
      expect(result).toMatchObject(outcome);
      expect(await refreshRecord(directory)).toMatchObject(record);
      const publishes = record.status === 'complete';
      expect((await readFile(join(directory, 'CURRENT'), 'utf8')) !== current).toBe(publishes);
      expect(await generations(directory)).toHaveLength(publishes ? 2 : 1);
      expect(await readdir(directory)).not.toContain('WRITER.lock');
    },
  );

  it('never classifies an abort by its error name', () => {
    for (const name of ['AbortError', 'TimeoutError']) {
      const safe = safeMirrorError(new DOMException('synthetic', name), 'acquisition');
      expect(safe.stage).toBe('acquisition');
      expect(safe.message).not.toMatch(/cancelled|timed out|preserved/);
    }
  });

  it.each(['unexpected.csv', '../escape.csv'])(
    'rejects an unexpected archive member %s without retaining staging',
    async (member) => {
      await expect(
        mirror(zipSource({ ...sourceFiles(), [member]: 'synthetic' })).initialize(),
      ).rejects.toMatchObject({ stage: 'validation' });
      expect(await mirror().status()).toMatchObject({
        ready: false,
        status: 'missing',
        refresh: { status: 'failed' },
      });
      expect(await readdir(directory)).toEqual(['REFRESH.json']);
    },
  );

  it('reads and verifies published generations without modifying database bytes or directory entries', async () => {
    const service = mirror();
    await service.initialize();
    const current = JSON.parse(await readFile(join(directory, 'CURRENT'), 'utf8')) as {
      generation: string;
    };
    const generation = join(directory, current.generation);
    const database = join(generation, 'mirror.sqlite');
    const before = await readFile(database);
    const entries = await readdir(generation);
    await chmod(database, 0o400);
    await chmod(generation, 0o500);
    try {
      expect(await service.status()).toMatchObject({ ready: true });
      expect(await service.verifyMirror()).toMatchObject({ ok: true });
      using lease = await service.acquire();
      expect(lease.db.prepare('SELECT count(*) n FROM airmen').get()).toEqual({ n: 1 });
      expect(() => lease.db.prepare('DELETE FROM airmen').get()).toThrow();
      expect(await readFile(database)).toEqual(before);
      expect(await readdir(generation)).toEqual(entries);
    } finally {
      await chmod(generation, 0o700);
      await chmod(database, 0o600);
    }
  });
});

describe('superseded generation pruning', () => {
  let directory: string;
  let outside: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'faa-prune-'));
    outside = await mkdtemp(join(tmpdir(), 'faa-prune-outside-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const name of await readdir(directory).catch((): string[] => []))
      await chmod(join(directory, name), 0o700).catch(() => {});
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const config = () => ({
    mirrorDir: directory,
    includeLocation: false,
    staleAfterDays: 45,
    redactPii: false,
  });
  const mirror = (bytes = snapshot('A9999999'), fetcher = sourceFetch(bytes)) =>
    new AirmenMirror(config(), { fetch: fetcher, clock: () => new Date('2026-10-20T00:00:00Z') });
  /** Apparent size of every regular file below a generation directory. */
  async function size(name: string): Promise<number> {
    let bytes = 0;
    for (const entry of await readdir(join(directory, name), {
      recursive: true,
      withFileTypes: true,
    }))
      if (entry.isFile()) bytes += (await stat(join(entry.parentPath, entry.name))).size;
    return bytes;
  }
  async function threeGenerations() {
    await mirror(snapshot('A9999999')).initialize();
    await mirror(snapshot('C9999998')).refresh();
    await mirror(snapshot('A9999997')).refresh();
    expect(await generations(directory)).toHaveLength(3);
  }
  const uuidName = () => `generation-${randomUUID()}`;
  /** Network fake serving `bytes`; on the archive request, `during` runs while staging exists. */
  function duringArchive(
    bytes: Uint8Array,
    during: (staging: string) => Promise<void>,
  ): typeof fetch {
    const inner = sourceFetch(bytes);
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.endsWith('releasable_airmen_download')) {
        const kept = await published(directory);
        await during((await generations(directory)).find((name) => name !== kept)!);
      }
      return inner(input, init);
    }) as typeof fetch;
  }
  /** Leave a file two levels below staging that a recursive removal cannot delete. */
  async function lockInside(staging: string): Promise<string> {
    const locked = join(directory, staging, 'nested', 'locked');
    await mkdir(locked, { recursive: true });
    await writeFile(join(locked, 'part'), 'x');
    await chmod(locked, 0o500);
    return locked;
  }
  /** Refresh to a new snapshot while `inject` runs during its archive fetch; restores the mode. */
  async function refreshWith(inject: () => Promise<void>) {
    try {
      return await settle(
        mirror(snapshot('C9999998'), duringArchive(snapshot('C9999998'), inject)).refresh(),
      );
    } finally {
      await chmod(directory, 0o700);
    }
  }
  const PUBLISHED_THEN_FAILED =
    'Mirror refresh published a new snapshot, which readers now serve, but a storage step after publishing failed; check free space and directory permissions.';
  const OTHER_WRITER = JSON.stringify({ pid: 999_999_998, runId: 'synthetic-second-writer' });

  it('removes every generation CURRENT does not name and reports the bytes freed', async () => {
    await threeGenerations();
    const kept = await published(directory);
    const current = await readFile(join(directory, 'CURRENT'), 'utf8');
    const refresh = await readFile(join(directory, 'REFRESH.json'), 'utf8');
    const superseded = (await generations(directory)).filter((name) => name !== kept);
    const expectedBytes = (await Promise.all(superseded.map(size))).reduce((a, b) => a + b, 0);
    expect(expectedBytes).toBeGreaterThan(0);
    const result = await mirror().prune();
    expect(result).toEqual({
      ok: true,
      kept,
      removed: expect.arrayContaining(
        superseded.map((generation) => ({ generation, bytes: expect.any(Number) })),
      ),
      bytesFreed: expectedBytes,
      skipped: [],
      failed: [],
    });
    expect(result.removed).toHaveLength(2);
    expect(await generations(directory)).toEqual([kept]);
    expect(await readFile(join(directory, 'CURRENT'), 'utf8')).toBe(current);
    expect(await readFile(join(directory, 'REFRESH.json'), 'utf8')).toBe(refresh);
    expect(await readdir(directory)).not.toContain('WRITER.lock');
    expect(await mirror().verifyMirror()).toMatchObject({ ok: true, issues: [] });
    expect(JSON.stringify(result)).not.toContain(directory);
  });

  it('refuses with lock and deletes nothing while WRITER.lock exists', async () => {
    await threeGenerations();
    const before = await generations(directory);
    await writeFile(join(directory, 'WRITER.lock'), 'synthetic-owner');
    await expect(mirror().prune()).rejects.toMatchObject({ stage: 'lock' });
    expect(await generations(directory)).toEqual(before);
    expect(await readFile(join(directory, 'WRITER.lock'), 'utf8')).toBe('synthetic-owner');
  });

  it('holds WRITER.lock until its deletions finish, so a refresh started then fails with lock', async () => {
    await mirror().initialize();
    const superseded = uuidName();
    await mkdir(join(directory, superseded));
    await writeFile(join(directory, superseded, 'part'), 'x');
    let deletedBeforeRelease: boolean | undefined;
    let competing: unknown;
    const released = await onLockRelease(async () => {
      deletedBeforeRelease = !existsSync(join(directory, superseded));
      competing = await settle(mirror(snapshot('C9999998')).refresh());
    });
    expect(await mirror().prune()).toMatchObject({
      ok: true,
      removed: [{ generation: superseded, bytes: 1 }],
    });
    expect(released()).toBe(true);
    expect(deletedBeforeRelease).toBe(true);
    expect(competing).toMatchObject({ stage: 'lock' });
    expect(await generations(directory)).toEqual([await published(directory)]);
    expect(await readdir(directory)).not.toContain('WRITER.lock');
  });

  it('a refresh whose WRITER.lock another writer replaced meanwhile leaves that lock in place', async () => {
    await mirror().initialize();
    const lock = join(directory, 'WRITER.lock');
    const bytes = snapshot('C9999998');
    const status = await mirror(
      bytes,
      duringArchive(bytes, async () => {
        await rm(lock);
        await writeFile(lock, OTHER_WRITER, { flag: 'wx' });
      }),
    ).refresh();
    expect(status).toMatchObject({ ready: true, refresh: { status: 'complete' } });
    expect(await readFile(lock, 'utf8')).toBe(OTHER_WRITER);
    // The other writer still owns the mirror, so a third writer cannot start beside it.
    await expect(mirror(snapshot('A9999997')).refresh()).rejects.toMatchObject({ stage: 'lock' });
    expect(await readFile(lock, 'utf8')).toBe(OTHER_WRITER);
  });

  it('a prune whose WRITER.lock another writer replaced meanwhile leaves that lock in place', async () => {
    await threeGenerations();
    const kept = await published(directory);
    const lock = join(directory, 'WRITER.lock');
    let replaced = false;
    // Prune reads the clock for its lock record, then again while it checks the snapshot under the lock.
    const clock = () => {
      if (!replaced && existsSync(lock)) {
        replaced = true;
        unlinkSync(lock);
        writeFileSync(lock, OTHER_WRITER, { flag: 'wx' });
      }
      return new Date('2026-10-20T00:00:00Z');
    };
    const result = await new AirmenMirror(config(), { clock }).prune();
    expect(replaced).toBe(true);
    expect(result).toMatchObject({ ok: true, kept, skipped: [], failed: [] });
    expect(result.removed).toHaveLength(2);
    expect(await generations(directory)).toEqual([kept]);
    expect(await readFile(lock, 'utf8')).toBe(OTHER_WRITER);
  });

  it('leaves its own WRITER.lock when it cannot read the lock handle, and still returns its result', async () => {
    await threeGenerations();
    const kept = await published(directory);
    vi.spyOn(await fileHandlePrototype(), 'stat').mockRejectedValue(
      Object.assign(new Error('synthetic handle stat failure'), { code: 'EIO' }),
    );
    const result = await mirror().prune();
    vi.restoreAllMocks();
    expect(result).toMatchObject({ ok: true, kept, failed: [] });
    expect(await generations(directory)).toEqual([kept]);
    expect(JSON.parse(await readFile(join(directory, 'WRITER.lock'), 'utf8'))).toMatchObject({
      pid: process.pid,
      runId: 'prune',
    });
  });

  it.each([
    ['missing', 'absent', () => rm(join(directory, 'CURRENT'))],
    ['unavailable', 'malformed', () => writeFile(join(directory, 'CURRENT'), '{not json')],
    [
      'unavailable',
      'naming an absent generation',
      () =>
        writeFile(
          join(directory, 'CURRENT'),
          JSON.stringify({ generation: uuidName(), sha256: 'a'.repeat(64) }),
        ),
    ],
  ] as const)(
    'refuses with %s and deletes nothing when CURRENT is %s',
    async (stage, _label, damage) => {
      await threeGenerations();
      const before = await generations(directory);
      await damage();
      await expect(mirror().prune()).rejects.toMatchObject({ stage });
      expect(await generations(directory)).toEqual(before);
      expect(await readdir(directory)).not.toContain('WRITER.lock');
    },
  );

  it.each([
    ['malformed', (path: string) => writeFile(path, '{not json')],
    ['a directory', (path: string) => mkdir(path)],
  ] as const)(
    'prunes superseded generations and leaves REFRESH.json as it found it when it is %s',
    async (_label, damage) => {
      await threeGenerations();
      const kept = await published(directory);
      const record = await damageRecord(directory, damage);
      const before = await fingerprint(record);
      const result = await mirror().prune();
      expect(result).toMatchObject({ ok: true, kept, skipped: [], failed: [] });
      expect(result.removed).toHaveLength(2);
      expect(await generations(directory)).toEqual([kept]);
      expect(await fingerprint(record)).toEqual(before);
      expect(await readdir(directory)).not.toContain('WRITER.lock');
    },
  );

  it('refuses with missing and creates nothing for an absent mirror directory', async () => {
    const absent = join(directory, 'absent');
    await expect(
      new AirmenMirror({ ...config(), mirrorDir: absent }).prune(),
    ).rejects.toMatchObject({ stage: 'missing' });
    expect(await readdir(directory)).toEqual([]);
  });

  it('skips symlinks, files, and non-UUID names without following them', async () => {
    await mirror().initialize();
    const kept = await published(directory);
    await writeFile(join(outside, 'target.bin'), Buffer.alloc(4096));
    const link = uuidName();
    const file = uuidName();
    await symlink(outside, join(directory, link), 'dir');
    await writeFile(join(directory, file), 'not a directory');
    await mkdir(join(directory, 'generation-not-a-uuid'));
    const superseded = uuidName();
    await mkdir(join(directory, superseded));
    await writeFile(join(directory, superseded, 'mirror.sqlite'), 'synthetic');
    await symlink(join(outside, 'target.bin'), join(directory, superseded, 'linked.bin'));
    const result = await mirror().prune();
    expect(result).toMatchObject({ ok: true, kept, failed: [] });
    expect([...result.skipped].sort()).toEqual([file, link, 'generation-not-a-uuid'].sort());
    expect(result.removed).toEqual([{ generation: superseded, bytes: expect.any(Number) }]);
    expect(result.bytesFreed).toBeLessThan(4096);
    expect((await readFile(join(outside, 'target.bin'))).byteLength).toBe(4096);
    expect((await lstat(join(directory, link))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(directory, file), 'utf8')).toBe('not a directory');
    expect(await generations(directory)).toEqual(
      [kept, file, link, 'generation-not-a-uuid'].sort(),
    );
  });

  it('removes a killed refresh staging directory once its stale lock is removed', async () => {
    await mirror().initialize();
    const staging = uuidName();
    await mkdir(join(directory, staging));
    await writeFile(join(directory, staging, 'download.zip'), 'partial');
    await writeFile(join(directory, staging, 'mirror.sqlite-wal'), 'partial');
    await writeFile(
      join(directory, 'REFRESH.json'),
      JSON.stringify({ status: 'in_progress', startedAt: '2026-10-19T00:00:00.000Z' }),
    );
    await writeFile(join(directory, 'WRITER.lock'), JSON.stringify({ pid: 999_999_999 }));
    await expect(mirror().prune()).rejects.toMatchObject({ stage: 'lock' });
    expect(await generations(directory)).toContain(staging);
    await rm(join(directory, 'WRITER.lock'));
    expect(await mirror().prune()).toMatchObject({
      ok: true,
      removed: [{ generation: staging, bytes: 14 }],
      bytesFreed: 14,
    });
    expect(await generations(directory)).toEqual([await published(directory)]);
  });

  it('reports a deletion that fails, does not count it as freed, and is not ok', async () => {
    await mirror(snapshot('A9999999')).initialize();
    await mirror(snapshot('C9999998')).refresh();
    const kept = await published(directory);
    const [stuck] = (await generations(directory)).filter((name) => name !== kept);
    await chmod(join(directory, stuck!), 0o500);
    const result = await mirror().prune();
    expect(result).toEqual({
      ok: false,
      kept,
      removed: [],
      bytesFreed: 0,
      skipped: [],
      failed: [stuck],
    });
    expect(await generations(directory)).toContain(stuck);
    expect(await readdir(directory)).not.toContain('WRITER.lock');
  });

  it.each([
    ['failed', 'acquisition', 'Mirror operation failed; no new snapshot was published.'],
    [
      'cancelled',
      'cancelled',
      'Mirror refresh was cancelled before it finished; no new snapshot was published.',
    ],
  ] as const)(
    'a %s refresh removes its staging directory before releasing WRITER.lock',
    async (ending, stage, message) => {
      await mirror().initialize();
      const kept = await published(directory);
      const controller = new AbortController();
      let staging: string | undefined;
      const fetcher = (async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.endsWith('releasable_airmen_download'))
          return new Response('<a href="https://registry.faa.gov/CS102026.zip">CSV</a>');
        staging = (await generations(directory)).find((name) => name !== kept);
        await writeFile(join(directory, staging!, 'part'), 'x');
        if (ending === 'cancelled') {
          controller.abort();
          throw new DOMException('This operation was aborted', 'AbortError');
        }
        return new Response('forbidden', { status: 403 });
      }) as typeof fetch;
      let atRelease: { staging: boolean; lock: boolean } | undefined;
      const released = await onLockRelease(() => {
        atRelease = {
          staging: existsSync(join(directory, staging!)),
          lock: existsSync(join(directory, 'WRITER.lock')),
        };
      });
      const error = await settle(mirror(snapshot('C9999998'), fetcher).refresh(controller.signal));
      expect(error).toMatchObject({ stage, message });
      expect(released()).toBe(true);
      expect(atRelease).toEqual({ staging: false, lock: true });
      expect(await generations(directory)).toEqual([kept]);
      expect(await readdir(directory)).not.toContain('WRITER.lock');
    },
  );

  it.each([
    ['the published bytes', 'A9999999', false],
    ['new bytes', 'C9999998', true],
  ] as const)(
    'a refresh of %s records complete and keeps only generations CURRENT has named',
    async (_label, id, publishes) => {
      await mirror().initialize();
      const kept = await published(directory);
      const status = await mirror(snapshot(id)).refresh();
      const fresh = await published(directory);
      expect(fresh !== kept).toBe(publishes);
      expect(status).toMatchObject({
        ready: true,
        provenance: { generationId: fresh },
        refresh: { status: 'complete' },
      });
      const record = await refreshRecord(directory);
      expect(record).toMatchObject({ status: 'complete' });
      expect(record).not.toHaveProperty('stage');
      expect((await readdir(directory)).sort()).toEqual(
        [...new Set(['CURRENT', 'REFRESH.json', kept, fresh])].sort(),
      );
    },
  );

  it.each([
    ['failed', 'validation', 'FAA ZIP member failed size or CRC validation.'],
    [
      'cancelled',
      'cancelled',
      'Mirror refresh was cancelled before it finished; no new snapshot was published.',
    ],
  ] as const)(
    'a %s refresh whose staging removal fails keeps its classified error and leaves the generation to prune',
    async (ending, stage, message) => {
      await mirror().initialize();
      const kept = await published(directory);
      const current = await readFile(join(directory, 'CURRENT'), 'utf8');
      const controller = new AbortController();
      const bytes = ending === 'failed' ? zipSource(sourceFiles(), true) : snapshot('C9999998');
      let locked: string | undefined;
      const fetcher = duringArchive(bytes, async (staging) => {
        locked = await lockInside(staging);
        if (ending === 'cancelled') {
          controller.abort();
          throw new DOMException('This operation was aborted', 'AbortError');
        }
      });
      try {
        const error = await settle(mirror(bytes, fetcher).refresh(controller.signal));
        expect(error).toMatchObject({ name: 'MirrorError', stage, message });
        expect(await refreshRecord(directory)).toMatchObject({ status: 'failed', stage });
        expect(await readFile(join(directory, 'CURRENT'), 'utf8')).toBe(current);
        expect(await readdir(directory)).not.toContain('WRITER.lock');
      } finally {
        if (locked) await chmod(locked, 0o700);
      }
      const [leftover, ...others] = (await generations(directory)).filter((name) => name !== kept);
      expect(others).toEqual([]);
      expect(await mirror().operatorStatus()).toMatchObject({
        supersededGenerations: { count: 1, unmeasured: 0 },
      });
      expect(await mirror().prune()).toMatchObject({
        ok: true,
        kept,
        removed: [{ generation: leftover }],
      });
      expect(await generations(directory)).toEqual([kept]);
    },
  );

  it('a refresh of the published bytes whose staging removal fails still succeeds and leaves the generation to prune', async () => {
    await mirror().initialize();
    const kept = await published(directory);
    const current = await readFile(join(directory, 'CURRENT'), 'utf8');
    const bytes = snapshot('A9999999');
    let locked: string | undefined;
    const fetcher = duringArchive(bytes, async (staging) => {
      locked = await lockInside(staging);
    });
    try {
      expect(await mirror(bytes, fetcher).refresh()).toMatchObject({
        ready: true,
        provenance: { generationId: kept },
        refresh: { status: 'complete' },
      });
      const record = await refreshRecord(directory);
      expect(record).toMatchObject({ status: 'complete' });
      expect(record).not.toHaveProperty('stage');
      expect(await readFile(join(directory, 'CURRENT'), 'utf8')).toBe(current);
      expect(await readdir(directory)).not.toContain('WRITER.lock');
    } finally {
      if (locked) await chmod(locked, 0o700);
    }
    const [leftover, ...others] = (await generations(directory)).filter((name) => name !== kept);
    expect(leftover).toBeDefined();
    expect(others).toEqual([]);
    expect(await mirror().prune()).toMatchObject({
      ok: true,
      kept,
      removed: [{ generation: leftover }],
    });
    expect(await generations(directory)).toEqual([kept]);
  });

  it('a mirror directory sync that fails after CURRENT names the new generation says it was published', async () => {
    await mirror().initialize();
    const kept = await published(directory);
    // Without read permission, opening the directory to fsync it fails; creates and renames do not.
    const error = await refreshWith(() => chmod(directory, 0o300));
    expect(error).toMatchObject({
      name: 'MirrorError',
      stage: 'disk',
      message: PUBLISHED_THEN_FAILED,
    });
    const fresh = await published(directory);
    expect(fresh).not.toBe(kept);
    expect((await readdir(directory)).sort()).toEqual(
      ['CURRENT', 'REFRESH.json', fresh, kept].sort(),
    );
    expect(await refreshRecord(directory)).toMatchObject({ status: 'failed', stage: 'disk' });
    expect(await mirror().status()).toMatchObject({
      ready: true,
      provenance: { generationId: fresh },
      refresh: { status: 'failed', stage: 'disk' },
    });
    using lease = await mirror().acquire();
    expect(lease.db.prepare('SELECT unique_id FROM airmen').all()).toEqual([
      { unique_id: 'C9999998' },
    ]);
  });

  it('a refresh record that cannot be written after CURRENT names the new generation says it was published', async () => {
    await mirror().initialize();
    const kept = await published(directory);
    const record = join(directory, 'REFRESH.json');
    // A directory in the record's place makes its rename fail; CURRENT's rename is unaffected.
    const error = await refreshWith(async () => {
      await rm(record);
      await mkdir(record);
    });
    expect(error).toMatchObject({
      name: 'MirrorError',
      stage: 'disk',
      message: PUBLISHED_THEN_FAILED,
    });
    const fresh = await published(directory);
    expect(fresh).not.toBe(kept);
    expect((await readdir(directory)).sort()).toEqual(
      ['CURRENT', 'REFRESH.json', fresh, kept].sort(),
    );
    expect(await readdir(record)).toEqual([]);
    using lease = await mirror().acquire();
    expect(lease.metadata.generationId).toBe(fresh);
    expect(lease.db.prepare('SELECT unique_id FROM airmen').all()).toEqual([
      { unique_id: 'C9999998' },
    ]);
  });

  it.each(['cancelled', 'timeout'] as const)(
    'a storage failure after CURRENT names the new generation stays disk when the %s signal fired first',
    async (fired) => {
      await mirror().initialize();
      const kept = await published(directory);
      const caller = new AbortController();
      const deadline = new AbortController();
      replaceDeadline(REFRESH_DEADLINE_MS, () => deadline.signal);
      let staging: string | undefined;
      let aborted = false;
      /**
       * The run's last clock read follows its final signal check, once the import is done and its
       * archive removed, just before CURRENT is written: a signal fired there cannot stop publication.
       */
      const clock = () => {
        if (
          !aborted &&
          staging &&
          existsSync(join(directory, staging, 'mirror.sqlite')) &&
          !existsSync(join(directory, staging, 'download.zip'))
        ) {
          aborted = true;
          if (fired === 'cancelled') caller.abort();
          else deadline.abort(timedOut());
        }
        return new Date('2026-10-20T00:00:00Z');
      };
      const bytes = snapshot('C9999998');
      // Without read permission, opening the directory to fsync it after CURRENT's rename fails.
      const fetcher = duringArchive(bytes, async (name) => {
        staging = name;
        await chmod(directory, 0o300);
      });
      let error: unknown;
      try {
        error = await settle(
          new AirmenMirror(config(), { fetch: fetcher, clock }).refresh(caller.signal),
        );
      } finally {
        await chmod(directory, 0o700);
      }
      expect(aborted).toBe(true);
      expect(error).toMatchObject({
        name: 'MirrorError',
        stage: 'disk',
        message: PUBLISHED_THEN_FAILED,
      });
      const fresh = await published(directory);
      expect(fresh).not.toBe(kept);
      expect(await refreshRecord(directory)).toMatchObject({ status: 'failed', stage: 'disk' });
      expect(await mirror().status()).toMatchObject({
        ready: true,
        provenance: { generationId: fresh },
        refresh: { status: 'failed', stage: 'disk' },
      });
    },
  );

  it('leaves the generation CURRENT names out of the CLI summary when that snapshot is unready', async () => {
    await mirror(snapshot('A9999999')).initialize();
    await mirror(snapshot('C9999998')).refresh();
    const kept = await published(directory);
    const [superseded, ...others] = (await generations(directory)).filter((name) => name !== kept);
    expect(others).toEqual([]);
    await writeFile(
      join(directory, 'CURRENT'),
      JSON.stringify({ generation: kept, sha256: '0'.repeat(64) }),
    );
    expect(await mirror().operatorStatus()).toMatchObject({
      ready: false,
      status: 'unavailable',
      provenance: null,
      supersededGenerations: { count: 1, bytes: await size(superseded!), unmeasured: 0 },
    });
  });

  it('keeps mirror_status free of generation housekeeping', async () => {
    await threeGenerations();
    const status = await mirror().status();
    expect(Object.keys(status).sort()).toEqual([
      'importPolicy',
      'provenance',
      'ready',
      'refresh',
      'status',
    ]);
  });
});
