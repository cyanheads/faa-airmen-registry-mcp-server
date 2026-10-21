/** Acquisition boundary tests use synthetic responses only. */
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTEMPT_TIMEOUT_MS, acquireSource } from '../../src/services/airmen/source.js';
import { sourceFetch, zipSource } from '../helpers/airmen-source.js';

/** The retry backoff resolves at once, so no test waits out the delays between attempts. */
vi.mock('node:timers/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:timers/promises')>()),
  setTimeout: async (_ms?: number, value?: unknown, options?: { signal?: AbortSignal }) => {
    options?.signal?.throwIfAborted();
    return value;
  },
}));

describe('FAA source acquisition', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'faa-source-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });
  const clock = () => new Date('2026-10-20T00:00:00Z');
  it('discovers the newest published month and hashes streamed bytes', async () => {
    const bytes = zipSource();
    const fetcher = vi.fn(sourceFetch(bytes));
    const path = join(directory, 'download.zip');
    const result = await acquireSource(path, fetcher, clock, new AbortController().signal);
    expect(result).toEqual({
      archiveUrl: 'https://registry.faa.gov/CS102026.zip',
      snapshotMonth: '2026-10',
      downloadedAt: clock().toISOString(),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(await readFile(path)).toEqual(bytes);
    expect(fetcher.mock.calls).toHaveLength(2);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
  });
  it.each([
    '<a href="https://outside.example/CS102026.zip">CSV</a>',
    '<a href="http://registry.faa.gov/CS102026.zip">CSV</a>',
    '<a href="https://registry.faa.gov/CS132026.zip">CSV</a>',
    '<p>No published monthly archive</p>',
  ])('rejects an unsafe or unrecognized publication without downloading', async (page) => {
    const fetcher = vi.fn(async () => new Response(page));
    await expect(
      acquireSource(
        join(directory, 'download.zip'),
        fetcher as typeof fetch,
        clock,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ stage: 'acquisition' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not retry forbidden access', async () => {
    const fetcher = vi.fn(async () => new Response('forbidden', { status: 403 }));
    await expect(
      acquireSource(
        join(directory, 'download.zip'),
        fetcher as typeof fetch,
        clock,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ stage: 'acquisition' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['https://outside.example/CS102026.zip', 'https://registry.faa.gov/not-a-month.zip'])(
    'validates every archive redirect: %s',
    async (location) => {
      const fetcher = vi.fn(async (input: string | URL | Request) =>
        String(input).endsWith('releasable_airmen_download')
          ? new Response('<a href="https://registry.faa.gov/CS102026.zip">CSV</a>')
          : new Response(null, { status: 302, headers: { location } }),
      );
      await expect(
        acquireSource(
          join(directory, 'download.zip'),
          fetcher as typeof fetch,
          clock,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ stage: 'acquisition' });
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );
  it('rejects HTML archive responses', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('releasable_airmen_download')
        ? new Response('<a href="https://registry.faa.gov/CS102026.zip">CSV</a>')
        : new Response('not zip', { headers: { 'content-type': 'text/html' } }),
    );
    await expect(
      acquireSource(
        join(directory, 'download.zip'),
        fetcher as typeof fetch,
        clock,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ stage: 'acquisition' });
  });
  it('rejects a redirect to a different snapshot month before fetching its bytes', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('releasable_airmen_download'))
        return new Response('<a href="https://registry.faa.gov/CS102026.zip">CSV</a>');
      if (url.endsWith('CS102026.zip'))
        return new Response(null, { status: 302, headers: { location: '/CS012025.zip' } });
      return new Response(new Uint8Array(zipSource()));
    });
    await expect(
      acquireSource(
        join(directory, 'download.zip'),
        fetcher as typeof fetch,
        clock,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ stage: 'acquisition' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(readFile(join(directory, 'download.zip'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('retries a storage fault writing the archive and records it as disk', async () => {
    const readOnly = join(directory, 'read-only');
    await mkdir(readOnly, { mode: 0o500 });
    const fetcher = vi.fn(sourceFetch(zipSource()));
    try {
      const error = await acquireSource(
        join(readOnly, 'download.zip'),
        fetcher,
        clock,
        new AbortController().signal,
      ).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        name: 'MirrorError',
        stage: 'disk',
        message: 'Mirror storage is unavailable; check free space and directory permissions.',
      });
      // One page request, then three archive attempts that each fail opening the file.
      expect(fetcher).toHaveBeenCalledTimes(4);
    } finally {
      await chmod(readOnly, 0o700);
    }
  });
  it('records a connection the host refuses as a retried acquisition failure, not disk', async () => {
    /** Node's fetch rejects a firewall- or MAC-refused connect with the errno on its cause. */
    const refused = (code: 'EPERM' | 'EACCES') =>
      vi.fn(async () => {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error(`connect ${code} 192.0.2.1:443`), {
            code,
            errno: -1,
            syscall: 'connect',
            address: '192.0.2.1',
            port: 443,
          }),
        });
      });
    const cases = (['EPERM', 'EACCES'] as const).map(async (code) => {
      const fetcher = refused(code);
      const error = await acquireSource(
        join(directory, `${code}.zip`),
        fetcher as typeof fetch,
        clock,
        new AbortController().signal,
      ).catch((caught: unknown) => caught);
      return { code, error, calls: fetcher.mock.calls.length };
    });
    for (const { code, error, calls } of await Promise.all(cases)) {
      expect({ code, error, calls }).toMatchObject({
        code,
        error: {
          name: 'MirrorError',
          stage: 'acquisition',
          message: 'Mirror operation failed; no new snapshot was published.',
        },
        calls: 3,
      });
    }
  });
  it.each([
    [
      'the final attempt timed out after two 503s',
      [503, 503, 'timeout'],
      {
        stage: 'timeout',
        message:
          'The final FAA request attempt timed out after 3 minutes; no new snapshot was published.',
      },
    ],
    [
      'only the first attempt timed out',
      ['timeout', 503, 503],
      { stage: 'acquisition', message: 'Mirror operation failed; no new snapshot was published.' },
    ],
  ] as const)(
    'records a timeout only when the final attempt timed out: %s',
    async (_label, attempts, expected) => {
      const realTimeout = AbortSignal.timeout.bind(AbortSignal);
      /** Each request attempt's timer, fired by hand instead of after three minutes. */
      const timers: AbortController[] = [];
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
        if (ms !== ATTEMPT_TIMEOUT_MS) return realTimeout(ms);
        const timer = new AbortController();
        timers.push(timer);
        return timer.signal;
      });
      let calls = 0;
      const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        if (attempts[calls++] !== 'timeout') return new Response('unavailable', { status: 503 });
        const pending = new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        });
        timers.at(-1)!.abort(new DOMException('The operation timed out.', 'TimeoutError'));
        return pending;
      });
      const error = await acquireSource(
        join(directory, 'download.zip'),
        fetcher as typeof fetch,
        clock,
        new AbortController().signal,
      ).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ name: 'MirrorError', ...expected });
      expect(fetcher).toHaveBeenCalledTimes(3);
    },
  );
  it('records the accepted final same-month download URL', async () => {
    const finalUrl = 'https://www.faa.gov/download/CS102026.zip';
    const bytes = zipSource();
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('releasable_airmen_download'))
        return new Response('<a href="https://registry.faa.gov/CS102026.zip">CSV</a>');
      if (url === 'https://registry.faa.gov/CS102026.zip')
        return new Response(null, { status: 302, headers: { location: finalUrl } });
      return new Response(new Uint8Array(bytes));
    });
    const result = await acquireSource(
      join(directory, 'download.zip'),
      fetcher as typeof fetch,
      clock,
      new AbortController().signal,
    );
    expect(result).toMatchObject({ archiveUrl: finalUrl, snapshotMonth: '2026-10' });
    expect(await readFile(join(directory, 'download.zip'))).toEqual(bytes);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
