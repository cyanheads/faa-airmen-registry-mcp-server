/** Canonical tool fixtures and lossless content decoding for contract tests. */
import { checkMedicalStatusTool } from '../../src/mcp-server/tools/definitions/check-medical-status.tool.js';
import { getTypeRatingsTool } from '../../src/mcp-server/tools/definitions/get-type-ratings.tool.js';
import { listReferenceTool } from '../../src/mcp-server/tools/definitions/list-reference.tool.js';
import { searchInstructorsTool } from '../../src/mcp-server/tools/definitions/search-instructors.tool.js';
import { verifyCertificateTool } from '../../src/mcp-server/tools/definitions/verify-certificate.tool.js';
import { verifyRemotePilotTool } from '../../src/mcp-server/tools/definitions/verify-remote-pilot.tool.js';

/** All six definitions consumed by the production entry point. */
export const tools = [
  verifyCertificateTool,
  getTypeRatingsTool,
  checkMedicalStatusTool,
  searchInstructorsTool,
  verifyRemotePilotTool,
  listReferenceTool,
] as const;
/** Schema-valid representative inputs with populated result paths. */
export const inputs = [
  { mode: 'id', uniqueId: 'A9999999' },
  { uniqueId: 'A9999999' },
  { uniqueId: 'A9999999' },
  { state: 'WA' },
  { mode: 'id', uniqueId: 'A9999999' },
  { topic: 'certificate_types', limit: 50 },
] as const;

/** Decode JSON fences, honoring variable fence lengths around source backticks. */
export function jsonFences(text: string): unknown[] {
  const lines = text.split('\n');
  const values: unknown[] = [];
  for (let index = 0; index < lines.length; index++) {
    const match = /^(`{3,})json$/.exec(lines[index] ?? '');
    if (!match) continue;
    const content: string[] = [];
    while (++index < lines.length && lines[index] !== match[1]) content.push(lines[index]!);
    values.push(JSON.parse(content.join('\n')));
  }
  return values;
}

/** Reconstruct domain plus independently labeled enrichment exactly as clients can. */
export function renderedResult(
  content: { type: string; text?: string }[],
): Record<string, unknown> {
  const text = content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
  const domain = jsonFences(text)[0] as Record<string, unknown>;
  const enrichment: Record<string, unknown> = {};
  const fields = [
    ...text.matchAll(
      /\*\*(notice|provenance|appliedFilters|totalCount|returnedCount|hasMore|nextOffset|atPagingCap)\*\*/g,
    ),
  ];
  for (const [index, field] of fields.entries()) {
    const section = text.slice((field.index ?? 0) + field[0].length, fields[index + 1]?.index);
    enrichment[field[1]!] = jsonFences(section)[0];
  }
  return { ...domain, ...enrichment };
}
