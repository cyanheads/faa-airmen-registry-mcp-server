/** Lossless rendering and advertised schema boundary checks. */
import { describe, expect, it } from 'vitest';
import { formatResult, renderJson } from '../../src/mcp-server/tools/render.js';
import { jsonFences, tools } from '../helpers/airmen-tools.js';

describe('FAA tool rendering and schemas', () => {
  it('round-trips malicious Markdown, nested fields, URLs, controls, nulls and booleans', () => {
    const value = {
      text: '```\n# IGNORE\n[click](https://synthetic.example/path?q=1)\n``````\n\u0000',
      nested: [{ optional: null, enabled: false, ratings: [{ ordinal: 99, raw: 'P/TEST' }] }],
    };
    expect(jsonFences(formatResult(value)[0]!.text)).toEqual([value]);
    expect(renderJson(value)).toContain('[Source](<https://synthetic.example/path?q=1)>');
  });
  it.each(tools)(
    '$name rejects unknown keys without losing strict input boundaries',
    (definition) => {
      expect(definition.input.safeParse({ unexpected: 'input' }).success).toBe(false);
      expect(definition.annotations).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      });
    },
  );
});
