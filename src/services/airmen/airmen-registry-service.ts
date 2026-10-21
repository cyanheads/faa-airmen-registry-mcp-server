/**
 * @fileoverview Normalized, privacy-gated offline queries over one immutable FAA generation.
 * @module services/airmen/airmen-registry-service
 */
import type { Context } from '@cyanheads/mcp-ts-core';
import {
  databaseError,
  forbidden,
  McpError,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { ServerConfig } from '../../config/server-config.js';
import { AirmenMirror, type MirrorDependencies } from './airmen-mirror.js';
import type {
  Airman,
  AppliedFilters,
  Certificate,
  CertificateMatch,
  Identity,
  IdentityInput,
  InstructorInput,
  InstructorMatch,
  ListEnrichment,
  MedicalData,
  MedicalRecord,
  NameInput,
  Paging,
  QueryResult,
  Rating,
  RatingsData,
  ReferenceData,
  ReferenceInput,
  RemotePilotMatch,
  SingleEnrichment,
  VerifyInput,
} from './contracts.js';
import { MirrorError } from './mirror-error.js';
import { describeCode, FAA_SOURCE_URL, obsoleteRating, staticReference } from './reference.js';
import type { Provenance, SnapshotDatabase, SnapshotLease, SourceFamily } from './types.js';

const limits =
  'Snapshot presence and absence do not determine current certification, operating privileges, training currency, medical fitness, or eligibility; address-withheld airmen are omitted.';
const medicalDisclaimer =
  'FAA medical fields are informational and are not authoritative evidence of medical certification, fitness, or eligibility to operate.';
const noMatch =
  'No record matched this releasable snapshot. This does not establish that a person is uncertificated. Check faa_airmen_list_reference with topic identifiers, then retry with fewer name filters.';
const aliases: Record<string, string> = {
  PILOT: 'P',
  CFI: 'F',
  REMOTE_PILOT: 'U',
  GROUND_INSTRUCTOR: 'G',
  MECHANIC: 'M',
  DISPATCHER: 'D',
};
const nameKeys = ['lastName', 'firstName', 'state', 'city', 'zipCode', 'nameMatch'];
const identityKeys = ['mode', 'uniqueId', ...nameKeys];
const pageKeys = ['limit', 'offset'];
const pageBudget = 24 * 1024;
type Row = Record<string, string | null>;
interface Where {
  bindings: string[];
  sql: string;
}
interface NormalizedName {
  city?: string;
  firstName?: string;
  lastName?: string;
  nameMatch: 'exact' | 'prefix';
  state?: string;
  zipCode?: string;
}
type Selector = { mode: 'id'; uniqueId: string } | ({ mode: 'name' } & NormalizedName);
function fail(reason: 'invalid_identity' | 'invalid_filter' | 'missing_search_filter'): never {
  throw validationError('The supplied identity or filter combination is invalid.', {
    reason,
    retryable: false,
  });
}
function keys(input: object, allowed: string[]) {
  if (Object.keys(input).some((key) => !allowed.includes(key))) fail('invalid_filter');
}
function text(
  value: string | undefined,
  reason: 'invalid_identity' | 'invalid_filter' = 'invalid_filter',
  max = 60,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}]/u.test(value)) fail(reason);
  const normalized = value.trim().replace(/\s+/gu, ' ').toUpperCase();
  if (!normalized) return undefined;
  if (normalized.length > max) fail(reason);
  return normalized;
}
function id(value: string | undefined) {
  const normalized = text(value, 'invalid_identity');
  if (!normalized || !/^[AC][0-9]{7}$/.test(normalized)) fail('invalid_identity');
  return normalized;
}
function paging(input: Paging): Required<Paging> {
  const limit = input.limit ?? 10,
    offset = input.offset ?? 0;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 10000
  )
    fail('invalid_filter');
  return { limit, offset };
}
function names(input: NameInput, includeLocation: boolean): NormalizedName {
  // Gate nonblank location values before format validation or any mirror access.
  if (
    !includeLocation &&
    [input.city, input.zipCode].some((value) => typeof value === 'string' && value.trim())
  )
    throw forbidden('City and ZIP access is disabled by the operator.', {
      reason: 'location_access_disabled',
      retryable: false,
    });
  const lastName = text(input.lastName, 'invalid_identity'),
    firstName = text(input.firstName, 'invalid_identity');
  const state = text(input.state),
    city = text(input.city),
    rawZip = text(input.zipCode);
  if (state && !/^[A-Z]{2}$/.test(state)) fail('invalid_filter');
  if (rawZip && !/^\d{5}(?:-?\d{4})?$/.test(rawZip)) fail('invalid_filter');
  const zipCode = rawZip?.length === 9 ? `${rawZip.slice(0, 5)}-${rawZip.slice(5)}` : rawZip;
  const nameMatch = input.nameMatch ?? 'exact';
  if (nameMatch !== 'exact' && nameMatch !== 'prefix') fail('invalid_filter');
  return {
    ...(lastName && { lastName }),
    ...(firstName && { firstName }),
    ...(state && { state }),
    ...(city && { city }),
    ...(zipCode && { zipCode }),
    nameMatch,
  };
}
function selector(input: IdentityInput, includeLocation: boolean): Selector {
  const normalized = names(input, includeLocation);
  if (input.mode === 'id') {
    if (
      Object.entries(normalized).some(([key, value]) => key !== 'nameMatch' && Boolean(value)) ||
      input.nameMatch !== undefined
    )
      fail('invalid_identity');
    return { mode: 'id', uniqueId: id(input.uniqueId) };
  }
  if (input.mode !== 'name' || text(input.uniqueId, 'invalid_identity') || !normalized.lastName)
    fail('invalid_identity');
  return { mode: 'name', ...normalized };
}
function typeCode(value?: string): string | undefined {
  const code = text(value);
  if (!code) return undefined;
  const result = aliases[code] ?? code;
  if (!/^[A-Z]$/.test(result)) fail('invalid_filter');
  return result;
}
function like(value: string) {
  return value.replace(/[\\%_]/g, '\\$&');
}
function identityWhere(value: Selector | NormalizedName): Where {
  if ('mode' in value && value.mode === 'id')
    return { sql: 'a.unique_id=?', bindings: [value.uniqueId] };
  const name = value as NormalizedName;
  const clauses = ['v.unique_id=a.unique_id', "v.origin='basic'"],
    bindings: string[] = [];
  for (const [key, column] of [
    ['lastName', 'last_name_normalized'],
    ['firstName', 'first_name_normalized'],
  ] as const) {
    const term = name[key];
    if (term) {
      clauses.push(
        name.nameMatch === 'prefix' ? `v.${column} LIKE ? ESCAPE '\\'` : `v.${column}=?`,
      );
      bindings.push(name.nameMatch === 'prefix' ? `${like(term)}%` : term);
    }
  }
  for (const [key, column] of [
    ['state', 'state'],
    ['city', 'city'],
    ['zipCode', 'zip_code'],
  ] as const) {
    const term = name[key];
    if (term) {
      clauses.push(key === 'zipCode' ? "REPLACE(v.zip_code,'-','')=?" : `UPPER(v.${column})=?`);
      bindings.push(key === 'zipCode' ? term.replace('-', '') : term);
    }
  }
  return {
    sql: `EXISTS(SELECT 1 FROM identity_variants v WHERE ${clauses.join(' AND ')})`,
    bindings,
  };
}
function certificateWhere(types: string[], ratings: string[] = []): Where {
  const bindings = [...types],
    clauses = [`c.type IN (${types.map(() => '?').join(',')})`];
  for (const code of ratings) {
    clauses.push(
      "EXISTS(SELECT 1 FROM ratings r WHERE r.record_id=c.record_id AND r.kind='rating' AND r.code=?)",
    );
    bindings.push(code);
  }
  return { sql: clauses.join(' AND '), bindings };
}
function identity(row: Row, location: boolean): Identity {
  const result: Identity = { firstName: row.first_name ?? '', lastName: row.last_name ?? '' };
  for (const [column, key] of [
    ['state', 'state'],
    ['country', 'country'],
    ['region', 'region'],
    ...(location
      ? [
          ['city', 'city'],
          ['zip_code', 'zipCode'],
        ]
      : []),
  ] as [string, keyof Identity][]) {
    const value = row[column];
    if (value) result[key] = value;
  }
  return result;
}
function families(value: string | null | undefined): SourceFamily[] {
  return JSON.parse(value ?? '[]');
}
function airman(db: SnapshotDatabase, row: Row, location: boolean): Airman {
  const primary = identity(row, location);
  const variants = db
    .prepare<Row>(
      "SELECT * FROM identity_variants WHERE unique_id=? ORDER BY CASE family WHEN 'pilot' THEN 0 ELSE 1 END,origin,tuple",
    )
    .all(row.unique_id ?? '');
  const different = variants
    .filter((variant) => {
      const projected = identity(variant, location);
      return variant.origin === 'certificate'
        ? projected.firstName !== primary.firstName || projected.lastName !== primary.lastName
        : JSON.stringify(projected) !== JSON.stringify(primary);
    })
    .map((variant) => ({
      ...identity(variant, location),
      sourceFamily: variant.family as SourceFamily,
      origin: variant.origin as 'basic' | 'certificate',
    }));
  return {
    uniqueId: row.unique_id ?? '',
    ...primary,
    sourceFamilies: families(row.source_families),
    ...(different.length && { identityVariants: different }),
  };
}
function certificates(db: SnapshotDatabase, ids: string[]): Map<string, Certificate[]> {
  const result = new Map<string, Certificate[]>();
  if (!ids.length) return result;
  const rows = db
    .prepare<Row & { ordinal: number | null }>(
      `SELECT c.*,r.kind,r.ordinal,r.raw,r.level_code,r.code FROM certificates c LEFT JOIN ratings r ON c.record_id=r.record_id WHERE c.unique_id IN (${ids.map(() => '?').join(',')}) ORDER BY c.unique_id,c.type,c.level,c.record_id,r.kind,r.ordinal`,
    )
    .all(...ids);
  const records = new Map<string, Certificate>();
  for (const row of rows) {
    const recordId = row.record_id ?? '';
    let record = records.get(recordId);
    if (!record) {
      record = {
        recordId,
        sourceFamilies: families(row.source_families),
        type: describeCode(row.type ?? '', 'type'),
        ...(row.level && { level: describeCode(row.level, 'level', row.type ?? '') }),
        ...(row.legacy_expire_date_raw && { legacyExpireDateRaw: row.legacy_expire_date_raw }),
        ratings: [],
        typeRatings: [],
      };
      records.set(recordId, record);
      const person = result.get(row.unique_id ?? '') ?? [];
      person.push(record);
      result.set(row.unique_id ?? '', person);
    }
    if (row.raw !== null && row.ordinal !== null) {
      const rating: Rating = {
        raw: row.raw ?? '',
        ordinal: row.ordinal,
        ...(row.kind === 'rating'
          ? { ...describeCode(row.code ?? '', 'rating'), ...obsoleteRating(row.code ?? '') }
          : { code: row.code ?? '' }),
        ...(row.level_code && { levelCode: row.level_code }),
      };
      (row.kind === 'type_rating' ? record.typeRatings : record.ratings).push(rating);
    }
  }
  return result;
}
function notice(provenance: Provenance | null, location: boolean, extra = '') {
  return [
    extra,
    limits,
    provenance?.stale
      ? 'This snapshot exceeds the configured source-age threshold; ask the operator to refresh it.'
      : '',
    !location ? 'City and ZIP access is disabled by the operator.' : '',
    provenance && Object.values(provenance.warnings).some(Boolean)
      ? 'The snapshot contains unknown codes or malformed source dates/ratings; raw values are retained.'
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}
function single(
  provenance: Provenance | null,
  appliedFilters: AppliedFilters,
  location: boolean,
  extra = '',
): SingleEnrichment {
  return { provenance, appliedFilters, notice: notice(provenance, location, extra) };
}
function finalPage<T>(
  entries: T[],
  total: number,
  page: Required<Paging>,
  enrichment: SingleEnrichment,
  empty: string,
): { entries: T[]; enrichment: ListEnrichment } {
  let selected = entries;
  // Reserve room for lossless content plus structuredContent, their enrichment, and the envelope.
  while (
    selected.length > 1 &&
    Buffer.byteLength(JSON.stringify({ entries: selected, enrichment })) * 2 + 2048 > pageBudget
  )
    selected = selected.slice(0, -1);
  const returnedCount = selected.length,
    next = page.offset + returnedCount;
  const remaining = returnedCount > 0 && next < total,
    atPagingCap = remaining && next > 10000;
  const extra =
    total === 0
      ? empty
      : page.offset >= total
        ? 'This page is past the available results; repeat the same tool with offset 0.'
        : '';
  const oversized =
    selected.length === 1 &&
    Buffer.byteLength(JSON.stringify({ entries: selected, enrichment })) * 2 + 2048 > pageBudget;
  return {
    entries: selected,
    enrichment: {
      ...enrichment,
      totalCount: total,
      returnedCount,
      hasMore: remaining && !atPagingCap,
      nextOffset: remaining && !atPagingCap ? next : null,
      atPagingCap,
      notice: [
        enrichment.notice,
        extra,
        atPagingCap ? 'Narrow the filters to reach remaining results within the offset cap.' : '',
        oversized
          ? 'One complete person exceeds the response byte budget; all source credentials are retained.'
          : '',
      ]
        .filter(Boolean)
        .join(' '),
    },
  };
}

/** Domain service; no query triggers acquisition, mutation, or network access. */
export class AirmenRegistryService {
  readonly mirror: AirmenMirror;
  constructor(
    readonly config: ServerConfig,
    dependencies: MirrorDependencies = {},
  ) {
    this.mirror = new AirmenMirror(config, dependencies);
  }
  status() {
    return this.mirror.status();
  }
  initialize(signal?: AbortSignal) {
    return this.mirror.initialize(signal);
  }
  refresh(signal?: AbortSignal) {
    return this.mirror.refresh(signal);
  }
  verifyMirror() {
    return this.mirror.verifyMirror();
  }
  private async read<T extends QueryResult<unknown>>(
    location: boolean,
    run: (lease: SnapshotLease) => T,
    ctx?: Context,
  ): Promise<T> {
    ctx?.signal?.throwIfAborted();
    try {
      using lease = await this.mirror.acquire();
      if (location && !lease.metadata.includeLocation)
        throw serviceUnavailable('The snapshot must be rebuilt before location filtering.', {
          reason: 'mirror_rebuild_required',
          retryable: false,
        });
      const result = run(lease);
      const lifecycle = await this.mirror.status();
      if (lifecycle.refresh?.status === 'failed')
        result.enrichment.notice +=
          ' The latest refresh failed; this result uses the last complete published generation.';
      ctx?.signal?.throwIfAborted();
      return result;
    } catch (error) {
      if (ctx?.signal?.aborted || error instanceof McpError) throw error;
      if (error instanceof MirrorError && error.stage === 'missing')
        throw serviceUnavailable('Local FAA mirror is not initialized.', {
          reason: 'mirror_missing',
          retryable: false,
        });
      throw databaseError(
        'Local FAA mirror could not be read; ask the operator to verify or rebuild it.',
        { reason: 'mirror_unavailable', retryable: true },
      );
    }
  }
  private people<T>(
    selectorValue: Selector | NormalizedName,
    page: Required<Paging>,
    filters: AppliedFilters,
    qualify: Where | undefined,
    project: (airman: Airman, certificates: Certificate[]) => T,
    ctx?: Context,
  ): Promise<QueryResult<{ matches: T[] }, ListEnrichment>> {
    const where = identityWhere(selectorValue);
    if (qualify) {
      where.sql += ` AND EXISTS(SELECT 1 FROM certificates c WHERE c.unique_id=a.unique_id AND ${qualify.sql})`;
      where.bindings.push(...qualify.bindings);
    }
    return this.read(
      Boolean(
        ('city' in selectorValue && selectorValue.city) ||
          ('zipCode' in selectorValue && selectorValue.zipCode),
      ),
      (lease) => {
        const total =
          lease.db
            .prepare<{ n: number }>(`SELECT COUNT(*) n FROM airmen a WHERE ${where.sql}`)
            .get(...where.bindings)?.n ?? 0;
        const rows = lease.db
          .prepare<Row>(
            `SELECT a.* FROM airmen a WHERE ${where.sql} ORDER BY a.last_name_normalized,a.first_name_normalized,a.unique_id LIMIT ? OFFSET ?`,
          )
          .all(...where.bindings, page.limit, page.offset);
        const certs = certificates(
          lease.db,
          rows.map((row) => row.unique_id ?? ''),
        );
        const matches = rows.map((row) =>
          project(
            airman(lease.db, row, this.config.includeLocation),
            certs.get(row.unique_id ?? '') ?? [],
          ),
        );
        const finalized = finalPage(
          matches,
          total,
          page,
          single(lease.provenance, filters, this.config.includeLocation),
          qualify
            ? `${noMatch} The requested certificate type or qualifying ratings were not found in this snapshot.`
            : noMatch,
        );
        return { data: { matches: finalized.entries }, enrichment: finalized.enrichment };
      },
      ctx,
    );
  }
  /** Type filters select people without hiding their other certificates. */
  verifyCertificates(
    input: VerifyInput,
    ctx?: Context,
  ): Promise<QueryResult<{ matches: CertificateMatch[] }, ListEnrichment>> {
    keys(input, [...identityKeys, ...pageKeys, 'certificateType']);
    const selected = selector(input, this.config.includeLocation),
      page = paging(input),
      certificateType = typeCode(input.certificateType);
    return this.people(
      selected,
      page,
      { ...selected, ...page, ...(certificateType && { certificateType }) },
      certificateType ? certificateWhere([certificateType]) : undefined,
      (airman, certificates) => ({ airman, certificates }),
      ctx,
    );
  }
  /** Remote pilot matches retain all U certificate records, without a currency verdict. */
  verifyRemotePilot(
    input: IdentityInput & Paging,
    ctx?: Context,
  ): Promise<QueryResult<{ matches: RemotePilotMatch[] }, ListEnrichment>> {
    keys(input, [...identityKeys, ...pageKeys]);
    const selected = selector(input, this.config.includeLocation),
      page = paging(input);
    return this.people(
      selected,
      page,
      { ...selected, ...page, certificateType: 'U' },
      certificateWhere(['U']),
      (airman, records) => ({
        airman,
        remotePilotCertificates: records.filter((record) => record.type.code === 'U'),
      }),
      ctx,
    );
  }
  /** Every requested rating must occur on one qualifying instructor certificate. */
  searchInstructors(
    input: InstructorInput,
    ctx?: Context,
  ): Promise<QueryResult<{ matches: InstructorMatch[] }, ListEnrichment>> {
    keys(input, [...nameKeys, ...pageKeys, 'instructorType', 'ratingCodes']);
    const selected = names(input, this.config.includeLocation),
      page = paging(input),
      instructorType = input.instructorType ?? 'both';
    if (!['flight', 'ground', 'both'].includes(instructorType)) fail('invalid_filter');
    const ratingCodes = input.ratingCodes?.map((code) => text(code));
    if (
      ratingCodes &&
      (!ratingCodes.length ||
        ratingCodes.length > 11 ||
        ratingCodes.some((code) => !code || !/^[A-Z0-9 -]{1,30}$/.test(code)) ||
        new Set(ratingCodes).size !== ratingCodes.length)
    )
      fail('invalid_filter');
    const ratings = (ratingCodes ?? []) as string[];
    if (
      !selected.lastName &&
      !selected.firstName &&
      !selected.state &&
      !selected.city &&
      !selected.zipCode &&
      !ratings.length
    )
      fail('missing_search_filter');
    const types =
      instructorType === 'flight' ? ['F'] : instructorType === 'ground' ? ['G'] : ['F', 'G'];
    return this.people(
      selected,
      page,
      {
        ...selected,
        ...page,
        instructorType,
        ratingCodes: ratings,
        ratingSemantics: 'all codes on the same qualifying certificate',
      },
      certificateWhere(types, ratings),
      (airman, records) => ({
        airman,
        instructorCertificates: records.filter(
          (record) =>
            types.includes(record.type.code) &&
            ratings.every((code) => record.ratings.some((rating) => rating.code === code)),
        ),
      }),
      ctx,
    );
  }
  /** Retrieve every pilot-family certificate with complete ordered rating slots. */
  getRatings(input: { uniqueId: string }, ctx?: Context): Promise<QueryResult<RatingsData>> {
    keys(input, ['uniqueId']);
    const uniqueId = id(input.uniqueId);
    return this.read(
      false,
      (lease) => {
        const row = lease.db.prepare<Row>('SELECT * FROM airmen WHERE unique_id=?').get(uniqueId);
        if (!row)
          return {
            data: { found: false },
            enrichment: single(
              lease.provenance,
              { uniqueId },
              this.config.includeLocation,
              'No person matched this snapshot; use faa_airmen_verify_certificate with mode name to discover candidate IDs.',
            ),
          };
        const records = (certificates(lease.db, [uniqueId]).get(uniqueId) ?? []).filter((record) =>
          record.sourceFamilies.includes('pilot'),
        );
        return {
          data: {
            found: true,
            airman: airman(lease.db, row, this.config.includeLocation),
            certificates: records,
          },
          enrichment: single(
            lease.provenance,
            { uniqueId },
            this.config.includeLocation,
            records.length
              ? ''
              : 'No pilot-family certificate was reported; use faa_airmen_verify_certificate for non-pilot credentials.',
          ),
        };
      },
      ctx,
    );
  }
  /** Return medical information without calculating expiry, fitness, or eligibility. */
  getMedical(input: { uniqueId: string }, ctx?: Context): Promise<QueryResult<MedicalData>> {
    keys(input, ['uniqueId']);
    const uniqueId = id(input.uniqueId);
    return this.read(
      false,
      (lease) => {
        const row = lease.db.prepare<Row>('SELECT * FROM airmen WHERE unique_id=?').get(uniqueId);
        if (!row)
          return {
            data: { found: false, disclaimer: medicalDisclaimer },
            enrichment: single(
              lease.provenance,
              { uniqueId },
              this.config.includeLocation,
              'No person matched this snapshot; use faa_airmen_verify_certificate with mode name to discover candidate IDs.',
            ),
          };
        const medicalRecords: MedicalRecord[] = lease.db
          .prepare<Row>('SELECT * FROM medical_records WHERE unique_id=? ORDER BY tuple')
          .all(uniqueId)
          .map((record) => ({
            sourceFamilies: families(record.source_families),
            ...(record.med_class && { medicalClass: describeCode(record.med_class, 'medical') }),
            ...(record.med_date && { medicalDateRaw: record.med_date }),
            ...(record.med_exp_date && { medicalExpireDateRaw: record.med_exp_date }),
            ...(record.basicmed_course_date && {
              basicMedCourseDateRaw: record.basicmed_course_date,
            }),
            ...(record.basicmed_cmec_date && { basicMedCmecDateRaw: record.basicmed_cmec_date }),
          }));
        return {
          data: {
            found: true,
            airman: airman(lease.db, row, this.config.includeLocation),
            medicalRecords,
            hasReportedMedicalFields: medicalRecords.length > 0,
            disclaimer: medicalDisclaimer,
          },
          enrichment: single(
            lease.provenance,
            { uniqueId },
            this.config.includeLocation,
            medicalRecords.length
              ? ''
              : 'The person is present but no medical or BasicMed fields were reported; this is not an adverse finding.',
          ),
        };
      },
      ctx,
    );
  }
  /** Static references and status work before mirror initialization. */
  async listReference(
    input: ReferenceInput,
    ctx?: Context,
  ): Promise<QueryResult<ReferenceData, ListEnrichment>> {
    keys(input, ['topic', 'filter', ...pageKeys]);
    const page = paging(input),
      filter = text(input.filter, 'invalid_filter', 80),
      topic = input.topic;
    if (
      ![
        'certificate_types',
        'certificate_levels',
        'ratings',
        'type_ratings',
        'identifiers',
        'medical_guidance',
        'mirror_status',
      ].includes(topic) ||
      (filter && ['identifiers', 'medical_guidance', 'mirror_status'].includes(topic))
    )
      fail('invalid_filter');
    const finish = (
      entries: ReferenceData['entries'],
      provenance: Provenance | null,
      mirrorStatus?: ReferenceData['mirrorStatus'],
    ): QueryResult<ReferenceData, ListEnrichment> => {
      const filtered = entries
        .filter(
          (entry) =>
            !filter || `${entry.code} ${entry.description ?? ''}`.toUpperCase().includes(filter),
        )
        .sort(
          (a, b) =>
            a.code.localeCompare(b.code) ||
            (a.certificateType ?? '').localeCompare(b.certificateType ?? ''),
        );
      const enrichment = provenance
        ? single(
            provenance,
            { topic, ...page, ...(filter && { filter }) },
            this.config.includeLocation,
          )
        : {
            provenance: null,
            appliedFilters: { topic, ...page, ...(filter && { filter }) },
            notice: '',
          };
      const result = finalPage(
        filtered.slice(page.offset, page.offset + page.limit),
        filtered.length,
        page,
        enrichment,
        'No reference entry matched; retry faa_airmen_list_reference without filter.',
      );
      return {
        data: { topic, entries: result.entries, ...(mirrorStatus && { mirrorStatus }) },
        enrichment: result.enrichment,
      };
    };
    if (topic === 'type_ratings')
      return this.read(
        false,
        (lease) =>
          finish(
            lease.db
              .prepare<{ code: string }>(
                "SELECT DISTINCT code FROM ratings WHERE kind='type_rating' ORDER BY code",
              )
              .all()
              .map((row) => ({ code: row.code, sourceUrls: [FAA_SOURCE_URL] })),
            lease.provenance,
          ),
        ctx,
      );
    if (topic === 'mirror_status') {
      const status = await this.status();
      const mirrorStatus: NonNullable<ReferenceData['mirrorStatus']> = {
        state: status.status,
        refreshState:
          status.refresh?.status === 'in_progress'
            ? 'running'
            : status.refresh?.status === 'failed'
              ? 'failed'
              : 'idle',
        ...(status.provenance && { provenance: status.provenance }),
        ...(status.refresh?.status === 'failed' && {
          lastRefreshFailure: status.refresh.stage ?? 'unavailable',
        }),
      };
      return finish(
        [
          {
            code: 'mirror_status',
            guidance: `Mirror state: ${status.status}. Initialize with faa-airmen-registry-mirror init; refresh with faa-airmen-registry-mirror refresh. Location import policy: ${status.importPolicy?.includeLocation === true ? 'enabled' : status.importPolicy === null ? 'not yet imported' : 'disabled'}.`,
            sourceUrls: [FAA_SOURCE_URL],
          },
        ],
        status.provenance,
        mirrorStatus,
      );
    }
    return finish(staticReference(topic), null);
  }
}
let service: AirmenRegistryService | undefined;
/** Initialize one process-level domain service without opening or downloading a mirror. */
export function initAirmenRegistryService(
  config: ServerConfig,
  dependencies: MirrorDependencies = {},
): AirmenRegistryService {
  service = new AirmenRegistryService(config, dependencies);
  return service;
}
/** Access the service initialized by createApp setup. */
export function getAirmenRegistryService(): AirmenRegistryService {
  if (!service)
    throw new Error(
      'AirmenRegistryService is not initialized; call initAirmenRegistryService in setup.',
    );
  return service;
}
