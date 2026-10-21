/** Seeded adversarial inputs exercise all six real handlers without source downloads. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fuzzTool } from '@cyanheads/mcp-ts-core/testing/fuzz';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { initAirmenRegistryService } from '../../src/services/airmen/airmen-registry-service.js';
import { tools } from '../helpers/airmen-tools.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'faa-fuzz-'));
  initAirmenRegistryService({ mirrorDir: directory, includeLocation: false, staleAfterDays: 45 });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
it.each(tools)('$name classifies generated and adversarial input safely', async (definition) => {
  const report = await fuzzTool(definition, { numRuns: 25, numAdversarial: 20, seed: 20261020 });
  expect(report.crashes).toEqual([]);
  expect(report.leaks).toEqual([]);
  expect(report.prototypePollution).toBe(false);
});
