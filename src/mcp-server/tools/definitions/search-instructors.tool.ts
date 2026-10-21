/**
 * @fileoverview faa_airmen_search_instructors read-only offline registry tool.
 * @module mcp-server/tools/definitions/search-instructors.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getAirmenRegistryService } from '@/services/airmen/airmen-registry-service.js';
import { formatResult, listTrailer } from '../render.js';
import {
  airmanSchema,
  certificateSchema,
  definedInput,
  listEnrichment,
  nameInput,
  pagingInput,
} from '../schemas.js';

/** Find releasable flight and ground instructor certificate records by name, state, and rating codes. Supply at least one name, state, city, ZIP, or rating filter. City and ZIP filters require operator-enabled location access. Legacy expiry fields do not establish instructor currency; CFI certificates no longer expire under the December 2024 rule. */
export const searchInstructorsTool = tool('faa_airmen_search_instructors', {
  description:
    'Find releasable flight and ground instructor certificate records by name, state, and rating codes. Supply at least one name, state, city, ZIP, or rating filter. City and ZIP filters require operator-enabled location access. Legacy expiry fields do not establish instructor currency; CFI certificates no longer expire under the December 2024 rule.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z
    .object({
      ...nameInput,
      instructorType: z
        .enum(['flight', 'ground', 'both'])
        .default('both')
        .describe('Select flight F, ground G, or both instructor certificate types; default both.'),
      ratingCodes: z
        .array(
          z
            .string()
            .describe(
              'FAA rating code, 1–30 normalized characters using letters, digits, spaces, or hyphens; obtain from faa_airmen_list_reference topic ratings.',
            ),
        )
        .min(1)
        .max(11)
        .optional()
        .describe(
          'One to eleven distinct codes; every code must occur on the same qualifying certificate, never across certificates.',
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
            instructorCertificates: z
              .array(certificateSchema)
              .describe(
                'Every F/G certificate satisfying all requested rating codes on that same certificate.',
              ),
          })
          .describe('Person and complete qualifying instructor certificates.'),
      )
      .describe(
        'Matching instructor candidates; certificate presence does not establish currency.',
      ),
  }),
  enrichment: listEnrichment,
  enrichmentTrailer: listTrailer,
  errors: [
    {
      reason: 'invalid_identity',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Invalid or blank semantic name filter.',
      recovery:
        'Call faa_airmen_list_reference with topic identifiers, then retry with a Unique ID or a nonblank name selector.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Invalid code, location, or filter combination after normalization.',
      recovery:
        'Call faa_airmen_list_reference with topic certificate_types or ratings, then retry with the documented filters.',
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
      thrownBy: 'service',
    },
    {
      reason: 'missing_search_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Instructor query has no qualifying name, location, or rating filter.',
      recovery:
        'Call faa_airmen_search_instructors with a name, state, or rating code from faa_airmen_list_reference.',
      retryable: false,
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
    const result = await getAirmenRegistryService().searchInstructors(definedInput(input), ctx);
    ctx.enrich(result.enrichment);
    return result.data;
  },
  format: formatResult,
});
