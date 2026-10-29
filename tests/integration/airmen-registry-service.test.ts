/** Query behavior over real synthetic FAA snapshots, never mocked SQL/domain logic. */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqlValue } from '@cyanheads/mcp-ts-core/mirror';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFRESH_DEADLINE_MS } from '../../src/services/airmen/airmen-mirror.js';
import { AirmenRegistryService } from '../../src/services/airmen/airmen-registry-service.js';
import { REFERENCE_TOPICS, type VerifyInput } from '../../src/services/airmen/contracts.js';
import { STATE_CODES } from '../../src/services/airmen/reference.js';
import type { SnapshotLease } from '../../src/services/airmen/types.js';
import {
  basicRow,
  certificateRow,
  sourceFetch,
  sourceFiles,
  zipSource,
} from '../helpers/airmen-source.js';

type NameMode = 'exact' | 'prefix' | 'words';
/** Synthetic BASIC variants crossing every name boundary; each person holds an instructor certificate. */
const boundaryVariants = [
  { id: 'A1000001', last: 'TESTER', first: 'PROBE', state: 'WA' },
  { id: 'A1000002', last: 'TESTER JR', first: 'PROBE QUINN', state: 'WA' },
  { id: 'A1000003', last: 'TESTER-SAMPLE', first: 'PROBE-PAIR', state: 'WA' },
  { id: 'A1000004', last: 'TESTERSON', first: 'PROBEX', state: 'WA' },
  { id: 'A1000005', last: "O'TESTER", first: "PROBE'S", state: 'WA' },
  { id: 'A1000006', last: 'O TESTER', first: 'PROBE/Q', state: 'OR' },
  { id: 'A1000007', last: 'TESTER JR', first: 'PROBE QUINN LEE', state: 'OR' },
  { id: 'A1000008', last: 'UNDER_SCORE', first: 'PCT%SIGN', state: 'WA' },
  { id: 'A1000009', last: 'UNDERXSCORE', first: 'PCTXSIGN', state: 'WA' },
  { id: 'A1000010', last: '%PERCENT', first: '_LEAD', state: 'WA' },
  { id: 'A1000011', last: 'BACK\\SLASH', first: 'BACK\\', state: 'WA' },
  { id: 'A1000012', last: 'ASTRAL😀TAIL', first: 'ÉVA', state: 'WA' },
  { id: 'A1000013', last: 'TESTER', first: 'QUINN PROBE', state: 'WA' },
  { id: 'A1000014', last: 'TESTER', first: 'ALPHA', state: 'WA' },
  { id: 'A1000014', last: 'VARIANT', first: 'PROBE', state: 'WA', nonpilot: true },
];
const lastTerms = [
  'TESTER',
  'TESTER JR',
  'TEST',
  'O',
  "O'",
  'TESTER-',
  'UNDER_',
  'UNDER',
  '%',
  '%PERCENT',
  '_',
  'BACK\\',
  'BACK\\SLASH',
  'ASTRAL😀',
  'ASTRAL😁',
  'ASTRAL',
  'VARIANT',
  'ABSENT',
];
const firstTerms = ['PROBE', 'PROBE QUINN', 'PROB', 'QUINN', '_', '%', 'PCT%', 'BACK\\', 'ÉVA'];
/** Independent oracle: one complete BASIC variant must satisfy every supplied field. */
function oracle(mode: NameMode, terms: { last?: string; first?: string; state?: string }) {
  const hit = (field: string, term?: string) =>
    term === undefined ||
    (mode === 'exact'
      ? field === term
      : mode === 'prefix'
        ? field.startsWith(term)
        : field === term || field.startsWith(`${term} `));
  return [
    ...new Set(
      boundaryVariants
        .filter(
          (variant) =>
            hit(variant.last, terms.last) &&
            hit(variant.first, terms.first) &&
            (!terms.state || variant.state === terms.state),
        )
        .map((variant) => variant.id),
    ),
  ].sort();
}
function personIds(result: { data: { matches: { airman: { uniqueId: string } }[] } }) {
  return result.data.matches.map((match) => match.airman.uniqueId).sort();
}
/** Record EXPLAIN QUERY PLAN rows for the identity SQL the service actually prepares. */
function captureIdentityPlans(registry: AirmenRegistryService): string[][] {
  const plans: string[][] = [];
  const acquire = registry.mirror.acquire.bind(registry.mirror);
  vi.spyOn(registry.mirror, 'acquire').mockImplementation(async (): Promise<SnapshotLease> => {
    const lease = await acquire();
    return {
      ...lease,
      db: {
        prepare<T>(sql: string) {
          const statement = lease.db.prepare<T>(sql);
          const explain = (bindings: SqlValue[]) => {
            if (sql.includes('identity_variants v'))
              plans.push(
                lease.db
                  .prepare<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
                  .all(...bindings)
                  .map((row) => row.detail),
              );
          };
          return {
            all: (...bindings: SqlValue[]) => {
              explain(bindings);
              return statement.all(...bindings);
            },
            get: (...bindings: SqlValue[]) => {
              explain(bindings);
              return statement.get(...bindings);
            },
          };
        },
      },
    };
  });
  return plans;
}
/** Drop the first-name index from the published generation, reproducing an older import's layout. */
async function dropFirstNameIndex(directory: string): Promise<{ before: number; after: number }> {
  const { generation } = JSON.parse(await readFile(join(directory, 'CURRENT'), 'utf8')) as {
    generation: string;
  };
  const path = join(directory, generation, 'mirror.sqlite');
  type Writable = {
    prepare(sql: string): { get(): unknown };
    exec(sql: string): unknown;
    close(): void;
  };
  const moduleName: string = 'bun:sqlite';
  const db: Writable =
    'Bun' in globalThis
      ? new ((await import(moduleName)) as { Database: new (path: string) => Writable }).Database(
          path,
        )
      : new (await import('better-sqlite3')).default(path);
  const count = () =>
    (
      db
        .prepare("SELECT count(*) n FROM sqlite_master WHERE name='identity_first_names'")
        .get() as { n: number }
    ).n;
  try {
    const before = count();
    db.exec('DROP INDEX IF EXISTS identity_first_names');
    return { before, after: count() };
  } finally {
    db.close();
  }
}
/** Count and page queries each read identity variants through the named index, never a scan. */
function expectIdentitySearch(plans: string[][], index: RegExp) {
  expect(plans).toHaveLength(2);
  for (const plan of plans) {
    const rows = plan.filter((detail) => /^(?:SCAN|SEARCH) v\b/.test(detail));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toMatch(index);
  }
}
/** A BASIC row for a synthetic person. */
function person(id: string, first: string, last: string, overrides: Record<number, string> = {}) {
  return basicRow(id, { 1: first, 2: last, ...overrides });
}
/** A certificate row carrying its holder's names. */
function cert(
  id: string,
  first: string,
  last: string,
  pilot: boolean,
  overrides: Record<number, string> = {},
) {
  return certificateRow(id, pilot, { 1: first, 2: last, ...overrides });
}
/** The one construction path for a service over `mirrorDir`; its fetch serves `bytes` unless replaced. */
function serviceAt(
  mirrorDir: string,
  {
    includeLocation = false,
    redactPii = false,
    bytes = zipSource(),
    fetch = sourceFetch(bytes),
    clock = () => new Date('2026-10-20T00:00:00Z'),
  }: {
    includeLocation?: boolean;
    redactPii?: boolean;
    bytes?: Buffer;
    fetch?: typeof globalThis.fetch;
    clock?: () => Date;
  } = {},
) {
  return new AirmenRegistryService(
    { mirrorDir, includeLocation, staleAfterDays: 45, redactPii },
    { fetch, clock },
  );
}
/** Import `bytes` once into a fresh directory for the enclosing describe. */
function sharedMirror(bytes: Buffer, includeLocation: boolean) {
  const mirror = { directory: '' };
  beforeAll(async () => {
    mirror.directory = await mkdtemp(join(tmpdir(), 'faa-shared-'));
    await serviceAt(mirror.directory, { bytes, includeLocation }).initialize();
  });
  afterAll(() => rm(mirror.directory, { recursive: true, force: true }));
  return mirror;
}
/** A rejection's caller-visible fields; `sync` means it was thrown before any asynchronous read. */
async function rejected(run: () => unknown) {
  const fields = (error: unknown, sync: boolean) => {
    const { code, message, data } = error as {
      code: number;
      message: string;
      data: { reason: string; recovery?: { hint: string } };
    };
    return { code, reason: data.reason, message, hint: data.recovery?.hint, sync };
  };
  let pending: unknown;
  try {
    pending = run();
  } catch (error) {
    return fields(error, true);
  }
  try {
    await pending;
  } catch (error) {
    return fields(error, false);
  }
  throw new Error('Expected a rejection.');
}
/** A rejection's reason, message, and hint alone. */
async function rejection(run: () => unknown) {
  const { reason, message, hint } = await rejected(run);
  return { reason, message, hint };
}
/**
 * Same-name people whose levels, ratings, and type ratings sit on one certificate or are split
 * across two. Index 4 is the certificate level; 6–16 ratings; 17+ type ratings.
 */
function credentialedSource() {
  const last = 'CREDENTIAL';
  return zipSource(
    sourceFiles({
      pilotBasic: [
        person('A9999001', 'ALPHA', last),
        person('A9999002', 'BRAVO', last),
        person('A9999003', 'CHARLIE', last),
        person('A9999005', 'ECHO', last),
        person('A9999006', 'FOXTROT', last),
        person('A9999007', 'GOLF', last),
      ],
      nonpilotBasic: [person('A9999004', 'DELTA', last)],
      pilotCert: [
        cert('A9999001', 'ALPHA', last, true, {
          4: 'A',
          6: 'A/AMEL',
          7: 'A/ASEL',
          17: 'A/B-737',
          18: 'A/SYNTH-9',
        }),
        cert('A9999001', 'ALPHA', last, true, { 3: 'F', 4: '', 6: 'C/ASEL' }),
        cert('A9999002', 'BRAVO', last, true, { 4: 'C', 6: 'C/AMEL', 17: 'A/B-737' }),
        cert('A9999003', 'CHARLIE', last, true, { 4: 'A', 6: 'A/AMEL' }),
        cert('A9999003', 'CHARLIE', last, true, { 4: 'C', 17: 'C/B-737' }),
        cert('A9999003', 'CHARLIE', last, true, { 3: 'F', 4: '', 6: 'C/INSTA' }),
        cert('A9999005', 'ECHO', last, true, { 4: 'S' }),
        // Source slots without a level, or with a longer one, keep their designator.
        cert('A9999006', 'FOXTROT', last, true, { 17: 'B-737', 18: 'AB/SYNTH-8' }),
        // A type rating held at commercial level on an ATP certificate.
        cert('A9999007', 'GOLF', last, true, { 4: 'A', 17: 'C/B-737' }),
      ],
      nonpilotCert: [cert('A9999004', 'DELTA', last, false, { 3: 'M', 4: '' })],
    }),
  );
}
/** The USPS codes the October 2026 snapshot's BASIC records carry: 50 states, DC, territories, freely associated states, and military. */
const uspsCodes = [
  ...'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO'.split(' '),
  ...'MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '),
  ...'DC PR GU VI MP AS FM MH PW AA AE AP'.split(' '),
];
/** A state outside the USPS codes, as every tool that accepts state rejects it. */
const stateRule = {
  reason: 'invalid_filter',
  message: 'state must be a two-letter USPS state, territory, or military code.',
  hint: 'Send state as a two-letter USPS code: a state such as WA, or DC, PR, GU, VI, MP, AS, FM, MH, PW, AA, AE or AP; omit it otherwise, since airmen with foreign addresses carry no state.',
};
/** The sentence a page the size budget cut short of `limit` carries while another page is reachable. */
const budgetCut = (limit: number, nextOffset: number) =>
  `The response size budget ended this page before limit ${limit}; more results remain, so repeat the call with offset ${nextOffset}.`;
/** Notice sentences as callers read them. */
const limits =
  'Snapshot presence and absence do not determine current certification, operating privileges, training currency, medical fitness, or eligibility; address-withheld airmen are omitted.';
const locationOff = 'City and ZIP access is disabled by the operator.';
const redactionNotice =
  'Personal-data redaction is on: city, ZIP, and medical fields are withheld, and name searches require both lastName and firstName.';
const absence =
  'No record matched this releasable snapshot. This does not establish that a person is uncertificated.';
const identifiersRoute = 'Check faa_airmen_list_reference with topic identifiers.';
const fewer =
  'Check faa_airmen_list_reference with topic identifiers, then retry with fewer name or location filters.';
const withoutState =
  'Check faa_airmen_list_reference with topic identifiers, then retry without state.';
const remoteByName =
  'No candidate matching the name holds a remote pilot (U) certificate; use faa_airmen_verify_certificate in name mode to check the name and other certificates.';
const ratingsRoute = 'Check the rating codes with faa_airmen_list_reference topic ratings.';
const ratingsRule =
  'Check the rating codes with faa_airmen_list_reference topic ratings; all must occur on the same certificate.';
const levelRoute =
  'Check the certificate level with faa_airmen_list_reference topic certificate_levels.';
const typeRatingsRoute =
  'Check the type ratings with faa_airmen_list_reference topic type_ratings.';
const typeRatingsRule =
  'Check the type ratings with faa_airmen_list_reference topic type_ratings; all must occur on the same certificate.';
const bothRule =
  'Check the rating codes with faa_airmen_list_reference topic ratings and the type ratings with faa_airmen_list_reference topic type_ratings; all must occur on the same certificate.';
/**
 * The sentence that follows the ratings route when the sent codes name CFII, MEI, or one of their
 * codes, on a call whose retries already land on F certificates; the other two forms name the
 * filter that confines each retry to F (a bare CFII code also matches a pilot certificate's
 * instrument rating, and a ground instructor certificate carries none of the alternatives).
 */
const cfiiMei =
  'CFII is INSTA, INSTH, INSTI, or INSTP on a flight instructor (F) certificate, and MEI is AME or ASME on F; send one call per alternative';
const alternatives = `${cfiiMei}.`;
const alternativesOnF = `${cfiiMei}, with certificateType F.`;
const alternativesFlight = `${cfiiMei}, with instructorType flight or both.`;
/** An instructor zero result's count of the people its search matches without ratingCodes. */
const instructorsCounted = (people: string, instructor: string, codes: string) =>
  `${people} this search without ratingCodes, and none holds a ${instructor} certificate carrying ${codes} in this snapshot.`;
const noInstructor = (instructor: string) =>
  `No ${instructor} matches this search even without ratingCodes.`;

