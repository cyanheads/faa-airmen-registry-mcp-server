/** Lifecycle CLI output and exit status, run in-process against real temp mirrors. */
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import {
  chmod,
  type FileHandle,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMirrorCommand } from '../../src/cli/mirror-command.js';
import { AirmenMirror } from '../../src/services/airmen/airmen-mirror.js';
import {
  basicRow,
  certificateRow,
  sourceFetch,
  sourceFiles,
  zipSource,
} from '../helpers/airmen-source.js';

const home = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>();
  return { ...os, homedir: () => home.value ?? os.homedir() };
});

const COMMANDS = ['init', 'refresh', 'verify', 'status', 'prune'] as const;

/** Capture what one command writes to stdout and stderr, and its exit code. */
async function cli(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const capture = (sink: string[]) =>
    ((chunk: string | Uint8Array) => {
      sink.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(capture(out));
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(capture(err));
  try {
    const code = await runMirrorCommand(args);
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

describe('faa-airmen-registry-mirror CLI', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'faa-cli-'));
    vi.stubEnv('FAA_AIRMEN_MIRROR_DIR', directory);
    vi.stubEnv('FAA_AIRMEN_INCLUDE_LOCATION', undefined);
    vi.stubEnv('FAA_AIRMEN_STALE_AFTER_DAYS', undefined);
    vi.stubEnv('FAA_AIRMEN_REDACT_PII', 'false');
  });
  afterEach(async () => {
    home.value = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  });
  async function initialized() {
    await new AirmenMirror(
      { mirrorDir: directory, includeLocation: false, staleAfterDays: 45, redactPii: false },
      { fetch: sourceFetch(zipSource()) },
    ).initialize();
  }
  async function published(): Promise<string> {
    return (
      JSON.parse(await readFile(join(directory, 'CURRENT'), 'utf8')) as { generation: string }
    ).generation;
  }
  /** A valid snapshot whose bytes differ from `initialized()`, so a refresh publishes it. */
  const replacement = () =>
    zipSource(
      sourceFiles({
        pilotBasic: [basicRow('C9999998')],
        nonpilotBasic: [basicRow('C9999998')],
        pilotCert: [certificateRow('C9999998')],
        nonpilotCert: [certificateRow('C9999998', false)],
      }),
    );

  it('prints status JSON on stdout and exits 0 for a ready mirror', async () => {
    await initialized();
    const result = await cli('status');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ready: true, status: 'ready' });
    expect(result.stderr).toBe('');
  });

  it('rejects a missing, unknown or extra argument with usage naming prune and exit 1', async () => {
    for (const args of [[], ['unknown'], ['status', 'extra']]) {
      const result = await cli(...args);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(
        /^Usage: faa-airmen-registry-mirror <init\|refresh\|verify\|status\|prune>\n/,
      );
      expect(result.stderr).toMatch(/prune[^\n]*stop every server process/i);
      expect(result.stdout).toBe('');
    }
  });

  it('reports superseded generations on status and removes them with prune', async () => {
    await initialized();
    await new AirmenMirror(
      { mirrorDir: directory, includeLocation: false, staleAfterDays: 45, redactPii: false },
      { fetch: sourceFetch(replacement()) },
    ).refresh();
    const kept = await published();
    const [superseded] = (await readdir(directory)).filter(
      (name) => name.startsWith('generation-') && name !== kept,
    );
    const bytes = (await stat(join(directory, superseded!, 'mirror.sqlite'))).size;
    const before = await cli('status');
    expect(before.code).toBe(0);
    expect(JSON.parse(before.stdout)).toMatchObject({
      ready: true,
      supersededGenerations: { count: 1, bytes, unmeasured: 0 },
    });
    const pruned = await cli('prune');
    expect(pruned.code).toBe(0);
    expect(pruned.stderr).toBe('');
    expect(JSON.parse(pruned.stdout)).toEqual({
      ok: true,
      kept,
      removed: [{ generation: superseded, bytes }],
      bytesFreed: bytes,
      skipped: [],
      failed: [],
    });
    expect(pruned.stdout).not.toContain(directory);
    const after = await cli('status');
    expect(JSON.parse(after.stdout)).toMatchObject({
      supersededGenerations: { count: 0, bytes: 0, unmeasured: 0 },
    });
  });

  it('prints missing: and exits 1, leaving nothing behind, when prune finds no published mirror', async () => {
    expect(await cli('prune')).toEqual({
      code: 1,
      stdout: '',
      stderr:
        'missing: Prune requires a ready published mirror; nothing was deleted. Check it with faa-airmen-registry-mirror verify.\n',
    });
    expect(await readdir(directory)).toEqual([]);
  });

  it('prints the ok: false result and exits 1 when prune cannot delete a generation or verify fails', async () => {
    await initialized();
    const kept = await published();
    const stuck = `generation-${randomUUID()}`;
    await mkdir(join(directory, stuck));
    await writeFile(join(directory, stuck, 'mirror.sqlite'), 'synthetic');
    // Without write permission on the generation, its contents cannot be removed.
    await chmod(join(directory, stuck), 0o500);
    try {
      const pruned = await cli('prune');
      expect(pruned).toMatchObject({ code: 1, stderr: '' });
      expect(JSON.parse(pruned.stdout)).toEqual({
        ok: false,
        kept,
        removed: [],
        bytesFreed: 0,
        skipped: [],
        failed: [stuck],
      });
    } finally {
      await chmod(join(directory, stuck), 0o700);
    }
    await writeFile(
      join(directory, 'CURRENT'),
      JSON.stringify({ generation: kept, sha256: '0'.repeat(64) }),
    );
    const verified = await cli('verify');
    expect(verified).toMatchObject({ code: 1, stderr: '' });
    expect(JSON.parse(verified.stdout)).toEqual({
      ok: false,
      issues: ['unavailable'],
      counts: null,
    });
  });

  it('names an unreadable REFRESH.json, not verify, when prune refuses because of it', async () => {
    await initialized();
    await writeFile(join(directory, 'REFRESH.json'), '{not json');
    expect((await cli('verify')).code).toBe(0);
    expect(await cli('prune')).toEqual({
      code: 1,
      stdout: '',
      stderr:
        'unavailable: REFRESH.json is unreadable, so prune cannot confirm the published mirror is ready; nothing was deleted. Remove REFRESH.json, which records only the last refresh outcome, and run prune again.\n',
    });
    await rm(join(directory, 'REFRESH.json'));
    expect(await cli('prune')).toMatchObject({ code: 0, stderr: '' });
  });

  it('prints the published-then-failed message and exits 1 when a storage step after CURRENT fails', async () => {
    await initialized();
    const kept = await published();
    const inner = sourceFetch(replacement());
    vi.stubGlobal('fetch', (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      // Without read permission, opening the directory to fsync it after CURRENT's rename fails.
      if (!url.endsWith('releasable_airmen_download')) await chmod(directory, 0o300);
      return inner(input, init);
    }) as typeof fetch);
    let result: Awaited<ReturnType<typeof cli>>;
    try {
      result = await cli('refresh');
    } finally {
      await chmod(directory, 0o700);
    }
    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr:
        'Mirror refresh started.\ndisk: Mirror refresh published a new snapshot, which readers now serve, but a storage step after publishing failed; check free space and directory permissions.\n',
    });
    const fresh = await published();
    expect(fresh).not.toBe(kept);
    expect(JSON.parse((await cli('status')).stdout)).toMatchObject({
      ready: true,
      provenance: { generationId: fresh },
      refresh: { status: 'failed', stage: 'disk' },
    });
  });

  it('prints lock: and exits 1 for init, refresh and prune while another writer holds WRITER.lock', async () => {
    await initialized();
    await writeFile(join(directory, 'WRITER.lock'), 'synthetic-owner');
    const lock =
      'lock: Another mirror writer owns WRITER.lock. Confirm its PID has exited before removing a stale lock.\n';
    for (const [command, stderr] of [
      ['init', `Mirror init started.\n${lock}`],
      ['refresh', `Mirror refresh started.\n${lock}`],
      ['prune', lock],
    ] as const)
      expect(await cli(command)).toEqual({ code: 1, stdout: '', stderr });
    expect(await readFile(join(directory, 'WRITER.lock'), 'utf8')).toBe('synthetic-owner');
  });

  it('reports a finished init whose WRITER.lock someone removed meanwhile as its real outcome', async () => {
    const inner = sourceFetch(zipSource());
    let removed = false;
    vi.stubGlobal('fetch', (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.endsWith('releasable_airmen_download')) {
        await rm(join(directory, 'WRITER.lock'));
        removed = true;
      }
      return inner(input, init);
    }) as typeof fetch);
    const result = await cli('init');
    expect(removed).toBe(true);
    expect(result).toMatchObject({ code: 0, stderr: 'Mirror init started.\n' });
    const { generation } = JSON.parse(await readFile(join(directory, 'CURRENT'), 'utf8')) as {
      generation: string;
    };
    expect(JSON.parse(result.stdout)).toMatchObject({
      ready: true,
      provenance: { generationId: generation },
      refresh: { status: 'complete' },
    });
    expect(await readdir(directory)).not.toContain('WRITER.lock');
  });

  it('prints the prune result when WRITER.lock is removed while prune runs', async () => {
    await initialized();
    const kept = await published();
    const superseded = `generation-${randomUUID()}`;
    await mkdir(join(directory, superseded));
    await writeFile(join(directory, superseded, 'part'), 'xx');
    // Release opens with a bigint stat of the held lock handle; remove the lock just before it.
    const probe = await open(new URL(import.meta.url));
    const prototype: FileHandle = Object.getPrototypeOf(probe);
    await probe.close();
    const original = prototype.stat;
    let removed = false;
    vi.spyOn(prototype, 'stat').mockImplementation(function (
      this: FileHandle,
      ...args: Parameters<FileHandle['stat']>
    ) {
      if (!removed && args[0]?.bigint) {
        removed = true;
        unlinkSync(join(directory, 'WRITER.lock'));
      }
      return original.apply(this, args);
    } as FileHandle['stat']);
    const result = await cli('prune');
    expect(removed).toBe(true);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      kept,
      removed: [{ generation: superseded, bytes: 2 }],
      bytesFreed: 2,
      skipped: [],
      failed: [],
    });
    expect((await readdir(directory)).sort()).toEqual(['CURRENT', 'REFRESH.json', kept].sort());
  });

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'cancels a refresh on %s and records cancelled',
    async (signal) => {
      await initialized();
      const current = await readFile(join(directory, 'CURRENT'), 'utf8');
      let started!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      vi.stubGlobal('fetch', (async (_input: unknown, init?: RequestInit) => {
        started();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        });
      }) as typeof fetch);
      const listeners = () => process.listenerCount('SIGINT') + process.listenerCount('SIGTERM');
      const before = listeners();
      const pending = cli('refresh');
      await entered;
      expect(listeners()).toBe(before + 2);
      process.emit(signal);
      const result = await pending;
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/^Mirror refresh started\.\ncancelled: /);
      expect(result.stderr).not.toContain('preserved');
      expect(await readFile(join(directory, 'CURRENT'), 'utf8')).toBe(current);
      const entries = await readdir(directory);
      expect(entries).not.toContain('WRITER.lock');
      expect(entries.filter((name) => name.startsWith('generation-'))).toHaveLength(1);
      expect(listeners()).toBe(before);
      const status = await cli('status');
      expect(JSON.parse(status.stdout)).toMatchObject({
        ready: true,
        refresh: { status: 'failed', stage: 'cancelled' },
      });
    },
  );

  it.each([
    ['FAA_AIRMEN_STALE_AFTER_DAYS', 'not-a-number-sentinel'],
    ['FAA_AIRMEN_STALE_AFTER_DAYS', '0'],
    ['FAA_AIRMEN_INCLUDE_LOCATION', 'yes-sentinel'],
  ])('prints the configuration error naming %s=%s for every command', async (name, value) => {
    vi.stubEnv(name, value);
    for (const command of COMMANDS) {
      const result = await cli(command);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/^Server config validation failed:\n/);
      expect(result.stderr).toContain(`  - ${name} (`);
      expect(result.stderr).not.toMatch(/^unavailable:/m);
      expect(result.stderr).not.toContain('sentinel');
      expect(result.stderr).not.toContain(directory);
    }
    expect(await readdir(directory)).toEqual([]);
  });

  it('prints the missing home-directory configuration error naming FAA_AIRMEN_MIRROR_DIR', async () => {
    vi.stubEnv('FAA_AIRMEN_MIRROR_DIR', undefined);
    vi.stubEnv('XDG_DATA_HOME', '');
    vi.stubEnv('LOCALAPPDATA', '');
    home.value = 'relative-home';
    const result = await cli('status');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('FAA_AIRMEN_MIRROR_DIR');
    expect(result.stderr).not.toMatch(/^unavailable:/m);
  });
});
