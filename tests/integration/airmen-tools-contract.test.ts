/** Production contract execution over real SQLite with both client consumption surfaces. */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initAirmenRegistryService } from '../../src/services/airmen/airmen-registry-service.js';
import {
  basicRow,
  certificateRow,
  sourceFetch,
  sourceFiles,
  zipSource,
} from '../helpers/airmen-source.js';
import { inputs, renderedResult, tools } from '../helpers/airmen-tools.js';

describe('FAA tool production contracts', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'faa-contract-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  function init(includeLocation = false) {
    const malicious = '``` [URL](https://synthetic.example/)\n# SOURCE DATA';
    const files = sourceFiles({
      pilotBasic: [
        basicRow(undefined, { 1: malicious, 10: '3', 11: 'MEDICAL-ONLY' }),
        basicRow('C9999998'),
      ],
      pilotCert: [
        certificateRow(undefined, true, { 3: 'F', 6: 'C/ASEL', 115: 'P/TYPE-99' }),
        certificateRow('C9999998'),
      ],
      nonpilotCert: [certificateRow(undefined, false, { 3: 'U', 4: '' })],
    });
    return initAirmenRegistryService(
      { mirrorDir: directory, includeLocation, staleAfterDays: 45 },
      { fetch: sourceFetch(zipSource(files)), clock: () => new Date('2026-10-20T00:00:00Z') },
    );
  }
  function parity(result: Awaited<ReturnType<typeof runToolContract>>) {
    expect(result.isError).not.toBe(true);
    expect(renderedResult(result.content)).toEqual(result.structuredContent);
  }

  it('registers exactly the six domain definitions in the production entry point', async () => {
    const entry = await readFile(new URL('../../src/index.ts', import.meta.url), 'utf8');
    for (const definition of tools)
      expect(entry).toContain(
        definition.name === 'faa_airmen_verify_certificate'
          ? 'verifyCertificateTool'
          : definition.name === 'faa_airmen_get_type_ratings'
            ? 'getTypeRatingsTool'
            : definition.name === 'faa_airmen_check_medical_status'
              ? 'checkMedicalStatusTool'
              : definition.name === 'faa_airmen_search_instructors'
                ? 'searchInstructorsTool'
                : definition.name === 'faa_airmen_verify_remote_pilot'
                  ? 'verifyRemotePilotTool'
                  : 'listReferenceTool',
      );
    expect(entry).not.toContain('echoTool');
  });
  it('preserves prototype-named unknown source codes through ZIP, SQLite and both output surfaces', async () => {
    const files = sourceFiles({
      pilotBasic: [basicRow(undefined, { 10: 'constructor' })],
      nonpilotBasic: [basicRow(undefined, { 10: 'constructor' })],
      pilotCert: [
        certificateRow(undefined, true, {
          3: 'constructor',
          4: 'toString',
          6: 'P/constructor',
          7: 'P/__proto__',
          8: 'P/toString',
        }),
        certificateRow(undefined, true, { 3: 'P', 4: 'constructor' }),
        certificateRow(undefined, true, { 3: '__proto__', 4: 'toString' }),
      ],
    });
    const service = initAirmenRegistryService(
      { mirrorDir: directory, includeLocation: false, staleAfterDays: 45 },
      { fetch: sourceFetch(zipSource(files)), clock: () => new Date('2026-10-20T00:00:00Z') },
    );
    await service.initialize();
    const certificates = await runToolContract(tools[0], { mode: 'id', uniqueId: 'A9999999' });
    parity(certificates);
    const data = renderedResult(certificates.content) as {
      matches: {
        certificates: {
          type: { code: string; description?: string };
          level?: { code: string; description?: string };
          ratings: { code: string; raw: string; description?: string }[];
        }[];
      }[];
    };
    const records = data.matches[0]!.certificates;
    expect(records.find((record) => record.type.code === 'constructor')).toMatchObject({
      type: { code: 'constructor' },
      level: { code: 'toString' },
      ratings: [
        { code: 'constructor', raw: 'P/constructor' },
        { code: '__proto__', raw: 'P/__proto__' },
        { code: 'toString', raw: 'P/toString' },
      ],
    });
    for (const record of records) {
      if (record.type.code !== 'P' && record.type.code !== 'U')
        expect(record.type).not.toHaveProperty('description');
      if (record.level?.code === 'constructor' || record.level?.code === 'toString')
        expect(record.level).not.toHaveProperty('description');
      for (const rating of record.ratings) expect(rating).not.toHaveProperty('description');
    }
    const medical = await runToolContract(tools[2], { uniqueId: 'A9999999' });
    parity(medical);
    expect(medical.structuredContent).toMatchObject({
      found: true,
      medicalRecords: [{ medicalClass: { code: 'constructor' } }],
    });
    const medicalData = renderedResult(medical.content) as {
      medicalRecords: { medicalClass: { code: string; description?: string } }[];
    };
    expect(medicalData.medicalRecords[0]!.medicalClass).not.toHaveProperty('description');
  });
  it('serves the real registered six-tool catalog and complete calls over stdio JSON-RPC', async () => {
    await init().initialize();
    const child = spawn('bun', ['run', 'src/index.ts'], {
      cwd: new URL('../..', import.meta.url),
      env: {
        ...process.env,
        MCP_TRANSPORT_TYPE: 'stdio',
        MCP_LOG_LEVEL: 'error',
        FAA_AIRMEN_MIRROR_DIR: directory,
        FAA_AIRMEN_INCLUDE_LOCATION: 'false',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: child.stdout });
    const pending = new Map<
      number,
      { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
    >();
    let sequence = 0;
    lines.on('line', (line) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof message.id !== 'number') return;
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result as Record<string, unknown>);
    });
    child.on('exit', (code) => {
      for (const waiter of pending.values())
        waiter.reject(new Error(`Synthetic MCP process exited: ${code}`));
      pending.clear();
    });
    function request(method: string, params: unknown) {
      const id = ++sequence;
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    }
    try {
      await request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'synthetic-fixture', version: '1' },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      );
      const catalog = await request('tools/list', {});
      expect((catalog.tools as { name: string }[]).map((tool) => tool.name).sort()).toEqual(
        tools.map((tool) => tool.name).sort(),
      );
      for (const [index, definition] of tools.entries()) {
        const result = await request('tools/call', {
          name: definition.name,
          arguments: inputs[index],
        });
        parity(result as Awaited<ReturnType<typeof runToolContract>>);
      }
      const invalid = await request('tools/call', {
        name: tools[0].name,
        arguments: { mode: 'name', lastName: ' ' },
      });
      expect(invalid).toMatchObject({
        isError: true,
        structuredContent: { error: { data: { reason: 'invalid_identity' } } },
      });
    } finally {
      lines.close();
      child.stdin.end();
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) resolve();
        else child.once('exit', () => resolve());
      });
    }
  });
  it.each(tools.map((definition, index) => ({ definition, input: inputs[index]! })))(
    '$definition.name preserves every domain and enrichment field on both surfaces',
    async ({ definition, input }) => {
      await init().initialize();
      const result = await runToolContract(definition, input);
      parity(result);
      const text = JSON.stringify(result);
      expect(text).not.toContain('PRIVATE STREET');
      expect(text).not.toContain('TEST CITY SENTINEL');
      if (definition.name !== 'faa_airmen_check_medical_status')
        expect(text).not.toContain('MEDICAL-ONLY');
    },
  );
  it('preserves missing optional branches, empty/past-end paging, max page and static provenance null', async () => {
    await init().initialize();
    const cases = [
      [tools[0], { mode: 'name', lastName: 'ABSENT' }],
      [tools[0], { mode: 'name', lastName: 'FIXTURE', offset: 50, limit: 50 }],
      [tools[1], { uniqueId: 'C0000000' }],
      [tools[2], { uniqueId: 'C0000000' }],
      [tools[2], { uniqueId: 'C9999998' }],
      [tools[3], { state: 'AK', limit: 50 }],
      [tools[4], { mode: 'id', uniqueId: 'C9999998' }],
      [tools[5], { topic: 'ratings', limit: 50 }],
      [tools[5], { topic: 'ratings', offset: 54 }],
      [tools[5], { topic: 'type_ratings' }],
    ] as const;
    for (const [definition, input] of cases) parity(await runToolContract(definition, input));
  });
  it('serves static references and missing status before initialization with full parity', async () => {
    init();
    for (const topic of [
      'certificate_types',
      'identifiers',
      'medical_guidance',
      'mirror_status',
    ] as const)
      parity(await runToolContract(tools[5], { topic }));
  });
  it('keeps a maximum reference page within the complete wire response budget', async () => {
    init();
    const result = await runToolContract(tools[5], { topic: 'ratings', limit: 50 });
    parity(result);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(24 * 1024);
    const structured = renderedResult(result.content);
    expect(structured.hasMore).toBe(true);
    expect(structured.nextOffset).toBe(structured.returnedCount);
  });
  it('puts every reachable declared failure reason and recovery on the contract path', async () => {
    init();
    const errors = [
      [tools[0], { mode: 'name', lastName: ' ' }, 'invalid_identity'],
      [
        tools[0],
        { mode: 'id', uniqueId: 'A9999999', lastName: 'PRIVATE INPUT' },
        'invalid_identity',
      ],
      [
        tools[0],
        { mode: 'name', lastName: 'PRIVATE INPUT', certificateType: 'ATP' },
        'invalid_filter',
      ],
      [
        tools[0],
        { mode: 'name', lastName: 'PRIVATE INPUT', city: 'PRIVATE CITY' },
        'location_access_disabled',
      ],
      [tools[3], {}, 'missing_search_filter'],
      [tools[1], { uniqueId: 'A9999999' }, 'mirror_missing'],
    ] as const;
    for (const [definition, input, reason] of errors) {
      const result = await runToolContract(definition, input);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { data: { reason } } });
      const contract = definition.errors?.find((entry) => entry.reason === reason);
      expect(JSON.stringify(result.content)).toContain(contract!.recovery);
      expect(JSON.stringify(result)).not.toContain('PRIVATE INPUT');
      expect(JSON.stringify(result)).not.toContain('PRIVATE CITY');
      expect(JSON.stringify(result)).not.toContain(directory);
    }
    await init().initialize();
    initAirmenRegistryService({ mirrorDir: directory, includeLocation: true, staleAfterDays: 45 });
    const rebuild = await runToolContract(tools[0], {
      mode: 'name',
      lastName: 'FIXTURE',
      city: 'TEST CITY SENTINEL',
    });
    expect(rebuild.structuredContent).toMatchObject({
      error: { data: { reason: 'mirror_rebuild_required' } },
    });
    await writeFile(join(directory, 'CURRENT'), '{}');
    const unavailable = await runToolContract(tools[1], { uniqueId: 'A9999999' });
    expect(unavailable.structuredContent).toMatchObject({
      error: { data: { reason: 'mirror_unavailable', retryable: true } },
    });
  });
  it('rejects unknown keys, paging bounds and bad ID schemas before successful execution', async () => {
    init();
    for (const input of [
      { mode: 'name', lastName: 'FIXTURE', unexpected: 'x' },
      { mode: 'name', lastName: 'FIXTURE', limit: 0 },
      { mode: 'name', lastName: 'FIXTURE', limit: 51 },
      { mode: 'name', lastName: 'FIXTURE', offset: 10001 },
    ] as const) {
      expect((await runToolContract(tools[0], input)).isError).toBe(true);
    }
    expect((await runToolContract(tools[1], { uniqueId: '123' })).isError).toBe(true);
  });
});
