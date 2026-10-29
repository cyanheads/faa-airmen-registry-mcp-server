/**
 * @fileoverview Typed FAA tool input, output, and enrichment schemas.
 * @module mcp-server/tools/schemas
 */
import { z } from '@cyanheads/mcp-ts-core';
import { NAME_MATCHES, REFERENCE_TOPICS } from '@/services/airmen/contracts.js';
import { UNIQUE_ID_SOURCE } from '@/services/airmen/reference.js';

type Defined<T> = { [K in keyof T]: Exclude<T[K], undefined> };

/** Omit absent optional arguments before crossing the exact-optional domain boundary. */
export function definedInput<T extends object>(input: T): Defined<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Defined<T>;
}

const sourceFamily = z.enum(['pilot', 'nonpilot']).describe('FAA source file family.');
const identityFields = {
  firstName: z.string().describe('Complete source FIRST NAME, including middle names.'),
  lastName: z.string().describe('Complete source LAST NAME, including suffixes.'),
  state: z
    .string()
    .optional()
    .describe(
      'Source USPS state, territory, or military code, when reported; absent for foreign addresses.',
    ),
  country: z.string().optional().describe('Source country, when reported.'),
  region: z.string().optional().describe('Source FAA region, when reported.'),
  city: z
    .string()
    .optional()
    .describe(
      'Source city; present only with operator-enabled location access and personal-data redaction off.',
    ),
  zipCode: z
    .string()
    .optional()
    .describe(
      'Source ZIP; present only with operator-enabled location access and personal-data redaction off.',
    ),
};
/** Complete privacy-projected identity, including distinct source variants. */
export const airmanSchema = z
  .object({
    uniqueId: z.string().describe('Opaque FAA Unique ID, not a certificate number.'),
    ...identityFields,
    sourceFamilies: z.array(sourceFamily).describe('Source families contributing this person.'),
    identityVariants: z
      .array(
        z
          .object({
            ...identityFields,
            sourceFamily,
            origin: z
              .enum(['basic', 'certificate'])
              .describe('Source record containing this distinct identity.'),
          })
          .describe('Distinct source identity.'),
      )
      .optional()
      .describe('All differing safe BASIC and certificate identities.'),
  })
  .describe('One person joined only by FAA Unique ID.');
const codeFields = {
  code: z.string().describe('Verbatim source code; unknown values remain usable.'),
  description: z.string().optional().describe('FAA documented meaning, absent for unknown codes.'),
};
const codeSchema = z.object(codeFields).describe('Source code and documented meaning.');
const ratingSchema = z
  .object({
    ...codeFields,
    raw: z.string().describe('Complete source rating value, including malformed values.'),
    ordinal: z
      .number()
      .int()
      .describe('One-based source slot, retaining gaps and duplicate values.'),
    levelCode: z.string().optional().describe('Parsed source rating level, when reported.'),
    obsolete: z
      .boolean()
      .optional()
      .describe('Whether FAA documentation marks this rating obsolete.'),
  })
  .describe('One nonblank positional rating.');
/** Complete originating certificate and both ordered rating arrays. */
export const certificateSchema = z
  .object({
    recordId: z.string().describe('Stable certificate identifier within this snapshot.'),
    sourceFamilies: z
      .array(sourceFamily)
      .describe('Source families contributing this certificate.'),
    type: codeSchema.describe('Certificate type.'),
    level: codeSchema.optional().describe('Certificate level, absent when blank in the source.'),
    legacyExpireDateRaw: z
      .string()
      .optional()
      .describe('Legacy source expiry field; does not establish instructor currency.'),
    ratings: z.array(ratingSchema).describe('Every nonblank rating slot in source order.'),
    typeRatings: z
      .array(ratingSchema)
      .describe('Every nonblank aircraft type-rating slot in source order.'),
  })
  .describe('Complete source certificate.');
