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
import {
  type Airman,
  type AppliedFilters,
  type CallProvenance,
  type Certificate,
  type CertificateMatch,
  type Code,
  type Identity,
  type IdentityInput,
  type InstructorInput,
  type InstructorMatch,
  type ListEnrichment,
  type MedicalData,
  type MedicalRecord,
  NAME_MATCHES,
  type NameInput,
  type NameMatch,
  type Paging,
  type QueryResult,
  type Rating,
  type RatingsData,
  REFERENCE_TOPICS,
  type ReferenceData,
  type ReferenceInput,
  type ReferenceTopic,
  type RemotePilotMatch,
  type SingleEnrichment,
  type VerifyInput,
} from './contracts.js';
import {
  isMalformedSlot,
  MONTH_DAY_YEAR,
  MONTH_YEAR,
  normalizeName,
  UNIQUE_ID,
  YEAR_MONTH_DAY,
} from './importer.js';
import { MirrorError } from './mirror-error.js';
import {
  certificateTypeFor,
  describeCode,
  FAA_SOURCE_URL,
  instructorAlternatives,
  NON_STATE_CODES,
  obsoleteRating,
  STATE_CODES,
  staticReference,
  UNIQUE_ID_SOURCE,
} from './reference.js';
import type {
  Provenance,
  RefreshState,
  SnapshotDatabase,
  SnapshotLease,
  SourceFamily,
} from './types.js';

const limits =
  'Snapshot presence and absence do not determine current certification, operating privileges, training currency, medical fitness, or eligibility; address-withheld airmen are omitted.';
const medicalDisclaimer =
  'FAA medical fields are informational and are not authoritative evidence of medical certification, fitness, or eligibility to operate.';
const noPerson =
  'No person matched this snapshot; use faa_airmen_verify_certificate with mode name to discover candidate IDs.';
/** Name and location filters a person query can send. */
const identityFilters = ['lastName', 'firstName', 'state', 'city', 'zipCode'] as const;
const nameKeys = [...identityFilters, 'nameMatch'];
const identityKeys = ['mode', 'uniqueId', ...nameKeys];
const pageKeys = ['limit', 'offset'];
const pageBudget = 24 * 1024;
const maxLimit = 50;
const limitClamped = `A limit above ${maxLimit} returns at most ${maxLimit}.`;
/** A rating code or type-rating designator. */
const codePart = /^[A-Z0-9 -]{1,30}$/;
/** One uppercase letter: a certificate type, a certificate level, or the level before a filter's slash. */
const singleLetter = /^[A-Z]$/;
type Row = Record<string, string | null>;
interface Where {
  bindings: string[];
  sql: string;
}
interface NormalizedName {
  city?: string;
  firstName?: string;
  lastName?: string;
  nameMatch: NameMatch;
  state?: string;
  zipCode?: string;
}
type Selector = { mode: 'id'; uniqueId: string } | ({ mode: 'name' } & NormalizedName);
/** A normalized rating filter: a bare code matches any level, `level/code` that level only. */
interface CodeFilter {
  code: string;
  level?: string;
}
type Reason = 'invalid_identity' | 'invalid_filter' | 'missing_search_filter';
/** Reject with a hint; in a name search the name gate will refuse, the hint also names that search. */
function fail(reason: Reason, message: string, hint?: string, serving?: Serving): never {
  const recovery = hint && serving?.refusesNames ? `${hint} ${namesToo}` : hint;
  throw validationError(message, {
    reason,
    retryable: false,
    ...(recovery && { recovery: { hint: recovery } }),
  });
}
const nameRule = (field: 'lastName' | 'firstName', source: string, optional: string) => ({
  reason: 'invalid_identity' as const,
  expected: 'at most 60 characters with no control or format characters',
  hint: `Retry with ${field} as written in the FAA ${source} field, at most 60 characters${optional}.`,
});
/** Each validated field's reason, expected form, and next step; never the rejected value. */
const fieldRules = {
  uniqueId: {
    reason: 'invalid_identity',
    expected: 'A or C plus seven digits, such as A9999999',
    hint: `Copy uniqueId from ${UNIQUE_ID_SOURCE}; it is not a certificate number.`,
  },
  lastName: nameRule('lastName', 'LAST NAME', ''),
  firstName: nameRule('firstName', 'FIRST NAME', ', or omit it'),
  state: {
    reason: 'invalid_filter',
    expected: 'a two-letter USPS state, territory, or military code',
    hint: `Send state as a two-letter USPS code: a state such as WA, or ${joined(NON_STATE_CODES, 'or')}; omit it otherwise, since airmen with foreign addresses carry no state.`,
  },
  city: {
    reason: 'invalid_filter',
    expected: 'at most 60 characters with no control or format characters',
    hint: 'Retry with city as at most 60 characters, or omit it.',
  },
  zipCode: {
    reason: 'invalid_filter',
    expected: 'five digits or ZIP+4',
    hint: 'Send zipCode as 99999, 99999-1234, or 999991234, or omit it.',
  },
  nameMatch: {
    reason: 'invalid_filter',
    expected: 'words, exact, or prefix',
    hint: 'Send nameMatch words, exact, or prefix, or omit it for words.',
  },
  certificateType: {
    reason: 'invalid_filter',
    expected: 'one certificate type letter, a certificate_types description, or CFI',
    hint: 'Call faa_airmen_list_reference with topic certificate_types and send a listed code or description, or omit certificateType together with any certificateLevel.',
  },
  certificateLevel: {
    reason: 'invalid_filter',
    expected: 'one certificate level letter',
    hint: 'Call faa_airmen_list_reference with topic certificate_levels and send a level letter listed for the certificateType, or omit certificateLevel.',
  },
  ratingCodes: {
    reason: 'invalid_filter',
    expected:
      '1–11 codes, each 1–30 letters, digits, spaces, or hyphens, optionally after a one-letter level and a slash',
    hint: 'Call faa_airmen_list_reference with topic ratings and send listed codes, bare or as level/code such as F/INSTA.',
  },
  typeRatings: {
    reason: 'invalid_filter',
    expected:
      '1–11 designators, each 1–30 letters, digits, spaces, or hyphens, optionally after a one-letter level and a slash',
    hint: 'Call faa_airmen_list_reference with topic type_ratings and send listed designators, bare or as level/designator such as A/B-737.',
  },
  instructorType: {
    reason: 'invalid_filter',
    expected: 'flight, ground, or both',
    hint: 'Send instructorType flight, ground, or both, or omit it for both.',
  },
  limit: {
    reason: 'invalid_filter',
    expected: 'a whole number of at least 1',
    hint: `Send limit from 1 to ${maxLimit}; a larger limit returns at most ${maxLimit}.`,
  },
  offset: {
    reason: 'invalid_filter',
    expected: 'a whole number from 0 to 10000',
    hint: 'Follow nextOffset, or narrow the filters to reach results beyond offset 10000.',
  },
  topic: {
    reason: 'invalid_filter',
    expected: 'a listed reference topic',
    hint: `Send topic ${joined(REFERENCE_TOPICS, 'or')}.`,
  },
  filter: {
    reason: 'invalid_filter',
    expected: 'at most 80 characters with no control or format characters',
    hint: 'Retry with filter as at most 80 characters, or omit it.',
  },
} as const satisfies Record<string, { reason: Reason; expected: string; hint: string }>;
type Field = keyof typeof fieldRules;
/** What redaction narrows: a rejected field never offers back an omission or value redaction refuses. */
const redactedRules: Partial<Record<Field, { expected?: string; hint: string }>> = {
  firstName: { hint: nameRule('firstName', 'FIRST NAME', '').hint },
  nameMatch: {
    expected: 'words or exact',
    hint: 'Send nameMatch words or exact, or omit it for words.',
  },
};
/** Reject one field by name and the form the serving mode accepts. */
function invalid(field: Field, serving?: Serving): never {
  const { reason, expected, hint } = {
    ...fieldRules[field],
    ...(serving?.redacted && redactedRules[field]),
  };
  fail(reason, `${field} must be ${expected}.`, hint, serving);
}
const idModeHint =
  'In mode id send uniqueId without name, location, or nameMatch fields; to search by name, use mode name without uniqueId.';
