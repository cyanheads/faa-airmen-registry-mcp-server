/**
 * @fileoverview Lossless JSON rendering with safe fences and real source links.
 * @module mcp-server/tools/render
 */

import { markdownLink } from '@cyanheads/mcp-ts-core/utils';

/** Render arbitrary JSON data without allowing embedded source strings to end the fence. */
export function renderJson(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  const runs = json.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  const urls = new Set<string>();
  function visit(item: unknown): void {
    if (typeof item === 'string') {
      for (const match of item.matchAll(/https?:\/\/[^\s<>"`]+/g)) urls.add(match[0]);
    } else if (Array.isArray(item)) {
      for (const child of item) visit(child);
    } else if (item && typeof item === 'object') {
      for (const child of Object.values(item)) visit(child);
    }
  }
  visit(value);
  const links = [...urls].map((url) => markdownLink('Source', url));
  return `${fence}json\n${json}\n${fence}${links.length ? `\n\n${links.join('\n')}` : ''}`;
}

/** Preserve every output field on the content surface. */
export function formatResult(value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: renderJson(value) }];
}

/** Label one enrichment field and render its value as lossless JSON. */
function labeled(label: string) {
  return { render: (value: unknown) => `**${label}**\n\n${renderJson(value)}` };
}

/** Render scalar enrichment too, preserving embedded newlines and Markdown as JSON data. */
export const singleTrailer = {
  notice: labeled('notice'),
  provenance: labeled('provenance'),
  appliedFilters: labeled('appliedFilters'),
  piiRedacted: labeled('piiRedacted'),
};
/** Each enrichment field remains independently recoverable as lossless JSON. */
export const listTrailer = {
  ...singleTrailer,
  totalCount: labeled('totalCount'),
  returnedCount: labeled('returnedCount'),
  hasMore: labeled('hasMore'),
  nextOffset: labeled('nextOffset'),
  atPagingCap: labeled('atPagingCap'),
};