describe('offline FAA registry queries', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'faa-query-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  function service(includeLocation = false, bytes = zipSource(), redactPii = false) {
    return serviceAt(directory, { includeLocation, bytes, redactPii });
  }
  async function populated(includeLocation = false) {
    const one = 'A9999999',
      two = 'C9999998',
      three = 'A9999997';
    const basics = [
      basicRow(one, { 1: 'ÉVA M.', 2: "O'NEIL_%", 10: '3', 11: 'MEDICAL-SENTINEL' }),
      basicRow(two, { 1: 'SECOND', 2: 'FIXTURE' }),
      basicRow(three, { 1: 'THIRD', 2: 'FIXTURE' }),
    ];
    const certs = [
      certificateRow(one, true, {
        1: 'CERTIFICATE VARIANT',
        3: 'P',
        6: 'P/ASEL',
        16: 'P/INST',
        115: 'P/TEST-99',
      }),
      certificateRow(one, true, { 3: 'F', 6: 'C/ASEL' }),
      certificateRow(one, true, { 3: 'F', 6: 'C/INST' }),
      certificateRow(two, true, { 3: 'F', 6: 'C/ASEL', 7: 'C/INST' }),
      certificateRow(three),
    ];
    const bytes = zipSource(
      sourceFiles({
        pilotBasic: basics,
        nonpilotBasic: [
          basicRow(one, { 1: 'OTHER', 2: 'IDENTITY', 6: 'OR', 10: '2', 11: '102026' }),
        ],
        pilotCert: certs,
        nonpilotCert: [
          certificateRow(one, false, { 3: 'U', 4: '' }),
          certificateRow(three, false, { 3: 'M' }),
        ],
      }),
    );
    const registry = service(includeLocation, bytes);
    await registry.initialize();
    return registry;
  }
  async function boundary() {
    const row = (variant: (typeof boundaryVariants)[number]) =>
      person(variant.id, variant.first, variant.last, { 6: variant.state });
    const people = [...new Set(boundaryVariants.map((variant) => variant.id))];
    const registry = service(
      false,
      zipSource(
        sourceFiles({
          pilotBasic: boundaryVariants.filter((variant) => !variant.nonpilot).map(row),
          nonpilotBasic: boundaryVariants.filter((variant) => variant.nonpilot).map(row),
          pilotCert: people.map((id) => certificateRow(id, true, { 3: 'F', 6: 'C/ASEL' })),
          nonpilotCert: [certificateRow('A1000014', false, { 3: 'G', 6: 'BASIC' })],
        }),
      ),
    );
    await registry.initialize();
    return registry;
  }
  /** Instructor and pilot certificates carrying one rating code at different source levels. */
  async function levels() {
    const last = 'LEVELS';
    const registry = service(
      false,
      zipSource(
        sourceFiles({
          pilotBasic: [
            person('A3000001', 'ALPHA', last),
            person('A3000002', 'BRAVO', last),
            person('A3000003', 'CHARLIE', last),
          ],
          nonpilotBasic: [person('A3000003', 'CHARLIE', last)],
          pilotCert: [
            cert('A3000001', 'ALPHA', last, true, { 3: 'F', 4: '', 6: 'F/INSTA', 7: 'F/ASE' }),
            cert('A3000001', 'ALPHA', last, true, { 3: 'P', 4: 'C', 6: 'C/INSTA', 7: 'C/ASEL' }),
            cert('A3000002', 'BRAVO', last, true, { 3: 'F', 4: '', 6: 'F/ASEL' }),
          ],
          nonpilotCert: [
            cert('A3000002', 'BRAVO', last, false, { 3: 'G', 4: '', 6: 'G/ADV' }),
            cert('A3000003', 'CHARLIE', last, false, { 3: 'G', 4: '', 6: 'G/INSTA' }),
          ],
        }),
      ),
    );
    await registry.initialize();
    return registry;
  }
  async function credentialed() {
    const registry = service(false, credentialedSource());
    await registry.initialize();
    return registry;
  }
  const idOnly =
    'In mode id send uniqueId without name, location, or nameMatch fields; to search by name, use mode name without uniqueId.';

  it('rejects a city or ZIP with location access off before any mode or format check', async () => {
    const registry = service();
    for (const input of [
      { mode: 'id', uniqueId: 'A9999999', city: 'PRIVATE CITY' },
      { mode: 'id', uniqueId: 'PRIVATE', zipCode: '99999' },
      { mode: 'name', zipCode: 'PRIVATE' },
    ] as const)
      expect((await rejection(() => registry.verifyCertificates(input))).reason).toBe(
        'location_access_disabled',
      );
  });

  it('names the failing field and its expected form, never the value, with a field-specific recovery', async () => {
    const registry = service(),
      located = service(true);
    const ratingCodes = [
      'invalid_filter',
      'ratingCodes must be 1–11 codes, each 1–30 letters, digits, spaces, or hyphens, optionally after a one-letter level and a slash.',
      'Call faa_airmen_list_reference with topic ratings and send listed codes, bare or as level/code such as F/INSTA.',
    ] as const;
    const state = [stateRule.reason, stateRule.message, stateRule.hint] as const;
    const typeRatings = [
      'invalid_filter',
      'typeRatings must be 1–11 designators, each 1–30 letters, digits, spaces, or hyphens, optionally after a one-letter level and a slash.',
      'Call faa_airmen_list_reference with topic type_ratings and send listed designators, bare or as level/designator such as A/B-737.',
    ] as const;
    const levelNeedsType = [
      'invalid_filter',
      'certificateLevel requires certificateType.',
      'Add the certificateType the level belongs to, such as P for level A, from faa_airmen_list_reference topic certificate_levels, or omit certificateLevel.',
    ] as const;
    const level = [
      'invalid_filter',
      'certificateLevel must be one certificate level letter.',
      'Call faa_airmen_list_reference with topic certificate_levels and send a level letter listed for the certificateType, or omit certificateLevel.',
    ] as const;
    const verify = (filters: Omit<VerifyInput, 'mode'>) => () =>
      registry.verifyCertificates({ mode: 'name', lastName: 'X', ...filters });
    const cases: [() => unknown, readonly [string, string, string]][] = [
      [verify({ certificateLevel: 'PRIVATE' }), levelNeedsType],
      [verify({ certificateType: ' ', certificateLevel: 'A' }), levelNeedsType],
      [
        () =>
          registry.verifyCertificates({ mode: 'id', uniqueId: 'A9999999', certificateLevel: 'A' }),
        levelNeedsType,
      ],
      [verify({ certificateType: 'P', certificateLevel: 'PRIVATE' }), level],
      [verify({ certificateType: 'P', certificateLevel: '1' }), level],
      [verify({ ratingCodes: [' /PRIVATE'] }), ratingCodes],
      [verify({ ratingCodes: Array.from({ length: 12 }, (_, i) => `PRIVATE${i}`) }), ratingCodes],
      [verify({ typeRatings: ['PRIVATE/X/Y'] }), typeRatings],
      [verify({ typeRatings: ['PRIVATE/ '] }), typeRatings],
      [verify({ typeRatings: [] }), typeRatings],
      [verify({ typeRatings: ['PRIVATE'.repeat(5)] }), typeRatings],
      // Every source slot level is one letter, so a longer or reversed level can never match.
      [verify({ ratingCodes: ['PRIVATE/F'] }), ratingCodes],
      [verify({ ratingCodes: ['1/PRIVATE'] }), ratingCodes],
      [verify({ typeRatings: ['PRIVATE-737/A'] }), typeRatings],
      [verify({ typeRatings: ['-/PRIVATE'] }), typeRatings],
      [() => registry.searchInstructors({ state: 'WA', ratingCodes: ['PRIVATE/F'] }), ratingCodes],
      [
        () => registry.verifyCertificates({ mode: 'name', lastName: 'PRIVATE', state: 'PRIVATE' }),
        state,
      ],
      [() => registry.searchInstructors({ state: 'PRIVATE' }), state],
      [
        () => registry.verifyCertificates({ mode: 'name', lastName: 'PRIVATE'.repeat(9) }),
        [
          'invalid_identity',
          'lastName must be at most 60 characters with no control or format characters.',
          'Retry with lastName as written in the FAA LAST NAME field, at most 60 characters.',
        ],
      ],
      [
        () => registry.searchInstructors({ firstName: 'PRIVATE\u0000' }),
        [
          'invalid_identity',
          'firstName must be at most 60 characters with no control or format characters.',
          'Retry with firstName as written in the FAA FIRST NAME field, at most 60 characters, or omit it.',
        ],
      ],
      [
        () => located.verifyCertificates({ mode: 'name', lastName: 'X', city: 'PRIVATE\u0007' }),
        [
          'invalid_filter',
          'city must be at most 60 characters with no control or format characters.',
          'Retry with city as at most 60 characters, or omit it.',
        ],
      ],
      [
        () => located.verifyCertificates({ mode: 'name', lastName: 'X', zipCode: 'PRIVATE' }),
        [
          'invalid_filter',
          'zipCode must be five digits or ZIP+4.',
          'Send zipCode as 99999, 99999-1234, or 999991234, or omit it.',
        ],
      ],
      [
        () =>
          registry.verifyCertificates({
            mode: 'name',
            lastName: 'X',
            nameMatch: 'PRIVATE' as 'exact',
          }),
        [
          'invalid_filter',
          'nameMatch must be words, exact, or prefix.',
          'Send nameMatch words, exact, or prefix, or omit it for words.',
        ],
      ],
      [
        () =>
          registry.verifyCertificates({ mode: 'name', lastName: 'X', certificateType: 'PRIVATE' }),
        [
          'invalid_filter',
          'certificateType must be one certificate type letter, a certificate_types description, or CFI.',
          'Call faa_airmen_list_reference with topic certificate_types and send a listed code or description, or omit certificateType together with any certificateLevel.',
        ],
      ],
      [() => registry.searchInstructors({ ratingCodes: ['PRIVATE/X/Y'] }), ratingCodes],
      [() => registry.searchInstructors({ ratingCodes: [' /PRIVATE'] }), ratingCodes],
      [() => registry.searchInstructors({ ratingCodes: ['PRIVATE/ '] }), ratingCodes],
      [() => registry.searchInstructors({ ratingCodes: [] }), ratingCodes],
      [
        () =>
          registry.searchInstructors({
            state: 'WA',
            instructorType: 'PRIVATE' as 'both',
          }),
        [
          'invalid_filter',
          'instructorType must be flight, ground, or both.',
          'Send instructorType flight, ground, or both, or omit it for both.',
        ],
      ],
      [
        () => registry.verifyCertificates({ mode: 'name', lastName: 'X', limit: 0 }),
        [
          'invalid_filter',
          'limit must be a whole number of at least 1.',
          'Send limit from 1 to 50; a larger limit returns at most 50.',
        ],
      ],
      [
        () => registry.verifyCertificates({ mode: 'name', lastName: 'X', offset: 10001 }),
        [
          'invalid_filter',
          'offset must be a whole number from 0 to 10000.',
          'Follow nextOffset, or narrow the filters to reach results beyond offset 10000.',
        ],
      ],
      [
        () => registry.getMedical({ uniqueId: 'PRIVATE' }),
        [
          'invalid_identity',
          'uniqueId must be A or C plus seven digits, such as A9999999.',
          'Copy uniqueId from a faa_airmen_verify_certificate, faa_airmen_search_instructors, or faa_airmen_verify_remote_pilot result; it is not a certificate number.',
        ],
      ],
      [
        () => registry.listReference({ topic: 'ratings', filter: 'PRIVATE'.repeat(12) }),
        [
          'invalid_filter',
          'filter must be at most 80 characters with no control or format characters.',
          'Retry with filter as at most 80 characters, or omit it.',
        ],
      ],
      [
        () => registry.listReference({ topic: 'identifiers', filter: 'PRIVATE' }),
        [
          'invalid_filter',
          'filter applies only to topics certificate_types, certificate_levels, ratings, and type_ratings.',
          'Retry without filter for this topic.',
        ],
      ],
    ];
    for (const [run, [reason, message, hint]] of cases) {
      const error = await rejection(run);
      expect(error).toEqual({ reason, message, hint });
      expect(JSON.stringify(error)).not.toContain('PRIVATE');
    }
  });

  it('checks the mode combination before any field format', async () => {
    const registry = service();
    const cases = [
      [{ mode: 'id', uniqueId: 'A9999999', state: 'PRIVATE' }, 'mode id forbids state.', idOnly],
      [
        { mode: 'id', uniqueId: 'A9999999', nameMatch: 'PRIVATE' as 'exact' },
        'mode id forbids nameMatch.',
        idOnly,
      ],
      // A valid nameMatch, the default included, is still a name field.
      ...(['words', 'exact', 'prefix'] as const).map(
        (nameMatch) =>
          [
            { mode: 'id', uniqueId: 'A9999999', nameMatch },
            'mode id forbids nameMatch.',
            idOnly,
          ] as const,
      ),
      [
        { mode: 'id', uniqueId: 'PRIVATE', lastName: 'PRIVATE' },
        'mode id forbids lastName.',
        idOnly,
      ],
      [
        { mode: 'id', uniqueId: ' 　 ' },
        'mode id requires uniqueId.',
        'Send the uniqueId from a faa_airmen_verify_certificate, faa_airmen_search_instructors, or faa_airmen_verify_remote_pilot result, or search with mode name and lastName.',
      ],
      [
        { mode: 'id', uniqueId: 'PRIVATE' },
        'uniqueId must be A or C plus seven digits, such as A9999999.',
        'Copy uniqueId from a faa_airmen_verify_certificate, faa_airmen_search_instructors, or faa_airmen_verify_remote_pilot result; it is not a certificate number.',
      ],
      [
        { mode: 'name', state: 'PRIVATE' },
        'mode name requires lastName.',
        'In mode name send a nonblank lastName, or use mode id with a uniqueId.',
      ],
      [
        { mode: 'name', lastName: 'PRIVATE', uniqueId: 'PRIVATE', state: 'PRIVATE' },
        'mode name forbids uniqueId.',
        'In mode name omit uniqueId; to read one ID, use mode id with uniqueId alone.',
      ],
    ] as const;
    for (const [input, message, hint] of cases)
      for (const run of [
        () => registry.verifyCertificates(input),
        () => registry.verifyRemotePilot(input),
      ]) {
        const error = await rejection(run);
        expect(error).toEqual({ reason: 'invalid_identity', message, hint });
        expect(JSON.stringify(error)).not.toContain('PRIVATE');
      }
  });

  it('rejects a control or format character inside a value, which is never blank', async () => {
    const registry = service();
    for (const [input, reason, message] of [
      [
        { mode: 'name', lastName: 'FIX\tTURE' },
        'invalid_identity',
        'lastName must be at most 60 characters with no control or format characters.',
      ],
      [
        { mode: 'id', uniqueId: 'A9999999\t' },
        'invalid_identity',
        'uniqueId must be A or C plus seven digits, such as A9999999.',
      ],
      [{ mode: 'name', lastName: 'fixture', state: 'W​A' }, 'invalid_filter', stateRule.message],
    ] as const)
      expect(await rejection(() => registry.verifyCertificates(input))).toMatchObject({
        reason,
        message,
      });
    expect(
      await rejection(() =>
        registry.verifyCertificates({ mode: 'id', uniqueId: 'A9999999', lastName: 'X​' }),
      ),
    ).toEqual({ reason: 'invalid_identity', message: 'mode id forbids lastName.', hint: idOnly });
  });

  it('treats a value of only whitespace, control, or format characters as unset', async () => {
    const registry = await populated();
    for (const blank of ['  ', '　', ' ', ' 　 ', '\t', '\n', '\r\n', '﻿', ' \t ', '\u000B\u000C']) {
      const label = JSON.stringify(blank);
      expect(
        await rejection(() => registry.verifyCertificates({ mode: 'id', uniqueId: blank })),
        label,
      ).toMatchObject({ reason: 'invalid_identity', message: 'mode id requires uniqueId.' });
      expect(
        await rejection(() => registry.verifyCertificates({ mode: 'name', lastName: blank })),
        label,
      ).toMatchObject({ reason: 'invalid_identity', message: 'mode name requires lastName.' });
      const byId = await registry.verifyCertificates({
        mode: 'id',
        uniqueId: 'A9999999',
        lastName: blank,
        firstName: blank,
        state: blank,
        city: blank,
        zipCode: blank,
        certificateType: blank,
        certificateLevel: blank,
      });
      expect(byId.enrichment.appliedFilters, label).toEqual({
        mode: 'id',
        uniqueId: 'A9999999',
        limit: 10,
        offset: 0,
      });
      expect(personIds(byId), label).toEqual(['A9999999']);
      const byName = await registry.verifyRemotePilot({
        mode: 'name',
        lastName: 'fixture',
        uniqueId: blank,
        state: blank,
      });
      expect(byName.enrichment.appliedFilters, label).toEqual({
        mode: 'name',
        lastName: 'FIXTURE',
        nameMatch: 'words',
        limit: 10,
        offset: 0,
        certificateType: 'U',
      });
      expect(
        await rejection(() => registry.searchInstructors({ state: blank, firstName: blank })),
        label,
      ).toMatchObject({
        reason: 'missing_search_filter',
        message: 'Instructor search requires lastName, firstName, state, or ratingCodes.',
      });
      const reference = await registry.listReference({ topic: 'identifiers', filter: blank });
      expect(reference.enrichment.appliedFilters, label).toEqual({
        topic: 'identifiers',
        limit: 10,
        offset: 0,
      });
    }
  });

  it('accepts each of the 62 USPS codes as state in any case and padded, and finds its person', async () => {
    const people = uspsCodes.map((code, index) => ({
      code,
      id: `A62000${String(index).padStart(2, '0')}`,
    }));
    const registry = service(
      false,
      zipSource(
        sourceFiles({
          pilotBasic: people.map(({ code, id }) => person(id, 'SYNTHETIC', 'STATES', { 6: code })),
          pilotCert: people.map(({ id }) => certificateRow(id, true, { 2: 'STATES' })),
        }),
      ),
    );
    await registry.initialize();
    expect(uspsCodes).toHaveLength(62);
    // The rejection cases name only a few outside codes; an extra packaged code would pass them.
    expect([...STATE_CODES].sort()).toEqual([...uspsCodes].sort());
    for (const { code, id } of people)
      for (const sent of [code, ` ${code.toLowerCase()} `]) {
        const result = await registry.verifyCertificates({
          mode: 'name',
          lastName: 'states',
          state: sent,
        });
        expect({
          sent,
          ids: personIds(result),
          state: result.enrichment.appliedFilters.state,
        }).toEqual({ sent, ids: [id], state: code });
      }
    // U+FB02 uppercases to FL, which is a listed code.
    const ligature = await registry.verifyCertificates({
      mode: 'name',
      lastName: 'states',
      state: 'ﬂ',
    });
    expect(ligature.enrichment.appliedFilters.state).toBe('FL');
    expect(personIds(ligature)).toEqual([people.find(({ code }) => code === 'FL')!.id]);
  });

  it('rejects a nonblank state outside the USPS codes on every tool that accepts state, after the location gate and mode checks', async () => {
    const registry = await populated();
    // ß uppercases to SS, two letters that are no USPS code.
    for (const state of ['ZZ', ' zz ', 'US', 'GB', 'ß', 'XX'])
      expect(
        await rejection(() =>
          registry.verifyCertificates({ mode: 'name', lastName: 'fixture', state }),
        ),
        state,
      ).toEqual(stateRule);
    for (const run of [
      () => registry.verifyRemotePilot({ mode: 'name', lastName: 'fixture', state: 'ZZ' }),
      () => registry.searchInstructors({ state: 'ZZ' }),
    ]) {
      const error = await rejection(run);
      expect(error).toEqual(stateRule);
      expect(JSON.stringify(error)).not.toContain('ZZ');
    }
    expect(
      await rejection(() =>
        registry.verifyCertificates({ mode: 'id', uniqueId: 'A9999999', state: 'ZZ' }),
      ),
    ).toEqual({ reason: 'invalid_identity', message: 'mode id forbids state.', hint: idOnly });
    expect(
      (
        await rejection(() =>
          registry.verifyCertificates({ mode: 'name', lastName: 'x', state: 'ZZ', city: 'X' }),
        )
      ).reason,
    ).toBe('location_access_disabled');
  });

  it('keeps the one-to-one certificate type aliases and unknown letters', async () => {
    const registry = await populated();
    for (const [alias, code] of [
      ['pilot', 'P'],
      ['CFI', 'F'],
      ['remote_pilot', 'U'],
      ['ground_instructor', 'G'],
      ['mechanic', 'M'],
      ['dispatcher', 'D'],
      [' z ', 'Z'],
    ] as const)
      expect(
        (
          await registry.verifyCertificates({
            mode: 'id',
            uniqueId: 'A9999999',
            certificateType: alias,
          })
        ).enrichment.appliedFilters.certificateType,
      ).toBe(code);
  });

  it('accepts every certificate_types description, case-insensitive with underscore and space interchangeable', async () => {
    const registry = await populated();
    const { entries } = (await registry.listReference({ topic: 'certificate_types', limit: 50 }))
      .data;
    expect(entries).toHaveLength(17);
    for (const { code, description } of entries)
      for (const spelling of [
        description!,
        description!.toLowerCase(),
        description!.replaceAll(' ', '_'),
        `_${description!.toUpperCase().replaceAll(' ', '  ')} `,
      ])
        expect(
          (
            await registry.verifyCertificates({
              mode: 'id',
              uniqueId: 'A9999999',
              certificateType: spelling,
            })
          ).enrichment.appliedFilters.certificateType,
          spelling,
        ).toBe(code);
    const flight = await registry.verifyCertificates({
      mode: 'id',
      uniqueId: 'A9999999',
      certificateType: 'flight instructor',
    });
    expect(flight.data.matches.map((match) => match.airman.uniqueId)).toEqual(['A9999999']);
    // Underscores stand in for spaces inside descriptions only; a letter takes none.
    for (const certificateType of ['ATP', 'remotepilot', 'remote-pilot', '_', '_U', 'U_', ' _P_ '])
      expect(
        (
          await rejection(() =>
            registry.verifyCertificates({ mode: 'name', lastName: 'FIXTURE', certificateType }),
          )
        ).reason,
      ).toBe('invalid_filter');
  });

  it('matches a level/code rating at that level and a bare code at any level, collapsing repeats', async () => {
    const registry = await levels();
    const search = async (ratingCodes: string[], instructorType?: 'flight' | 'ground') => {
      const result = await registry.searchInstructors({
        ratingCodes,
        ...(instructorType && { instructorType }),
      });
      return {
        people: personIds(result),
        codes: result.enrichment.appliedFilters.ratingCodes,
        returned: result.data.matches.flatMap((match) =>
          match.instructorCertificates.map((record) => record.type.code),
        ),
      };
    };
    expect(await search(['INSTA'], 'flight')).toEqual({
      people: ['A3000001'],
      codes: ['INSTA'],
      returned: ['F'],
    });
    expect(await search([' f / insta '], 'flight')).toEqual({
      people: ['A3000001'],
      codes: ['F/INSTA'],
      returned: ['F'],
    });
    expect((await search(['G/INSTA'], 'flight')).people).toEqual([]);
    expect(await search(['g/insta'])).toEqual({
      people: ['A3000003'],
      codes: ['G/INSTA'],
      returned: ['G'],
    });
    expect((await search(['INSTA'])).people).toEqual(['A3000001', 'A3000003']);
    expect((await search(['C/INSTA'])).people).toEqual([]);
    expect(await search(['ASE', 'ase', ' Ase '])).toEqual({
      people: ['A3000001'],
      codes: ['ASE'],
      returned: ['F'],
    });
    expect((await search(['F/INSTA', 'F/ASE', 'f/insta'])).codes).toEqual(['F/INSTA', 'F/ASE']);
    expect((await search(['F/INSTA', 'F/ASE'])).people).toEqual(['A3000001']);
    expect((await search(['F/INSTA', 'ASEL'])).people).toEqual([]);
  });

  it('requires every verify credential filter on one certificate and returns all certificates', async () => {
    const registry = await credentialed();
    const search = async (filters: Omit<VerifyInput, 'mode'>) =>
      personIds(
        await registry.verifyCertificates({ mode: 'name', lastName: 'credential', ...filters }),
      );
    expect(await search({})).toEqual([
      'A9999001',
      'A9999002',
      'A9999003',
      'A9999004',
      'A9999005',
      'A9999006',
      'A9999007',
    ]);
    expect(await search({ certificateType: 'pilot', certificateLevel: 'a' })).toEqual([
      'A9999001',
      'A9999003',
      'A9999007',
    ]);
    expect(await search({ typeRatings: ['b-737'] })).toEqual([
      'A9999001',
      'A9999002',
      'A9999003',
      'A9999006',
      'A9999007',
    ]);
    expect(await search({ typeRatings: ['A/B-737'] })).toEqual(['A9999001', 'A9999002']);
    expect(await search({ typeRatings: ['B-737', 'SYNTH-9'] })).toEqual(['A9999001']);
    // A malformed source slot with a longer level is found by its bare designator alone.
    expect(await search({ typeRatings: ['synth-8'] })).toEqual(['A9999006']);
    expect((await rejection(() => search({ typeRatings: ['ab/synth-8'] }))).reason).toBe(
      'invalid_filter',
    );
    expect(await search({ typeRatings: ['A/SYNTH-8'] })).toEqual([]);
    // The certificate's level and a type-rating slot's own level are separate filters.
    expect(
      await search({ certificateType: 'P', certificateLevel: 'A', typeRatings: ['B-737'] }),
    ).toEqual(['A9999001', 'A9999007']);
    expect(
      await search({ certificateType: 'P', certificateLevel: 'A', typeRatings: ['C/B-737'] }),
    ).toEqual(['A9999007']);
    expect(
      await search({ certificateType: 'P', certificateLevel: 'C', typeRatings: ['A/B-737'] }),
    ).toEqual(['A9999002']);
    expect(
      await search({ certificateType: 'P', certificateLevel: 'A', typeRatings: ['A/B-737'] }),
    ).toEqual(['A9999001']);
    // Credentials held only on different certificates never combine.
    expect(
      await search({
        certificateType: 'P',
        certificateLevel: 'A',
        ratingCodes: ['AMEL'],
        typeRatings: ['B-737'],
      }),
    ).toEqual(['A9999001']);
    expect(await search({ ratingCodes: ['INSTA'], typeRatings: ['B-737'] })).toEqual([]);
    expect(await search({ ratingCodes: ['AMEL'], typeRatings: ['B-737'] })).toEqual([
      'A9999001',
      'A9999002',
    ]);
    expect(await search({ ratingCodes: ['A/AMEL'] })).toEqual(['A9999001', 'A9999003']);
    expect(await search({ ratingCodes: ['AMEL', 'ASEL'] })).toEqual(['A9999001']);
    expect(await search({ certificateType: 'F', typeRatings: ['B-737'] })).toEqual([]);
    expect(await search({ certificateType: 'M', certificateLevel: 'A' })).toEqual([]);
    // Filters select people; each match keeps every certificate, the F record included.
    const full = await registry.verifyCertificates({
      mode: 'name',
      lastName: 'credential',
      certificateType: 'P',
      certificateLevel: 'A',
      typeRatings: ['A/B-737'],
    });
    expect(personIds(full)).toEqual(['A9999001']);
    expect(
      full.data.matches[0]!.certificates.map((record) => ({
        type: record.type.code,
        ratings: record.ratings.map((rating) => rating.raw),
        typeRatings: record.typeRatings.map((rating) => rating.raw),
      })),
    ).toEqual([
      { type: 'F', ratings: ['C/ASEL'], typeRatings: [] },
      { type: 'P', ratings: ['A/AMEL', 'A/ASEL'], typeRatings: ['A/B-737', 'A/SYNTH-9'] },
    ]);
    // A certificateType alone, with no level or code, still keeps the other certificates.
    const typed = await registry.verifyCertificates({
      mode: 'name',
      lastName: 'credential',
      certificateType: 'F',
    });
    expect(
      typed.data.matches.map((match) => [
        match.airman.uniqueId,
        match.certificates.map((record) => record.type.code),
      ]),
    ).toEqual([
      ['A9999001', ['F', 'P']],
      ['A9999003', ['F', 'P', 'P']],
    ]);
    const id = async (filters: Omit<VerifyInput, 'mode' | 'uniqueId'>) =>
      personIds(
        await registry.verifyCertificates({ mode: 'id', uniqueId: 'A9999003', ...filters }),
      );
    expect(await id({ certificateType: 'P', typeRatings: ['B-737'] })).toEqual(['A9999003']);
    expect(
      await id({ certificateType: 'P', certificateLevel: 'A', typeRatings: ['B-737'] }),
    ).toEqual([]);
    expect(await id({ ratingCodes: ['INSTA'], typeRatings: ['C/B-737'] })).toEqual([]);
    const echoed = await registry.verifyCertificates({
      mode: 'name',
      lastName: ' credential ',
      certificateType: 'pilot',
      certificateLevel: ' a ',
      ratingCodes: [' a/amel ', 'A / AMEL', 'amel'],
      typeRatings: [' b-737', 'B-737 ', 'a/synth-9'],
    });
    expect(personIds(echoed)).toEqual(['A9999001']);
    expect(echoed.enrichment.appliedFilters).toEqual({
      mode: 'name',
      lastName: 'CREDENTIAL',
      nameMatch: 'words',
      limit: 10,
      offset: 0,
      certificateType: 'P',
      certificateLevel: 'A',
      ratingCodes: ['A/AMEL', 'AMEL'],
      typeRatings: ['B-737', 'A/SYNTH-9'],
    });
    expect(Object.keys(echoed.enrichment.appliedFilters)).toEqual([
      'mode',
      'lastName',
      'nameMatch',
      'limit',
      'offset',
      'certificateType',
      'certificateLevel',
      'ratingCodes',
      'typeRatings',
    ]);
    const blank = await registry.verifyCertificates({
      mode: 'name',
      lastName: 'credential',
      certificateType: 'P',
      certificateLevel: ' ',
    });
    expect(blank.enrichment.appliedFilters).not.toHaveProperty('certificateLevel');
    expect(blank.enrichment.totalCount).toBe(6);
  });

  it('clamps a limit above 50 to 50 with a notice and the effective limit echoed', async () => {
    const registry = await boundary();
    const clamped = 'A limit above 50 returns at most 50.';
    const fifty = await registry.verifyCertificates({
      mode: 'name',
      lastName: 'TESTER',
      limit: 50,
    });
    expect(fifty.enrichment.notice).not.toContain(clamped);
    for (const limit of [51, 100, 10000]) {
      const result = await registry.verifyCertificates({ mode: 'name', lastName: 'TESTER', limit });
      expect(result.data).toEqual(fifty.data);
      expect(result.enrichment).toEqual({
        ...fifty.enrichment,
        appliedFilters: { ...fifty.enrichment.appliedFilters, limit: 50 },
        notice: `${fifty.enrichment.notice} ${clamped}`,
      });
    }
    const past = await registry.verifyCertificates({
      mode: 'name',
      lastName: 'TESTER',
      limit: 1000,
      offset: 5,
    });
    expect(past.enrichment).toMatchObject({ totalCount: 5, returnedCount: 0, nextOffset: null });
    expect(past.enrichment.notice).toContain(
      `This page is past the available results; repeat the same tool with offset 0. ${clamped}`,
    );
    const instructors = await registry.searchInstructors({ state: 'WA', limit: 51 });
    expect(instructors.enrichment.appliedFilters.limit).toBe(50);
    expect(instructors.enrichment.notice).toContain(clamped);
    const reference = await registry.listReference({ topic: 'ratings', limit: 100 });
    const referenceFifty = await registry.listReference({ topic: 'ratings', limit: 50 });
    expect(reference.data).toEqual(referenceFifty.data);
    // The size budget cuts the 55 ratings short of 50, so both pages also carry the cut sentence.
    expect(referenceFifty.enrichment.notice).toBe(
      budgetCut(50, referenceFifty.enrichment.returnedCount),
    );
    expect(reference.enrichment).toEqual({
      ...referenceFifty.enrichment,
      appliedFilters: { ...referenceFifty.enrichment.appliedFilters, limit: 50 },
      notice: `${clamped} ${referenceFifty.enrichment.notice}`,
    });
    const walked: string[] = [];
    for (let offset: number | null = 0; offset !== null; ) {
      const page = await registry.listReference({ topic: 'ratings', limit: 100, offset });
      walked.push(...page.data.entries.map((entry) => entry.code));
      offset = page.enrichment.nextOffset;
    }
    expect(walked).toHaveLength(55);
    expect(new Set(walked).size).toBe(55);
  });

  it('says the size budget cut a page short of limit only when another page is reachable', async () => {
    // Fifteen long type ratings per person let the budget fit two of the five people per page.
    const ids = ['A4000001', 'A4000002', 'A4000003', 'A4000004', 'A4000005'];
    const long = Object.fromEntries(
      Array.from({ length: 15 }, (_, index) => [index + 17, `P/SYNTH-${index}-${'X'.repeat(40)}`]),
    );
    // Sixty short designators: a clamped type_ratings page fits all 50 within the budget.
    const short = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [index + 17, `P/T-${index}`]),
    );
    const registry = service(
      false,
      zipSource(
        sourceFiles({
          pilotBasic: [
            ...ids.map((id) => person(id, 'SYNTHETIC', 'BUDGET')),
            person('A4000099', 'SYNTHETIC', 'DESIGNATORS'),
          ],
          pilotCert: [
            ...ids.map((id) => cert(id, 'SYNTHETIC', 'BUDGET', true, long)),
            cert('A4000099', 'SYNTHETIC', 'DESIGNATORS', true, short),
          ],
        }),
      ),
    );
    await registry.initialize();
    const search = (paging: { limit?: number; offset?: number }) =>
      registry.verifyCertificates({ mode: 'name', lastName: 'BUDGET', ...paging });
    const cut = await search({ limit: 50 });
    expect(cut.enrichment).toMatchObject({
      totalCount: 5,
      returnedCount: 2,
      hasMore: true,
      nextOffset: 2,
      atPagingCap: false,
    });
    expect(cut.enrichment.notice).toBe(`${limits} ${locationOff} ${budgetCut(50, 2)}`);
    // A later page cut again names its own continuation.
    const second = await search({ limit: 50, offset: 2 });
    expect(second.enrichment).toMatchObject({ returnedCount: 2, nextOffset: 4 });
    expect(second.enrichment.notice).toBe(`${limits} ${locationOff} ${budgetCut(50, 4)}`);
    // A clamped limit keeps both sentences: the clamp, then the cut.
    const clampedCut = await search({ limit: 100 });
    expect(personIds(clampedCut)).toEqual(personIds(cut));
    expect(clampedCut.enrichment.notice).toBe(
      `${limits} ${locationOff} A limit above 50 returns at most 50. ${budgetCut(50, 2)}`,
    );
    // A page holding exactly limit entries, with more to come, was not cut.
    const full = await search({ limit: 2 });
    expect(full.enrichment).toMatchObject({ returnedCount: 2, hasMore: true, nextOffset: 2 });
    expect(full.enrichment.notice).toBe(`${limits} ${locationOff}`);
    // The last page is short because the results end, not because of the budget.
    const last = await search({ limit: 50, offset: 3 });
    expect(last.enrichment).toMatchObject({
      returnedCount: 2,
      hasMore: false,
      nextOffset: null,
    });
    expect(last.enrichment.notice).toBe(`${limits} ${locationOff}`);
    // A clamped page that returns all 50 entries was not cut either.
    const clampedFull = await registry.listReference({ topic: 'type_ratings', limit: 100 });
    expect(clampedFull.enrichment).toMatchObject({
      totalCount: 75,
      returnedCount: 50,
      hasMore: true,
      nextOffset: 50,
    });
    expect(clampedFull.enrichment.notice).toBe(
      `${limits} ${locationOff} A limit above 50 returns at most 50.`,
    );
    // A static reference page carries the sentence as its whole notice.
    const ratings = await registry.listReference({ topic: 'ratings', limit: 50 });
    expect(ratings.enrichment.returnedCount).toBeLessThan(50);
    expect(ratings.enrichment).toMatchObject({
      hasMore: true,
      nextOffset: ratings.enrichment.returnedCount,
    });
    expect(ratings.enrichment.notice).toBe(budgetCut(50, ratings.enrichment.returnedCount));
  });

  it.each(['exact', 'prefix', 'words'] as const)(
    'matches %s names as the oracle does at punctuation, wildcard, accent and word boundaries',
    async (nameMatch) => {
      const registry = await boundary();
      for (const lastName of lastTerms)
        expect(
          personIds(
            await registry.verifyCertificates({ mode: 'name', lastName, nameMatch, limit: 50 }),
          ),
          `lastName ${lastName}`,
        ).toEqual(oracle(nameMatch, { last: lastName }));
      for (const firstName of firstTerms)
        expect(
          personIds(await registry.searchInstructors({ firstName, nameMatch, limit: 50 })),
          `firstName ${firstName}`,
        ).toEqual(oracle(nameMatch, { first: firstName }));
      for (const terms of [
        { last: 'TESTER', first: 'PROBE' },
        { last: 'O', first: 'PROBE' },
        { last: 'TESTER', first: 'PROBE', state: 'OR' },
      ])
        expect(
          personIds(
            await registry.verifyCertificates({
              mode: 'name',
              lastName: terms.last.toLowerCase(),
              firstName: ` ${terms.first.toLowerCase()} `,
              ...(terms.state && { state: terms.state.toLowerCase() }),
              nameMatch,
              limit: 50,
            }),
          ),
          JSON.stringify(terms),
        ).toEqual(oracle(nameMatch, terms));
    },
  );

  it('pins representative matches for each nameMatch and defaults to whole leading words', async () => {
    const registry = await boundary();
    const last = async (lastName: string, nameMatch?: NameMode) =>
      personIds(
        await registry.verifyCertificates({
          mode: 'name',
          lastName,
          ...(nameMatch && { nameMatch }),
        }),
      );
    const prefix = (lastName: string) => last(lastName, 'prefix');
    expect(await prefix('TESTER')).toEqual([
      'A1000001',
      'A1000002',
      'A1000003',
      'A1000004',
      'A1000007',
      'A1000013',
      'A1000014',
    ]);
    expect(await prefix('UNDER_')).toEqual(['A1000008']);
    expect(await prefix('%')).toEqual(['A1000010']);
    expect(await prefix('BACK\\')).toEqual(['A1000011']);
    expect(await prefix('ASTRAL😀')).toEqual(['A1000012']);
    expect(await prefix('ASTRAL😁')).toEqual([]);
    expect(
      personIds(await registry.searchInstructors({ firstName: '_', nameMatch: 'prefix' })),
    ).toEqual(['A1000010']);
    expect(await last('TESTER', 'exact')).toEqual(['A1000001', 'A1000013', 'A1000014']);
    // Without nameMatch, whole leading words split only at spaces.
    expect(await last('TESTER')).toEqual([
      'A1000001',
      'A1000002',
      'A1000007',
      'A1000013',
      'A1000014',
    ]);
    expect(await last('O')).toEqual(['A1000006']);
    expect(await last('TEST')).toEqual([]);
    expect(await last('UNDER')).toEqual([]);
    const byFirstName = await registry.searchInstructors({ firstName: 'probe' });
    expect(personIds(byFirstName)).toEqual(['A1000001', 'A1000002', 'A1000007', 'A1000014']);
    expect(byFirstName.enrichment.appliedFilters.nameMatch).toBe('words');
    for (const [nameMatch, echoed] of [
      [undefined, 'words'],
      ['exact', 'exact'],
    ] as const)
      expect(
        (
          await registry.verifyCertificates({
            mode: 'name',
            lastName: 'TESTER',
            ...(nameMatch && { nameMatch }),
          })
        ).enrichment.appliedFilters.nameMatch,
      ).toBe(echoed);
    const byState = await registry.searchInstructors({ state: ' or ', limit: 50 });
    expect(personIds(byState)).toEqual(['A1000006', 'A1000007']);
    expect(byState.enrichment.appliedFilters.state).toBe('OR');
  });

  it('pages whole-word matches by person in name order', async () => {
    const registry = await boundary();
    const walked: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = await registry.verifyCertificates({
        mode: 'name',
        lastName: 'tester',
        limit: 2,
        offset,
      });
      expect(page.enrichment.totalCount).toBe(5);
      walked.push(...page.data.matches.map((match) => match.airman.uniqueId));
      offset = page.enrichment.nextOffset;
    }
    expect(walked).toEqual(['A1000014', 'A1000001', 'A1000013', 'A1000002', 'A1000007']);
  });

  it('plans a whole-word lastName as an identity_names equality plus word range', async () => {
    const registry = await boundary();
    const plans = captureIdentityPlans(registry);
    await registry.verifyCertificates({ mode: 'name', lastName: 'tester' });
    expectIdentitySearch(plans, /^SEARCH v USING (?:COVERING )?INDEX identity_names \(/);
    for (const plan of plans) {
      expect(plan).toContain('MULTI-INDEX OR');
      expect(plan).toContainEqual(
        expect.stringMatching(/identity_names \(last_name_normalized=\?\)$/),
      );
      expect(plan).toContainEqual(
        expect.stringMatching(
          /identity_names \(last_name_normalized>\? AND last_name_normalized<\?\)$/,
        ),
      );
    }
  });

  type Search = (registry: AirmenRegistryService) => Promise<unknown>;
  const namesRange =
    /^SEARCH v USING (?:COVERING )?INDEX identity_names \(last_name_normalized>\? AND last_name_normalized<\?\)/;
  const firstNames =
    /^SEARCH v USING (?:COVERING )?INDEX identity_first_names \(first_name_normalized[=>]/;
  const byState = /^SEARCH v USING (?:COVERING )?INDEX identity_state \(state=\?/;
  it.each<[string, Search, RegExp]>([
    [
      'a prefix lastName',
      (r) => r.verifyCertificates({ mode: 'name', lastName: 'test', nameMatch: 'prefix' }),
      namesRange,
    ],
    [
      'a prefix lastName and firstName',
      (r) =>
        r.verifyCertificates({
          mode: 'name',
          lastName: 'tester',
          firstName: 'probe',
          nameMatch: 'prefix',
        }),
      namesRange,
    ],
    [
      'a whole-word lastName and firstName',
      (r) => r.verifyCertificates({ mode: 'name', lastName: 'tester', firstName: 'probe' }),
      /^SEARCH v USING (?:COVERING )?INDEX identity_names \(/,
    ],
    ...(['exact', 'prefix', 'words'] as const).map((nameMatch): [string, Search, RegExp] => [
      `a first-name-only ${nameMatch} instructor search`,
      (r) => r.searchInstructors({ firstName: 'probe', nameMatch }),
      firstNames,
    ]),
    [
      'an exact firstName bounded by state',
      (r) => r.searchInstructors({ firstName: 'probe', state: 'or', nameMatch: 'exact' }),
      byState,
    ],
    ['a state-only instructor search', (r) => r.searchInstructors({ state: ' or ' }), byState],
  ])('plans %s as an index search over identity variants', async (_case, search, index) => {
    const registry = await boundary();
    const plans = captureIdentityPlans(registry);
    await search(registry);
    expectIdentitySearch(plans, index);
  });

  it('serves a generation imported without the first-name index with identical results', async () => {
    const registry = await boundary();
    const queries = (['exact', 'prefix', 'words'] as const).flatMap((nameMatch) => [
      ...firstTerms.map(
        (firstName) => () => registry.searchInstructors({ firstName, nameMatch, limit: 50 }),
      ),
      () => registry.searchInstructors({ firstName: 'PROBE', state: 'OR', nameMatch, limit: 50 }),
      () =>
        registry.verifyCertificates({
          mode: 'name',
          lastName: 'TESTER',
          firstName: 'PROBE',
          nameMatch,
          limit: 50,
        }),
    ]);
    const run = async () => {
      const results = [];
      for (const query of queries) {
        const { data, enrichment } = await query();
        results.push({ data, totalCount: enrichment.totalCount });
      }
      return results;
    };
    const indexed = await run();
    expect(indexed.filter((result) => result.totalCount > 0).length).toBeGreaterThan(20);
    expect(await dropFirstNameIndex(directory)).toEqual({ before: 1, after: 0 });
    expect(await registry.mirror.verifyMirror()).toMatchObject({ ok: true, issues: [] });
    const plans = captureIdentityPlans(registry);
    expect(await run()).toEqual(indexed);
    expect(plans[0]).toContainEqual(expect.stringMatching(/^SCAN v\b/));
  });

  it('plans every credential filter as an index search under the name candidates, never a scan', async () => {
    const registry = await credentialed();
    const plans = captureIdentityPlans(registry);
    const filters: VerifyInput = {
      mode: 'name',
      lastName: 'credential',
      certificateType: 'P',
      certificateLevel: 'A',
      ratingCodes: ['A/AMEL', 'ASEL'],
    };
    await registry.verifyCertificates({ ...filters, typeRatings: ['B-737'] });
    await registry.verifyCertificates({ ...filters, typeRatings: ['NONE-1'] });
    // A hit runs count and page; the zero result adds its name-only count.
    expect(plans).toHaveLength(5);
    for (const plan of plans) {
      expect(plan.filter((detail) => /^SCAN\b/.test(detail))).toEqual([]);
      expect(plan).toContainEqual(
        expect.stringMatching(/^SEARCH v USING (?:COVERING )?INDEX identity_names \(/),
      );
    }
    for (const plan of plans.slice(0, 4)) {
      expect(plan).toContainEqual(
        expect.stringMatching(
          /^SEARCH c (?:EXISTS )?USING (?:COVERING )?INDEX certificates_person_type \(unique_id=\? AND type=\?\)$/,
        ),
      );
      expect(
        plan.filter((detail) =>
          /^SEARCH r (?:EXISTS )?USING (?:COVERING )?INDEX ratings_code \(kind=\? AND code=\? AND record_id=\?\)$/.test(
            detail,
          ),
        ),
      ).toHaveLength(3);
    }
    expect(plans[4]!.some((detail) => /\b[cr]\b USING/.test(detail))).toBe(false);
  });

  it('returns complete nested certificates, positional ratings and safe conflicting identities', async () => {
    const registry = await populated();
    const result = await registry.verifyCertificates({
      mode: 'id',
      uniqueId: ' a9999999 ',
      certificateType: 'remote_pilot',
    });
    expect(result.data.matches).toHaveLength(1);
    const match = result.data.matches[0]!;
    expect(match.certificates.map((c) => c.type.code)).toEqual(['F', 'F', 'P', 'U']);
    expect(match.airman).toMatchObject({
      firstName: 'ÉVA M.',
      lastName: "O'NEIL_%",
      sourceFamilies: ['pilot', 'nonpilot'],
      identityVariants: expect.arrayContaining([
        expect.objectContaining({ firstName: 'OTHER', lastName: 'IDENTITY', origin: 'basic' }),
        expect.objectContaining({ firstName: 'CERTIFICATE VARIANT', origin: 'certificate' }),
      ]),
    });
    const pilot = match.certificates.find((c) => c.type.code === 'P')!;
    expect(pilot.ratings.map((r) => r.ordinal)).toEqual([1, 11]);
    expect(pilot.typeRatings).toEqual([
      { ordinal: 99, raw: 'P/TEST-99', code: 'TEST-99', levelCode: 'P' },
    ]);
    expect(result.enrichment).toMatchObject({
      totalCount: 1,
      returnedCount: 1,
      hasMore: false,
      nextOffset: null,
      atPagingCap: false,
      appliedFilters: { uniqueId: 'A9999999', certificateType: 'U' },
    });
    expect(JSON.stringify(result)).not.toContain('MEDICAL-SENTINEL');
    expect(JSON.stringify(result)).not.toContain('TEST CITY SENTINEL');
    expect(JSON.stringify(result)).not.toContain('PRIVATE STREET');
  });

  it('matches exact/prefix names literally with punctuation, accents and whole BASIC variants', async () => {
    const registry = await populated();
    for (const input of [
      { lastName: " o'neil_% ", firstName: ' éva   m. ' },
      { lastName: "O'NEIL_", nameMatch: 'prefix' as const },
      { lastName: 'IDENTITY', firstName: 'OTHER', state: 'or' },
    ]) {
      const result = await registry.verifyCertificates({ mode: 'name', ...input });
      expect(result.data.matches.map((m) => m.airman.uniqueId)).toEqual(['A9999999']);
    }
    for (const input of [
      { lastName: "O'NEIL" },
      { lastName: '%', nameMatch: 'prefix' as const },
      { lastName: "O'NEIL_%", firstName: 'EVA M.' },
      { lastName: 'IDENTITY', firstName: 'ÉVA M.' },
    ]) {
      expect((await registry.verifyCertificates({ mode: 'name', ...input })).data.matches).toEqual(
        [],
      );
    }
  });

  it('requires all instructor ratings on one certificate and returns every qualifying record', async () => {
    const registry = await populated();
    const combined = await registry.searchInstructors({
      state: ' wa ',
      ratingCodes: ['asel', 'inst'],
    });
    expect(combined.data.matches.map((m) => m.airman.uniqueId)).toEqual(['C9999998']);
    expect(combined.data.matches[0]!.instructorCertificates[0]!.ratings).toHaveLength(2);
    const split = await registry.searchInstructors({ lastName: "O'NEIL_%", ratingCodes: ['ASEL'] });
    expect(split.data.matches[0]!.instructorCertificates).toHaveLength(1);
    expect(
      (await registry.searchInstructors({ state: 'WA', instructorType: 'ground' })).data.matches,
    ).toEqual([]);
    expect(JSON.stringify(combined)).not.toContain('MEDICAL-SENTINEL');
  });

  it('distinguishes missing IDs, missing medical data and missing requested certificate families', async () => {
    const registry = await populated();
    expect((await registry.getRatings({ uniqueId: 'C0000000' })).data).toEqual({ found: false });
    expect((await registry.getMedical({ uniqueId: 'C0000000' })).data).toMatchObject({
      found: false,
    });
    const absent = await registry.getMedical({ uniqueId: 'A9999997' });
    expect(absent.data).toMatchObject({
      found: true,
      medicalRecords: [],
      hasReportedMedicalFields: false,
    });
    const medical = await registry.getMedical({ uniqueId: 'A9999999' });
    expect(medical.data.medicalRecords).toHaveLength(2);
    expect(medical.data.medicalRecords).toEqual(
      expect.arrayContaining([expect.objectContaining({ medicalDateRaw: 'MEDICAL-SENTINEL' })]),
    );
    expect(medical.data.disclaimer).toContain('not authoritative evidence');
    const ratings = await registry.getRatings({ uniqueId: 'A9999999' });
    expect(ratings.data.certificates).toHaveLength(3);
    expect(JSON.stringify(ratings)).not.toContain('MEDICAL-SENTINEL');
    expect(
      (await registry.verifyRemotePilot({ mode: 'id', uniqueId: 'A9999997' })).data.matches,
    ).toEqual([]);
    const remote = await registry.verifyRemotePilot({ mode: 'id', uniqueId: 'A9999999' });
    expect(remote.data.matches[0]!.remotePilotCertificates.map((c) => c.type.code)).toEqual(['U']);
    expect(JSON.stringify(remote)).not.toContain('MEDICAL-SENTINEL');
  });

  it('pages people without truncating nested credentials and distinguishes empty from past-end', async () => {
    const registry = await populated();
    const first = await registry.verifyCertificates({
      mode: 'name',
      lastName: 'FIXTURE',
      limit: 1,
    });
    expect(first.enrichment).toMatchObject({
      totalCount: 2,
      returnedCount: 1,
      hasMore: true,
      nextOffset: 1,
    });
    const second = await registry.verifyCertificates({
      mode: 'name',
      lastName: 'FIXTURE',
      limit: 1,
      offset: 1,
    });
    expect(second.enrichment).toMatchObject({
      totalCount: 2,
      returnedCount: 1,
      hasMore: false,
      nextOffset: null,
    });
    expect(second.data.matches[0]!.certificates).toHaveLength(2);
    const past = await registry.verifyCertificates({
      mode: 'name',
      lastName: 'FIXTURE',
      offset: 2,
    });
    expect(past.enrichment).toMatchObject({ totalCount: 2, returnedCount: 0, nextOffset: null });
    expect(past.enrichment.notice).toContain('past the available results');
    const empty = await registry.verifyCertificates({ mode: 'name', lastName: 'ABSENT' });
    expect(empty.enrichment.totalCount).toBe(0);
    expect(empty.enrichment.notice).toContain('does not establish');
  });

  it('gates current location access immediately and requires rebuild for previously discarded location', async () => {
    await populated(false);
    await expect(
      service(true).verifyCertificates({
        mode: 'name',
        lastName: 'FIXTURE',
        city: 'TEST CITY SENTINEL',
      }),
    ).rejects.toMatchObject({ data: { reason: 'mirror_rebuild_required' } });
    await populated(true);
    const enabled = await service(true).verifyCertificates({
      mode: 'name',
      lastName: 'FIXTURE',
      city: 'test city sentinel',
      zipCode: '99999',
    });
    expect(enabled.data.matches).toHaveLength(2);
    expect(enabled.data.matches[0]!.airman.city).toBe('TEST CITY SENTINEL');
    expect(JSON.stringify(await service(false).getMedical({ uniqueId: 'A9999999' }))).not.toContain(
      'TEST CITY SENTINEL',
    );
    expect(() =>
      service(false).verifyCertificates({
        mode: 'name',
        lastName: 'ABSENT',
        city: 'SECRET CITY INPUT',
      }),
    ).toThrow(
      expect.objectContaining({
        data: expect.objectContaining({ reason: 'location_access_disabled' }),
      }),
    );
  });

  it('offers complete sourced static references before initialization', async () => {
    const registry = service();
    for (const [topic, total] of [
      ['certificate_types', 17],
      ['certificate_levels', 8],
      ['ratings', 55],
      ['identifiers', 1],
      ['medical_guidance', 1],
    ] as const) {
      const result = await registry.listReference({ topic, limit: 50 });
      expect(result.enrichment.totalCount).toBe(total);
      expect(result.enrichment.provenance).toBeNull();
      expect(
        result.data.entries.every((entry) =>
          entry.sourceUrls.every((url) => url.startsWith('https://')),
        ),
      ).toBe(true);
    }
    const identifiers = await registry.listReference({ topic: 'identifiers' });
    expect(identifiers.data.entries[0]!.guidance).toContain('not certificate numbers');
    expect(identifiers.data.entries[0]!.guidance).toContain('whole leading words by default');
    expect((await registry.listReference({ topic: 'mirror_status' })).data.mirrorStatus).toEqual({
      state: 'missing',
      refreshState: 'idle',
    });
    await expect(registry.listReference({ topic: 'type_ratings' })).rejects.toMatchObject({
      data: { reason: 'mirror_missing' },
    });
    await populated();
    expect((await registry.listReference({ topic: 'type_ratings' })).data.entries).toEqual([
      { code: 'TEST-99', sourceUrls: [expect.stringContaining('faa.gov')] },
    ]);
  });

  it('returns only the provenance fields that interpret or cite a result, keeping the full record in mirror_status', async () => {
    const registry = await populated();
    const status = await registry.listReference({ topic: 'mirror_status' });
    const slim = {
      sourceName: 'FAA Releasable Airmen Database',
      snapshotMonth: '2026-10',
      ageDays: 19,
      ageBasis: 'snapshot_month_start',
      stale: false,
      staleAfterDays: 45,
      generationId: expect.stringMatching(/^generation-[0-9a-f-]{36}$/),
      includeLocation: false,
    };
    const results = [
      status,
      await registry.verifyCertificates({ mode: 'id', uniqueId: 'A9999999' }),
      await registry.verifyCertificates({ mode: 'name', lastName: 'absent' }),
      await registry.verifyRemotePilot({ mode: 'id', uniqueId: 'A9999999' }),
      await registry.searchInstructors({ state: 'WA' }),
      await registry.getRatings({ uniqueId: 'A9999999' }),
      await registry.getRatings({ uniqueId: 'C0000000' }),
      await registry.getMedical({ uniqueId: 'A9999999' }),
      await registry.listReference({ topic: 'type_ratings' }),
    ];
    for (const result of results) {
      expect(result.enrichment.provenance).toEqual(slim);
      expect(Object.keys(result.enrichment.provenance ?? {})).toEqual(Object.keys(slim));
    }
    expect(status.data.mirrorStatus?.provenance).toEqual({
      ...slim,
      sourcePageUrl:
        'https://www.faa.gov/licenses_certificates/airmen_certification/releasable_airmen_download',
      archiveUrl: 'https://registry.faa.gov/CS102026.zip',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      downloadedAt: '2026-10-20T00:00:00.000Z',
      importedAt: '2026-10-20T00:00:00.000Z',
      schemaVersion: expect.any(Number),
      referenceVersion: 1,
      complete: true,
      fileCounts: expect.any(Object),
      counts: expect.objectContaining({ airmen: 3 }),
      warnings: expect.any(Object),
    });
  });

  const imported = Date.parse('2026-10-20T00:00:00Z');
  const day = 86_400_000;
  const olderGeneration = 'this result uses the last complete published generation.';
  it('keeps serving after a failed refresh that started after the served generation, and says so', async () => {
    const registry = await populated();
    await expect(
      serviceAt(directory, {
        bytes: zipSource(sourceFiles(), true),
        clock: () => new Date(imported + day),
      }).mirror.refresh(),
    ).rejects.toMatchObject({ stage: 'validation' });
    expect(
      (await registry.listReference({ topic: 'mirror_status' })).data.mirrorStatus,
    ).toMatchObject({ state: 'ready', refreshState: 'failed', lastRefreshFailure: 'validation' });
    const lookup = await registry.verifyCertificates({ mode: 'id', uniqueId: 'A9999999' });
    expect(lookup.data.matches).toHaveLength(1);
    expect(lookup.enrichment.notice).toContain(`The latest refresh failed; ${olderGeneration}`);
    expect(lookup.enrichment.notice).not.toContain('published this snapshot');
  });

  it('says an interrupted refresh that started after the served generation left that generation serving', async () => {
    await populated();
    const started = imported + 2 * day;
    await writeFile(
      join(directory, 'REFRESH.json'),
      JSON.stringify({ status: 'in_progress', startedAt: new Date(started).toISOString() }),
    );
    const interrupted = await serviceAt(directory, {
      clock: () => new Date(started + REFRESH_DEADLINE_MS + 1000),
    }).verifyCertificates({ mode: 'id', uniqueId: 'A9999999' });
    expect(interrupted.data.matches).toHaveLength(1);
    expect(interrupted.enrichment.notice).toContain(
      `The latest refresh was interrupted before it recorded a result; ${olderGeneration}`,
    );
    expect(interrupted.enrichment.notice).not.toContain('published this snapshot');
  });

  it('says the latest refresh published the served snapshot when a storage step after publishing failed', async () => {
    let tick = 0;
    const clock = () => new Date(imported + 1000 * tick++);
    const inner = sourceFetch(zipSource());
    // Without read permission, opening the directory to fsync it fails; creates and renames do not.
    const archiveUnreadable = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.endsWith('releasable_airmen_download')) await chmod(directory, 0o300);
      return inner(input, init);
    }) as typeof fetch;
    const registry = serviceAt(directory, { fetch: archiveUnreadable, clock });
    try {
      await expect(registry.initialize()).rejects.toMatchObject({
        stage: 'disk',
        message: expect.stringContaining('published a new snapshot, which readers now serve'),
      });
    } finally {
      await chmod(directory, 0o700);
    }
    expect(
      (await registry.listReference({ topic: 'mirror_status' })).data.mirrorStatus,
    ).toMatchObject({ state: 'ready', refreshState: 'failed', lastRefreshFailure: 'disk' });
    const lookup = await registry.verifyCertificates({ mode: 'id', uniqueId: 'A9999999' });
    expect(lookup.data.matches).toHaveLength(1);
    expect(lookup.enrichment.notice).toContain(
      'The latest refresh published this snapshot, then failed a later storage step.',
    );
    expect(lookup.enrichment.notice).not.toContain(olderGeneration);
  });

  it('reports a cancelled refresh as cancelled rather than failed', async () => {
    const registry = await populated();
    await expect(registry.mirror.refresh(AbortSignal.abort())).rejects.toMatchObject({
      stage: 'cancelled',
    });
    expect(
      (await registry.listReference({ topic: 'mirror_status' })).data.mirrorStatus,
    ).toMatchObject({ state: 'ready', refreshState: 'failed', lastRefreshFailure: 'cancelled' });
    const lookup = await registry.verifyCertificates({ mode: 'id', uniqueId: 'A9999999' });
    expect(lookup.data.matches).toHaveLength(1);
    expect(lookup.enrichment.notice).toContain(
      'The latest refresh was cancelled before it finished; this result uses the last complete published generation.',
    );
    expect(lookup.enrichment.notice).not.toContain('refresh failed');
  });

  it.each([
    [REFRESH_DEADLINE_MS + 1000, 'failed'],
    [REFRESH_DEADLINE_MS - 1000, 'running'],
  ] as const)(
    'maps an in-progress record %i ms old to refreshState %s and leaves the lock and record alone',
    async (age, refreshState) => {
      const registry = await populated();
      const record = JSON.stringify({
        status: 'in_progress',
        startedAt: new Date(Date.parse('2026-10-20T00:00:00Z') - age).toISOString(),
      });
      await writeFile(join(directory, 'REFRESH.json'), record);
      await writeFile(join(directory, 'WRITER.lock'), 'synthetic-dead-owner');
      const status = (await registry.listReference({ topic: 'mirror_status' })).data.mirrorStatus;
      expect(status).toMatchObject({ state: 'ready', refreshState });
      if (refreshState === 'failed') expect(status?.lastRefreshFailure).toBe('interrupted');
      else expect(status).not.toHaveProperty('lastRefreshFailure');
      const lookup = await registry.verifyCertificates({ mode: 'id', uniqueId: 'A9999999' });
      expect(lookup.data.matches).toHaveLength(1);
      // The record started before the served generation was imported, so that run published it.
      if (refreshState === 'failed') {
        expect(lookup.enrichment.notice).toContain(
          'The latest refresh published this snapshot, then was interrupted before it recorded a result.',
        );
        expect(lookup.enrichment.notice).not.toContain('last complete published generation');
      } else expect(lookup.enrichment.notice).not.toContain('latest refresh');
      expect(await readFile(join(directory, 'REFRESH.json'), 'utf8')).toBe(record);
      expect(await readFile(join(directory, 'WRITER.lock'), 'utf8')).toBe('synthetic-dead-owner');
    },
  );

  it('serves lookups over an unreadable refresh record with the notice a missing record gets, leaving it and WRITER.lock alone', async () => {
    const registry = await populated();
    await rm(join(directory, 'REFRESH.json'));
    const baseline = await registry.verifyCertificates({ mode: 'id', uniqueId: 'A9999999' });
    await writeFile(join(directory, 'REFRESH.json'), '{');
    await writeFile(join(directory, 'WRITER.lock'), 'synthetic-dead-owner');
    const lookup = await registry.verifyCertificates({ mode: 'id', uniqueId: 'A9999999' });
    expect(lookup.data.matches).toHaveLength(1);
    expect(lookup.enrichment.notice).toBe(baseline.enrichment.notice);
    expect(await registry.mirror.verifyMirror()).toMatchObject({ ok: true });
    expect(await readFile(join(directory, 'REFRESH.json'), 'utf8')).toBe('{');
    expect(await readFile(join(directory, 'WRITER.lock'), 'utf8')).toBe('synthetic-dead-owner');
  });

  const unreadableGuidance =
    'Refresh record: REFRESH.json in the mirror directory is unreadable; it records only the last refresh outcome, so the operator can remove it, and the next refresh rewrites it.';
  it('reports a serving mirror as ready with an unreadable refresh record, naming REFRESH.json and its removal', async () => {
    const registry = await populated();
    const generationId = (await registry.mirror.status()).provenance?.generationId;
    await writeFile(join(directory, 'REFRESH.json'), '{');
    const reference = await registry.listReference({ topic: 'mirror_status' });
    expect(reference.data.mirrorStatus).toEqual({
      state: 'ready',
      refreshState: 'unreadable',
      provenance: expect.objectContaining({ generationId }),
    });
    expect(reference.data.entries[0]!.guidance).toBe(
      `Mirror state: ready. ${unreadableGuidance} Initialize with faa-airmen-registry-mirror init; refresh with faa-airmen-registry-mirror refresh. Location import policy: disabled. Personal-data redaction: off.`,
    );
    expect(reference.enrichment.provenance).toMatchObject({ generationId });
    expect(await readFile(join(directory, 'REFRESH.json'), 'utf8')).toBe('{');
  });

  it('reports missing with the unreadable refresh record when no generation is published', async () => {
    const registry = service();
    await writeFile(join(directory, 'REFRESH.json'), '{');
    const reference = await registry.listReference({ topic: 'mirror_status' });
    expect(reference.data.mirrorStatus).toEqual({ state: 'missing', refreshState: 'unreadable' });
    expect(reference.data.entries[0]!.guidance).toContain(unreadableGuidance);
    await rm(join(directory, 'REFRESH.json'));
    const absent = await registry.listReference({ topic: 'mirror_status' });
    expect(absent.data.mirrorStatus).toEqual({ state: 'missing', refreshState: 'idle' });
    expect(absent.data.entries[0]!.guidance).not.toContain('REFRESH.json');
  });

  it('returns classified errors without echoing personal input or local paths', async () => {
    const registry = service();
    const cases: [() => unknown, string][] = [
      [() => registry.verifyCertificates({ mode: 'name', lastName: ' ' }), 'invalid_identity'],
      [
        () =>
          registry.verifyCertificates({
            mode: 'id',
            uniqueId: 'A9999999',
            lastName: 'PRIVATE INPUT',
          }),
        'invalid_identity',
      ],
      [
        () =>
          registry.verifyCertificates({ mode: 'name', lastName: 'PRIVATE INPUT', state: 'BAD' }),
        'invalid_filter',
      ],
      [() => registry.searchInstructors({ firstName: ' ' }), 'missing_search_filter'],
      [() => registry.getMedical({ uniqueId: 'PRIVATE INPUT' }), 'invalid_identity'],
      [
        () => registry.listReference({ topic: 'identifiers', filter: 'PRIVATE INPUT' }),
        'invalid_filter',
      ],
    ];
    for (const [run, reason] of cases) {
      const error = await Promise.resolve()
        .then(run)
        .catch((error) => error);
      expect(error).toMatchObject({ data: { reason } });
      expect(JSON.stringify(error)).not.toContain('PRIVATE INPUT');
      expect(JSON.stringify(error)).not.toContain(directory);
    }
    // A limit above 50 and a repeated rating code pass validation and reach the (missing) mirror.
    await expect(
      registry.verifyCertificates({ mode: 'name', lastName: 'PRIVATE INPUT', limit: 51 }),
    ).rejects.toMatchObject({ data: { reason: 'mirror_missing' } });
    await expect(
      registry.searchInstructors({ state: 'WA', ratingCodes: ['ASEL', 'asel'] }),
    ).rejects.toMatchObject({ data: { reason: 'mirror_missing' } });
    await expect(registry.getRatings({ uniqueId: 'A9999999' })).rejects.toMatchObject({
      data: { reason: 'mirror_missing', retryable: false },
    });
    await writeFile(join(directory, 'CURRENT'), '{}');
    await expect(registry.getRatings({ uniqueId: 'A9999999' })).rejects.toMatchObject({
      data: { reason: 'mirror_unavailable', retryable: true },
    });
  });

  it('reports the offset cap using actual remaining people', async () => {
    const ids = Array.from({ length: 10003 }, (_, index) => `A${String(index).padStart(7, '0')}`);
    // The two people at offsets 10000 and 10001 each fit the size budget alone, but not together.
    const long = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [index + 18, `P/SYNTH-${index}-${'X'.repeat(40)}`]),
    );
    const bytes = zipSource(
      sourceFiles({
        pilotBasic: ids.map((id) => basicRow(id)),
        pilotCert: ids.map((id, index) =>
          certificateRow(id, true, {
            17: 'P/SYNTH-1',
            ...(index >= 10000 && index < 10002 && long),
          }),
        ),
      }),
    );
    const registry = service(false, bytes);
    await registry.initialize();
    const result = await registry.verifyCertificates({
      mode: 'name',
      lastName: 'FIXTURE',
      offset: 10000,
      limit: 1,
    });
    const credentialed = await registry.verifyCertificates({
      mode: 'name',
      lastName: 'FIXTURE',
      certificateType: 'P',
      certificateLevel: 'P',
      typeRatings: ['P/SYNTH-1'],
      offset: 10000,
      limit: 1,
    });
    expect(credentialed.enrichment).toMatchObject({
      totalCount: 10003,
      returnedCount: 1,
      hasMore: false,
      nextOffset: null,
      atPagingCap: true,
      appliedFilters: { certificateLevel: 'P', typeRatings: ['P/SYNTH-1'] },
    });
    const capped = `${limits} ${locationOff} Narrow the filters to reach remaining results within the offset cap.`;
    expect(credentialed.enrichment.notice).toBe(capped);
    expect(result.enrichment).toMatchObject({
      totalCount: 10004,
      returnedCount: 1,
      hasMore: false,
      nextOffset: null,
      atPagingCap: true,
      appliedFilters: { nameMatch: 'words' },
    });
    expect(result.enrichment.notice).toBe(capped);
    // A page the budget cut at the cap carries the cap sentence alone: no page follows to continue.
    const cutAtCap = await registry.verifyCertificates({
      mode: 'name',
      lastName: 'FIXTURE',
      offset: 10000,
      limit: 2,
    });
    expect(cutAtCap.enrichment).toMatchObject({
      returnedCount: 1,
      hasMore: false,
      nextOffset: null,
      atPagingCap: true,
    });
    expect(cutAtCap.enrichment.notice).toBe(capped);
  });

  it('returns complete oversized people and advances continuations by the actual returned count', async () => {
    const ids = ['A9999991', 'A9999992', 'A9999993'];
    const longRatings = Object.fromEntries(
      Array.from({ length: 99 }, (_, index) => [
        index + 17,
        `P/SYNTHETIC-${index}-${'X'.repeat(120)}`,
      ]),
    );
    const bytes = zipSource(
      sourceFiles({
        pilotBasic: ids.map((id) => basicRow(id)),
        // Only people the byte budget trims from the first page carry an undocumented rating.
        pilotCert: ids.map((id, index) =>
          certificateRow(id, true, { ...longRatings, ...(index > 0 && { 6: 'P/XYZ' }) }),
        ),
      }),
    );
    const registry = service(false, bytes);
    await registry.initialize();
    const first = await registry.verifyCertificates({
      mode: 'name',
      lastName: 'FIXTURE',
      limit: 50,
    });
    expect(first.data.matches).toHaveLength(1);
    expect(first.enrichment.notice).not.toContain('raw values are retained');
    expect(first.data.matches[0]!.certificates[0]!.typeRatings).toHaveLength(99);
    expect(first.enrichment).toMatchObject({
      totalCount: 4,
      returnedCount: 1,
      hasMore: true,
      nextOffset: 1,
    });
    expect(first.enrichment.notice).toContain('all source credentials are retained');
    // The budget cut the page to one oversized record: both sentences, the cut first.
    const oversized =
      'One complete record exceeds the response byte budget; all source credentials are retained.';
    expect(first.enrichment.notice).toBe(
      `${limits} ${locationOff} ${budgetCut(50, 1)} ${oversized}`,
    );
    // A limit of 1 returns a full page: the record is oversized, but nothing was cut.
    const single = await registry.verifyCertificates({
      mode: 'name',
      lastName: 'FIXTURE',
      limit: 1,
    });
    expect(personIds(single)).toEqual(personIds(first));
    expect(single.enrichment).toMatchObject({ returnedCount: 1, hasMore: true, nextOffset: 1 });
    expect(single.enrichment.notice).toBe(`${limits} ${locationOff} ${oversized}`);
    const next = await registry.verifyCertificates({
      mode: 'name',
      lastName: 'FIXTURE',
      limit: 50,
      offset: first.enrichment.nextOffset!,
    });
    expect(next.data.matches[0]!.airman.uniqueId).not.toBe(first.data.matches[0]!.airman.uniqueId);
    expect(next.enrichment.nextOffset).toBe(2);
    expect(next.enrichment.notice).toContain('undocumented code');
  });

  it('distinguishes nonpilot-only people and preserves unknown codes without invented descriptions', async () => {
    const bytes = zipSource(
      sourceFiles({
        nonpilotBasic: [basicRow('C9999998')],
        nonpilotCert: [certificateRow('C9999998', false, { 3: 'Z', 4: 'Q', 6: 'Q/UNKNOWN' })],
      }),
    );
    const registry = service(false, bytes);
    await registry.initialize();
    const ratings = await registry.getRatings({ uniqueId: 'C9999998' });
    expect(ratings.data).toMatchObject({ found: true, certificates: [] });
    expect(ratings.enrichment.notice).toContain(
      'No pilot-family certificate was reported; faa_airmen_verify_certificate mode id returns every certificate, non-pilot ones included.',
    );
    const result = await registry.verifyCertificates({
      mode: 'id',
      uniqueId: 'C9999998',
      certificateType: 'Z',
    });
    expect(result.data.matches[0]!.certificates[0]).toMatchObject({
      type: { code: 'Z' },
      level: { code: 'Q' },
      ratings: [{ code: 'UNKNOWN', raw: 'Q/UNKNOWN', ordinal: 1, levelCode: 'Q' }],
    });
    expect(result.data.matches[0]!.certificates[0]!.type).not.toHaveProperty('description');
  });

  it.each(['99999-1234', '999991234'])(
    'matches source ZIP %s with either accepted input spelling',
    async (sourceZip) => {
      const registry = service(
        true,
        zipSource(
          sourceFiles({
            pilotBasic: [basicRow(undefined, { 7: sourceZip })],
            nonpilotBasic: [basicRow(undefined, { 7: sourceZip })],
          }),
        ),
      );
      await registry.initialize();
      const result = await registry.verifyCertificates({
        mode: 'name',
        lastName: 'FIXTURE',
        firstName: ' ',
        state: '',
        zipCode: '999991234',
        certificateType: ' ',
      });
      expect(result.data.matches).toHaveLength(1);
      expect(result.data.matches[0]!.airman.zipCode).toBe(sourceZip);
      expect(
        (
          await registry.verifyCertificates({
            mode: 'name',
            lastName: 'FIXTURE',
            zipCode: '99999-1234',
          })
        ).data.matches,
      ).toHaveLength(1);
      expect(result.enrichment.appliedFilters).toEqual({
        mode: 'name',
        lastName: 'FIXTURE',
        zipCode: '99999-1234',
        nameMatch: 'words',
        limit: 10,
        offset: 0,
      });
      expect(
        (await registry.listReference({ topic: 'ratings', filter: ' no such code ' })).enrichment,
      ).toMatchObject({ totalCount: 0, returnedCount: 0, hasMore: false, nextOffset: null });
    },
  );
});