function keys(input: object, allowed: string[]) {
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    fail(
      'invalid_filter',
      'The input carries a field this tool does not accept.',
      'Remove every field the tool input schema does not list.',
    );
}
/**
 * Trimmed, whitespace-collapsed, uppercased text. Blank is unset, by the same `trim()` test as
 * `nonblank()`, so a tab alone is unset too; a control or format character in a nonblank value fails.
 */
function text(
  value: string | undefined,
  field: Field,
  { max = 60, serving }: { max?: number; serving?: Serving } = {},
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') invalid(field, serving);
  const normalized = normalizeName(value);
  if (!normalized) return undefined;
  if (/[\p{Cc}\p{Cf}]/u.test(value) || normalized.length > max) invalid(field, serving);
  return normalized;
}
function nonblank(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}
function id(value: string | undefined) {
  const normalized = text(value, 'uniqueId');
  if (!normalized || !UNIQUE_ID.test(normalized)) invalid('uniqueId');
  return normalized;
}
/** A limit above the maximum clamps (the caller is told); anything else out of range fails. */
function paging(input: Paging, serving?: Serving): { page: Required<Paging>; clamped: boolean } {
  const limit = input.limit ?? 10,
    offset = input.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1) invalid('limit', serving);
  if (!Number.isInteger(offset) || offset < 0 || offset > 10000) invalid('offset', serving);
  return { page: { limit: Math.min(limit, maxLimit), offset }, clamped: limit > maxLimit };
}
/** What responses show: city and ZIP only with location access on and redaction off. */
interface Serving {
  location: boolean;
  redacted: boolean;
  /** Set for one name search whose names the redaction gate will refuse; see `searchServing`. */
  refusesNames?: true;
}
const operatorOff = 'for a personal install, the operator can set FAA_AIRMEN_REDACT_PII=false';
/** The name search redaction allows, in the words its hints use. */
const bothNames = 'both lastName and firstName';
/** What a rejection raised before the name gate adds to its hint when the gate will refuse the call. */
const namesToo = `While personal-data redaction is on, a name search also needs ${bothNames}, with nameMatch words or exact.`;
/**
 * Under redaction, mark a name search missing a name or matching by prefix: the gate refuses it after
 * every other check, so each earlier rejection's retry must also carry both names.
 */
function searchServing(input: NameInput & { mode?: string }, serving: Serving): Serving {
  if (!serving.redacted || input.mode === 'id') return serving;
  const refused =
    !nonblank(input.lastName) || !nonblank(input.firstName) || input.nameMatch === 'prefix';
  return refused ? { ...serving, refusesNames: true } : serving;
}
/** The retry a redacted city or ZIP refusal names, per search shape. */
const locationRetry = {
  id: 'Retry in mode id without name, location, or nameMatch fields',
  name: `Retry in mode name without city or zipCode, with ${bothNames} and nameMatch words or exact, narrowing with state if needed`,
  instructors: `Retry without city or zipCode, with ${bothNames} and nameMatch words or exact, narrowing with state, instructorType, or ratingCodes if needed`,
};
const redactionNotice =
  'Personal-data redaction is on: city, ZIP, and medical fields are withheld, and name searches require both lastName and firstName.';
const locationDisabled = 'City and ZIP access is disabled by the operator.';
const personHint = `Retry with both lastName and firstName as the FAA record writes them, using nameMatch words or exact, or use mode id with a uniqueId; ${operatorOff} to allow partial-name and prefix searches.`;
const instructorHint = `Retry faa_airmen_search_instructors with both lastName and firstName as the FAA record writes them, using nameMatch words or exact, plus any state, instructorType, or ratingCodes; ${operatorOff} to allow searches by state, rating, or partial name.`;
/** Reject what redaction forbids, naming the fields and the setting, never a value. */
function redactionRefusal(problem: string, hint: string): never {
  throw forbidden(`${problem} while personal-data redaction (FAA_AIRMEN_REDACT_PII) is on.`, {
    reason: 'pii_redacted',
    retryable: false,
    recovery: { hint },
  });
}
/**
 * Nonblank city or ZIP fails before any other check or mirror access: redaction forbids it, and so
 * does disabled location access. Under redaction the hint names the whole retry the search allows.
 */
function locationGate(input: NameInput, serving: Serving, redactedRetry: string) {
  const sent = (['city', 'zipCode'] as const).filter((field) => nonblank(input[field]));
  if (!sent.length) return;
  if (serving.redacted)
    redactionRefusal(
      `${joined(sent, 'and')} ${sent.length > 1 ? 'are' : 'is'} unavailable`,
      `${redactedRetry}; ${operatorOff}, and city and ZIP filters also need FAA_AIRMEN_INCLUDE_LOCATION=true.`,
    );
  if (!serving.location)
    throw forbidden(locationDisabled, {
      reason: 'location_access_disabled',
      retryable: false,
    });
}
/**
 * Under redaction a name search names one whole person: both names, matched by words or exact. It
 * runs after every other check, so input invalid in both modes keeps its own reason.
 */
