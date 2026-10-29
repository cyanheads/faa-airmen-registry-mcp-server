/**
 * @fileoverview faa_airmen_check_medical_status read-only offline registry tool.
 * @module mcp-server/tools/definitions/check-medical-status.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getAirmenRegistryService } from '@/services/airmen/airmen-registry-service.js';
import { formatResult, singleTrailer } from '../render.js';
import { airmanSchema, idInput, medicalRecordSchema, singleEnrichment } from '../schemas.js';

/** Read the FAA snapshot's informational medical class, medical dates, and BasicMed dates for one airman Unique ID. These fields are not authoritative medical certification or fitness determinations. Get the ID from a faa_airmen_verify_certificate, faa_airmen_search_instructors, or faa_airmen_verify_remote_pilot result. Every call is rejected while the operator's personal-data redaction is on (the default). */
export const checkMedicalStatusTool = tool('faa_airmen_check_medical_status', {
  description:
    "Read the FAA snapshot's informational medical class, medical dates, and BasicMed dates for one airman Unique ID. These fields are not authoritative medical certification or fitness determinations. Get the ID from a faa_airmen_verify_certificate, faa_airmen_search_instructors, or faa_airmen_verify_remote_pilot result. Every call is rejected while the operator's personal-data redaction is on (the default).",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: idInput,
  output: z.object({
    found: z.boolean().describe('Whether this Unique ID occurs in the releasable snapshot.'),
    airman: airmanSchema.optional().describe('Matched person, absent for a missing ID.'),
    medicalRecords: z
      .array(medicalRecordSchema)
      .optional()
      .describe(
        'All distinct reported medical records; empty when a known person has no reported medical fields.',
      ),
    hasReportedMedicalFields: z
      .boolean()
      .optional()
      .describe(
        'Whether any medical fields were reported; absent for a missing person, never an adverse finding.',
      ),
    disclaimer: z.string().describe('Medical information limitations, present on every result.'),
  }),
  enrichment: singleEnrichment,
  enrichmentTrailer: singleTrailer,
  errors: [
    {
      reason: 'pii_redacted',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Personal-data redaction is on; every medical call that passes the input schema is rejected before the ID is checked or the mirror is read.',
      recovery:
        'Use faa_airmen_verify_certificate or faa_airmen_get_type_ratings for certificate records; for a personal install, the operator can set FAA_AIRMEN_REDACT_PII=false to read informational medical fields.',
      retryable: false,
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_identity',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Invalid or blank semantic identity selector.',
      recovery:
        'Use faa_airmen_verify_certificate with mode name and lastName to obtain a Unique ID, then retry faa_airmen_check_medical_status with that uniqueId.',
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
    const result = await getAirmenRegistryService().getMedical(input, ctx);
    ctx.enrich(result.enrichment);
    return result.data;
  },
  format: formatResult,
});
