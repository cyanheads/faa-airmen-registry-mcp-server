/** Query behavior over real synthetic FAA snapshots, never mocked SQL/domain logic. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AirmenRegistryService } from '../../src/services/airmen/airmen-registry-service.js';
import {
  basicRow,
  certificateRow,
  sourceFetch,
  sourceFiles,
  zipSource,
} from '../helpers/airmen-source.js';

describe('offline FAA registry queries', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'faa-query-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  function service(includeLocation = false, bytes = zipSource()) {
    return new AirmenRegistryService(
      { mirrorDir: directory, includeLocation, staleAfterDays: 45 },
      { fetch: sourceFetch(bytes), clock: () => new Date('2026-10-20T00:00:00Z') },
    );
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
      ['ratings', 54],
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
      [
        () => registry.verifyCertificates({ mode: 'name', lastName: 'PRIVATE INPUT', limit: 51 }),
        'invalid_filter',
      ],
      [() => registry.searchInstructors({ firstName: ' ' }), 'missing_search_filter'],
      [
        () => registry.searchInstructors({ state: 'WA', ratingCodes: ['ASEL', 'asel'] }),
        'invalid_filter',
      ],
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
    const bytes = zipSource(
      sourceFiles({
        pilotBasic: ids.map((id) => basicRow(id)),
        pilotCert: ids.map((id) => certificateRow(id)),
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
    expect(result.enrichment).toMatchObject({
      totalCount: 10004,
      returnedCount: 1,
      hasMore: false,
      nextOffset: null,
      atPagingCap: true,
    });
    expect(result.enrichment.notice).toContain('Narrow the filters');
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
        pilotCert: ids.map((id) => certificateRow(id, true, longRatings)),
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
    expect(first.data.matches[0]!.certificates[0]!.typeRatings).toHaveLength(99);
    expect(first.enrichment).toMatchObject({
      totalCount: 4,
      returnedCount: 1,
      hasMore: true,
      nextOffset: 1,
    });
    expect(first.enrichment.notice).toContain('all source credentials are retained');
    const next = await registry.verifyCertificates({
      mode: 'name',
      lastName: 'FIXTURE',
      limit: 50,
      offset: first.enrichment.nextOffset!,
    });
    expect(next.data.matches[0]!.airman.uniqueId).not.toBe(first.data.matches[0]!.airman.uniqueId);
    expect(next.enrichment.nextOffset).toBe(2);
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
    expect(ratings.enrichment.notice).toContain('No pilot-family certificate');
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
        nameMatch: 'exact',
        limit: 10,
        offset: 0,
      });
      expect(
        (await registry.listReference({ topic: 'ratings', filter: ' no such code ' })).enrichment,
      ).toMatchObject({ totalCount: 0, returnedCount: 0, hasMore: false, nextOffset: null });
    },
  );
});
