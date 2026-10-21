/** Real SQLite importer/lifecycle tests against synthetic network bytes. */
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AirmenMirror } from '../../src/services/airmen/airmen-mirror.js';
import {
  basicRow,
  certificateRow,
  sourceFetch,
  sourceFiles,
  zipSource,
} from '../helpers/airmen-source.js';

describe('synthetic FAA mirror', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'faa-synthetic-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  function mirror(bytes = zipSource(), includeLocation = false) {
    return new AirmenMirror(
      { mirrorDir: directory, includeLocation, staleAfterDays: 10 },
      { fetch: sourceFetch(bytes), clock: () => new Date('2026-10-20T00:00:00Z') },
    );
  }

  it('does not create paths for missing status, verification or acquisition', async () => {
    const missing = new AirmenMirror({
      mirrorDir: join(directory, 'absent'),
      includeLocation: false,
      staleAfterDays: 45,
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
    await expect(mirror().initialize(controller.signal)).rejects.toMatchObject({
      message: expect.stringContaining('cancelled'),
    });
    expect(await readdir(directory)).toEqual(['REFRESH.json']);
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
      { mirrorDir: directory, includeLocation: false, staleAfterDays: 45 },
      { fetch: fetcher },
    );
    const pending = service.refresh(controller.signal);
    await entered;
    await expect(mirror().refresh()).rejects.toMatchObject({ stage: 'lock' });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ message: expect.stringContaining('cancelled') });
    expect(await readFile(join(directory, 'CURRENT'), 'utf8')).toBe(current);
    expect(await readdir(directory)).not.toContain('WRITER.lock');
    expect(
      (await readdir(directory)).filter((name) => name.startsWith('generation-')),
    ).toHaveLength(1);
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
