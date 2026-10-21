/**
 * @fileoverview faa_airmen_list_reference read-only offline registry tool.
 * @module mcp-server/tools/definitions/list-reference.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getAirmenRegistryService } from '@/services/airmen/airmen-registry-service.js';
import { formatResult, listTrailer } from '../render.js';
import {
  definedInput,
  listEnrichment,
  pagingInput,
  referenceOutput,
  topicSchema,
} from '../schemas.js';

/** Read FAA certificate and rating codes, observed aircraft type designators, identity guidance, medical guidance, or local mirror status. Use these references to construct lookup filters and interpret snapshot limits. Static topics work before mirror initialization. */
export const listReferenceTool = tool('faa_airmen_list_reference', {
  description:
    'Read FAA certificate and rating codes, observed aircraft type designators, identity guidance, medical guidance, or local mirror status. Use these references to construct lookup filters and interpret snapshot limits. Static topics work before mirror initialization.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z
    .object({
      topic: topicSchema,
      filter: z
        .string()
        .optional()
        .describe(
          'Literal case-insensitive substring over code and description, 1–80 normalized characters; vocabulary topics only. Blank means unset.',
        ),
      ...pagingInput,
    })
    .strict(),
  output: referenceOutput,
  enrichment: listEnrichment,
  enrichmentTrailer: listTrailer,
  errors: [
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Invalid reference topic, filter text, or filter/topic combination after normalization.',
      recovery:
        'Retry faa_airmen_list_reference with a listed topic; use filter only for certificate_types, certificate_levels, ratings, or type_ratings, with at most 80 normalized characters.',
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
  ],
  async handler(input, ctx) {
    const result = await getAirmenRegistryService().listReference(definedInput(input), ctx);
    ctx.enrich(result.enrichment);
    return result.data;
  },
  format: formatResult,
});
