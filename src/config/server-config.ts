/**
 * @fileoverview Operator configuration for the local FAA mirror.
 * @module config/server-config
 */
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';
import { configurationError } from '@cyanheads/mcp-ts-core/errors';

const schema = z.object({
  mirrorDir: z.string().optional().describe('Persistent operator-owned mirror directory'),
  includeLocation: z
    .stringbool({ truthy: ['true'], falsy: ['false'] })
    .default(false)
    .describe('Import and expose city and ZIP fields'),
  staleAfterDays: z.coerce
    .number()
    .int()
    .min(1)
    .max(366)
    .default(45)
    .describe('Source age warning threshold in days'),
  redactPii: z
    .preprocess(
      (value) => typeof value !== 'string' || value.trim().toLowerCase() !== 'false',
      z.boolean(),
    )
    .describe('Serving-time personal-data redaction; only false, any case, turns it off'),
});

/** Resolved configuration; no directories are created while parsing. */
export interface ServerConfig {
  includeLocation: boolean;
  mirrorDir: string;
  /** Serving only: the mirror's import policy follows includeLocation alone. */
  redactPii: boolean;
  staleAfterDays: number;
}

/** A platform base directory variable counts only when absolute; blank or relative values are ignored. */
function absolute(value: string | undefined): string | undefined {
  return value && isAbsolute(value) ? value : undefined;
}

/** The platform user-data directory, never anchored at the working directory. */
function defaultMirrorDir(): string {
  const [variable, segments] =
    process.platform === 'darwin'
      ? [undefined, ['Library', 'Application Support']]
      : process.platform === 'win32'
        ? [process.env.LOCALAPPDATA, ['AppData', 'Local']]
        : [process.env.XDG_DATA_HOME, ['.local', 'share']];
  const home = homedir();
  const base = absolute(variable) ?? (isAbsolute(home) ? join(home, ...segments) : undefined);
  if (!base)
    throw configurationError(
      'Server config validation failed:\n  - FAA_AIRMEN_MIRROR_DIR (mirrorDir): No absolute home directory is available for the default mirror location; set an absolute directory.',
    );
  return join(base, 'faa-airmen-registry-mcp-server');
}

/** Resolve the platform data directory independently of the working directory. */
export function getServerConfig(): ServerConfig {
  const config = parseEnvConfig(schema, {
    mirrorDir: 'FAA_AIRMEN_MIRROR_DIR',
    includeLocation: 'FAA_AIRMEN_INCLUDE_LOCATION',
    staleAfterDays: 'FAA_AIRMEN_STALE_AFTER_DAYS',
    redactPii: 'FAA_AIRMEN_REDACT_PII',
  });
  return { ...config, mirrorDir: resolve(config.mirrorDir ?? defaultMirrorDir()) };
}
