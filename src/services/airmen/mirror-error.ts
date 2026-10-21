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
  | 'unavailable'
  /** The caller's signal stopped the run. */
  | 'cancelled'
  /** One of the lifecycle's own deadlines expired. */
  | 'timeout'
  /** A refresh record outlived the refresh deadline: its writer ended without recording a result. */
  | 'interrupted';

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

/** Read a Node system error code such as ENOENT from an unknown thrown value. */
export function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

const STORAGE_ERRNO = new Set(['ENOSPC', 'EDQUOT', 'EIO', 'EACCES', 'EPERM', 'EROFS']);
/** SQLite results for storage it cannot open, write, or read, extended codes included. */
const SQLITE_STORAGE = /^SQLITE_(?:CANTOPEN|FULL|IOERR|READONLY)(?:_[A-Z_]+)?$/;

/** Whether a failure, or an error it wraps (the mirror store wraps driver errors), is a storage fault. */
function storageFault(error: unknown): boolean {
  for (let current = error, depth = 0; current !== undefined && depth < 8; depth++) {
    const code = errorCode(current);
    if (typeof code === 'string' && (STORAGE_ERRNO.has(code) || SQLITE_STORAGE.test(code)))
      return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

/**
 * Map unexpected failures to safe classified diagnostics. Cancellation and deadlines are
 * classified by the owner of the signal that fired, never from an error name.
 */
export function safeMirrorError(error: unknown, fallback: MirrorStage): MirrorError {
  if (error instanceof MirrorError) return error;
  if (storageFault(error))
    return new MirrorError(
      'disk',
      'Mirror storage is unavailable; check free space and directory permissions.',
    );
  return new MirrorError(fallback, 'Mirror operation failed; no new snapshot was published.');
}
