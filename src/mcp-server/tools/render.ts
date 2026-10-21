/**
 * @fileoverview Lossless JSON rendering with safe fences and real source links.
 * @module mcp-server/tools/render
 */

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
  const links = [...urls].map(
    (url) => `[Source](<${url.replaceAll('\\', '%5C').replaceAll('>', '%3E')}>)`,
  );
  return `${fence}json\n${json}\n${fence}${links.length ? `\n\n${links.join('\n')}` : ''}`;
}

/** Preserve every output field on the content surface. */
export function formatResult(value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: renderJson(value) }];
}

/** Render scalar enrichment too, preserving embedded newlines and Markdown as JSON data. */
export const singleTrailer = {
  notice: { render: (value: unknown) => `**notice**\n\n${renderJson(value)}` },
  provenance: { render: (value: unknown) => `**provenance**\n\n${renderJson(value)}` },
  appliedFilters: { render: (value: unknown) => `**appliedFilters**\n\n${renderJson(value)}` },
};
/** Each enrichment field remains independently recoverable as lossless JSON. */
export const listTrailer = {
  ...singleTrailer,
  totalCount: { render: (value: unknown) => `**totalCount**\n\n${renderJson(value)}` },
  returnedCount: { render: (value: unknown) => `**returnedCount**\n\n${renderJson(value)}` },
  hasMore: { render: (value: unknown) => `**hasMore**\n\n${renderJson(value)}` },
  nextOffset: { render: (value: unknown) => `**nextOffset**\n\n${renderJson(value)}` },
  atPagingCap: { render: (value: unknown) => `**atPagingCap**\n\n${renderJson(value)}` },
};