function nameGate(name: NormalizedName, serving: Serving, hint: string) {
  if (!serving.redacted) return;
  const missing = (['lastName', 'firstName'] as const).filter((field) => !name[field]);
  const problems = [
    ...(missing.length
      ? [`${joined(missing, 'and')} ${missing.length > 1 ? 'are' : 'is'} required`]
      : []),
    ...(name.nameMatch === 'prefix' ? ['nameMatch must be words or exact'] : []),
  ];
  if (problems.length) redactionRefusal(problems.join(' and '), hint);
}
/** Name and location field formats; the caller runs the location gate first. */
function names(input: NameInput, serving: Serving): NormalizedName {
  const lastName = text(input.lastName, 'lastName', { serving }),
    firstName = text(input.firstName, 'firstName', { serving });
  const state = text(input.state, 'state', { serving }),
    city = text(input.city, 'city', { serving }),
    rawZip = text(input.zipCode, 'zipCode', { serving });
  // A code outside the set can never match a record, so it fails instead of returning an empty page.
  if (state && !STATE_CODES.has(state)) invalid('state', serving);
  if (rawZip && !/^\d{5}(?:-?\d{4})?$/.test(rawZip)) invalid('zipCode', serving);
  const zipCode = rawZip?.length === 9 ? `${rawZip.slice(0, 5)}-${rawZip.slice(5)}` : rawZip;
  const nameMatch = input.nameMatch ?? 'words';
  if (!NAME_MATCHES.includes(nameMatch)) invalid('nameMatch', serving);
  return {
    ...(lastName && { lastName }),
    ...(firstName && { firstName }),
    ...(state && { state }),
    ...(city && { city }),
    ...(zipCode && { zipCode }),
    nameMatch,
  };
}
/** Location gate, then the mode combination, then field formats; hints name the search redaction allows. */
function selector(input: IdentityInput, serving: Serving): Selector {
  locationGate(input, serving, input.mode === 'id' ? locationRetry.id : locationRetry.name);
  const fullName = serving.redacted ? bothNames : undefined;
  if (input.mode === 'id') {
    const forbidden =
      identityFilters.find((key) => nonblank(input[key])) ??
      (input.nameMatch !== undefined ? 'nameMatch' : undefined);
    if (forbidden) fail('invalid_identity', `mode id forbids ${forbidden}.`, idModeHint);
    if (!nonblank(input.uniqueId))
      fail(
        'invalid_identity',
        'mode id requires uniqueId.',
        `Send the uniqueId from ${UNIQUE_ID_SOURCE}, or search with mode name and ${fullName ?? 'lastName'}.`,
      );
    names(input, serving);
    return { mode: 'id', uniqueId: id(input.uniqueId) };
  }
  if (input.mode !== 'name')
    fail(
      'invalid_identity',
      'mode must be id or name.',
      `Send mode id with a uniqueId, or mode name with ${fullName ?? 'a lastName'}.`,
    );
  if (nonblank(input.uniqueId))
    fail(
      'invalid_identity',
      'mode name forbids uniqueId.',
      'In mode name omit uniqueId; to read one ID, use mode id with uniqueId alone.',
      serving,
    );
  if (!nonblank(input.lastName))
    fail(
      'invalid_identity',
      'mode name requires lastName.',
      `In mode name send ${fullName ?? 'a nonblank lastName'}, or use mode id with a uniqueId.`,
    );
  return { mode: 'name', ...names(input, serving) };
}
function typeCode(value: string | undefined, serving: Serving): string | undefined {
  const normalized = text(value, 'certificateType', { serving });
  if (!normalized) return undefined;
  const code = normalized === 'CFI' ? 'F' : (certificateTypeFor(normalized) ?? normalized);
  if (!singleLetter.test(code)) invalid('certificateType', serving);
  return code;
}
/** One level letter; levels are defined per certificate type, so a level needs its type. */
function levelCode(
  value: string | undefined,
  certificateType: string | undefined,
  serving: Serving,
) {
  const level = text(value, 'certificateLevel', { serving });
  if (!level) return;
  if (!certificateType)
    fail(
      'invalid_filter',
      'certificateLevel requires certificateType.',
      'Add the certificateType the level belongs to, such as P for level A, from faa_airmen_list_reference topic certificate_levels, or omit certificateLevel.',
      serving,
    );
  if (!singleLetter.test(level)) invalid('certificateLevel', serving);
  return level;
}
/** Normalize 1–11 rating or type-rating filters; a `level/` prefix splits at the first slash, and repeats collapse. */
function codeFilters(
  values: string[] | undefined,
  field: 'ratingCodes' | 'typeRatings',
  serving: Serving,
): CodeFilter[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length < 1 || values.length > 11) invalid(field, serving);
  const filters = new Map<string, CodeFilter>();
  for (const value of values) {
    const normalized = text(value, field, { max: Number.POSITIVE_INFINITY, serving });
    if (!normalized) invalid(field, serving);
    const slash = normalized.indexOf('/');
    const level = slash < 0 ? undefined : normalized.slice(0, slash).trim();
    const code = slash < 0 ? normalized : normalized.slice(slash + 1).trim();
    if (!codePart.test(code) || (level !== undefined && !singleLetter.test(level)))
      invalid(field, serving);
    filters.set(level === undefined ? code : `${level}/${code}`, {
      code,
      ...(level !== undefined && { level }),
    });
  }
  return [...filters.values()];
}
/** The echoed form of a rating filter. */
function codeLabel({ code, level }: CodeFilter): string {
  return level === undefined ? code : `${level}/${code}`;
}
/** Whether one returned rating slot satisfies a filter. */
function matchesFilter(rating: Rating, filter: CodeFilter): boolean {
  return (
    rating.code === filter.code && (filter.level === undefined || rating.levelCode === filter.level)
  );
}
/**
 * Equalities and BINARY index ranges over normalized names, so `%`, `_`, and `\` stay literal. A
 * whole-word range `TERM ` to `TERM!` holds exactly the values continuing with a space (U+0020 is
 * followed by U+0021). A prefix range ends before the term followed by U+10FFFF, the highest code
 * point; only a continuation that itself starts with that noncharacter falls outside it.
 */