/** All persisted aggregate provenance fields plus source-age interpretation. */
const provenanceSchema = z
  .object({
    archiveUrl: z.string().describe('Official archive download URL.'),
    complete: z.literal(true).describe('Only complete published snapshots are readable.'),
    counts: z
      .object({
        airmen: z.number().int().describe('Imported distinct people.'),
        certificates: z.number().int().describe('Imported distinct certificates.'),
        ratings: z.number().int().describe('Imported nonblank rating slots.'),
        medicalRecords: z.number().int().describe('Imported distinct medical records.'),
      })
      .describe('Aggregate snapshot row counts.'),
    downloadedAt: z.string().describe('Archive download timestamp.'),
    fileCounts: z
      .record(z.string(), z.number().int())
      .describe('Source member filenames mapped to imported row counts.'),
    generationId: z.string().describe('Immutable published generation identifier.'),
    importedAt: z.string().describe('Snapshot import timestamp.'),
    includeLocation: z
      .boolean()
      .describe(
        'Generation import policy: city and ZIP kept at import, not what this response returns.',
      ),
    publishedAt: z
      .string()
      .optional()
      .describe('FAA publication timestamp, only when explicitly supplied.'),
    referenceVersion: z.number().int().describe('Packaged reference schema revision.'),
    schemaVersion: z.number().int().describe('Snapshot storage schema version.'),
    sha256: z.string().describe('Downloaded archive SHA-256 digest.'),
    snapshotMonth: z
      .string()
      .describe('Advertised publication month in YYYY-MM format, not an exact effective date.'),
    sourceName: z.string().describe('Official dataset name.'),
    sourcePageUrl: z.string().describe('Official FAA dataset documentation URL.'),
    warnings: z
      .object({
        unknownCodes: z.number().int().describe('Count of retained unknown source codes.'),
        malformedDates: z.number().int().describe('Count of retained malformed source dates.'),
        malformedRatings: z.number().int().describe('Count of retained malformed source ratings.'),
      })
      .describe('Aggregate source-quality warning counts.'),
    ageBasis: z
      .enum(['published_at', 'snapshot_month_start'])
      .describe('Publication timestamp or conservative first-of-month age basis.'),
    ageDays: z.number().describe('Source age in days, independent of import time.'),
    stale: z
      .boolean()
      .describe('Source exceeds the configured age threshold; not a credential judgment.'),
    staleAfterDays: z.number().describe('Configured source-age warning threshold in days.'),
  })
  .describe('Complete source provenance without local filesystem paths.');
/** Per-call provenance: the fields that interpret or cite one result. */
const callProvenanceSchema = provenanceSchema
  .pick({
    sourceName: true,
    snapshotMonth: true,
    ageDays: true,
    ageBasis: true,
    stale: true,
    staleAfterDays: true,
    generationId: true,
    includeLocation: true,
  })
  .describe('Per-call source provenance; topic mirror_status returns the full record.');