describe('per-result source-quality notice', () => {
  const sentence =
    'A returned record contains an undocumented code or a malformed source date or rating; raw values are retained.';
  const last = 'QUALITY';
  const medical = { 10: '3', 11: '102026', 12: '102028', 13: '20260115', 14: '20260110' };
  /** One synthetic person per trigger or negative; index 3 is the type, 4 the level, 5 the expiry. */
  const mirror = sharedMirror(
    zipSource(
      sourceFiles({
        pilotBasic: [
          person('A9999101', 'TYPE', last),
          person('A9999102', 'LEVEL', last),
          person('A9999103', 'RATING', last),
          person('A9999104', 'EXPIRY', last),
          person('A9999105', 'SLASH', last),
          person('A9999106', 'NOSLASH', last),
          person('A9999107', 'EMPTYCODE', last),
          person('A9999108', 'TYPESLASH', last),
          person('A9999109', 'TYPEEMPTY', last),
          person('A9999110', 'LATER', last),
          person('A9999111', 'CLEAN', last),
          person('A9999112', 'DESIGNATOR', last),
          person('A9999116', 'SPLIT', last),
          person('A9999117', 'INSTRUCTOR', last),
          person('A9999118', 'MEDICAL', last, medical),
          person('A9999119', 'CLASS', last, { ...medical, 10: '8' }),
          person('A9999120', 'MEDDATE', last, { ...medical, 11: '2026-10' }),
          person('A9999121', 'MEDEXPIRY', last, { ...medical, 12: '132026' }),
          person('A9999122', 'COURSE', last, { ...medical, 13: '01152026' }),
          person('A9999123', 'CMEC', last, medical),
        ],
        nonpilotBasic: [
          person('A9999113', 'BLANK', last),
          person('A9999114', 'SUAS', last),
          person('A9999115', 'REMOTE', last),
          person('A9999123', 'CMEC', last, { ...medical, 14: '2026011' }),
        ],
        pilotCert: [
          cert('A9999101', 'TYPE', last, true, { 3: 'Z' }),
          cert('A9999102', 'LEVEL', last, true, { 4: 'Q' }),
          cert('A9999103', 'RATING', last, true, { 6: 'P/ASEL', 7: 'P/XYZ' }),
          cert('A9999104', 'EXPIRY', last, true, { 5: '13012026' }),
          cert('A9999105', 'SLASH', last, true, { 6: 'PP/ASEL' }),
          cert('A9999106', 'NOSLASH', last, true, { 6: 'ASEL' }),
          cert('A9999107', 'EMPTYCODE', last, true, { 6: 'P/' }),
          cert('A9999108', 'TYPESLASH', last, true, { 17: 'B-737' }),
          cert('A9999109', 'TYPEEMPTY', last, true, { 17: 'P/' }),
          // F sorts before P, so the issue sits on the later certificate, past its first rating.
          cert('A9999110', 'LATER', last, true, { 3: 'F', 4: '', 6: 'F/ASEL' }),
          cert('A9999110', 'LATER', last, true, { 6: 'P/ASEL', 7: 'P/ASEL', 8: 'P/XYZ' }),
          cert('A9999111', 'CLEAN', last, true, {
            5: '01312026',
            6: 'P/ASEL',
            7: 'Q/ASEL',
            17: 'P/B-737',
          }),
          cert('A9999112', 'DESIGNATOR', last, true, { 115: 'X/ZZ-9' }),
          cert('A9999116', 'SPLIT', last, true, { 4: 'Q' }),
          cert('A9999116', 'SPLIT', last, true, { 3: 'F', 4: '', 6: 'F/INSTA' }),
          cert('A9999117', 'INSTRUCTOR', last, true, { 3: 'F', 4: '', 6: 'F/XYZ' }),
          // Every imported person holds a certificate; the medical cases hold a documented one.
          cert('A9999118', 'MEDICAL', last, true),
          cert('A9999119', 'CLASS', last, true),
          cert('A9999120', 'MEDDATE', last, true),
          cert('A9999121', 'MEDEXPIRY', last, true),
          cert('A9999122', 'COURSE', last, true),
          cert('A9999123', 'CMEC', last, true),
        ],
        nonpilotCert: [
          cert('A9999113', 'BLANK', last, false, { 3: 'U', 4: '' }),
          cert('A9999114', 'SUAS', last, false, { 3: 'U', 4: '', 6: 'U/SUAS' }),
          cert('A9999115', 'REMOTE', last, false, { 3: 'U', 4: '', 6: 'U/XYZ' }),
        ],
      }),
    ),
    false,
  );
  type Read = (service: AirmenRegistryService) => Promise<{ enrichment: { notice: string } }>;
  const byId =
    (uniqueId: string): Read =>
    (s) =>
      s.verifyCertificates({ mode: 'id', uniqueId });
  const medicalOf =
    (uniqueId: string): Read =>
    (s) =>
      s.getMedical({ uniqueId });

  it.each<[string, Read, string, boolean]>([
    ['verify flags an undocumented certificate type', byId('A9999101'), 'A9999101', true],
    ['verify flags an undocumented certificate level', byId('A9999102'), 'A9999102', true],
    ['verify flags an undocumented rating', byId('A9999103'), 'A9999103', true],
    ['verify flags a malformed legacy expiry date', byId('A9999104'), 'A9999104', true],
    ['verify flags a rating whose slash is not at index 1', byId('A9999105'), 'A9999105', true],
    ['verify flags a rating without a slash', byId('A9999106'), 'A9999106', true],
    ['verify flags a rating with an empty code', byId('A9999107'), 'A9999107', true],
    ['verify flags a type rating without a slash', byId('A9999108'), 'A9999108', true],
    ['verify flags a type rating with an empty code', byId('A9999109'), 'A9999109', true],
    [
      'verify flags an undocumented rating on a later certificate past its first rating',
      byId('A9999110'),
      'A9999110',
      true,
    ],
    [
      'verify passes documented codes, a well-formed date, and an undescribed rating level code',
      byId('A9999111'),
      'A9999111',
      false,
    ],
    [
      'verify passes an undescribed type-rating designator and level',
      byId('A9999112'),
      'A9999112',
      false,
    ],
    ['verify passes blank optional certificate fields', byId('A9999113'), 'A9999113', false],
    [
      'get_type_ratings flags an undocumented level on a pilot-family certificate',
      (s) => s.getRatings({ uniqueId: 'A9999116' }),
      'A9999116',
      true,
    ],
    [
      'verify_remote_pilot passes the documented small UAS rating',
      (s) => s.verifyRemotePilot({ mode: 'id', uniqueId: 'A9999114' }),
      'A9999114',
      false,
    ],
    [
      'verify_remote_pilot flags an undocumented remote pilot rating',
      (s) => s.verifyRemotePilot({ mode: 'id', uniqueId: 'A9999115' }),
      'A9999115',
      true,
    ],
    [
      'search_instructors flags an undocumented instructor rating',
      (s) => s.searchInstructors({ lastName: 'quality', firstName: 'instructor' }),
      'A9999117',
      true,
    ],
    [
      'search_instructors passes a clean instructor certificate beside a flawed one it does not return',
      (s) => s.searchInstructors({ lastName: 'quality', firstName: 'split' }),
      'A9999116',
      false,
    ],
    [
      'check_medical_status passes documented medical fields',
      medicalOf('A9999118'),
      'A9999118',
      false,
    ],
    [
      'check_medical_status flags an undocumented medical class',
      medicalOf('A9999119'),
      'A9999119',
      true,
    ],
    [
      'check_medical_status flags a malformed medical date',
      medicalOf('A9999120'),
      'A9999120',
      true,
    ],
    [
      'check_medical_status flags a malformed medical expiry date',
      medicalOf('A9999121'),
      'A9999121',
      true,
    ],
    [
      'check_medical_status flags a malformed BasicMed course date',
      medicalOf('A9999122'),
      'A9999122',
      true,
    ],
    [
      'check_medical_status flags a malformed BasicMed CMEC date on a later record',
      medicalOf('A9999123'),
      'A9999123',
      true,
    ],
  ])('%s', async (_case, read, uniqueId, flagged) => {
    const result = await read(serviceAt(mirror.directory));
    expect(JSON.stringify(result)).toContain(`"uniqueId":"${uniqueId}"`);
    expect(result.enrichment.notice).toBe(
      [limits, locationOff, ...(flagged ? [sentence] : [])].join(' '),
    );
  });

  it('never adds it to a reference topic or a result that returns no record', async () => {
    const service = serviceAt(mirror.directory);
    const empty = [
      await service.verifyCertificates({ mode: 'name', lastName: 'absent' }),
      await service.verifyCertificates({ mode: 'id', uniqueId: 'A9999101', certificateType: 'P' }),
      await service.verifyCertificates({ mode: 'name', lastName: 'quality', offset: 100 }),
    ];
    for (const result of empty) {
      expect(result.enrichment.returnedCount).toBe(0);
      expect(result.enrichment.notice).not.toContain(sentence);
    }
    for (const result of [
      await service.getRatings({ uniqueId: 'A9999190' }),
      await service.getMedical({ uniqueId: 'A9999190' }),
    ]) {
      expect(result.data.found).toBe(false);
      expect(result.enrichment.notice).not.toContain(sentence);
    }
    for (const topic of ['mirror_status', 'type_ratings', 'ratings'] as const)
      expect((await service.listReference({ topic })).enrichment.notice).not.toContain(sentence);
  });
});

