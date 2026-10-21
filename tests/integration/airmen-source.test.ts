/** Acquisition boundary tests use synthetic responses only. */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireSource } from '../../src/services/airmen/source.js';
import { sourceFetch, zipSource } from '../helpers/airmen-source.js';

describe('FAA source acquisition', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'faa-source-'));
  });
  afterEach(async () => {
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
});
