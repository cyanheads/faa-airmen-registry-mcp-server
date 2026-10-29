/**
 * @fileoverview faa_airmen_verify_remote_pilot read-only offline registry tool.
 * @module mcp-server/tools/definitions/verify-remote-pilot.tool
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

/** Find releasable FAA remote pilot certificate records by Unique ID or name. While the operator's personal-data redaction is on (the default), name mode needs lastName and firstName, nameMatch prefix and city or ZIP filters are rejected, and city and ZIP are withheld. Results establish certificate presence in the local snapshot; they do not establish recurrent-training currency, commercial operating authority, or current Part 107 eligibility. */
export const verifyRemotePilotTool = tool('faa_airmen_verify_remote_pilot', {
  description:
    "Find releasable FAA remote pilot certificate records by Unique ID or name. While the operator's personal-data redaction is on (the default), name mode needs lastName and firstName, nameMatch prefix and city or ZIP filters are rejected, and city and ZIP are withheld. Results establish certificate presence in the local snapshot; they do not establish recurrent-training currency, commercial operating authority, or current Part 107 eligibility.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({ ...identityInput, ...pagingInput }).strict(),
  output: z.object({
    matches: z
      .array(
        z
          .object({
            airman: airmanSchema,
            remotePilotCertificates: z
              .array(certificateSchema)
              .describe(
                'Every reported U certificate, preserving blank levels and all reported ratings.',
              ),
          })
          .describe('Person and complete remote pilot certificates.'),
      )
      .describe('Candidates with U certificate records in this snapshot.'),
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
        'Retry faa_airmen_verify_remote_pilot with a two-letter USPS state code and nameMatch words or exact (prefix only while personal-data redaction is off); omit blank optional filters, and use a limit of at least 1 and an offset of 0–10000.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'location_access_disabled',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Nonblank city or ZIP filter supplied while location access is disabled.',
      recovery:
        'Retry faa_airmen_verify_remote_pilot using name and state only; city and ZIP access is disabled by the operator.',
      retryable: false,
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'pii_redacted',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Personal-data redaction is on and the call sends city or ZIP, a name search without both names, or nameMatch prefix.',
      recovery:
        'Retry faa_airmen_verify_remote_pilot with both lastName and firstName, nameMatch words or exact, and no city or zipCode, or with mode id and a uniqueId; for a personal install, the operator can set FAA_AIRMEN_REDACT_PII=false.',
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
    const result = await getAirmenRegistryService().verifyRemotePilot(definedInput(input), ctx);
    ctx.enrich(result.enrichment);
    return result.data;
  },
  format: formatResult,
});