/** Mandatory enrichment for ID lookups. */
export const singleEnrichment = {
  notice: z
    .string()
    .describe(
      'Snapshot limitations, absence guidance, source-quality notices for the returned records, and operational notices; may be empty.',
    ),
  provenance: callProvenanceSchema
    .nullable()
    .describe('Snapshot provenance, or null for static reference topics.'),
  appliedFilters: z
    .record(
      z.string(),
      z.union([
        z.string().describe('Normalized text filter.'),
        z.number().describe('Normalized numeric filter.'),
        z.array(z.string().describe('Normalized code.')).describe('Normalized rating filters.'),
      ]),
    )
    .describe('Every effective normalized selector, filter, and paging value.'),
  piiRedacted: z
    .boolean()
    .describe(
      'Operator personal-data redaction: true withholds city, ZIP, and medical fields and limits searches to a full name or Unique ID.',
    ),
};
/** Mandatory enrichment for every paged success, including empty pages. */
export const listEnrichment = {
  ...singleEnrichment,
  notice: z
    .string()
    .describe(
      'Snapshot limitations, absence guidance, source-quality notices for the returned records, paging notices (a clamped limit, the offset cap, or a page the response size budget ended before limit), and operational notices; may be empty.',
    ),
  totalCount: z.number().int().describe('Total matches after filtering, before paging.'),
  returnedCount: z
    .number()
    .int()
    .describe(
      'Complete people or reference entries returned on this page. Fewer than limit means the results ended or the response size budget ended the page; while hasMore is true, the notice names the offset to continue from.',
    ),
  hasMore: z.boolean().describe('Whether another page is reachable within the offset cap.'),
  nextOffset: z
    .number()
    .int()
    .nullable()
    .describe('Next reachable offset, or null when no next page is available.'),
  atPagingCap: z
    .boolean()
    .describe('Matches remain but the next offset exceeds 10000; narrow the filters.'),
};
/** Names remain raw until service normalization; blank optional strings are unset. */
export const nameInput = {
  lastName: z
    .string()
    .optional()
    .describe(
      'LAST NAME, which may include a suffix; the default words match finds SMITH JR from SMITH. 1–60 visible characters after normalization. Blank means unset.',
    ),
  firstName: z
    .string()
    .optional()
    .describe(
      'FIRST NAME, which usually includes middle names; the default words match finds JOHN ROBERT from JOHN. 1–60 visible characters after normalization. Blank means unset.',
    ),
  state: z
    .string()
    .optional()
    .describe(
      'Two-letter USPS code: one of the 50 states, DC, PR, GU, VI, MP, AS, FM, MH, PW, or the military AA, AE, AP; trimmed and uppercased. Airmen with foreign addresses carry no state. Blank means unset.',
    ),
  city: z
    .string()
    .optional()
    .describe(
      'Exact city, 1–60 visible characters; requires operator-enabled location access and is rejected while personal-data redaction is on. Blank means unset.',
    ),
  zipCode: z
    .string()
    .regex(
      /^\s*(?:[0-9]{5}(?:-?[0-9]{4})?\s*)?$/,
      'Must be five digits or ZIP+4, such as 99999 or 99999-1234; blank means unset',
    )
    .optional()
    .describe(
      'Five-digit ZIP or ZIP+4, preserving leading zeros; requires operator-enabled location access and is rejected while personal-data redaction is on. Blank means unset.',
    ),
  nameMatch: z
    .enum(NAME_MATCHES)
    .optional()
    .describe(
      'How each supplied name field matches; default words for name searches. words: the field equals the term or continues with a space after it; only a space separates words, so a hyphenated or apostrophe name is one word. exact: the whole field. prefix: the field begins with the term, also mid-word; rejected while personal-data redaction is on.',
    ),
};
const uniqueIdDescription = `Opaque FAA Unique ID from ${UNIQUE_ID_SOURCE}, A or C plus seven digits, for example A9999999; not a certificate number.`;
/** Flat identity selector; service validates mutually exclusive modes. */
export const identityInput = {
  mode: z
    .enum(['id', 'name'])
    .describe(
      'id requires uniqueId and forbids nonblank name/location fields and explicit nameMatch; name requires lastName, plus firstName while personal-data redaction is on, and forbids nonblank uniqueId.',
    ),
  uniqueId: z
    .string()
    .regex(
      /^\s*(?:[AaCc][0-9]{7}\s*)?$/,
      `Must be A or C plus seven digits, such as A9999999, from ${UNIQUE_ID_SOURCE}; blank means unset`,
    )
    .optional()
    .describe(`${uniqueIdDescription} Trimmed and uppercased.`),
  ...nameInput,
};
/** One rating filter; the instructor and certificate searches share its parsing. */
export const ratingCode = z
  .string()
  .describe(
    'FAA rating code from faa_airmen_list_reference topic ratings, such as INSTA, matching any source level; level/code such as F/INSTA matches that level only. The code is 1–30 letters, digits, spaces, or hyphens and the level one letter; trimmed and uppercased.',
  );