describe('zero-result notice routing by the filters sent', () => {
  // Location is imported and served, so a notice is the limits sentence, then the route.
  const mirror = sharedMirror(credentialedSource(), true);
  const idAbsent =
    'No person has this Unique ID in this snapshot; check its format with faa_airmen_list_reference topic identifiers, or rediscover it with faa_airmen_verify_certificate mode name.';
  const idHolds = (wanted: string, without: string) =>
    `This Unique ID holds no ${wanted}; retry faa_airmen_verify_certificate in ID mode without ${without} to read the person's other certificates.`;
  const every = 'single certificate carrying every requested credential';
  const counted = (people: string, without: string, wanted: string) =>
    `${people} this name search without ${without}, and none holds a ${wanted} in this snapshot.`;
  type Search = (service: AirmenRegistryService) => Promise<{
    enrichment: { notice: string; totalCount: number; returnedCount: number };
  }>;
  const name = { mode: 'name', lastName: 'credential' } as const;

  it.each<[string, Search, string[]]>([
    [
      'verify ID mode, ID absent',
      (s) => s.verifyCertificates({ mode: 'id', uniqueId: 'A9999990' }),
      [idAbsent],
    ],
    [
      'verify ID mode, ID absent with certificateType',
      (s) => s.verifyCertificates({ mode: 'id', uniqueId: 'A9999990', certificateType: 'P' }),
      [idAbsent],
    ],
    [
      'verify ID mode, ID present, type missing',
      (s) => s.verifyCertificates({ mode: 'id', uniqueId: 'A9999004', certificateType: 'P' }),
      [idHolds('certificate matching the requested certificate type', 'certificateType')],
    ],
    [
      'verify ID mode, ID present, type and level missing from one certificate',
      (s) =>
        s.verifyCertificates({
          mode: 'id',
          uniqueId: 'A9999003',
          certificateType: 'P',
          certificateLevel: 'S',
        }),
      [idHolds(every, 'certificateType or certificateLevel'), levelRoute],
    ],
    [
      'verify ID mode, ID present, type and a rating code missing from one certificate',
      (s) =>
        s.verifyCertificates({
          mode: 'id',
          uniqueId: 'A9999001',
          certificateType: 'P',
          ratingCodes: ['ZZ-9'],
        }),
      [idHolds(every, 'certificateType or ratingCodes'), ratingsRoute],
    ],
    [
      'verify ID mode, ID present, two type ratings missing from one certificate',
      (s) =>
        s.verifyCertificates({ mode: 'id', uniqueId: 'A9999001', typeRatings: ['ZZ-9', 'ZZ-8'] }),
      [idHolds('certificate matching the requested type ratings', 'typeRatings'), typeRatingsRule],
    ],
    [
      'verify ID mode, ID present, a rating code and a type rating missing from one certificate',
      (s) =>
        s.verifyCertificates({
          mode: 'id',
          uniqueId: 'A9999001',
          ratingCodes: ['ZZ-9'],
          typeRatings: ['ZZ-8'],
        }),
      [idHolds(every, 'ratingCodes or typeRatings'), bothRule],
    ],
    [
      'remote pilot ID mode, ID absent',
      (s) => s.verifyRemotePilot({ mode: 'id', uniqueId: 'A9999990' }),
      [idAbsent],
    ],
    [
      'remote pilot ID mode, ID present, U missing',
      (s) => s.verifyRemotePilot({ mode: 'id', uniqueId: 'A9999001' }),
      [
        "This Unique ID holds no remote pilot (U) certificate; use faa_airmen_verify_certificate in ID mode to read the person's other certificates.",
      ],
    ],
    [
      'verify name mode, lastName only',
      (s) => s.verifyCertificates({ mode: 'name', lastName: 'absent' }),
      [identifiersRoute],
    ],
    [
      'verify name mode with an optional filter',
      (s) => s.verifyCertificates({ mode: 'name', lastName: 'absent', state: 'WA' }),
      [fewer],
    ],
    [
      'remote pilot by name',
      (s) => s.verifyRemotePilot({ ...name, firstName: 'alpha' }),
      [remoteByName, fewer],
    ],
    [
      'verify name mode with every credential filter, rating codes and type ratings, and its name-only count',
      (s) =>
        s.verifyCertificates({
          ...name,
          certificateType: 'P',
          certificateLevel: 'A',
          ratingCodes: ['INSTA'],
          typeRatings: ['B-737'],
        }),
      [
        counted(
          '7 people match',
          'certificateType, certificateLevel, ratingCodes or typeRatings',
          every,
        ),
        levelRoute,
        bothRule,
        /**
         * INSTA is a CFII code, so the alternatives follow the shared ratings sentence; the call
         * sent type P, so each retry must switch to F.
         */
        alternativesOnF,
      ],
    ],
    [
      'verify name mode with type, level and a type rating, and its name-only count',
      (s) =>
        s.verifyCertificates({
          ...name,
          certificateType: 'P',
          certificateLevel: 'A',
          typeRatings: ['ZZ-9'],
        }),
      [
        counted('7 people match', 'certificateType, certificateLevel or typeRatings', every),
        levelRoute,
        typeRatingsRoute,
      ],
    ],
    [
      'verify name mode with certificateType and a name-only count',
      (s) => s.verifyCertificates({ ...name, certificateType: 'G' }),
      [
        counted(
          '7 people match',
          'certificateType',
          'certificate matching the requested certificate type',
        ),
      ],
    ],
    [
      'verify name mode with one rating code matching one person by name',
      (s) => s.verifyCertificates({ ...name, firstName: 'alpha', ratingCodes: ['ZZ-9'] }),
      [
        counted(
          '1 person matches',
          'ratingCodes',
          'certificate matching the requested rating codes',
        ),
        ratingsRoute,
      ],
    ],
    ...(
      [
        ['one type rating', ['A/B-737'], typeRatingsRoute],
        ['one type rating in two spellings, collapsed', ['A/B-737', ' a/b-737 '], typeRatingsRoute],
        ['two type ratings', ['A/B-737', 'ZZ-9'], typeRatingsRule],
      ] as const
    ).map(([label, typeRatings, route]): [string, Search, string[]] => [
      `verify name mode with ${label}, matching one person by name`,
      (s) => s.verifyCertificates({ ...name, firstName: 'charlie', typeRatings: [...typeRatings] }),
      [
        counted(
          '1 person matches',
          'typeRatings',
          'certificate matching the requested type ratings',
        ),
        route,
      ],
    ]),
    [
      'verify name mode whose name matches nobody even without its type ratings',
      (s) => s.verifyCertificates({ ...name, state: 'OR', typeRatings: ['B-737'] }),
      ['No person matches this name search even without typeRatings.', fewer],
    ],
    [
      'verify name mode whose name matches nobody even without its credential filters',
      (s) =>
        s.verifyCertificates({
          ...name,
          state: 'OR',
          ratingCodes: ['ZZ-9'],
          typeRatings: ['ZZ-8'],
        }),
      ['No person matches this name search even without ratingCodes or typeRatings.', fewer],
    ],
    [
      'verify name mode with a CFII code, naming the alternatives on F after the ratings route',
      (s) => s.verifyCertificates({ ...name, firstName: 'alpha', ratingCodes: ['INSTP'] }),
      [
        counted(
          '1 person matches',
          'ratingCodes',
          'certificate matching the requested rating codes',
        ),
        ratingsRoute,
        alternativesOnF,
      ],
    ],
    [
      'verify ID mode with the shorthand cfii, naming the alternatives on F',
      (s) => s.verifyCertificates({ mode: 'id', uniqueId: 'A9999001', ratingCodes: ['cfii'] }),
      [
        idHolds('certificate matching the requested rating codes', 'ratingCodes'),
        ratingsRoute,
        alternativesOnF,
      ],
    ],
    [
      'verify ID mode with a level-qualified CFII code, still naming certificateType F for the bare alternatives',
      (s) => s.verifyCertificates({ mode: 'id', uniqueId: 'A9999001', ratingCodes: ['F/INSTH'] }),
      [
        idHolds('certificate matching the requested rating codes', 'ratingCodes'),
        ratingsRoute,
        alternativesOnF,
      ],
    ],
    [
      'verify ID mode already confined to F by certificateType CFI, naming the alternatives alone',
      (s) =>
        s.verifyCertificates({
          mode: 'id',
          uniqueId: 'A9999001',
          certificateType: 'cfi',
          ratingCodes: ['INSTH'],
        }),
      [idHolds(every, 'certificateType or ratingCodes'), ratingsRoute, alternatives],
    ],
    [
      'verify ID mode with ASE, which names neither alternative',
      (s) => s.verifyCertificates({ mode: 'id', uniqueId: 'A9999001', ratingCodes: ['ASE'] }),
      [idHolds('certificate matching the requested rating codes', 'ratingCodes'), ratingsRoute],
    ],
    // An instructor search with a name or location filter counts the instructors it matches without its codes.
    [
      'instructors by state and ratingCodes',
      (s) => s.searchInstructors({ state: 'WA', ratingCodes: ['ZZ-9'] }),
      [
        instructorsCounted(
          '2 flight or ground instructors match',
          'flight or ground instructor',
          'the requested code',
        ),
        ratingsRoute,
      ],
    ],
    [
      'instructors by ratingCodes alone, never counted',
      (s) => s.searchInstructors({ ratingCodes: ['ZZ-9'] }),
      [ratingsRoute],
    ],
    [
      'instructors by a level-qualified MEI code alone, naming the alternatives',
      (s) => s.searchInstructors({ ratingCodes: ['f/asme'] }),
      [ratingsRoute, alternatives],
    ],
    [
      'ground instructors by a CFII code alone, naming the alternatives with a flight instructorType',
      (s) => s.searchInstructors({ instructorType: 'ground', ratingCodes: ['INSTA'] }),
      [ratingsRoute, alternativesFlight],
    ],
    [
      'instructors by state and two rating codes',
      (s) => s.searchInstructors({ state: 'WA', ratingCodes: ['ZZ-9', 'ZZ-8'] }),
      [
        instructorsCounted(
          '2 flight or ground instructors match',
          'flight or ground instructor',
          'every requested code',
        ),
        ratingsRule,
      ],
    ],
    [
      'instructors by state and two rating codes, one of them AME',
      (s) => s.searchInstructors({ state: 'WA', ratingCodes: ['ZZ-9', ' ame '] }),
      [
        instructorsCounted(
          '2 flight or ground instructors match',
          'flight or ground instructor',
          'every requested code',
        ),
        ratingsRule,
        alternatives,
      ],
    ],
    [
      'instructors by firstName, state and ratingCodes',
      (s) => s.searchInstructors({ firstName: 'alpha', state: 'WA', ratingCodes: ['ZZ-9'] }),
      [
        instructorsCounted(
          '1 flight or ground instructor matches',
          'flight or ground instructor',
          'the requested code',
        ),
        ratingsRoute,
      ],
    ],
    [
      'instructors by lastName and ratingCodes',
      (s) => s.searchInstructors({ lastName: 'credential', ratingCodes: ['ZZ-9'] }),
      [
        instructorsCounted(
          '2 flight or ground instructors match',
          'flight or ground instructor',
          'the requested code',
        ),
        ratingsRoute,
      ],
    ],
    [
      'flight instructors by lastName and MEI',
      (s) =>
        s.searchInstructors({
          lastName: 'credential',
          instructorType: 'flight',
          ratingCodes: ['MEI'],
        }),
      [
        instructorsCounted('2 flight instructors match', 'flight instructor', 'the requested code'),
        ratingsRoute,
        alternatives,
      ],
    ],
    [
      'instructors by a name that holds no instructor certificate, with a CFII code',
      (s) =>
        s.searchInstructors({ lastName: 'credential', firstName: 'bravo', ratingCodes: ['CFII'] }),
      [noInstructor('flight or ground instructor'), fewer],
    ],
    [
      'ground instructors by a name holding only flight instructor certificates',
      (s) =>
        s.searchInstructors({
          lastName: 'credential',
          instructorType: 'ground',
          ratingCodes: ['INST'],
        }),
      [noInstructor('ground instructor'), fewer],
    ],
    [
      'instructors by a state no instructor lives in, with ratingCodes',
      (s) => s.searchInstructors({ state: 'OR', ratingCodes: ['ZZ-9'] }),
      [noInstructor('flight or ground instructor'), fewer],
    ],
    [
      'instructors by lastName alone',
      (s) => s.searchInstructors({ lastName: 'absent' }),
      [identifiersRoute],
    ],
    ['instructors by state alone', (s) => s.searchInstructors({ state: 'OR' }), [identifiersRoute]],
    [
      'instructors by state and city',
      (s) => s.searchInstructors({ state: 'WA', city: 'nowhere' }),
      [fewer],
    ],
  ])('routes %s', async (_case, search, route) => {
    const result = await search(serviceAt(mirror.directory, { includeLocation: true }));
    expect(result.enrichment).toMatchObject({
      totalCount: 0,
      returnedCount: 0,
      notice: [limits, absence, ...route].join(' '),
    });
  });

  it('adds no route to a credential search that matches', async () => {
    const service = serviceAt(mirror.directory, { includeLocation: true });
    for (const [result, totalCount] of [
      [await service.verifyCertificates({ ...name, typeRatings: ['A/B-737'] }), 2],
      [
        await service.verifyCertificates({
          mode: 'id',
          uniqueId: 'A9999001',
          certificateType: 'P',
          certificateLevel: 'A',
        }),
        1,
      ],
      [await service.searchInstructors({ lastName: 'credential', ratingCodes: ['INSTA'] }), 1],
    ] as const)
      expect(result.enrichment).toMatchObject({ totalCount, notice: limits });
  });
});