function identityWhere(value: Selector | NormalizedName): Where {
  if ('uniqueId' in value) return { sql: 'a.unique_id=?', bindings: [value.uniqueId] };
  const clauses = ["v.origin='basic'"],
    bindings: string[] = [];
  for (const [key, column] of [
    ['lastName', 'v.last_name_normalized'],
    ['firstName', 'v.first_name_normalized'],
  ] as const) {
    const term = value[key];
    if (!term) continue;
    if (value.nameMatch === 'exact') {
      clauses.push(`${column}=?`);
      bindings.push(term);
    } else if (value.nameMatch === 'prefix') {
      clauses.push(`${column}>=? AND ${column}<?`);
      bindings.push(term, `${term}\u{10FFFF}`);
    } else {
      clauses.push(`(${column}=? OR (${column}>=? AND ${column}<?))`);
      bindings.push(term, `${term} `, `${term}!`);
    }
  }
  if (value.state) {
    clauses.push('v.state=?');
    bindings.push(value.state);
  }
  if (value.city) {
    clauses.push('UPPER(v.city)=?');
    bindings.push(value.city);
  }
  if (value.zipCode) {
    clauses.push("REPLACE(v.zip_code,'-','')=?");
    bindings.push(value.zipCode.replace('-', ''));
  }
  return {
    sql: `a.unique_id IN (SELECT v.unique_id FROM identity_variants v WHERE ${clauses.join(' AND ')})`,
    bindings,
  };
}
/**
 * Predicates over one certificate `c`: any of the types (none means any type), its own level, then
 * each rating and type-rating slot. A slot's `level/` is the slot's level, not the certificate's.
 */
