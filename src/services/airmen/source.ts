/**
 * @fileoverview Bounded FAA page discovery and streamed archive acquisition.
 * @module services/airmen/source
 */
import { createHash } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { MirrorError, safeMirrorError } from './mirror-error.js';
import { FAA_SOURCE_URL } from './reference.js';

/** Compressed archive size limit, enforced on download and again on import. */
export const MAX_ARCHIVE = 200 * 1024 * 1024;
/** Timeout of one page or archive request attempt; three attempts are made. */
export const ATTEMPT_TIMEOUT_MS = 180_000;
/** Overall deadline for discovering and downloading the archive. */
export const ACQUISITION_DEADLINE_MS = 600_000;
const FAA_HOSTS = new Set(['www.faa.gov', 'faa.gov', 'registry.faa.gov']);

/** Acquisition metadata is independent of the local archive filename. */
export interface AcquiredSource {
  archiveUrl: string;
  downloadedAt: string;
  sha256: string;
  snapshotMonth: string;
}

class HttpFailure extends Error {
  constructor(
    readonly retryable: boolean,
    readonly retryAfterMs: number,
  ) {
    super('FAA request failed');
  }
}

function allowed(url: URL): void {
  if (
    url.protocol !== 'https:' ||
    !FAA_HOSTS.has(url.hostname) ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new MirrorError(
      'acquisition',
      'FAA source redirected outside the permitted HTTPS hosts.',
    );
  }
}

/** Monthly archive filename such as /CS102026.ZIP, which every redirect must preserve. */
function archiveName(url: URL): string | undefined {
  return /\/CS\d{6}\.zip$/i.exec(url.pathname)?.[0].toUpperCase();
}

async function get(
  url: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<{ response: Response; url: string }> {
  let current = new URL(url);
  const archiveIdentity = archiveName(current);
  for (let redirects = 0; redirects <= 5; redirects++) {
    allowed(current);
    if (archiveIdentity && archiveName(current) !== archiveIdentity)
      throw new MirrorError(
        'acquisition',
        'FAA archive redirected outside the advertised snapshot month.',
      );
    const response = await fetcher(current, {
      redirect: 'manual',
      signal,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }).catch((error: unknown) => {
      // A refused connect's cause carries EPERM or EACCES, yet it is a network failure, never disk.
      throw signal.aborted ? error : new HttpFailure(true, 0);
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) break;
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      const retry = response.headers.get('retry-after');
      const seconds = retry === null ? Number.NaN : Number(retry);
      const retryAfterMs = Number.isFinite(seconds)
        ? Math.max(0, seconds * 1000)
        : Math.max(0, Date.parse(retry ?? '') - Date.now()) || 0;
      throw new HttpFailure(
        response.status === 408 || response.status === 429 || response.status >= 500,
        retryAfterMs,
      );
    }
    return { response, url: current.href };
  }
  throw new MirrorError('acquisition', 'FAA source exceeded the permitted redirect count.');
}

async function retry<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  fetchSignal: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    fetchSignal.throwIfAborted();
    const attemptSignal = AbortSignal.any([fetchSignal, AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)]);
    try {
      return await operation(attemptSignal);
    } catch (error) {
      fetchSignal.throwIfAborted();
      if (attempt === 2 && attemptSignal.aborted)
        throw new MirrorError(
          'timeout',
          `The final FAA request attempt timed out after ${ATTEMPT_TIMEOUT_MS / 60_000} minutes; no new snapshot was published.`,
        );
      if (
        attempt === 2 ||
        error instanceof MirrorError ||
        (error instanceof HttpFailure && !error.retryable)
      ) {
        throw safeMirrorError(error, 'acquisition');
      }
      await delay(
        Math.max(2000 * 2 ** attempt, error instanceof HttpFailure ? error.retryAfterMs : 0),
        undefined,
        { signal: fetchSignal },
      );
    }
  }
}

