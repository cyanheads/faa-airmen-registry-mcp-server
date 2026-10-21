/**
 * @fileoverview faa_airmen_get_type_ratings read-only offline registry tool.
 * @module mcp-server/tools/definitions/get-type-ratings.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getAirmenRegistryService } from '@/services/airmen/airmen-registry-service.js';
import { formatResult, singleTrailer } from '../render.js';
import { airmanSchema, certificateSchema, idInput, singleEnrichment } from '../schemas.js';

/** Read all source aircraft type, category/class, and instrument ratings for one FAA airman Unique ID. Get the ID from faa_airmen_verify_certificate. Ratings retain their source certificate type and level and do not establish current operating privileges. */
export const getTypeRatingsTool = tool('faa_airmen_get_type_ratings', {
  description:
    'Read all source aircraft type, category/class, and instrument ratings for one FAA airman Unique ID. Get the ID from faa_airmen_verify_certificate. Ratings retain their source certificate type and level and do not establish current operating privileges.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: idInput,
  output: z.object({
    found: z.boolean().describe('Whether this Unique ID occurs in the releasable snapshot.'),
    airman: airmanSchema.optional().describe('Matched person, absent for a missing ID.'),
    certificates: z
      .array(certificateSchema)
      .optional()
      .describe(
        'All pilot-family certificates with complete rating arrays; empty when the person has no reported pilot-family certificate.',
      ),
  }),
  enrichment: singleEnrichment,
  enrichmentTrailer: singleTrailer,
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
    const result = await getAirmenRegistryService().getRatings(input, ctx);
    ctx.enrich(result.enrichment);
    return result.data;
  },
  format: formatResult,
});
