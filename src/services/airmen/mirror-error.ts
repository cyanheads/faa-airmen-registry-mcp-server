/**
 * @fileoverview Classified mirror failures without source records or local paths.
 * @module services/airmen/mirror-error
 */
/** A safe operator-facing failure stage, suitable for lifecycle status. */
export type MirrorStage =
  | 'acquisition'
  | 'schema'
  | 'validation'
  | 'disk'
  | 'lock'
  | 'integrity'
  | 'missing'
  | 'unavailable';

/** Raw filesystem, parser and database exceptions never cross this boundary. */
export class MirrorError extends Error {
  constructor(
    readonly stage: MirrorStage,
    message: string,
  ) {
    super(message);
    this.name = 'MirrorError';
  }
}

/** Map unexpected failures to safe classified diagnostics. */
export function safeMirrorError(error: unknown, fallback: MirrorStage): MirrorError {
  if (error instanceof MirrorError) return error;
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return new MirrorError(
      fallback,
      'Mirror operation cancelled or timed out; the published snapshot was preserved.',
    );
  }
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  if (code === 'ENOSPC' || code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new MirrorError(
      'disk',
      'Mirror storage is unavailable; check free space and directory permissions.',
    );
  }
  return new MirrorError(
    fallback,
    `Mirror ${fallback} failed; the published snapshot was preserved.`,
  );
}