/** Discover the published archive and download it without buffering it in memory. */
export async function acquireSource(
  path: string,
  fetcher: typeof fetch,
  clock: () => Date,
  signal: AbortSignal,
): Promise<AcquiredSource> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(ACQUISITION_DEADLINE_MS)]);
  try {
    return await download(path, fetcher, clock, deadline);
  } catch (error) {
    // An abort of the caller's signal belongs to its owner; only the acquisition deadline is ours.
    if (deadline.aborted && !signal.aborted)
      throw new MirrorError(
        'timeout',
        `FAA download exceeded its ${ACQUISITION_DEADLINE_MS / 60_000}-minute deadline; no new snapshot was published.`,
      );
    throw error;
  }
}

async function download(
  path: string,
  fetcher: typeof fetch,
  clock: () => Date,
  deadline: AbortSignal,
): Promise<AcquiredSource> {
  const page = await retry(async (attemptSignal) => {
    const { response } = await get(FAA_SOURCE_URL, fetcher, attemptSignal);
    if (!response.body) throw new Error('Missing response stream');
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for await (const chunk of response.body) {
        attemptSignal.throwIfAborted();
        length += chunk.byteLength;
        if (length > 2 * 1024 * 1024)
          throw new MirrorError('acquisition', 'FAA download page exceeded its size limit.');
        chunks.push(chunk);
      }
    } finally {
      if (!response.body.locked) await response.body.cancel();
    }
    return Buffer.concat(chunks).toString('utf8');
  }, deadline);
  const candidates = [
    ...page.matchAll(/href\s*=\s*["']([^"']*\/CS(\d{2})(\d{4})\.zip(?:\?[^"']*)?)["']/gi),
  ]
    .map((match) => {
      const href = (match[1] ?? '').replaceAll('&amp;', '&');
      if (!URL.canParse(href, FAA_SOURCE_URL))
        throw new MirrorError(
          'acquisition',
          'FAA page advertised an archive link that is not a URL.',
        );
      const url = new URL(href, FAA_SOURCE_URL);
      allowed(url);
      const month = Number(match[2]);
      if (month < 1 || month > 12)
        throw new MirrorError('acquisition', 'FAA publication month is invalid.');
      return { archiveUrl: url.href, snapshotMonth: `${match[3]}-${match[2]}` };
    })
    .sort((a, b) => b.snapshotMonth.localeCompare(a.snapshotMonth));
  const selected = candidates[0];
  if (!selected)
    throw new MirrorError(
      'acquisition',
      'FAA page did not advertise a recognized monthly CSV archive.',
    );
  const downloaded = await retry(async (attemptSignal) => {
    await rm(path, { force: true });
    const { response, url } = await get(selected.archiveUrl, fetcher, attemptSignal);
    if (!response.body) throw new Error('Missing response stream');
    if (/text\/html/i.test(response.headers.get('content-type') ?? '')) {
      await response.body.cancel();
      throw new MirrorError('acquisition', 'FAA archive response was HTML instead of ZIP data.');
    }
    if (Number(response.headers.get('content-length')) > MAX_ARCHIVE) {
      await response.body.cancel();
      throw new MirrorError('acquisition', 'FAA archive exceeds the compressed size limit.');
    }
    const file = await open(path, 'wx', 0o600);
    const hash = createHash('sha256');
    let length = 0;
    try {
      for await (const chunk of response.body) {
        attemptSignal.throwIfAborted();
        length += chunk.byteLength;
        if (length > MAX_ARCHIVE)
          throw new MirrorError('acquisition', 'FAA archive exceeds the compressed size limit.');
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) offset += (await file.write(chunk, offset)).bytesWritten;
      }
      if (length === 0) throw new Error('Empty response stream');
      await file.sync();
      return { sha256: hash.digest('hex'), archiveUrl: url };
    } finally {
      await file.close();
      if (!response.body.locked) await response.body.cancel();
    }
  }, deadline);
  return { ...selected, ...downloaded, downloadedAt: clock().toISOString() };
}