/** Bounded paging over complete people or reference entries. */
export const pagingInput = {
  limit: z
    .number()
    .int()
    .min(1)
    .default(10)
    .describe(
      'Maximum complete people or reference entries per page; default 10, maximum 50. A larger limit returns at most 50, with a notice.',
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .max(10000)
    .default(0)
    .describe(
      'Zero-based offset; default 0, maximum 10000. Follow nextOffset or narrow filters at the cap.',
    ),
};
/** ID-only lookup input shared by ratings and medical tools. */
export const idInput = z
  .object({
    uniqueId: z
      .string()
      .regex(
        /^\s*[AaCc][0-9]{7}\s*$/,
        `Must be A or C plus seven digits, such as A9999999, from ${UNIQUE_ID_SOURCE}`,
      )
      .describe(uniqueIdDescription),
  })
  .strict();
/** All supported static and dynamic reference topics. */
export const topicSchema = z
  .enum(REFERENCE_TOPICS)
  .describe('One FAA vocabulary, interpretation guide, or mirror diagnostic topic.');
/** Fully typed informational medical output. */
export const medicalRecordSchema = z
  .object({
    sourceFamilies: z
      .array(sourceFamily)
      .describe('Source families contributing these medical fields.'),
    medicalClass: codeSchema
      .optional()
      .describe('Reported medical class; no fitness or eligibility verdict.'),
    medicalDateRaw: z
      .string()
      .optional()
      .describe('Raw source medical date, normally MMYYYY; malformed nonblank values retained.'),
    medicalExpireDateRaw: z
      .string()
      .optional()
      .describe(
        'Raw source medical expiry date, normally MMYYYY; not an eligibility determination.',
      ),
    basicMedCourseDateRaw: z
      .string()
      .optional()
      .describe('Raw BasicMed course date, normally YYYYMMDD.'),
    basicMedCmecDateRaw: z
      .string()
      .optional()
      .describe('Raw BasicMed examination checklist date, normally YYYYMMDD.'),
  })
  .describe('One distinct set of informational medical source fields.');
/** Reference output supports status diagnostics without opening a missing mirror. */
export const referenceOutput = z.object({
  topic: topicSchema,
  entries: z
    .array(
      z
        .object({
          ...codeFields,
          certificateType: z
            .string()
            .optional()
            .describe('Certificate type qualifying a level code.'),
          obsolete: z.boolean().optional().describe('Whether the documented rating is obsolete.'),
          guidance: z
            .string()
            .optional()
            .describe('Sourced interpretation or operational guidance.'),
          sourceUrls: z
            .array(z.string().describe('Official reference URL.'))
            .describe('Official sources supporting this entry.'),
        })
        .describe('Documented code or sourced guidance.'),
    )
    .describe('Complete matching reference entries for this page.'),
  mirrorStatus: z
    .object({
      state: z.enum(['missing', 'ready', 'unavailable']).describe('Published mirror availability.'),
      refreshState: z
        .enum(['idle', 'running', 'failed', 'unreadable'])
        .describe(
          'Most recent refresh lifecycle state: idle when none is recorded or the last one completed, running while one is in progress within its 40-minute deadline, failed when the last one did not complete (see lastRefreshFailure), unreadable when its record cannot be read or is not a valid refresh record, which leaves state and lookups unaffected; the entry guidance names the repair.',
        ),
      provenance: provenanceSchema
        .optional()
        .describe('Latest successful generation provenance, when available.'),
      lastRefreshFailure: z
        .string()
        .optional()
        .describe(
          'Classified stage of the last refresh that did not complete, such as acquisition, schema, validation, disk, lock, or integrity; cancelled when its caller stopped it, timeout when one of its own deadlines expired, interrupted when its process ended without recording a result. Never paths or raw exception text.',
        ),
    })
    .optional()
    .describe('Safe diagnostic state present only for mirror_status.'),
});
