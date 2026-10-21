/** Operator configuration must require explicit privacy opt-in. */
import { isAbsolute, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '../../src/config/server-config.js';

describe('server configuration', () => {
  beforeEach(() => {
    for (const key of [
      'FAA_AIRMEN_MIRROR_DIR',
      'FAA_AIRMEN_INCLUDE_LOCATION',
      'FAA_AIRMEN_STALE_AFTER_DAYS',
    ])
      vi.stubEnv(key, undefined);
  });
  afterEach(() => vi.unstubAllEnvs());
  it('defaults to private access and an absolute user data path', () => {
    const config = getServerConfig();
    expect(config.includeLocation).toBe(false);
    expect(config.staleAfterDays).toBe(45);
    expect(isAbsolute(config.mirrorDir)).toBe(true);
    expect(config.mirrorDir).toContain('faa-airmen-registry-mcp-server');
  });
  it.each(['true', 'false'])('parses explicit %s without JavaScript truthiness', (value) => {
    vi.stubEnv('FAA_AIRMEN_INCLUDE_LOCATION', value);
    vi.stubEnv('FAA_AIRMEN_MIRROR_DIR', './synthetic-data');
    expect(getServerConfig()).toMatchObject({
      includeLocation: value === 'true',
      mirrorDir: resolve('./synthetic-data'),
    });
  });
  it('uses the stable data directory when MCPB forwards an empty optional directory', () => {
    const defaultDirectory = getServerConfig().mirrorDir;
    vi.stubEnv('FAA_AIRMEN_MIRROR_DIR', '');
    expect(getServerConfig().mirrorDir).toBe(defaultDirectory);
  });
  it.each(['1', 'yes'])('rejects nonliteral privacy switch %s', (value) => {
    vi.stubEnv('FAA_AIRMEN_INCLUDE_LOCATION', value);
    expect(() => getServerConfig()).toThrow();
  });
  it.each(['0', '367', '1.5', 'not-a-number'])(
    'rejects invalid freshness threshold %s',
    (value) => {
      vi.stubEnv('FAA_AIRMEN_STALE_AFTER_DAYS', value);
      expect(() => getServerConfig()).toThrow();
    },
  );
});
