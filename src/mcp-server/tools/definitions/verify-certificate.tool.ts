/**
 * @fileoverview faa_airmen_verify_certificate read-only offline registry tool.
 * @module mcp-server/tools/definitions/verify-certificate.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getAirmenRegistryService } from '@/services/airmen/airmen-registry-service.js';
import { formatResult, listTrailer } from '../render.js';
import {
  airmanSchema,
  certificateSchema,
  definedInput,
  identityInput,
  listEnrichment,
  pagingInput,
  ratingCode,
} from '../schemas.js';

/** Find releasable FAA airman records by exact Unique ID or name and read their certificate records. Use name mode to discover IDs, then use an ID for ratings or informational medical fields. Certificate type, level, rating, and type-rating filters must all match one certificate, and each match still returns all its certificates. While the operator's personal-data redaction is on (the default), name mode needs lastName and firstName, nameMatch prefix and city or ZIP filters are rejected, and city and ZIP are withheld. A missing or matching record is not a current licensing or operating-privilege determination. */
export const verifyCertificateTool = tool('faa_airmen_verify_certificate', {
  description:
    "Find releasable FAA airman records by exact Unique ID or name and read their certificate records. Use name mode to discover IDs, then use an ID for ratings or informational medical fields. Certificate type, level, rating, and type-rating filters must all match one certificate, and each match still returns all its certificates. While the operator's personal-data redaction is on (the default), name mode needs lastName and firstName, nameMatch prefix and city or ZIP filters are rejected, and city and ZIP are withheld. A missing or matching record is not a current licensing or operating-privilege determination.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z
    .object({
      ...identityInput,
      certificateType: z
        .string()
        .optional()
        .describe(
          'One FAA certificate type letter, its description from faa_airmen_list_reference topic certificate_types (case-insensitive; underscore or space, such as remote pilot or flight_instructor), or CFI; selects people while retaining all their certificates.',
        ),
      certificateLevel: z
        .string()
        .optional()
        .describe(
          "One level letter listed for the certificateType in faa_airmen_list_reference topic certificate_levels, such as A (airline transport pilot) with certificateType P; requires certificateType and matches the certificate's own level. Trimmed and uppercased; blank means unset.",
        ),
      ratingCodes: z
        .array(ratingCode)
        .min(1)
        .max(11)
        .optional()
        .describe(
          'One to eleven rating codes, repeats collapsed; every code must occur on the same certificate as every other requested credential, never across certificates.',
        ),
      typeRatings: z
        .array(
          z
            .string()
            .describe(
              'Aircraft type designator from faa_airmen_list_reference topic type_ratings, such as B-737, matching any source level; level/designator such as A/B-737 matches that slot level only, which can differ from certificateLevel. The designator is 1–30 letters, digits, spaces, or hyphens and the level one letter; trimmed and uppercased; hyphens are significant.',
            ),
        )
        .min(1)
        .max(11)
        .optional()
        .describe(
          'One to eleven type-rating designators, repeats collapsed; every designator must occur on the same certificate as every other requested credential.',
        ),
      ...pagingInput,
    })
    .strict(),
  output: z.object({
    matches: z
      .array(
        z
          .object({
            airman: airmanSchema,
            certificates: z
              .array(certificateSchema)
              .describe(
                'All certificates for the matched person, including types outside the filter.',
              ),
          })
          .describe('Complete person and certificates.'),
      )
      .describe('Separate identity candidates; never infer a single person from multiple matches.'),
  }),
  enrichment: listEnrichment,
  enrichmentTrailer: listTrailer,
  errors: [
    {
      reason: 'invalid_identity',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Invalid or blank semantic identity selector.',
      recovery:
        'Call faa_airmen_list_reference with topic identifiers, then retry with a Unique ID or a nonblank lastName, plus firstName while personal-data redaction is on.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Invalid code, location, or filter combination after normalization.',
      recovery:
        'Correct the filter the error names, taking its codes from the matching faa_airmen_list_reference topic (certificate_types, certificate_levels, ratings, or type_ratings), then retry.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'location_access_disabled',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Nonblank city or ZIP filter supplied while location access is disabled.',
      recovery:
        'Retry faa_airmen_verify_certificate or faa_airmen_search_instructors using name and state only; city and ZIP access is disabled by the operator.',
      retryable: false,
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'pii_redacted',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Personal-data redaction is on and the call sends city or ZIP, a name search without both names, or nameMatch prefix.',
      recovery:
        'Retry with both lastName and firstName, nameMatch words or exact, and no city or zipCode, or use mode id with a uniqueId; for a personal install, the operator can set FAA_AIRMEN_REDACT_PII=false.',
      retryable: false,
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'mirror_missing',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'No complete published mirror generation is available.',
      recovery:
        'Call faa_airmen_list_reference with topic mirror_status for initialization instructions; ask the operator to run the mirror init command, then retry.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'mirror_unavailable',
      code: JsonRpcErrorCode.DatabaseError,
      when: 'Published generation is corrupt, missing, incompatible, or unreadable.',
      recovery:
        'Call faa_airmen_list_reference with topic mirror_status; ask the operator to verify or rebuild the mirror, then retry.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'mirror_rebuild_required',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Location access is enabled but this generation discarded city and ZIP.',
      recovery:
        'Call faa_airmen_list_reference with topic mirror_status; ask the operator to rebuild the mirror with location access enabled, then retry.',
      retryable: false,
      thrownBy: 'service',
    },
  ],
  async handler(input, ctx) {
    const result = await getAirmenRegistryService().verifyCertificates(definedInput(input), ctx);
    ctx.enrich(result.enrichment);
    return result.data;
  },
  format: formatResult,
});