function certificateWhere(
  types: string[],
  {
    level,
    ratings = [],
    typeRatings = [],
  }: { level?: string; ratings?: CodeFilter[]; typeRatings?: CodeFilter[] } = {},
): Where {
  const bindings = [...types],
    clauses = types.length ? [`c.type IN (${types.map(() => '?').join(',')})`] : [];
  if (level) {
    clauses.push('c.level=?');
    bindings.push(level);
  }
  for (const [kind, filters] of [
    ['rating', ratings],
    ['type_rating', typeRatings],
  ] as const)
    for (const { code, level: slotLevel } of filters) {
      clauses.push(
        `EXISTS(SELECT 1 FROM ratings r WHERE r.record_id=c.record_id AND r.kind='${kind}' AND r.code=?${slotLevel === undefined ? '' : ' AND r.level_code=?'})`,
      );
      bindings.push(code, ...(slotLevel === undefined ? [] : [slotLevel]));
    }
  return { sql: clauses.join(' AND '), bindings };
}
function identity(row: Row, location: boolean): Identity {
  return {
    firstName: row.first_name ?? '',
    lastName: row.last_name ?? '',
    ...(row.state && { state: row.state }),
    ...(row.country && { country: row.country }),
    ...(row.region && { region: row.region }),
    ...(location && row.city && { city: row.city }),
    ...(location && row.zip_code && { zipCode: row.zip_code }),
  };
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
/**
 * Whether any returned certificate or medical record carries an undocumented code, a malformed source
 * date, or a malformed rating slot. Reads only the values a response returns, so withheld fields and
 * type-rating designators (never described) cannot trigger it.
 */
export function hasSourceQualityIssue(
  certificates: readonly Certificate[],
  medicalRecords: readonly MedicalRecord[] = [],
): boolean {
  const undocumented = (code: Code | undefined) => code !== undefined && !code.description;
  const malformed = (value: string | undefined, shape: RegExp) =>
    value !== undefined && !shape.test(value);
  return (
    certificates.some(
      (record) =>
        undocumented(record.type) ||
        undocumented(record.level) ||
        malformed(record.legacyExpireDateRaw, MONTH_DAY_YEAR) ||
        record.ratings.some(
          (rating) => undocumented(rating) || isMalformedSlot(rating.raw, rating.code),
        ) ||
        record.typeRatings.some((rating) => isMalformedSlot(rating.raw, rating.code)),
    ) ||
    medicalRecords.some(
      (record) =>
        undocumented(record.medicalClass) ||
        malformed(record.medicalDateRaw, MONTH_YEAR) ||
        malformed(record.medicalExpireDateRaw, MONTH_YEAR) ||
        malformed(record.basicMedCourseDateRaw, YEAR_MONTH_DAY) ||
        malformed(record.basicMedCmecDateRaw, YEAR_MONTH_DAY),
    )
  );
}
/** Person-query tools whose zero results route by the filters sent. */
type PersonTool =
  | 'faa_airmen_verify_certificate'
  | 'faa_airmen_verify_remote_pilot'
  | 'faa_airmen_search_instructors';
/** Filters that select people by their certificates, in the order a zero result names them. */
const CREDENTIAL_FILTERS = [
  'certificateType',
  'certificateLevel',
  'ratingCodes',
  'typeRatings',
] as const;
type CredentialFilter = (typeof CREDENTIAL_FILTERS)[number];
/**
 * How a zero result names each credential filter, the reference topic holding its vocabulary, and
 * whether it sends codes that must share one certificate.
 */
const credentialFilters: Record<
  CredentialFilter,
  { label: string; topic?: ReferenceTopic; codes?: true }
> = {
  certificateType: { label: 'certificate type' },
  certificateLevel: { label: 'certificate level', topic: 'certificate_levels' },
  ratingCodes: { label: 'rating codes', topic: 'ratings', codes: true },
  typeRatings: { label: 'type ratings', topic: 'type_ratings', codes: true },
};
/** Sent filters a retry must keep for the call to stay valid, per tool. */
const retryKeeps: Record<PersonTool, readonly string[]> = {
  faa_airmen_verify_certificate: ['lastName'],
  faa_airmen_verify_remote_pilot: ['lastName'],
  faa_airmen_search_instructors: [],
};
/** Under redaction a retry keeps both names, and city or ZIP can never be offered back. */
const redactedKeeps = ['lastName', 'firstName', 'city', 'zipCode'] as const;
/** The filters a zero-result person query actually sent, after normalization. */
export interface SentFilters {
  /** faa_airmen_verify_certificate only: the certificate type code sent. */
  certificateType?: string;
  /** Rating codes and type ratings sent, after normalization collapses repeats. */
  codeCount: number;
  /** Credential filters sent. */
  credentials: readonly CredentialFilter[];
  /** ID mode only: whether the Unique ID exists in this snapshot. */
  idExists?: boolean;
  /** Name and location filters sent. */
  identity: readonly string[];
  /** Instructor searches only: the certificate types searched. */
  instructorType?: InstructorType;
  /** Rating codes sent, without their levels. */
  ratingCodes: readonly string[];
  /** Sent filters a retry must keep; a stricter serving mode adds to this set. */
  required: readonly string[];
  tool: PersonTool;
  /**
   * A name or location search with credential filters: the people it matches without them, among
   * the searched instructor types on faa_airmen_search_instructors.
   */
  withoutCredentials?: number;
}
type InstructorType = NonNullable<InstructorInput['instructorType']>;
/** How a counted instructor zero result names the types searched. */
const instructorNouns: Record<InstructorType, string> = {
  flight: 'flight instructor',
  ground: 'ground instructor',
  both: 'flight or ground instructor',
};
/** The count sentence: how many the search matches without its credential filters. */
function countedSentence(sent: SentFilters, counted: number, inputs: string, wanted: string) {
  if (!sent.instructorType)
    return counted
      ? `${counted} ${counted === 1 ? 'person matches' : 'people match'} this name search without ${inputs}, and none holds a ${wanted} in this snapshot.`
      : `No person matches this name search even without ${inputs}.`;
  const noun = instructorNouns[sent.instructorType];
  return counted
    ? `${counted} ${noun}${counted === 1 ? ' matches' : 's match'} this search without ratingCodes, and none holds a ${noun} certificate carrying ${sent.codeCount > 1 ? 'every requested code' : 'the requested code'} in this snapshot.`
    : `No ${noun} matches this search even without ratingCodes.`;
}
function joined(items: readonly string[], word: 'and' | 'or'): string {
  return items.length > 1
    ? `${items.slice(0, -1).join(', ')} ${word} ${items.at(-1)}`
    : items.join('');
}
/**
 * What each CFII or MEI alternative's retry must add to reach F certificates. A bare CFII code on
 * faa_airmen_verify_certificate also matches a pilot (P) certificate's instrument rating unless the
 * call sent type F, and a ground-only instructor search can never match an alternative.
 */
function alternativesRetry(sent: SentFilters): string | undefined {
  if (sent.tool === 'faa_airmen_verify_certificate')
    return sent.certificateType === 'F' ? undefined : 'certificateType F';
  return sent.instructorType === 'ground' ? 'instructorType flight or both' : undefined;
}
/** Name and location filters a retry may drop: never a required one, never the only filter left. */
function droppable(sent: SentFilters): string[] {
  return sent.identity.filter(
    (filter) =>
      !sent.required.includes(filter) && sent.identity.length + sent.credentials.length > 1,
  );
}
/** Zero-result notice routed only by what the call sent; the absence sentence always leads. */
export function zeroResultNotice(sent: SentFilters): string {
  const labels = joined(
    sent.credentials.map((filter) => credentialFilters[filter].label),
    'and',
  );
  const inputs = joined(sent.credentials, 'or');
  const wanted =
    sent.credentials.length > 1
      ? 'single certificate carrying every requested credential'
      : `certificate matching the requested ${labels}`;
  const lookup = (filter: CredentialFilter) =>
    `the ${credentialFilters[filter].label} with faa_airmen_list_reference topic ${credentialFilters[filter].topic}`;
  const routed = sent.credentials.filter((filter) => credentialFilters[filter].topic);
  const coded = routed.filter((filter) => credentialFilters[filter].codes);
  // Sent rating codes always produce the coded sentence, so the alternatives follow the ratings route.
  const alternatives = instructorAlternatives(sent.ratingCodes, alternativesRetry(sent));
  // Rating and type-rating lookups share one sentence, so the same-certificate rule is stated once.
  const routes = [
    ...routed
      .filter((filter) => !credentialFilters[filter].codes)
      .map((filter) => `Check ${lookup(filter)}.`),
    ...(coded.length
      ? [
          `Check ${joined(coded.map(lookup), 'and')}${sent.codeCount > 1 ? '; all must occur on the same certificate' : ''}.`,
        ]
      : []),
    ...(alternatives ? [alternatives] : []),
  ];
  const parts = [
    'No record matched this releasable snapshot. This does not establish that a person is uncertificated.',
  ];
  if (sent.idExists === false)
    parts.push(
      'No person has this Unique ID in this snapshot; check its format with faa_airmen_list_reference topic identifiers, or rediscover it with faa_airmen_verify_certificate mode name.',
    );
  else if (sent.idExists)
    parts.push(
      sent.tool === 'faa_airmen_verify_remote_pilot'
        ? "This Unique ID holds no remote pilot (U) certificate; use faa_airmen_verify_certificate in ID mode to read the person's other certificates."
        : `This Unique ID holds no ${wanted}; retry faa_airmen_verify_certificate in ID mode without ${inputs} to read the person's other certificates.`,
      ...routes,
    );
  else {
    const counted = sent.withoutCredentials;
    if (sent.tool === 'faa_airmen_verify_remote_pilot')
      parts.push(
        'No candidate matching the name holds a remote pilot (U) certificate; use faa_airmen_verify_certificate in name mode to check the name and other certificates.',
      );
    else if (counted !== undefined) parts.push(countedSentence(sent, counted, inputs, wanted));
    // A counted name match leaves only the credentials to check; a counted miss only the filters.
    if (counted !== 0) parts.push(...routes);
    const nameSent = sent.identity.some(
      (filter) => filter === 'lastName' || filter === 'firstName',
    );
    const drop = droppable(sent);
    // A mode that keeps both names can drop only location filters, so the retry names them.
    const namesKept = ['lastName', 'firstName'].every((name) => sent.required.includes(name));
    const retry = !drop.length
      ? ''
      : namesKept
        ? `, then retry without ${joined(drop, 'or')}`
        : ', then retry with fewer name or location filters';
    if (counted === 0 || (counted === undefined && (nameSent || !routes.length)))
      parts.push(`Check faa_airmen_list_reference with topic identifiers${retry}.`);
  }
  return parts.join(' ');
}
function notice(provenance: Provenance | null, serving: Serving, extra = '', quality = false) {
  return [
    extra,
    limits,
    provenance?.stale
      ? 'This snapshot exceeds the configured source-age threshold; ask the operator to refresh it.'
      : '',
    serving.redacted ? redactionNotice : !serving.location ? locationDisabled : '',
    quality
      ? 'A returned record contains an undocumented code or a malformed source date or rating; raw values are retained.'
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}
/** Project a generation's full provenance to the fields every per-call result carries. */
export function callProvenance(provenance: Provenance): CallProvenance {
  const {
    sourceName,
    snapshotMonth,
    ageDays,
    ageBasis,
    stale,
    staleAfterDays,
    generationId,
    includeLocation,
  } = provenance;
  return {
    sourceName,
    snapshotMonth,
    ageDays,
    ageBasis,
    stale,
    staleAfterDays,
    generationId,
    includeLocation,
  };
}
function single(
  provenance: Provenance | null,
  appliedFilters: AppliedFilters,
  serving: Serving,
  extra = '',
  quality = false,
): SingleEnrichment {
  return {
    provenance: provenance && callProvenance(provenance),
    appliedFilters,
    notice: notice(provenance, serving, extra, quality),
    piiRedacted: serving.redacted,
  };
}
/** Page within the byte budget; enrichment is built for the exact slice returned. */
function finalPage<T>(
  entries: T[],
  total: number,
  page: Required<Paging>,
  enrichmentFor: (selected: T[]) => SingleEnrichment,
  empty: string,
  clamped: boolean,
): { entries: T[]; enrichment: ListEnrichment } {
  let selected = entries;
  const responseBytes = () => {
    const payload = { entries: selected, enrichment: enrichmentFor(selected) };
    /** Include JSON-escaped pretty content, structured data, labels, links, and pagination. */
    return (
      Buffer.byteLength(JSON.stringify(payload)) +
      Buffer.byteLength(JSON.stringify(JSON.stringify(payload, null, 2))) +
      4096
    );
  };
  while (selected.length > 1 && responseBytes() > pageBudget) selected = selected.slice(0, -1);
  const returnedCount = selected.length,
    next = page.offset + returnedCount;
  const remaining = returnedCount > 0 && next < total,
    atPagingCap = remaining && next > 10000,
    hasMore = remaining && !atPagingCap;
  const extra =
    total === 0
      ? empty
      : page.offset >= total
        ? 'This page is past the available results; repeat the same tool with offset 0.'
        : '';
  const oversized = selected.length === 1 && responseBytes() > pageBudget;
  /**
   * Without it a cut page reads like the last one to a caller that stops at returnedCount < limit.
   * The estimate never measures the page sentences; its 4096-byte reserve covers them.
   */
  const cut = returnedCount < entries.length && hasMore;
  const enrichment = enrichmentFor(selected);
  return {
    entries: selected,
    enrichment: {
      ...enrichment,
      totalCount: total,
      returnedCount,
      hasMore,
      nextOffset: hasMore ? next : null,
      atPagingCap,
      notice: [
        enrichment.notice,
        extra,
        clamped ? limitClamped : '',
        atPagingCap ? 'Narrow the filters to reach remaining results within the offset cap.' : '',
        cut
          ? `The response size budget ended this page before limit ${page.limit}; more results remain, so repeat the call with offset ${next}.`
          : '',
        oversized
          ? 'One complete record exceeds the response byte budget; all source credentials are retained.'
          : '',
      ]
        .filter(Boolean)
        .join(' '),
    },
  };
}

/** One paged person query and how each matched person becomes a result. */
interface PeopleQuery<T> {
  /** faa_airmen_verify_certificate only: the certificate type code sent. */
  certificateType?: string;
  /** Whether the requested limit exceeded the maximum. */
  clamped: boolean;
  /** Rating codes and type ratings sent, after repeats collapse. */
  codeCount: number;
  credentials: CredentialFilter[];
  filters: AppliedFilters;
  /**
   * Instructor searches only: the types searched and their certificate predicate, which a zero
   * result's count keeps when it drops the rating codes.
   */
  instructor?: { type: InstructorType; certificate: Where };
  page: Required<Paging>;
  project(airman: Airman, certificates: Certificate[]): T;
  qualify?: Where;
  /** Rating codes sent, without their levels. */
  ratingCodes: string[];
  /** The certificates a result returns: the only records its source-quality check reads. */
  returned(match: T): Certificate[];
  selector: Selector | NormalizedName;
  tool: PersonTool;
}

/** Domain service; no query triggers acquisition, mutation, or network access. */
export class AirmenRegistryService {
  readonly mirror: AirmenMirror;
  /** The mirror imports by config.includeLocation alone; redaction narrows only what is served. */
  private readonly serving: Serving;
  constructor(
    readonly config: ServerConfig,
    dependencies: MirrorDependencies = {},
  ) {
    this.mirror = new AirmenMirror(config, dependencies);
    this.serving = {
      location: config.includeLocation && !config.redactPii,
      redacted: config.redactPii,
    };
  }
  initialize(signal?: AbortSignal) {
    return this.mirror.initialize(signal);
  }
  private async read<T extends QueryResult<unknown>>(
    location: boolean,
    run: (lease: SnapshotLease) => T,
    ctx?: Context,
  ): Promise<T> {
    ctx?.signal.throwIfAborted();
    try {
      using lease = await this.mirror.acquire();
      if (location && !lease.metadata.includeLocation)
        throw serviceUnavailable('The snapshot must be rebuilt before location filtering.', {
          reason: 'mirror_rebuild_required',
          retryable: false,
        });
      const result = run(lease);
      const refresh = await this.mirror.refreshState();
      if (refresh?.status === 'failed') {
        const interrupted = 'was interrupted before it recorded a result';
        /**
         * A run records its start before importing, and no other writer can publish while it holds
         * WRITER.lock, so a generation imported after that start is the one this run published.
         */
        if (Date.parse(lease.metadata.importedAt) > Date.parse(refresh.startedAt))
          result.enrichment.notice += ` The latest refresh published this snapshot, then ${refresh.stage === 'interrupted' ? interrupted : 'failed a later storage step'}.`;
        else {
          const outcome =
            refresh.stage === 'cancelled'
              ? 'was cancelled before it finished'
              : refresh.stage === 'interrupted'
                ? interrupted
                : 'failed';
          result.enrichment.notice += ` The latest refresh ${outcome}; this result uses the last complete published generation.`;
        }
      }
      ctx?.signal.throwIfAborted();
      return result;
    } catch (error) {
      if (ctx?.signal.aborted || error instanceof McpError) throw error;
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
    query: PeopleQuery<T>,
    ctx?: Context,
  ): Promise<QueryResult<{ matches: T[] }, ListEnrichment>> {
    const { selector: selectorValue, page } = query;
    const identity = identityWhere(selectorValue);
    /** The identity predicate, narrowed to people holding one certificate that `qualify` matches. */
    const holding = (qualify?: Where): Where =>
      qualify
        ? {
            sql: `${identity.sql} AND EXISTS(SELECT 1 FROM certificates c WHERE c.unique_id=a.unique_id AND ${qualify.sql})`,
            bindings: [...identity.bindings, ...qualify.bindings],
          }
        : identity;
    const where = holding(query.qualify);
    return this.read(
      Boolean(
        ('city' in selectorValue && selectorValue.city) ||
          ('zipCode' in selectorValue && selectorValue.zipCode),
      ),
      (lease) => {
        const count = ({ sql, bindings }: Where) =>
          lease.db
            .prepare<{ n: number }>(`SELECT COUNT(*) n FROM airmen a WHERE ${sql}`)
            .get(...bindings)?.n ?? 0;
        const total = count(where);
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
          query.project(
            airman(lease.db, row, this.serving.location),
            certs.get(row.unique_id ?? '') ?? [],
          ),
        );
        const common = {
          tool: query.tool,
          credentials: query.credentials,
          codeCount: query.codeCount,
          ratingCodes: query.ratingCodes,
          ...(query.certificateType && { certificateType: query.certificateType }),
          ...(query.instructor && { instructorType: query.instructor.type }),
        };
        const sent = (): SentFilters => {
          if ('uniqueId' in selectorValue)
            return {
              ...common,
              identity: [],
              required: [],
              // bun:sqlite reports a missing row as null, better-sqlite3 as undefined.
              idExists: Boolean(
                lease.db
                  .prepare('SELECT 1 FROM airmen WHERE unique_id=?')
                  .get(selectorValue.uniqueId),
              ),
            };
          const sentIdentity = identityFilters.filter((filter) => selectorValue[filter]);
          return {
            ...common,
            identity: sentIdentity,
            required: [...retryKeeps[query.tool], ...(this.serving.redacted ? redactedKeeps : [])],
            /**
             * One extra count without the credential filters separates a name or location miss from
             * a credential miss; an instructor search keeps its instructor certificate types. A
             * rating-only instructor search has nothing to count.
             */
            ...(query.credentials.length > 0 &&
              sentIdentity.length > 0 && {
                withoutCredentials: count(holding(query.instructor?.certificate)),
              }),
          };
        };
        const finalized = finalPage(
          matches,
          total,
          page,
          (selected) =>
            single(
              lease.provenance,
              query.filters,
              this.serving,
              '',
              hasSourceQualityIssue(selected.flatMap(query.returned)),
            ),
          total === 0 ? zeroResultNotice(sent()) : '',
          query.clamped,
        );
        return { data: { matches: finalized.entries }, enrichment: finalized.enrichment };
      },
      ctx,
    );
  }
  /** Credential filters select people holding all of them on one certificate, without hiding their other certificates. */
  verifyCertificates(
    input: VerifyInput,
    ctx?: Context,
  ): Promise<QueryResult<{ matches: CertificateMatch[] }, ListEnrichment>> {
    keys(input, [...identityKeys, ...pageKeys, ...CREDENTIAL_FILTERS]);
    const serving = searchServing(input, this.serving);
    const selected = selector(input, serving),
      { page, clamped } = paging(input, serving),
      certificateType = typeCode(input.certificateType, serving),
      certificateLevel = levelCode(input.certificateLevel, certificateType, serving),
      ratings = codeFilters(input.ratingCodes, 'ratingCodes', serving),
      typeRatings = codeFilters(input.typeRatings, 'typeRatings', serving);
    if (selected.mode === 'name') nameGate(selected, serving, personHint);
    const echo = {
      ...(certificateType && { certificateType }),
      ...(certificateLevel && { certificateLevel }),
      ...(ratings.length && { ratingCodes: ratings.map(codeLabel) }),
      ...(typeRatings.length && { typeRatings: typeRatings.map(codeLabel) }),
    };
    const credentials = CREDENTIAL_FILTERS.filter((filter) => filter in echo);
    return this.people(
      {
        tool: 'faa_airmen_verify_certificate',
        selector: selected,
        page,
        clamped,
        ...(certificateType && { certificateType }),
        filters: { ...selected, ...page, ...echo },
        credentials,
        codeCount: ratings.length + typeRatings.length,
        ratingCodes: ratings.map(({ code }) => code),
        ...(credentials.length && {
          qualify: certificateWhere(certificateType ? [certificateType] : [], {
            ...(certificateLevel && { level: certificateLevel }),
            ratings,
            typeRatings,
          }),
        }),
        project: (airman, certificates) => ({ airman, certificates }),
        returned: (match) => match.certificates,
      },
      ctx,
    );
  }
  /** Remote pilot matches retain all U certificate records, without a currency verdict. */
  verifyRemotePilot(
    input: IdentityInput & Paging,
    ctx?: Context,
  ): Promise<QueryResult<{ matches: RemotePilotMatch[] }, ListEnrichment>> {
    keys(input, [...identityKeys, ...pageKeys]);
    const serving = searchServing(input, this.serving);
    const selected = selector(input, serving),
      { page, clamped } = paging(input, serving);
    if (selected.mode === 'name') nameGate(selected, serving, personHint);
    return this.people(
      {
        tool: 'faa_airmen_verify_remote_pilot',
        selector: selected,
        page,
        clamped,
        filters: { ...selected, ...page, certificateType: 'U' },
        credentials: [],
        codeCount: 0,
        ratingCodes: [],
        qualify: certificateWhere(['U']),
        project: (airman, records) => ({
          airman,
          remotePilotCertificates: records.filter((record) => record.type.code === 'U'),
        }),
        returned: (match) => match.remotePilotCertificates,
      },
      ctx,
    );
  }
  /** Every requested rating must occur on one qualifying instructor certificate. */
  searchInstructors(
    input: InstructorInput,
    ctx?: Context,
  ): Promise<QueryResult<{ matches: InstructorMatch[] }, ListEnrichment>> {
    keys(input, [...nameKeys, ...pageKeys, 'instructorType', 'ratingCodes']);
    const serving = searchServing(input, this.serving);
    locationGate(input, serving, locationRetry.instructors);
    const selected = names(input, serving),
      { page, clamped } = paging(input, serving),
      instructorType = input.instructorType ?? 'both';
    if (!['flight', 'ground', 'both'].includes(instructorType)) invalid('instructorType', serving);
    const ratings = codeFilters(input.ratingCodes, 'ratingCodes', serving);
    if (!identityFilters.some((filter) => selected[filter]) && !ratings.length)
      fail(
        'missing_search_filter',
        this.serving.redacted
          ? `Instructor search requires ${bothNames}.`
          : `Instructor search requires lastName, firstName, state, ${this.serving.location ? 'city, zipCode, ' : ''}or ratingCodes.`,
        this.serving.redacted
          ? `Call faa_airmen_search_instructors with ${bothNames}; ${operatorOff} to search by state or rating alone.`
          : undefined,
      );
    nameGate(selected, serving, instructorHint);
    const types =
      instructorType === 'flight' ? ['F'] : instructorType === 'ground' ? ['G'] : ['F', 'G'];
    return this.people(
      {
        tool: 'faa_airmen_search_instructors',
        selector: selected,
        page,
        clamped,
        filters: {
          ...selected,
          ...page,
          instructorType,
          ratingCodes: ratings.map(codeLabel),
          ratingSemantics: 'all codes on the same qualifying certificate',
        },
        credentials: ratings.length ? ['ratingCodes'] : [],
        codeCount: ratings.length,
        ratingCodes: ratings.map(({ code }) => code),
        instructor: { type: instructorType, certificate: certificateWhere(types) },
        qualify: certificateWhere(types, { ratings }),
        project: (airman, records) => ({
          airman,
          instructorCertificates: records.filter(
            (record) =>
              types.includes(record.type.code) &&
              ratings.every((filter) =>
                record.ratings.some((rating) => matchesFilter(rating, filter)),
              ),
          ),
        }),
        returned: (match) => match.instructorCertificates,
      },
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
            enrichment: single(lease.provenance, { uniqueId }, this.serving, noPerson),
          };
        const records = (certificates(lease.db, [uniqueId]).get(uniqueId) ?? []).filter((record) =>
          record.sourceFamilies.includes('pilot'),
        );
        return {
          data: {
            found: true,
            airman: airman(lease.db, row, this.serving.location),
            certificates: records,
          },
          enrichment: single(
            lease.provenance,
            { uniqueId },
            this.serving,
            records.length
              ? ''
              : 'No pilot-family certificate was reported; faa_airmen_verify_certificate mode id returns every certificate, non-pilot ones included.',
            hasSourceQualityIssue(records),
          ),
        };
      },
      ctx,
    );
  }
  /**
   * Return medical information without calculating expiry, fitness, or eligibility. Redaction
   * rejects every call first, so no input or ID is checked against the snapshot.
   */
  getMedical(input: { uniqueId: string }, ctx?: Context): Promise<QueryResult<MedicalData>> {
    if (this.serving.redacted)
      redactionRefusal(
        'Medical fields are withheld',
        `Use faa_airmen_verify_certificate or faa_airmen_get_type_ratings for certificate records; ${operatorOff} to read informational medical fields.`,
      );
    keys(input, ['uniqueId']);
    const uniqueId = id(input.uniqueId);
    return this.read(
      false,
      (lease) => {
        const row = lease.db.prepare<Row>('SELECT * FROM airmen WHERE unique_id=?').get(uniqueId);
        if (!row)
          return {
            data: { found: false, disclaimer: medicalDisclaimer },
            enrichment: single(lease.provenance, { uniqueId }, this.serving, noPerson),
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
            airman: airman(lease.db, row, this.serving.location),
            medicalRecords,
            hasReportedMedicalFields: medicalRecords.length > 0,
            disclaimer: medicalDisclaimer,
          },
          enrichment: single(
            lease.provenance,
            { uniqueId },
            this.serving,
            medicalRecords.length
              ? ''
              : 'The person is present but no medical or BasicMed fields were reported; this is not an adverse finding.',
            hasSourceQualityIssue([], medicalRecords),
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
    const { page, clamped } = paging(input),
      filter = text(input.filter, 'filter', { max: 80 }),
      topic = input.topic;
    if (!REFERENCE_TOPICS.includes(topic)) invalid('topic');
    if (filter && ['identifiers', 'medical_guidance', 'mirror_status'].includes(topic))
      fail(
        'invalid_filter',
        'filter applies only to topics certificate_types, certificate_levels, ratings, and type_ratings.',
        'Retry without filter for this topic.',
      );
    const appliedFilters = { topic, ...page, ...(filter && { filter }) };
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
        ? single(provenance, appliedFilters, this.serving)
        : { provenance: null, appliedFilters, notice: '', piiRedacted: this.serving.redacted };
      const result = finalPage(
        filtered.slice(page.offset, page.offset + page.limit),
        filtered.length,
        page,
        () => enrichment,
        'No reference entry matched; retry faa_airmen_list_reference without filter.',
        clamped,
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
      const status = await this.mirror.status();
      const policy = !status.importPolicy
        ? 'not yet imported'
        : status.importPolicy.includeLocation
          ? 'enabled'
          : 'disabled';
      const refreshState = mirrorRefreshState(status.refresh);
      const mirrorStatus: NonNullable<ReferenceData['mirrorStatus']> = {
        state: status.status,
        refreshState,
        ...(status.provenance && { provenance: status.provenance }),
        ...(status.refresh?.status === 'failed' && {
          lastRefreshFailure: status.refresh.stage ?? 'unavailable',
        }),
      };
      const record =
        refreshState === 'unreadable'
          ? ' Refresh record: REFRESH.json in the mirror directory is unreadable; it records only the last refresh outcome, so the operator can remove it, and the next refresh rewrites it.'
          : '';
      return finish(
        [
          {
            code: 'mirror_status',
            guidance: `Mirror state: ${status.status}.${record} Initialize with faa-airmen-registry-mirror init; refresh with faa-airmen-registry-mirror refresh. Location import policy: ${policy}. Personal-data redaction: ${this.serving.redacted ? 'on, so city, ZIP, and medical fields are withheld and name searches require both lastName and firstName; the operator turns it off with FAA_AIRMEN_REDACT_PII=false' : 'off'}.`,
            sourceUrls: [FAA_SOURCE_URL],
          },
        ],
        status.provenance,
        mirrorStatus,
      );
    }
    return finish(staticReference(topic, this.serving.redacted), null);
  }
}
/** The mirror_status refresh lifecycle state for the last recorded refresh. */
function mirrorRefreshState(
  refresh: RefreshState | null,
): NonNullable<ReferenceData['mirrorStatus']>['refreshState'] {
  if (!refresh) return 'idle';
  switch (refresh.status) {
    case 'complete':
      return 'idle';
    case 'in_progress':
      return 'running';
    case 'failed':
      return 'failed';
    case 'unreadable':
      return 'unreadable';
    default: {
      const unhandled: never = refresh;
      return unhandled;
    }
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
