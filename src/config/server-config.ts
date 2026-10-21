/**
 * @fileoverview Operator configuration for the local FAA mirror.
 * @module config/server-config
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

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
});

/** Resolved configuration; no directories are created while parsing. */
export interface ServerConfig {
  includeLocation: boolean;
  mirrorDir: string;
  staleAfterDays: number;
}

/** Resolve the platform data directory independently of the working directory. */
export function getServerConfig(): ServerConfig {
  const config = parseEnvConfig(schema, {
    mirrorDir: 'FAA_AIRMEN_MIRROR_DIR',
    includeLocation: 'FAA_AIRMEN_INCLUDE_LOCATION',
    staleAfterDays: 'FAA_AIRMEN_STALE_AFTER_DAYS',
  });
  const base =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : process.platform === 'win32'
        ? (process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'))
        : (process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'));
  return {
    ...config,
    mirrorDir: resolve(config.mirrorDir ?? join(base, 'faa-airmen-registry-mcp-server')),
  };
}
