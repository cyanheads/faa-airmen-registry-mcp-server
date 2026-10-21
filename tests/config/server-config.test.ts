/** Operator configuration must require explicit privacy opt-in. */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '../../src/config/server-config.js';

/** Bun ignores a runtime HOME change, so the home directory is driven through the OS module. */
const home = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>();
  return { ...os, homedir: () => home.value ?? os.homedir() };
});

describe('server configuration', () => {
  beforeEach(() => {
    for (const key of [
      'FAA_AIRMEN_MIRROR_DIR',
      'FAA_AIRMEN_INCLUDE_LOCATION',
      'FAA_AIRMEN_STALE_AFTER_DAYS',
      'FAA_AIRMEN_REDACT_PII',
    ])
      vi.stubEnv(key, undefined);
  });
  afterEach(() => vi.unstubAllEnvs());
  it('defaults to private access and an absolute user data path', () => {
    const config = getServerConfig();
    expect(config.includeLocation).toBe(false);
    expect(config.redactPii).toBe(true);
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
  it.each([
    '',
    '   ',
    // An unsubstituted MCPB or plugin placeholder.
    `\${user_config.redact_pii}`,
    'true',
    'TRUE',
    '0',
    'no',
    'off',
    '1',
    'yes',
    'flase',
    'false-ish',
  ])(
    'keeps personal-data redaction on for FAA_AIRMEN_REDACT_PII=%j without failing startup',
    (value) => {
      vi.stubEnv('FAA_AIRMEN_REDACT_PII', value);
      expect(getServerConfig().redactPii).toBe(true);
    },
  );
  it.each(['false', 'FALSE', 'False', ' false ', '\tfalse\n'])(
    'turns personal-data redaction off only for FAA_AIRMEN_REDACT_PII=%j',
    (value) => {
      vi.stubEnv('FAA_AIRMEN_REDACT_PII', value);
      expect(getServerConfig().redactPii).toBe(false);
    },
  );
  it.each(['0', '367', '1.5', 'not-a-number'])(
    'rejects invalid freshness threshold %s',
    (value) => {
      vi.stubEnv('FAA_AIRMEN_STALE_AFTER_DAYS', value);
      expect(() => getServerConfig()).toThrow();
    },
  );
});

describe('platform default mirror directory', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const cwd = process.cwd();
  let first: string;
  let second: string;
  beforeEach(async () => {
    vi.stubEnv('FAA_AIRMEN_MIRROR_DIR', undefined);
    vi.stubEnv('XDG_DATA_HOME', undefined);
    vi.stubEnv('LOCALAPPDATA', undefined);
    home.value = '/synthetic/home';
    first = await realpath(await mkdtemp(join(tmpdir(), 'faa-cwd-a-')));
    second = await realpath(await mkdtemp(join(tmpdir(), 'faa-cwd-b-')));
  });
  afterEach(async () => {
    Object.defineProperty(process, 'platform', platform);
    home.value = undefined;
    vi.unstubAllEnvs();
    process.chdir(cwd);
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  });
  function on(value: NodeJS.Platform) {
    Object.defineProperty(process, 'platform', { ...platform, value });
  }
  /** Resolve the default from two working directories; both must agree. */
  function fromBothDirectories(): string {
    process.chdir(first);
    const a = getServerConfig().mirrorDir;
    process.chdir(second);
    const b = getServerConfig().mirrorDir;
    expect(b).toBe(a);
    expect(a.startsWith(first)).toBe(false);
    return a;
  }
  const app = 'faa-airmen-registry-mcp-server';

  it.each([undefined, '', '   ', 'relative/share'])(
    'linux ignores XDG_DATA_HOME=%j that is not absolute',
    (value) => {
      on('linux');
      vi.stubEnv('XDG_DATA_HOME', value);
      expect(fromBothDirectories()).toBe(join('/synthetic/home', '.local', 'share', app));
    },
  );
  it('linux uses an absolute XDG_DATA_HOME as given', () => {
    on('linux');
    vi.stubEnv('XDG_DATA_HOME', '/synthetic/xdg');
    expect(fromBothDirectories()).toBe(join('/synthetic/xdg', app));
  });
  it.each([undefined, '', '   ', 'AppData-relative'])(
    'win32 ignores LOCALAPPDATA=%j that is not absolute',
    (value) => {
      on('win32');
      vi.stubEnv('LOCALAPPDATA', value);
      expect(fromBothDirectories()).toBe(join('/synthetic/home', 'AppData', 'Local', app));
    },
  );
  it('win32 uses an absolute LOCALAPPDATA as given', () => {
    on('win32');
    vi.stubEnv('LOCALAPPDATA', '/c/Users/synthetic/AppData/Local');
    expect(fromBothDirectories()).toBe(join('/c/Users/synthetic/AppData/Local', app));
  });
  it('darwin keeps the Application Support default and ignores XDG_DATA_HOME', () => {
    on('darwin');
    vi.stubEnv('XDG_DATA_HOME', '/synthetic/xdg');
    expect(fromBothDirectories()).toBe(
      join('/synthetic/home', 'Library', 'Application Support', app),
    );
  });
  it.each([
    ['linux', ''],
    ['linux', 'relative-home'],
    ['win32', ''],
    ['darwin', 'relative-home'],
  ] as const)(
    '%s with home %j and no absolute platform variable fails naming FAA_AIRMEN_MIRROR_DIR',
    (value, homeValue) => {
      on(value);
      home.value = homeValue;
      vi.stubEnv('XDG_DATA_HOME', '');
      vi.stubEnv('LOCALAPPDATA', '');
      process.chdir(first);
      let thrown: unknown;
      try {
        getServerConfig();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({
        code: JsonRpcErrorCode.ConfigurationError,
        message: expect.stringContaining('FAA_AIRMEN_MIRROR_DIR'),
      });
      // Neither the message nor the error's data names the working directory.
      expect((thrown as Error).message).not.toContain(first);
      expect(JSON.stringify(thrown)).not.toContain(first);
    },
  );
  it('an absolute platform variable still works when the home directory is not absolute', () => {
    on('linux');
    home.value = '';
    vi.stubEnv('XDG_DATA_HOME', '/synthetic/xdg');
    expect(fromBothDirectories()).toBe(join('/synthetic/xdg', app));
  });
  it('an explicit FAA_AIRMEN_MIRROR_DIR wins over the platform default, relative or absolute', () => {
    on('linux');
    home.value = '';
    vi.stubEnv('XDG_DATA_HOME', '');
    vi.stubEnv('FAA_AIRMEN_MIRROR_DIR', '/synthetic/explicit');
    expect(getServerConfig().mirrorDir).toBe('/synthetic/explicit');
    process.chdir(first);
    vi.stubEnv('FAA_AIRMEN_MIRROR_DIR', 'relative-mirror');
    expect(getServerConfig().mirrorDir).toBe(join(first, 'relative-mirror'));
    vi.stubEnv('FAA_AIRMEN_MIRROR_DIR', '   ');
    vi.stubEnv('XDG_DATA_HOME', '/synthetic/xdg');
    expect(getServerConfig().mirrorDir).toBe(join('/synthetic/xdg', app));
  });
});