describe('personal-data redaction', () => {
  const medical = { 10: '3', 11: '102026', 12: '102028' };
  /** Two BASIC variants for A5000001 differ only by city and ZIP. */
  const bytes = zipSource(
    sourceFiles({
      pilotBasic: [
        person('A5000001', 'SYNTHETIC QUINN', 'FIXTURE', medical),
        person('A5000002', 'SYNTHETIC', 'FIXTURE JR', { 6: 'OR' }),
        person('A5000003', 'OTHER', 'FIXTURE'),
      ],
      nonpilotBasic: [
        person('A5000001', 'SYNTHETIC QUINN', 'FIXTURE', {
          ...medical,
          5: 'SECOND CITY SENTINEL',
          7: '99998',
        }),
      ],
      pilotCert: [
        cert('A5000001', 'SYNTHETIC QUINN', 'FIXTURE', true, {
          4: 'C',
          6: 'C/ASEL',
          17: 'C/SYNTH-1',
        }),
        cert('A5000001', 'SYNTHETIC QUINN', 'FIXTURE', true, { 3: 'F', 4: '', 6: 'C/INSTA' }),
        cert('A5000002', 'SYNTHETIC', 'FIXTURE JR', true, { 3: 'F', 4: '', 6: 'C/INSTA' }),
        cert('A5000003', 'OTHER', 'FIXTURE', true, {}),
      ],
      nonpilotCert: [cert('A5000001', 'SYNTHETIC QUINN', 'FIXTURE', false, { 3: 'U', 4: '' })],
    }),
  );
  const mirror = sharedMirror(bytes, true);
  let empty: string;
  beforeAll(async () => {
    empty = await mkdtemp(join(tmpdir(), 'faa-redact-missing-'));
  });
  afterAll(() => rm(empty, { recursive: true, force: true }));
  /** A service over the shared location-imported snapshot, or over a missing mirror. */
  function registry(redactPii: boolean, includeLocation = false, mirrorDir = mirror.directory) {
    return serviceAt(mirrorDir, { redactPii, includeLocation, bytes });
  }
  type Call = (service: AirmenRegistryService) => unknown;
  const on = 'while personal-data redaction (FAA_AIRMEN_REDACT_PII) is on.';
  const nameHint =
    'Retry with both lastName and firstName as the FAA record writes them, using nameMatch words or exact, or use mode id with a uniqueId; for a personal install, the operator can set FAA_AIRMEN_REDACT_PII=false to allow partial-name and prefix searches.';
  const instructorHint =
    'Retry faa_airmen_search_instructors with both lastName and firstName as the FAA record writes them, using nameMatch words or exact, plus any state, instructorType, or ratingCodes; for a personal install, the operator can set FAA_AIRMEN_REDACT_PII=false to allow searches by state, rating, or partial name.';
  const locationOperator =
    'for a personal install, the operator can set FAA_AIRMEN_REDACT_PII=false, and city and ZIP filters also need FAA_AIRMEN_INCLUDE_LOCATION=true.';
  /** Each location refusal names the whole retry redaction accepts in that mode. */
  const locationHints = {
    id: `Retry in mode id without name, location, or nameMatch fields; ${locationOperator}`,
    name: `Retry in mode name without city or zipCode, with both lastName and firstName and nameMatch words or exact, narrowing with state if needed; ${locationOperator}`,
    instructors: `Retry without city or zipCode, with both lastName and firstName and nameMatch words or exact, narrowing with state, instructorType, or ratingCodes if needed; ${locationOperator}`,
  };
  /** The sentence a rejection in a name search redaction will refuse adds to its own hint. */
  const namesToo =
    'While personal-data redaction is on, a name search also needs both lastName and firstName, with nameMatch words or exact.';
  const medicalHint =
    'Use faa_airmen_verify_certificate or faa_airmen_get_type_ratings for certificate records; for a personal install, the operator can set FAA_AIRMEN_REDACT_PII=false to read informational medical fields.';
  const full = { mode: 'name', lastName: 'fixture', firstName: 'synthetic' } as const;
  const names = (message: string) => ({ message: `${message} ${on}`, hint: nameHint });
  const instructors = (message: string) => ({ message: `${message} ${on}`, hint: instructorHint });

  it.each<[string, Call, string[], string[] | { message: string; hint: string }]>([
    [
      'verify by ID',
      (s) => s.verifyCertificates({ mode: 'id', uniqueId: 'A5000001' }),
      ['A5000001'],
      ['A5000001'],
    ],
    [
      'verify by ID with credential filters',
      (s) =>
        s.verifyCertificates({
          mode: 'id',
          uniqueId: 'A5000001',
          certificateType: 'F',
          ratingCodes: ['INSTA'],
        }),
      ['A5000001'],
      ['A5000001'],
    ],
    [
      'verify by full name',
      (s) => s.verifyCertificates(full),
      ['A5000001', 'A5000002'],
      ['A5000001', 'A5000002'],
    ],
    [
      'verify by full name with nameMatch exact',
      (s) => s.verifyCertificates({ ...full, firstName: 'synthetic quinn', nameMatch: 'exact' }),
      ['A5000001'],
      ['A5000001'],
    ],
    [
      'verify by full name with state and every credential filter',
      (s) =>
        s.verifyCertificates({
          ...full,
          state: 'wa',
          certificateType: 'P',
          certificateLevel: 'C',
          ratingCodes: ['ASEL'],
          typeRatings: ['SYNTH-1'],
        }),
      ['A5000001'],
      ['A5000001'],
    ],
    [
      'verify by last name alone',
      (s) => s.verifyCertificates({ mode: 'name', lastName: 'fixture' }),
      ['A5000001', 'A5000002', 'A5000003'],
      names('firstName is required'),
    ],
    [
      'verify by last name with a type rating',
      (s) => s.verifyCertificates({ mode: 'name', lastName: 'fixture', typeRatings: ['SYNTH-1'] }),
      ['A5000001'],
      names('firstName is required'),
    ],
    [
      'verify by full-name prefix',
      (s) => s.verifyCertificates({ ...full, lastName: 'fix', nameMatch: 'prefix' }),
      ['A5000001', 'A5000002'],
      names('nameMatch must be words or exact'),
    ],
    [
      'verify by last-name prefix alone',
      (s) => s.verifyCertificates({ mode: 'name', lastName: 'fix', nameMatch: 'prefix' }),
      ['A5000001', 'A5000002', 'A5000003'],
      names('firstName is required and nameMatch must be words or exact'),
    ],
    [
      'remote pilot by ID',
      (s) => s.verifyRemotePilot({ mode: 'id', uniqueId: 'A5000001' }),
      ['A5000001'],
      ['A5000001'],
    ],
    ['remote pilot by full name', (s) => s.verifyRemotePilot(full), ['A5000001'], ['A5000001']],
    [
      'remote pilot by last name alone',
      (s) => s.verifyRemotePilot({ mode: 'name', lastName: 'fixture' }),
      ['A5000001'],
      names('firstName is required'),
    ],
    [
      'instructors by full name, state, type, and rating',
      (s) =>
        s.searchInstructors({
          lastName: 'fixture',
          firstName: 'synthetic',
          state: 'WA',
          instructorType: 'flight',
          ratingCodes: ['INSTA'],
        }),
      ['A5000001'],
      ['A5000001'],
    ],
    [
      'instructors by state alone',
      (s) => s.searchInstructors({ state: 'WA' }),
      ['A5000001'],
      instructors('lastName and firstName are required'),
    ],
    [
      'instructors by rating alone',
      (s) => s.searchInstructors({ ratingCodes: ['INSTA'] }),
      ['A5000001', 'A5000002'],
      instructors('lastName and firstName are required'),
    ],
    [
      'instructors by first name alone',
      (s) => s.searchInstructors({ firstName: 'synthetic' }),
      ['A5000001', 'A5000002'],
      instructors('lastName is required'),
    ],
    [
      'instructors by last name alone',
      (s) => s.searchInstructors({ lastName: 'fixture' }),
      ['A5000001', 'A5000002'],
      instructors('firstName is required'),
    ],
    [
      'instructors by full-name prefix',
      (s) => s.searchInstructors({ lastName: 'fix', firstName: 'syn', nameMatch: 'prefix' }),
      ['A5000001', 'A5000002'],
      instructors('nameMatch must be words or exact'),
    ],
  ])(
    '%s: served with redaction off; redaction on serves or rejects before any read',
    async (_case, run, off, redacted) => {
      expect(personIds((await run(registry(false))) as Parameters<typeof personIds>[0])).toEqual(
        off,
      );
      if (Array.isArray(redacted)) {
        const result = (await run(registry(true))) as Parameters<typeof personIds>[0] & {
          enrichment: { piiRedacted: boolean };
        };
        expect(personIds(result)).toEqual(redacted);
        expect(result.enrichment.piiRedacted).toBe(true);
      } else
        expect(await rejected(() => run(registry(true)))).toEqual({
          code: -32005,
          reason: 'pii_redacted',
          ...redacted,
          sync: true,
        });
    },
  );

  it.each([true, false])(
    'rejects city and ZIP filters first under redaction with location access %s, never echoing them, and the retry each hint names succeeds',
    async (includeLocation) => {
      const redacted = registry(true, includeLocation);
      const byId = { mode: 'id', uniqueId: 'A5000001' } as const;
      // Each case: the refused call, its message, its mode's hint, and that hint's retry.
      for (const [run, message, hint, retry] of [
        [
          (s) => s.verifyCertificates({ ...full, city: 'test city sentinel' }),
          `city is unavailable ${on}`,
          locationHints.name,
          (s) => s.verifyCertificates(full),
        ],
        [
          (s) => s.verifyCertificates({ ...full, zipCode: '99999' }),
          `zipCode is unavailable ${on}`,
          locationHints.name,
          (s) => s.verifyCertificates(full),
        ],
        [
          (s) =>
            s.verifyCertificates({
              mode: 'name',
              lastName: ' ',
              city: 'PRIVATE',
              zipCode: 'PRIVATE',
            }),
          `city and zipCode are unavailable ${on}`,
          locationHints.name,
          (s) => s.verifyCertificates(full),
        ],
        [
          (s) =>
            s.verifyCertificates({
              mode: 'name',
              lastName: 'fixture',
              nameMatch: 'prefix',
              city: 'PRIVATE',
            }),
          `city is unavailable ${on}`,
          locationHints.name,
          (s) => s.verifyCertificates({ ...full, nameMatch: 'words' }),
        ],
        [
          (s) => s.verifyCertificates({ ...byId, city: 'PRIVATE' }),
          `city is unavailable ${on}`,
          locationHints.id,
          (s) => s.verifyCertificates(byId),
        ],
        [
          (s) =>
            s.verifyCertificates({ ...byId, state: 'WA', certificateType: 'P', city: 'PRIVATE' }),
          `city is unavailable ${on}`,
          locationHints.id,
          (s) => s.verifyCertificates({ ...byId, certificateType: 'P' }),
        ],
        [
          (s) => s.verifyRemotePilot({ ...full, zipCode: '99999' }),
          `zipCode is unavailable ${on}`,
          locationHints.name,
          (s) => s.verifyRemotePilot(full),
        ],
        [
          (s) => s.verifyRemotePilot({ mode: 'name', lastName: 'fixture', city: 'PRIVATE' }),
          `city is unavailable ${on}`,
          locationHints.name,
          (s) => s.verifyRemotePilot({ ...full, state: 'WA' }),
        ],
        [
          (s) => s.verifyRemotePilot({ ...byId, zipCode: '99999' }),
          `zipCode is unavailable ${on}`,
          locationHints.id,
          (s) => s.verifyRemotePilot(byId),
        ],
        [
          (s) => s.searchInstructors({ state: 'WA', city: 'test city sentinel' }),
          `city is unavailable ${on}`,
          locationHints.instructors,
          (s) => s.searchInstructors({ lastName: 'fixture', firstName: 'synthetic', state: 'WA' }),
        ],
        [
          (s) => s.searchInstructors({ city: 'PRIVATE' }),
          `city is unavailable ${on}`,
          locationHints.instructors,
          (s) =>
            s.searchInstructors({
              lastName: 'fixture',
              firstName: 'synthetic',
              instructorType: 'flight',
              ratingCodes: ['INSTA'],
            }),
        ],
      ] as [Call, string, string, Call][]) {
        const result = await rejected(() => run(redacted));
        expect(result).toEqual({
          code: -32005,
          reason: 'pii_redacted',
          message,
          hint,
          sync: true,
        });
        for (const value of ['PRIVATE', 'sentinel', '99999'])
          expect(JSON.stringify(result)).not.toContain(value);
        const accepted = (await retry(redacted)) as Parameters<typeof personIds>[0];
        expect(personIds(accepted)).toContain('A5000001');
      }
      const open = () =>
        registry(false, includeLocation).verifyCertificates({
          ...full,
          city: 'test city sentinel',
        });
      if (includeLocation) expect(personIds(await open())).toEqual(['A5000001', 'A5000002']);
      else
        expect(await rejected(open)).toMatchObject({
          reason: 'location_access_disabled',
          sync: true,
        });
    },
  );

  it('withholds city and ZIP from every person, identity variants included, even with location access on', async () => {
    const located = await registry(false, true).verifyCertificates({
      mode: 'id',
      uniqueId: 'A5000001',
    });
    expect(located.enrichment.piiRedacted).toBe(false);
    expect(located.data.matches[0]!.airman.identityVariants).toHaveLength(1);
    for (const value of ['TEST CITY SENTINEL', 'SECOND CITY SENTINEL', '"zipCode":"99998"'])
      expect(JSON.stringify(located)).toContain(value);
    for (const includeLocation of [true, false]) {
      const service = registry(true, includeLocation);
      for (const result of [
        await service.verifyCertificates({ mode: 'id', uniqueId: 'A5000001' }),
        await service.verifyCertificates(full),
        await service.verifyRemotePilot(full),
        await service.searchInstructors({ lastName: 'fixture', firstName: 'synthetic' }),
        await service.getRatings({ uniqueId: 'A5000001' }),
      ]) {
        const text = JSON.stringify(result);
        for (const value of [
          'CITY SENTINEL',
          '"city"',
          '"zipCode"',
          '"99999"',
          '"99998"',
          'identityVariants',
        ])
          expect({ includeLocation, value, found: text.includes(value) }).toEqual({
            includeLocation,
            value,
            found: false,
          });
        expect(result.enrichment.piiRedacted).toBe(true);
      }
    }
  });

  it('rejects every medical call before validating input or reading the mirror', async () => {
    for (const service of [registry(true), registry(true, true), registry(true, false, empty)])
      for (const input of [
        { uniqueId: 'A5000001' },
        { uniqueId: 'C0000000' },
        { uniqueId: 'not an id' },
        { uniqueId: 'A5000001\t' },
        { uniqueId: 'A5000001', unexpected: 'PRIVATE INPUT' },
      ])
        expect(await rejected(() => service.getMedical(input))).toEqual({
          code: -32005,
          reason: 'pii_redacted',
          message: `Medical fields are withheld ${on}`,
          hint: medicalHint,
          sync: true,
        });
    const open = registry(false);
    const medicalResult = await open.getMedical({ uniqueId: 'A5000001' });
    expect(medicalResult.data).toMatchObject({ found: true, hasReportedMedicalFields: true });
    expect(medicalResult.enrichment.piiRedacted).toBe(false);
    expect((await rejected(() => open.getMedical({ uniqueId: 'A5000001\t' }))).reason).toBe(
      'invalid_identity',
    );
    expect(
      await rejected(() => registry(false, false, empty).getMedical({ uniqueId: 'C0000000' })),
    ).toMatchObject({ reason: 'mirror_missing', sync: false });
  });

  it('raises pii_redacted before a missing mirror is read, while allowed calls still reach it', async () => {
    const redacted = registry(true, false, empty),
      open = registry(false, false, empty);
    const missing = { reason: 'mirror_missing', sync: false };
    for (const [run, unredacted] of [
      [(s) => s.verifyCertificates({ mode: 'name', lastName: 'fixture' }), missing],
      [(s) => s.verifyRemotePilot({ ...full, nameMatch: 'prefix' }), missing],
      [(s) => s.searchInstructors({ state: 'WA' }), missing],
      [
        (s) =>
          s.searchInstructors({ lastName: 'fixture', firstName: 'synthetic', zipCode: '99999' }),
        { reason: 'location_access_disabled', sync: true },
      ],
    ] as [Call, { reason: string; sync: boolean }][]) {
      expect(await rejected(() => run(redacted))).toMatchObject({
        reason: 'pii_redacted',
        sync: true,
      });
      expect(await rejected(() => run(open))).toMatchObject(unredacted);
    }
    expect(await rejected(() => redacted.verifyCertificates(full))).toMatchObject({
      reason: 'mirror_missing',
      sync: false,
    });
    expect(await rejected(() => redacted.getRatings({ uniqueId: 'A5000001' }))).toMatchObject({
      reason: 'mirror_missing',
    });
  });

  it('keeps the reason of an input invalid in both modes', async () => {
    const state = stateRule.message;
    for (const [run, reason, message] of [
      [
        (s) => s.verifyCertificates({ mode: 'name', lastName: ' ' }),
        'invalid_identity',
        'mode name requires lastName.',
      ],
      [
        (s) => s.verifyCertificates({ mode: 'name', firstName: 'synthetic' }),
        'invalid_identity',
        'mode name requires lastName.',
      ],
      [
        (s) => s.verifyCertificates({ mode: 'name', lastName: 'fixture', state: 'Washington' }),
        'invalid_filter',
        state,
      ],
      [
        (s) => s.verifyCertificates({ mode: 'name', lastName: 'fixture', certificateType: 'ATP' }),
        'invalid_filter',
        'certificateType must be one certificate type letter, a certificate_types description, or CFI.',
      ],
      [
        (s) =>
          s.verifyCertificates({ mode: 'name', lastName: 'fix', nameMatch: 'prefix', limit: 0 }),
        'invalid_filter',
        'limit must be a whole number of at least 1.',
      ],
      [
        (s) => s.verifyCertificates({ mode: 'id', uniqueId: 'A5000001', nameMatch: 'prefix' }),
        'invalid_identity',
        'mode id forbids nameMatch.',
      ],
      [
        (s) => s.verifyRemotePilot({ mode: 'name', lastName: 'fixture', state: 'Washington' }),
        'invalid_filter',
        state,
      ],
      [(s) => s.searchInstructors({ state: 'Washington' }), 'invalid_filter', state],
      [
        (s) => s.searchInstructors({ firstName: 'synthetic', ratingCodes: ['NOT/A/CODE!'] }),
        'invalid_filter',
        'ratingCodes must be 1–11 codes, each 1–30 letters, digits, spaces, or hyphens, optionally after a one-letter level and a slash.',
      ],
      [
        (s) => s.verifyCertificates({ ...full, typeRatings: ['B-737/A'] }),
        'invalid_filter',
        'typeRatings must be 1–11 designators, each 1–30 letters, digits, spaces, or hyphens, optionally after a one-letter level and a slash.',
      ],
    ] as [Call, string, string][])
      for (const redactPii of [false, true]) {
        const result = await rejected(() => run(registry(redactPii)));
        expect({ redactPii, reason: result.reason, message: result.message }).toEqual({
          redactPii,
          reason,
          message,
        });
      }
  });

  const bothNames = 'Instructor search requires both lastName and firstName.';
  const bothNamesHint =
    'Call faa_airmen_search_instructors with both lastName and firstName; for a personal install, the operator can set FAA_AIRMEN_REDACT_PII=false to search by state or rating alone.';
  it.each<[string, boolean, boolean, string, string | undefined]>([
    [
      'location access on',
      false,
      true,
      'Instructor search requires lastName, firstName, state, city, zipCode, or ratingCodes.',
      undefined,
    ],
    [
      'location access off',
      false,
      false,
      'Instructor search requires lastName, firstName, state, or ratingCodes.',
      undefined,
    ],
    ['redaction with location access on', true, true, bothNames, bothNamesHint],
    ['redaction with location access off', true, false, bothNames, bothNamesHint],
  ])(
    'names only the instructor filters the serving mode accepts in missing_search_filter, %s',
    async (_case, redactPii, includeLocation, message, hint) => {
      expect(
        await rejected(() => registry(redactPii, includeLocation).searchInstructors({})),
      ).toEqual({
        code: -32007,
        reason: 'missing_search_filter',
        message,
        hint,
        sync: true,
      });
    },
  );

  it('offers only a call the serving mode allows in identity and name-field hints', async () => {
    const lastNameOnly = { mode: 'name', firstName: 'synthetic' } as const;
    const badFirstName = { lastName: 'fixture', firstName: 'PRIVATE\u0000' } as const;
    const badMatch = { ...full, nameMatch: 'PRIVATE' as 'exact' };
    const firstNameRule =
      'firstName must be at most 60 characters with no control or format characters.';
    const firstNameOff =
      'Retry with firstName as written in the FAA FIRST NAME field, at most 60 characters, or omit it.';
    const firstNameOn =
      'Retry with firstName as written in the FAA FIRST NAME field, at most 60 characters.';
    const matchOff = {
      message: 'nameMatch must be words, exact, or prefix.',
      hint: 'Send nameMatch words, exact, or prefix, or omit it for words.',
    };
    const matchOn = {
      message: 'nameMatch must be words or exact.',
      hint: 'Send nameMatch words or exact, or omit it for words.',
    };
    const idOff = {
      message: 'mode id requires uniqueId.',
      hint: 'Send the uniqueId from a faa_airmen_verify_certificate, faa_airmen_search_instructors, or faa_airmen_verify_remote_pilot result, or search with mode name and lastName.',
    };
    const idOn = {
      message: 'mode id requires uniqueId.',
      hint: 'Send the uniqueId from a faa_airmen_verify_certificate, faa_airmen_search_instructors, or faa_airmen_verify_remote_pilot result, or search with mode name and both lastName and firstName.',
    };
    const nameOff = {
      message: 'mode name requires lastName.',
      hint: 'In mode name send a nonblank lastName, or use mode id with a uniqueId.',
    };
    const nameOn = {
      message: 'mode name requires lastName.',
      hint: 'In mode name send both lastName and firstName, or use mode id with a uniqueId.',
    };
    const modeOff = {
      message: 'mode must be id or name.',
      hint: 'Send mode id with a uniqueId, or mode name with a lastName.',
    };
    const modeOn = {
      message: 'mode must be id or name.',
      hint: 'Send mode id with a uniqueId, or mode name with both lastName and firstName.',
    };
    type Text = { message: string; hint: string };
    for (const [run, reason, off, on] of [
      [(s) => s.verifyCertificates({ mode: 'id', uniqueId: ' ' }), 'invalid_identity', idOff, idOn],
      [(s) => s.verifyRemotePilot({ mode: 'id', uniqueId: ' ' }), 'invalid_identity', idOff, idOn],
      [(s) => s.verifyCertificates(lastNameOnly), 'invalid_identity', nameOff, nameOn],
      [(s) => s.verifyRemotePilot(lastNameOnly), 'invalid_identity', nameOff, nameOn],
      [(s) => s.verifyCertificates({ mode: 'other' as 'id' }), 'invalid_identity', modeOff, modeOn],
      [(s) => s.verifyRemotePilot({ mode: 'other' as 'id' }), 'invalid_identity', modeOff, modeOn],
      [
        (s) => s.verifyCertificates({ mode: 'name', ...badFirstName }),
        'invalid_identity',
        { message: firstNameRule, hint: firstNameOff },
        { message: firstNameRule, hint: firstNameOn },
      ],
      [
        (s) => s.searchInstructors(badFirstName),
        'invalid_identity',
        { message: firstNameRule, hint: firstNameOff },
        { message: firstNameRule, hint: firstNameOn },
      ],
      [(s) => s.verifyCertificates(badMatch), 'invalid_filter', matchOff, matchOn],
      [(s) => s.verifyRemotePilot(badMatch), 'invalid_filter', matchOff, matchOn],
      [
        (s) =>
          s.searchInstructors({
            lastName: 'fixture',
            firstName: 'synthetic',
            nameMatch: 'PRIVATE' as 'exact',
          }),
        'invalid_filter',
        matchOff,
        matchOn,
      ],
    ] as [Call, string, Text, Text][])
      for (const [redactPii, expected] of [
        [false, off],
        [true, on],
      ] as const) {
        const result = await rejected(() => run(registry(redactPii)));
        expect.soft({ redactPii, ...result }).toEqual({
          redactPii,
          code: -32007,
          reason,
          ...expected,
          sync: true,
        });
        expect(JSON.stringify(result)).not.toContain('PRIVATE');
      }
  });

  it('adds the redacted name search to every rejection raised before the name gate refuses, and each hinted retry succeeds', async () => {
    const typeHint =
      'Call faa_airmen_list_reference with topic certificate_types and send a listed code or description, or omit certificateType together with any certificateLevel.';
    const typeRule =
      'certificateType must be one certificate type letter, a certificate_types description, or CFI.';
    const lastNameOnly = { mode: 'name', lastName: 'fixture' } as const;
    // Redaction off: omitting certificateType alone still fails on certificateLevel, so the hint drops both.
    const open = registry(false);
    const typed = { ...lastNameOnly, nameMatch: 'exact', certificateLevel: 'A' } as const;
    expect(
      await rejected(() => open.verifyCertificates({ ...typed, certificateType: 'Q9' })),
    ).toMatchObject({ reason: 'invalid_filter', message: typeRule, hint: typeHint });
    expect(await rejected(() => open.verifyCertificates(typed))).toMatchObject({
      message: 'certificateLevel requires certificateType.',
    });
    expect(
      personIds(await open.verifyCertificates({ ...lastNameOnly, nameMatch: 'exact' })),
    ).toEqual(['A5000001', 'A5000003']);
    /**
     * Each case: the call, its reason and message (the same in both modes), its hint with redaction
     * off, whether redaction will refuse its names, and the retry its redacted hint names.
     */
    for (const [run, reason, message, hint, refused, retry] of [
      [
        (s) => s.verifyCertificates({ ...lastNameOnly, certificateType: 'Q9' }),
        'invalid_filter',
        typeRule,
        typeHint,
        true,
        (s) => s.verifyCertificates(full),
      ],
      [
        (s) => s.verifyCertificates({ ...lastNameOnly, certificateLevel: 'A' }),
        'invalid_filter',
        'certificateLevel requires certificateType.',
        'Add the certificateType the level belongs to, such as P for level A, from faa_airmen_list_reference topic certificate_levels, or omit certificateLevel.',
        true,
        (s) => s.verifyCertificates({ ...full, certificateType: 'P', certificateLevel: 'C' }),
      ],
      [
        (s) => s.verifyCertificates({ ...lastNameOnly, state: 'Washington' }),
        'invalid_filter',
        stateRule.message,
        stateRule.hint,
        true,
        (s) => s.verifyCertificates({ ...full, state: 'WA' }),
      ],
      [
        (s) => s.verifyCertificates({ ...lastNameOnly, state: 'ZZ' }),
        'invalid_filter',
        stateRule.message,
        stateRule.hint,
        true,
        (s) => s.verifyCertificates({ ...full, state: 'WA' }),
      ],
      [
        (s) => s.verifyCertificates({ ...lastNameOnly, typeRatings: ['B-737/A'] }),
        'invalid_filter',
        'typeRatings must be 1–11 designators, each 1–30 letters, digits, spaces, or hyphens, optionally after a one-letter level and a slash.',
        'Call faa_airmen_list_reference with topic type_ratings and send listed designators, bare or as level/designator such as A/B-737.',
        true,
        (s) => s.verifyCertificates({ ...full, typeRatings: ['C/SYNTH-1'] }),
      ],
      [
        (s) => s.verifyCertificates({ ...lastNameOnly, uniqueId: 'A5000001' }),
        'invalid_identity',
        'mode name forbids uniqueId.',
        'In mode name omit uniqueId; to read one ID, use mode id with uniqueId alone.',
        true,
        (s) => s.verifyCertificates(full),
      ],
      [
        (s) => s.verifyCertificates({ ...full, nameMatch: 'prefix', offset: 10001 }),
        'invalid_filter',
        'offset must be a whole number from 0 to 10000.',
        'Follow nextOffset, or narrow the filters to reach results beyond offset 10000.',
        true,
        (s) => s.verifyCertificates({ ...full, offset: 0 }),
      ],
      [
        (s) => s.verifyRemotePilot({ ...lastNameOnly, limit: 0 }),
        'invalid_filter',
        'limit must be a whole number of at least 1.',
        'Send limit from 1 to 50; a larger limit returns at most 50.',
        true,
        (s) => s.verifyRemotePilot({ ...full, limit: 1 }),
      ],
      [
        (s) => s.searchInstructors({ lastName: 'X'.repeat(61) }),
        'invalid_identity',
        'lastName must be at most 60 characters with no control or format characters.',
        'Retry with lastName as written in the FAA LAST NAME field, at most 60 characters.',
        true,
        (s) => s.searchInstructors({ lastName: 'fixture', firstName: 'synthetic' }),
      ],
      [
        (s) => s.searchInstructors({ firstName: 'synthetic', ratingCodes: ['NOT/A/CODE!'] }),
        'invalid_filter',
        'ratingCodes must be 1–11 codes, each 1–30 letters, digits, spaces, or hyphens, optionally after a one-letter level and a slash.',
        'Call faa_airmen_list_reference with topic ratings and send listed codes, bare or as level/code such as F/INSTA.',
        true,
        (s) =>
          s.searchInstructors({
            lastName: 'fixture',
            firstName: 'synthetic',
            ratingCodes: ['INSTA'],
          }),
      ],
      [
        (s) => s.searchInstructors({ lastName: 'fixture', instructorType: 'other' as 'flight' }),
        'invalid_filter',
        'instructorType must be flight, ground, or both.',
        'Send instructorType flight, ground, or both, or omit it for both.',
        true,
        (s) => s.searchInstructors({ lastName: 'fixture', firstName: 'synthetic' }),
      ],
      // A complete name, or ID mode, leaves nothing for the gate to refuse, so the hint is the field's own.
      [
        (s) => s.verifyCertificates({ ...full, certificateType: 'Q9' }),
        'invalid_filter',
        typeRule,
        typeHint,
        false,
        (s) => s.verifyCertificates(full),
      ],
      [
        (s) => s.verifyCertificates({ mode: 'id', uniqueId: 'A5000001', certificateType: 'Q9' }),
        'invalid_filter',
        typeRule,
        typeHint,
        false,
        (s) => s.verifyCertificates({ mode: 'id', uniqueId: 'A5000001' }),
      ],
    ] as [Call, string, string, string, boolean, Call][])
      for (const redactPii of [false, true]) {
        const service = registry(redactPii);
        expect({ redactPii, ...(await rejected(() => run(service))) }).toEqual({
          redactPii,
          code: -32007,
          reason,
          message,
          hint: redactPii && refused ? `${hint} ${namesToo}` : hint,
          sync: true,
        });
        if (redactPii)
          expect(personIds((await retry(service)) as Parameters<typeof personIds>[0])).toContain(
            'A5000001',
          );
      }
  });

  it('treats a whitespace-only value carrying a control character as unset in both modes, never as a refused filter', async () => {
    for (const redactPii of [false, true]) {
      const service = registry(redactPii);
      const byName = await service.verifyCertificates({
        ...full,
        uniqueId: '\t',
        state: '\n',
        city: '\t',
        zipCode: '﻿',
      });
      expect({
        redactPii,
        people: personIds(byName),
        filters: byName.enrichment.appliedFilters,
      }).toEqual({
        redactPii,
        people: ['A5000001', 'A5000002'],
        filters: {
          mode: 'name',
          lastName: 'FIXTURE',
          firstName: 'SYNTHETIC',
          nameMatch: 'words',
          limit: 10,
          offset: 0,
        },
      });
      const byId = await service.verifyRemotePilot({
        mode: 'id',
        uniqueId: 'A5000001',
        lastName: '\t',
        city: '\r\n',
      });
      expect({ redactPii, people: personIds(byId) }).toEqual({ redactPii, people: ['A5000001'] });
      const instructors = await service.searchInstructors({
        lastName: 'fixture',
        firstName: 'synthetic',
        zipCode: ' \t ',
      });
      expect({ redactPii, people: personIds(instructors) }).toEqual({
        redactPii,
        people: ['A5000001', 'A5000002'],
      });
    }
  });

  it('resolves the default whole-word nameMatch before the gate', async () => {
    const result = await registry(true).verifyCertificates(full);
    expect(personIds(result)).toEqual(['A5000001', 'A5000002']);
    expect(result.enrichment).toMatchObject({
      piiRedacted: true,
      notice: `${limits} ${redactionNotice}`,
      appliedFilters: { lastName: 'FIXTURE', firstName: 'SYNTHETIC', nameMatch: 'words' },
    });
    // Whole words find SYNTHETIC QUINN and FIXTURE JR; exact finds neither.
    expect(
      personIds(await registry(true).verifyCertificates({ ...full, nameMatch: 'exact' })),
    ).toEqual([]);
  });

  it.each([
    [false, false, locationOff],
    [false, true, ''],
    [true, false, redactionNotice],
    [true, true, redactionNotice],
  ] as const)(
    'redaction %s with location access %s puts the mode sentence where the location sentence was',
    async (redactPii, includeLocation, sentence) => {
      const service = registry(redactPii, includeLocation);
      for (const result of [
        await service.verifyCertificates({ mode: 'id', uniqueId: 'A5000001' }),
        await service.getRatings({ uniqueId: 'A5000001' }),
        await service.listReference({ topic: 'type_ratings' }),
      ])
        expect(result.enrichment.notice).toBe([limits, sentence].filter(Boolean).join(' '));
      expect(
        (await service.listReference({ topic: 'certificate_types' })).enrichment,
      ).toMatchObject({
        notice: '',
        provenance: null,
        piiRedacted: redactPii,
      });
    },
  );

  it('never offers a required name or a rejected filter for removal in a redacted zero result', async () => {
    const absent = { lastName: 'absent', firstName: 'nobody' } as const;
    const nobody =
      'No person matches this name search even without certificateType or typeRatings.';
    for (const [run, offRoute, onRoute] of [
      [(s) => s.verifyCertificates({ mode: 'name', ...absent }), fewer, identifiersRoute],
      [
        (s) => s.verifyRemotePilot({ mode: 'name', ...absent }),
        `${remoteByName} ${fewer}`,
        `${remoteByName} ${identifiersRoute}`,
      ],
      [(s) => s.searchInstructors(absent), fewer, identifiersRoute],
      [(s) => s.verifyCertificates({ mode: 'name', ...absent, state: 'WA' }), fewer, withoutState],
      [
        (s) => s.verifyRemotePilot({ mode: 'name', ...absent, state: 'WA' }),
        `${remoteByName} ${fewer}`,
        `${remoteByName} ${withoutState}`,
      ],
      [(s) => s.searchInstructors({ ...absent, state: 'WA' }), fewer, withoutState],
      [
        (s) => s.searchInstructors({ ...absent, ratingCodes: ['ZZ-9'] }),
        `${noInstructor('flight or ground instructor')} ${fewer}`,
        `${noInstructor('flight or ground instructor')} ${identifiersRoute}`,
      ],
      [
        (s) => s.searchInstructors({ ...absent, state: 'WA', ratingCodes: ['ZZ-9'] }),
        `${noInstructor('flight or ground instructor')} ${fewer}`,
        `${noInstructor('flight or ground instructor')} ${withoutState}`,
      ],
      [
        (s) =>
          s.verifyCertificates({
            mode: 'name',
            ...absent,
            state: 'WA',
            certificateType: 'P',
            typeRatings: ['ZZ-9'],
          }),
        `${nobody} ${fewer}`,
        `${nobody} ${withoutState}`,
      ],
    ] as [Call, string, string][])
      for (const [redactPii, route, sentence] of [
        [false, offRoute, locationOff],
        [true, onRoute, redactionNotice],
      ] as const) {
        const result = (await run(registry(redactPii))) as {
          enrichment: { notice: string; totalCount: number };
        };
        expect(result.enrichment).toMatchObject({
          totalCount: 0,
          notice: `${limits} ${sentence} ${absence} ${route}`,
        });
      }
  });

  it('counts a redacted full-name search without its credential filters, itself an allowed call', async () => {
    const service = registry(true);
    const result = await service.verifyCertificates({ ...full, certificateType: 'M' });
    expect(result.enrichment).toMatchObject({
      totalCount: 0,
      piiRedacted: true,
      notice: `${limits} ${redactionNotice} ${absence} 2 people match this name search without certificateType, and none holds a certificate matching the requested certificate type in this snapshot.`,
    });
    expect((await service.verifyCertificates(full)).enrichment.totalCount).toBe(2);
    const nobody = await service.verifyCertificates({
      mode: 'name',
      lastName: 'absent',
      firstName: 'nobody',
      certificateType: 'M',
    });
    expect(nobody.enrichment.notice).toBe(
      `${limits} ${redactionNotice} ${absence} No person matches this name search even without certificateType. ${identifiersRoute}`,
    );
  });

  it('counts a redacted full-name instructor search without its rating codes, itself an allowed call', async () => {
    const service = registry(true);
    const { lastName, firstName } = full;
    const result = await service.searchInstructors({ lastName, firstName, ratingCodes: ['MEI'] });
    expect(result.enrichment).toMatchObject({
      totalCount: 0,
      piiRedacted: true,
      notice: `${limits} ${redactionNotice} ${absence} ${instructorsCounted('2 flight or ground instructors match', 'flight or ground instructor', 'the requested code')} ${ratingsRoute} ${alternatives}`,
    });
    expect((await service.searchInstructors({ lastName, firstName })).enrichment.totalCount).toBe(
      2,
    );
    const ground = await service.searchInstructors({
      lastName,
      firstName,
      instructorType: 'ground',
      ratingCodes: ['MEI'],
    });
    expect(ground.enrichment.notice).toBe(
      `${limits} ${redactionNotice} ${absence} ${noInstructor('ground instructor')} ${identifiersRoute}`,
    );
  });

  it.each([false, true])(
    'reports piiRedacted %s on every success and states the mode in mirror_status and identifiers',
    async (redactPii) => {
      const service = registry(redactPii, true);
      const successes = [
        await service.verifyCertificates({ mode: 'id', uniqueId: 'A5000001' }),
        await service.verifyCertificates({ mode: 'name', lastName: 'absent', firstName: 'nobody' }),
        await service.verifyRemotePilot({ mode: 'id', uniqueId: 'A5000001' }),
        await service.searchInstructors({ lastName: 'fixture', firstName: 'synthetic' }),
        await service.getRatings({ uniqueId: 'A5000001' }),
        await service.getRatings({ uniqueId: 'C0000000' }),
        ...(redactPii ? [] : [await service.getMedical({ uniqueId: 'A5000001' })]),
        ...(await Promise.all(REFERENCE_TOPICS.map((topic) => service.listReference({ topic })))),
        await registry(redactPii, false, empty).listReference({ topic: 'mirror_status' }),
      ];
      for (const result of successes) expect(result.enrichment.piiRedacted).toBe(redactPii);
      const guidance = async (topic: 'mirror_status' | 'identifiers') =>
        (await service.listReference({ topic })).data.entries[0]!.guidance ?? '';
      expect(await guidance('mirror_status')).toMatch(
        redactPii
          ? / Personal-data redaction: on, so city, ZIP, and medical fields are withheld and name searches require both lastName and firstName; the operator turns it off with FAA_AIRMEN_REDACT_PII=false\.$/
          : / Location import policy: enabled\. Personal-data redaction: off\.$/,
      );
      const identifierGuidance = await guidance('identifiers');
      if (redactPii)
        expect(identifierGuidance).toMatch(
          / Personal-data redaction is on: name searches require both lastName and firstName, or a Unique ID; nameMatch prefix and city or ZIP filters are rejected, city and ZIP are withheld, and faa_airmen_check_medical_status is unavailable\. The operator turns it off with FAA_AIRMEN_REDACT_PII=false\.$/,
        );
      else expect(identifierGuidance).not.toContain('redaction');
    },
  );
});
