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
} from '../schemas.js';

/** Find releasable FAA airman records by exact Unique ID or name and read their certificate records. Use name mode to discover IDs, then use an ID for ratings or informational medical fields. A missing or matching record is not a current licensing or operating-privilege determination. */
export const verifyCertificateTool = tool('faa_airmen_verify_certificate', {
  description:
    'Find releasable FAA airman records by exact Unique ID or name and read their certificate records. Use name mode to discover IDs, then use an ID for ratings or informational medical fields. A missing or matching record is not a current licensing or operating-privilege determination.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z
    .object({
      ...identityInput,
      certificateType: z
        .string()
        .optional()
        .describe(
          'One FAA certificate type letter or one-to-one alias pilot, CFI, remote_pilot, ground_instructor, mechanic, dispatcher; selects people while retaining all their certificates.',
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
