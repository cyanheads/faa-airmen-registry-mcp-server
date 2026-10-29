/** Production contract execution over real SQLite with both client consumption surfaces. */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AirmenRegistryService,
  initAirmenRegistryService,
} from '../../src/services/airmen/airmen-registry-service.js';
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
  function init(includeLocation = false, redactPii = false) {
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
      { mirrorDir: directory, includeLocation, staleAfterDays: 45, redactPii },
      { fetch: sourceFetch(zipSource(files)), clock: () => new Date('2026-10-20T00:00:00Z') },
    );
  }
  function parity(result: Awaited<ReturnType<typeof runToolContract>>) {
    expect(result.isError).not.toBe(true);
    expect(renderedResult(result.content)).toEqual(result.structuredContent);
  }
  /** Documented codes and well-formed dates only, so no record carries a source-quality issue. */
  function clean() {
    const medical = { 10: '3', 11: '102026', 12: '102028' };
    const files = sourceFiles({
      pilotBasic: [basicRow(undefined, medical), basicRow('C9999998', { 1: 'GROUND' })],
      nonpilotBasic: [basicRow(undefined, medical)],
      pilotCert: [
        certificateRow(undefined, true, { 6: 'P/ASEL', 7: 'P/INST', 17: 'P/SYNTH-1' }),
        certificateRow(undefined, true, { 3: 'F', 4: '', 6: 'C/ASEL', 7: 'C/INSTA' }),
      ],
      nonpilotCert: [
        certificateRow(undefined, false, { 3: 'U', 4: '' }),
        certificateRow('C9999998', false, { 1: 'GROUND', 3: 'G', 4: '', 6: 'G/ADV' }),
      ],
    });
    return initAirmenRegistryService(
      { mirrorDir: directory, includeLocation: false, staleAfterDays: 45, redactPii: false },
      { fetch: sourceFetch(zipSource(files)), clock: () => new Date('2026-10-20T00:00:00Z') },
    );
  }
  const enrichmentKeys = new Set([
    'notice',
    'provenance',
    'appliedFilters',
    'piiRedacted',
    'totalCount',
    'returnedCount',
    'hasMore',
    'nextOffset',
    'atPagingCap',
  ]);
  /** Domain output exactly as serialized, with per-generation record IDs masked. */
  function domainBytes(result: Awaited<ReturnType<typeof runToolContract>>): string {
    const structured = result.structuredContent as Record<string, unknown>;
    return JSON.stringify(
      Object.fromEntries(Object.entries(structured).filter(([key]) => !enrichmentKeys.has(key))),
      (key, value) => (key === 'recordId' ? '<recordId>' : value),
    );
  }
  /** The notice as both client surfaces carry it; they must agree. */
  function noticeOf(result: Awaited<ReturnType<typeof runToolContract>>): string {
    parity(result);
    return (result.structuredContent as { notice: string }).notice;
  }
  const limits =
    'Snapshot presence and absence do not determine current certification, operating privileges, training currency, medical fitness, or eligibility; address-withheld airmen are omitted.';
  const locationOff = 'City and ZIP access is disabled by the operator.';
  /** The sentence a limit-50 page the size budget cut carries while another page is reachable. */
  const budgetCut = (nextOffset: number) =>
    `The response size budget ended this page before limit 50; more results remain, so repeat the call with offset ${nextOffset}.`;
  const quality =
    'A returned record contains an undocumented code or a malformed source date or rating; raw values are retained.';
  /** Clean people beside people whose own records carry source-quality issues; snapshot counters are nonzero. */
  function mixed() {
    const person = (id: string, first: string, overrides: Record<number, string> = {}) =>
      basicRow(id, { 1: first, ...overrides });
    const cert = (id: string, first: string, pilot: boolean, overrides: Record<number, string>) =>
      certificateRow(id, pilot, { 1: first, ...overrides });
    const files = sourceFiles({
      pilotBasic: [
        person('A9999999', 'CLEAN', { 10: '3', 11: '102026' }),
        person('A9999997', 'DIRTY', { 10: '8' }),
        person('A9999995', 'MIXED'),
        person('A9999996', 'REMOTE', { 10: '1', 11: '102026' }),
      ],
      nonpilotBasic: [person('A9999999', 'CLEAN', { 10: '3', 11: '102026' })],
      pilotCert: [
        cert('A9999999', 'CLEAN', true, { 6: 'P/ASEL', 17: 'P/SYNTH-1' }),
        cert('A9999999', 'CLEAN', true, { 3: 'F', 4: '', 6: 'C/INSTA' }),
        cert('A9999997', 'DIRTY', true, { 4: 'Q', 6: 'Q/ASEL' }),
        cert('A9999997', 'DIRTY', true, { 3: 'F', 4: '', 5: '13012026', 6: 'C/XYZ' }),
        cert('A9999995', 'MIXED', true, { 4: 'Q' }),
        cert('A9999995', 'MIXED', true, { 3: 'F', 4: '', 6: 'C/ASEL' }),
        cert('A9999996', 'REMOTE', true, {}),
      ],
      nonpilotCert: [
        cert('A9999999', 'CLEAN', false, { 3: 'U', 4: '', 6: 'U/SUAS' }),
        cert('A9999995', 'MIXED', false, { 3: 'U', 4: '', 6: 'U/SUAS' }),
        cert('A9999996', 'REMOTE', false, { 3: 'U', 4: '', 6: 'USUAS' }),
      ],
    });
    return initAirmenRegistryService(
      { mirrorDir: directory, includeLocation: false, staleAfterDays: 45, redactPii: false },
      { fetch: sourceFetch(zipSource(files)), clock: () => new Date('2026-10-20T00:00:00Z') },
    );
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
      { mirrorDir: directory, includeLocation: false, staleAfterDays: 45, redactPii: false },
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
  type Request = (method: string, params: unknown) => Promise<Record<string, unknown>>;
  /** The inherited environment without the redaction switch, so each session sets it explicitly. */
  const { FAA_AIRMEN_REDACT_PII: _redactPii, ...inherited } = process.env;
  /**
   * One initialized stdio session of the real entry point over the synthetic mirror, then stop it.
   * `logs`, when passed, receives every record of the server's `combined.log` file sink at level
   * debug once the process has exited; under a test environment the logger writes only its file sinks.
   */
  async function stdio<T>(
    redactPii: string | undefined,
    session: (request: Request) => Promise<T>,
    logs?: Record<string, unknown>[],
  ): Promise<T> {
    const logsDir = logs && (await mkdtemp(join(tmpdir(), 'faa-logs-')));
    const child = spawn('bun', ['run', 'src/index.ts'], {
      cwd: new URL('../..', import.meta.url),
      env: {
        ...inherited,
        MCP_TRANSPORT_TYPE: 'stdio',
        MCP_LOG_LEVEL: logs ? 'debug' : 'error',
        ...(logsDir && { LOGS_DIR: logsDir }),
        FAA_AIRMEN_MIRROR_DIR: directory,
        FAA_AIRMEN_INCLUDE_LOCATION: 'false',
        ...(redactPii !== undefined && { FAA_AIRMEN_REDACT_PII: redactPii }),
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
      return await session(request);
    } finally {
      lines.close();
      child.stdin.end();
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) resolve();
        else child.once('exit', () => resolve());
      });
      if (logsDir) {
        const written = await readFile(join(logsDir, 'combined.log'), 'utf8');
        logs?.push(
          ...written
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, unknown>),
        );
        await rm(logsDir, { recursive: true, force: true });
      }
    }
  }
  it('serves the real registered six-tool catalog and complete calls over stdio JSON-RPC', async () => {
    await init().initialize();
    await stdio('false', async (request) => {
      const catalog = await request('tools/list', {});
      expect((catalog.tools as { name: string }[]).map((tool) => tool.name).sort()).toEqual(
        tools.map((tool) => tool.name).sort(),
      );
      // Per-call provenance schema: 1,265 B measured; the bound is 1,300 B.
      for (const tool of catalog.tools as {
        name: string;
        outputSchema: { properties: { provenance: unknown } };
      }[]) {
        const schema = JSON.stringify(tool.outputSchema.properties.provenance);
        expect({ tool: tool.name, bytes: Buffer.byteLength(schema) <= 1300 }).toEqual({
          tool: tool.name,
          bytes: true,
        });
        expect(schema).not.toContain('sha256');
      }
      // The only full provenance schema left in the catalog is mirror_status's mirrorStatus.provenance.
      expect(JSON.stringify(catalog).split('"sha256":')).toHaveLength(2);
      const nameModes = (
        catalog.tools as { inputSchema: { properties: Record<string, unknown> } }[]
      )
        .map((tool) => tool.inputSchema.properties.nameMatch)
        .filter(Boolean);
      expect(nameModes).toHaveLength(3);
      for (const schema of nameModes)
        expect(schema).toMatchObject({ enum: ['words', 'exact', 'prefix'] });
      const properties = Object.fromEntries(
        (
          catalog.tools as {
            name: string;
            inputSchema: { properties: Record<string, { pattern?: string; maximum?: number }> };
          }[]
        ).map((tool) => [tool.name, tool.inputSchema.properties]),
      );
      const patterns = Object.fromEntries(
        Object.entries(properties).map(([name, fields]) => [
          name,
          Object.fromEntries(
            Object.entries(fields)
              .filter(([, field]) => field.pattern !== undefined)
              .map(([key, field]) => [key, field.pattern]),
          ),
        ]),
      );
      const optionalId = '^\\s*(?:[AaCc][0-9]{7}\\s*)?$',
        requiredId = '^\\s*[AaCc][0-9]{7}\\s*$',
        zip = '^\\s*(?:[0-9]{5}(?:-?[0-9]{4})?\\s*)?$';
      expect(patterns).toEqual({
        faa_airmen_verify_certificate: { uniqueId: optionalId, zipCode: zip },
        faa_airmen_verify_remote_pilot: { uniqueId: optionalId, zipCode: zip },
        faa_airmen_search_instructors: { zipCode: zip },
        faa_airmen_get_type_ratings: { uniqueId: requiredId },
        faa_airmen_check_medical_status: { uniqueId: requiredId },
        faa_airmen_list_reference: {},
      });
      // The service checks state against the USPS codes after uppercasing; the schema stays a bare string.
      for (const name of [
        'faa_airmen_verify_certificate',
        'faa_airmen_verify_remote_pilot',
        'faa_airmen_search_instructors',
      ])
        expect(Object.keys(properties[name]?.state ?? {}).sort()).toEqual(['description', 'type']);
      for (const name of [
        'faa_airmen_verify_certificate',
        'faa_airmen_verify_remote_pilot',
        'faa_airmen_search_instructors',
        'faa_airmen_list_reference',
      ])
        expect(properties[name]?.limit?.maximum ?? Number.MAX_SAFE_INTEGER).toBeGreaterThan(50);
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
    });
  });
  it('advertises a byte-identical tools/list with redaction on by default and off', async () => {
    await init().initialize();
    const session = (redactPii: string | undefined) =>
      stdio(redactPii, async (request) => ({
        catalog: JSON.stringify(await request('tools/list', {})),
        ratings: await request('tools/call', {
          name: tools[1].name,
          arguments: { uniqueId: 'A9999999' },
        }),
        medical: await request('tools/call', {
          name: tools[2].name,
          arguments: { uniqueId: 'A9999999' },
        }),
      }));
    const redacted = await session(undefined);
    const open = await session('false');
    expect(redacted.catalog).toBe(open.catalog);
    expect(redacted.catalog).toContain('"piiRedacted"');
    expect(redacted.ratings).toMatchObject({
      structuredContent: { found: true, piiRedacted: true },
    });
    expect(open.ratings).toMatchObject({ structuredContent: { found: true, piiRedacted: false } });
    expect(redacted.medical).toMatchObject({
      isError: true,
      structuredContent: { error: { code: -32005, data: { reason: 'pii_redacted' } } },
    });
    expect(JSON.stringify(redacted.medical)).not.toContain('MEDICAL-ONLY');
    expect(open.medical).toMatchObject({
      structuredContent: { found: true, hasReportedMedicalFields: true, piiRedacted: false },
    });
  });
  it('logs privacy-policy refusals below error on the real log sink, and other failures at error', async () => {
    await init().initialize();
    /** Each call's code and reason beside the pino level of its `Error in tool:` record, matched by request ID. */
    const failures = async (redactPii: string | undefined, calls: [string, object][]) => {
      const logs: Record<string, unknown>[] = [];
      const errors = await stdio(
        redactPii,
        async (request) => {
          const results: { code: number; reason: string; requestId: string }[] = [];
          for (const [name, args] of calls) {
            const result = (await request('tools/call', { name, arguments: args })) as {
              structuredContent: {
                error: { code: number; data: { reason: string; requestId: string } };
              };
            };
            const { code, data } = result.structuredContent.error;
            results.push({ code, ...data });
          }
          return results;
        },
        logs,
      );
      return errors.map(({ code, reason, requestId }, index) => ({
        tool: calls[index]![0],
        code,
        reason,
        levels: logs
          .filter(
            (record) =>
              record.requestId === requestId &&
              String(record.msg).startsWith(`Error in tool:${calls[index]![0]}:`),
          )
          .map((record) => record.level),
      }));
    };
    const [verify, , medical, instructors, remote] = tools.map((definition) => definition.name);
    const blankLastName = { mode: 'name', lastName: ' ' };
    // Pino writes notice at 30, the framework's level for its own policy refusals, and error at 50.
    expect(
      await failures(undefined, [
        [verify!, { mode: 'name', lastName: 'FIXTURE' }],
        [remote!, { mode: 'name', lastName: 'FIXTURE' }],
        [instructors!, { state: 'WA' }],
        [medical!, { uniqueId: 'A9999999' }],
        [verify!, blankLastName],
      ]),
    ).toEqual([
      { tool: verify, code: -32005, reason: 'pii_redacted', levels: [30] },
      { tool: remote, code: -32005, reason: 'pii_redacted', levels: [30] },
      { tool: instructors, code: -32005, reason: 'pii_redacted', levels: [30] },
      { tool: medical, code: -32005, reason: 'pii_redacted', levels: [30] },
      { tool: verify, code: -32007, reason: 'invalid_identity', levels: [50] },
    ]);
    expect(
      await failures('false', [
        [verify!, { mode: 'name', lastName: 'FIXTURE', city: 'X' }],
        [remote!, { mode: 'name', lastName: 'FIXTURE', zipCode: '99999' }],
        [instructors!, { city: 'X' }],
        [remote!, blankLastName],
      ]),
    ).toEqual([
      { tool: verify, code: -32005, reason: 'location_access_disabled', levels: [30] },
      { tool: remote, code: -32005, reason: 'location_access_disabled', levels: [30] },
      { tool: instructors, code: -32005, reason: 'location_access_disabled', levels: [30] },
      { tool: remote, code: -32007, reason: 'invalid_identity', levels: [50] },
    ]);
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
  it('matches whole leading words by default on both surfaces and echoes the effective mode', async () => {
    const files = sourceFiles({
      pilotBasic: [
        basicRow('A1000001', { 1: 'SYNTHETIC QUINN', 2: 'FIXTURE JR' }),
        basicRow('A1000002'),
        basicRow('A1000003', { 1: 'SYNTHETICS', 2: 'FIXTURE-PAIR' }),
      ],
      nonpilotBasic: [basicRow('A1000002')],
      pilotCert: ['A1000001', 'A1000002', 'A1000003'].map((id) =>
        certificateRow(id, true, { 3: 'F', 6: 'C/ASEL' }),
      ),
      nonpilotCert: [
        certificateRow('A1000001', false, { 3: 'U', 4: '' }),
        certificateRow('A1000003', false, { 3: 'U', 4: '' }),
      ],
    });
    await initAirmenRegistryService(
      { mirrorDir: directory, includeLocation: false, staleAfterDays: 45, redactPii: false },
      { fetch: sourceFetch(zipSource(files)), clock: () => new Date('2026-10-20T00:00:00Z') },
    ).initialize();
    const people = (result: Awaited<ReturnType<typeof runToolContract>>) => {
      parity(result);
      const rendered = renderedResult(result.content) as {
        matches: { airman: { uniqueId: string } }[];
        appliedFilters: { nameMatch?: string };
      };
      return {
        ids: rendered.matches.map((match) => match.airman.uniqueId),
        nameMatch: rendered.appliedFilters.nameMatch,
      };
    };
    const name = { mode: 'name', lastName: 'fixture', firstName: 'synthetic' } as const;
    expect(people(await runToolContract(tools[0], name))).toEqual({
      ids: ['A1000002', 'A1000001'],
      nameMatch: 'words',
    });
    expect(people(await runToolContract(tools[0], { ...name, nameMatch: 'exact' }))).toEqual({
      ids: ['A1000002'],
      nameMatch: 'exact',
    });
    expect(people(await runToolContract(tools[0], { ...name, nameMatch: 'prefix' }))).toEqual({
      ids: ['A1000002', 'A1000001', 'A1000003'],
      nameMatch: 'prefix',
    });
    expect(people(await runToolContract(tools[4], name))).toEqual({
      ids: ['A1000001'],
      nameMatch: 'words',
    });
    expect(people(await runToolContract(tools[3], { firstName: 'synthetic' }))).toEqual({
      ids: ['A1000002', 'A1000001'],
      nameMatch: 'words',
    });
    const empty = await runToolContract(tools[0], { ...name, firstName: 'quinn' });
    expect(people(empty).ids).toEqual([]);
    expect(empty.structuredContent).toMatchObject({ totalCount: 0 });
    const past = await runToolContract(tools[0], { ...name, offset: 2 });
    expect(people(past).ids).toEqual([]);
    expect(past.structuredContent).toMatchObject({ totalCount: 2, nextOffset: null });
    const idMode = await runToolContract(tools[0], {
      mode: 'id',
      uniqueId: 'A1000001',
      nameMatch: 'words',
    });
    expect(idMode.structuredContent).toMatchObject({
      error: { data: { reason: 'invalid_identity' } },
    });
    expect(JSON.stringify(idMode.content)).toContain(
      'In mode id send uniqueId without name, location, or nameMatch fields; to search by name, use mode name without uniqueId.',
    );
    const unknown = await runToolContract(tools[0], { ...name, nameMatch: 'WORDS' as 'words' });
    expect(unknown.isError).toBe(true);
    expect(unknown.structuredContent).toMatchObject({ error: { code: -32602 } });
  });
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
      [tools[5], { topic: 'ratings', offset: 55 }],
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
    expect(structured.returnedCount).toBeGreaterThanOrEqual(25);
    // The cut sentence rides inside the measured response, on both surfaces.
    expect(noticeOf(result)).toBe(budgetCut(structured.returnedCount as number));
  });
  it('says the size budget cut a page on all four list tools, on both surfaces, within the budget', async () => {
    const ids = ['A9999991', 'A9999992', 'A9999993', 'A9999994', 'A9999995', 'A9999996'];
    // Long designators on an instructor certificate and long ratings on a remote pilot certificate.
    const designators = Object.fromEntries(
      Array.from({ length: 15 }, (_, index) => [index + 17, `F/SYNTH-${index}-${'X'.repeat(40)}`]),
    );
    const ratings = Object.fromEntries(
      Array.from({ length: 11 }, (_, index) => [index + 6, `U/SYNTH-${index}-${'X'.repeat(120)}`]),
    );
    const files = sourceFiles({
      pilotBasic: ids.map((id) => basicRow(id, { 2: 'BUDGET' })),
      nonpilotBasic: ids.map((id) => basicRow(id, { 2: 'BUDGET' })),
      pilotCert: ids.map((id) =>
        certificateRow(id, true, { 2: 'BUDGET', 3: 'F', 4: '', ...designators }),
      ),
      nonpilotCert: ids.map((id) =>
        certificateRow(id, false, { 2: 'BUDGET', 3: 'U', 4: '', ...ratings }),
      ),
    });
    await initAirmenRegistryService(
      { mirrorDir: directory, includeLocation: false, staleAfterDays: 45, redactPii: false },
      { fetch: sourceFetch(zipSource(files)), clock: () => new Date('2026-10-20T00:00:00Z') },
    ).initialize();
    const name = { lastName: 'BUDGET', firstName: 'SYNTHETIC', limit: 50 };
    for (const [definition, input] of [
      [tools[0], { mode: 'name', ...name }],
      [tools[4], { mode: 'name', ...name }],
      [tools[3], name],
      [tools[5], { topic: 'ratings', limit: 50 }],
    ] as const) {
      const result = await runToolContract(definition, input);
      const structured = result.structuredContent as {
        returnedCount: number;
        hasMore: boolean;
        nextOffset: number;
      };
      expect({ tool: definition.name, cut: structured.returnedCount < 50 }).toEqual({
        tool: definition.name,
        cut: true,
      });
      expect(structured.hasMore).toBe(true);
      expect(structured.nextOffset).toBe(structured.returnedCount);
      const notice = noticeOf(result);
      expect(notice.endsWith(budgetCut(structured.returnedCount))).toBe(true);
      expect(notice).not.toContain('exceeds the response byte budget');
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(24 * 1024);
    }
  });
  it('puts every reachable declared failure reason and recovery on the contract path', async () => {
    init();
    // Field rejections carry their own recovery; the other reasons carry the declared one.
    const errors = [
      [
        tools[0],
        { mode: 'name', lastName: ' ' },
        'invalid_identity',
        'In mode name send a nonblank lastName, or use mode id with a uniqueId.',
      ],
      [
        tools[0],
        { mode: 'id', uniqueId: 'A9999999', lastName: 'PRIVATE INPUT' },
        'invalid_identity',
        'In mode id send uniqueId without name, location, or nameMatch fields; to search by name, use mode name without uniqueId.',
      ],
      [
        tools[0],
        { mode: 'name', lastName: 'PRIVATE INPUT', certificateType: 'ATP' },
        'invalid_filter',
        'Call faa_airmen_list_reference with topic certificate_types and send a listed code or description, or omit certificateType together with any certificateLevel.',
      ],
      [
        tools[0],
        { mode: 'name', lastName: 'PRIVATE INPUT', city: 'PRIVATE CITY' },
        'location_access_disabled',
        undefined,
      ],
      [tools[3], {}, 'missing_search_filter', undefined],
      [tools[1], { uniqueId: 'A9999999' }, 'mirror_missing', undefined],
    ] as const;
    for (const [definition, input, reason, hint] of errors) {
      const result = await runToolContract(definition, input);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { data: { reason } } });
      const contract = definition.errors?.find((entry) => entry.reason === reason);
      expect(JSON.stringify(result.content)).toContain(hint ?? contract!.recovery);
      expect(JSON.stringify(result)).not.toContain('PRIVATE INPUT');
      expect(JSON.stringify(result)).not.toContain('PRIVATE CITY');
      expect(JSON.stringify(result)).not.toContain(directory);
    }
    await init().initialize();
    initAirmenRegistryService({
      mirrorDir: directory,
      includeLocation: true,
      staleAfterDays: 45,
      redactPii: false,
    });
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
      { mode: 'name', lastName: 'FIXTURE', offset: 10001 },
    ] as const) {
      expect((await runToolContract(tools[0], input)).isError).toBe(true);
    }
    // A limit above 50 passes the schema and reaches the (uninitialized) mirror.
    expect(
      (await runToolContract(tools[0], { mode: 'name', lastName: 'FIXTURE', limit: 51 }))
        .structuredContent,
    ).toMatchObject({ error: { data: { reason: 'mirror_missing' } } });
    expect((await runToolContract(tools[1], { uniqueId: '123' })).isError).toBe(true);
  });
  it('names the failing field and its recovery on both surfaces, never the value', async () => {
    init();
    const designators: string[] = ['Washington/X/Y'];
    // Reversed level/code forms: the level before the slash is longer than one letter.
    const reversed: string[] = ['Washington/F'],
      reversedInsta: string[] = ['INSTA/F'];
    const ratingCodes = [
      'ratingCodes must be 1–11 codes, each 1–30 letters, digits, spaces, or hyphens, optionally after a one-letter level and a slash.',
      'Call faa_airmen_list_reference with topic ratings and send listed codes, bare or as level/code such as F/INSTA.',
    ] as const;
    const state = [
      'state must be a two-letter USPS state, territory, or military code.',
      'Send state as a two-letter USPS code: a state such as WA, or DC, PR, GU, VI, MP, AS, FM, MH, PW, AA, AE or AP; omit it otherwise, since airmen with foreign addresses carry no state.',
    ] as const;
    for (const [definition, input, reason, [message, hint]] of [
      [
        tools[0],
        { mode: 'name', lastName: 'PRIVATE INPUT', state: 'Washington' },
        'invalid_filter',
        state,
      ],
      [tools[3], { state: 'Washington' }, 'invalid_filter', state],
      // Two letters that are no USPS code, on each tool that accepts state.
      [tools[0], { mode: 'name', lastName: 'PRIVATE INPUT', state: 'zz' }, 'invalid_filter', state],
      [tools[4], { mode: 'name', lastName: 'PRIVATE INPUT', state: 'ZZ' }, 'invalid_filter', state],
      [tools[3], { state: 'ZZ' }, 'invalid_filter', state],
      [
        tools[0],
        { mode: 'name', lastName: 'PRIVATE INPUT'.repeat(5) },
        'invalid_identity',
        [
          'lastName must be at most 60 characters with no control or format characters.',
          'Retry with lastName as written in the FAA LAST NAME field, at most 60 characters.',
        ],
      ],
      [
        tools[0],
        { mode: 'id', uniqueId: 'A9999999', state: 'Washington' },
        'invalid_identity',
        [
          'mode id forbids state.',
          'In mode id send uniqueId without name, location, or nameMatch fields; to search by name, use mode name without uniqueId.',
        ],
      ],
      [
        tools[0],
        { mode: 'name', lastName: 'PRIVATE INPUT', certificateLevel: 'Washington' },
        'invalid_filter',
        [
          'certificateLevel requires certificateType.',
          'Add the certificateType the level belongs to, such as P for level A, from faa_airmen_list_reference topic certificate_levels, or omit certificateLevel.',
        ],
      ],
      [
        tools[0],
        { mode: 'name', lastName: 'PRIVATE INPUT', typeRatings: designators },
        'invalid_filter',
        [
          'typeRatings must be 1–11 designators, each 1–30 letters, digits, spaces, or hyphens, optionally after a one-letter level and a slash.',
          'Call faa_airmen_list_reference with topic type_ratings and send listed designators, bare or as level/designator such as A/B-737.',
        ],
      ],
      [tools[3], { state: 'WA', ratingCodes: reversed }, 'invalid_filter', ratingCodes],
      [
        tools[0],
        { mode: 'name', lastName: 'PRIVATE INPUT', ratingCodes: reversedInsta },
        'invalid_filter',
        ratingCodes,
      ],
    ] as const) {
      const result = await runToolContract(definition, input);
      expect(result.structuredContent).toMatchObject({
        error: { code: -32007, message, data: { reason, recovery: { hint } } },
      });
      const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
      expect(text).toContain(`Error: ${message}`);
      expect(text).toContain(`Recovery: ${hint}`);
      expect(text).not.toContain('certificate_types');
      for (const value of ['Washington', 'PRIVATE INPUT'])
        expect(JSON.stringify(result)).not.toContain(value);
    }
  });
  it('treats a whitespace-only value carrying a control character as unset on both surfaces', async () => {
    await init().initialize();
    for (const [definition, input, appliedFilters] of [
      [
        tools[0],
        { mode: 'id', uniqueId: 'A9999999', lastName: '\t', state: '\n', certificateLevel: '﻿' },
        { mode: 'id', uniqueId: 'A9999999', limit: 10, offset: 0 },
      ],
      [
        tools[4],
        { mode: 'name', lastName: 'FIXTURE', uniqueId: '\t', zipCode: '\t' },
        {
          mode: 'name',
          lastName: 'FIXTURE',
          nameMatch: 'words',
          limit: 10,
          offset: 0,
          certificateType: 'U',
        },
      ],
      [
        tools[5],
        { topic: 'identifiers', filter: ' \t ' },
        { topic: 'identifiers', limit: 10, offset: 0 },
      ],
    ] as const) {
      const result = await runToolContract(definition, input);
      parity(result);
      expect(result.structuredContent).toMatchObject({ appliedFilters });
      expect(renderedResult(result.content)).toMatchObject({ appliedFilters });
    }
  });
  it('rejects a malformed ID or ZIP at the schema and still serves padded, lowercase IDs', async () => {
    const service = init();
    const zip = await runToolContract(tools[0], { mode: 'name', lastName: 'X', zipCode: '9810' });
    expect(zip.structuredContent).toMatchObject({
      error: { code: -32602, data: { reason: 'invalid_arguments' } },
    });
    expect(JSON.stringify(zip.content)).toContain(
      'zipCode: Must be five digits or ZIP+4, such as 99999 or 99999-1234; blank means unset',
    );
    for (const zipCode of [' 99999-1234 ', ' 999991234', '99999'])
      expect(
        (await runToolContract(tools[0], { mode: 'name', lastName: 'X', zipCode }))
          .structuredContent,
      ).toMatchObject({ error: { data: { reason: 'location_access_disabled' } } });
    for (const [definition, input] of [
      [tools[1], { uniqueId: 'A 9999999' }],
      [tools[0], { mode: 'id', uniqueId: 'A９999999' }],
    ] as const) {
      const result = await runToolContract(definition, input);
      expect(result.structuredContent).toMatchObject({
        error: { code: -32602, data: { reason: 'invalid_arguments' } },
      });
      expect(JSON.stringify(result.content)).toContain(
        'uniqueId: Must be A or C plus seven digits, such as A9999999, from a faa_airmen_verify_certificate, faa_airmen_search_instructors, or faa_airmen_verify_remote_pilot result',
      );
    }
    await service.initialize();
    for (const uniqueId of [' a9999999　', ' A9999999 '])
      expect((await runToolContract(tools[1], { uniqueId })).structuredContent).toMatchObject({
        found: true,
        appliedFilters: { uniqueId: 'A9999999' },
      });
    expect(
      (await runToolContract(tools[0], { mode: 'name', lastName: 'FIXTURE', uniqueId: '　' }))
        .structuredContent,
    ).toMatchObject({ totalCount: 2 });
  });
  describe('advertised uniqueId and zipCode patterns', () => {
    let located: AirmenRegistryService;
    beforeEach(() => {
      located = new AirmenRegistryService({
        mirrorDir: directory,
        includeLocation: true,
        staleAfterDays: 45,
        redactPii: false,
      });
    });
    /** Validation passed when the call reached the uninitialized mirror. */
    const accepts = async (run: () => unknown) => {
      try {
        await run();
        return true;
      } catch (error) {
        const reason = (error as { data?: { reason?: string } }).data?.reason;
        if (reason === 'mirror_missing') return true;
        assert.ok(reason === 'invalid_identity' || reason === 'invalid_filter', String(reason));
        return false;
      }
    };
    const characters: string[] = [];
    for (let point = 0; point <= 0x10ffff; point++) {
      if (point >= 0xd800 && point <= 0xdfff) continue;
      const character = String.fromCodePoint(point);
      if (
        character.trim() === '' ||
        /[\p{Cc}\p{Cf}\p{Pd}−﹣－]|\p{Nd}/u.test(character) ||
        (character !== character.toUpperCase() && /^[A-Z]+$/.test(character.toUpperCase()))
      )
        characters.push(character);
    }
    characters.push('Ａ', 'Ｃ', 'ａ');
    const variants = (bases: string[]) => {
      const values = new Set(['', ' ', ...characters.filter((c) => c.trim() === '')]);
      for (const base of bases) {
        values.add(base.toLowerCase());
        for (const character of characters) {
          values.add(character + base);
          values.add(base + character);
          values.add(character + base + character);
          for (let index = 0; index < base.length; index++) {
            values.add(base.slice(0, index + 1) + character + base.slice(index + 1));
            values.add(base.slice(0, index) + character + base.slice(index + 1));
          }
        }
      }
      return values;
    };
    const fields = [
      {
        name: 'required uniqueId',
        schema: tools[1].input.shape.uniqueId,
        values: variants(['A9999999', 'c0000001', 'A999999']),
        service: (uniqueId: string) => located.getRatings({ uniqueId }),
      },
      {
        name: 'optional uniqueId',
        schema: tools[0].input.shape.uniqueId,
        values: variants(['A9999999', 'c0000001', 'A999999']),
        service: async (uniqueId: string) =>
          (await accepts(() => located.verifyCertificates({ mode: 'id', uniqueId }))) ||
          located.verifyCertificates({ mode: 'name', lastName: 'X', uniqueId }),
      },
      {
        name: 'zipCode',
        schema: tools[0].input.shape.zipCode,
        values: variants(['99999', '99999-1234', '999991234', '9999']),
        service: (zipCode: string) =>
          located.verifyCertificates({ mode: 'name', lastName: 'X', zipCode }),
      },
    ];
    it.each(fields)(
      '$name accepts every value the service accepts',
      async ({ schema, values, service }) => {
        let accepted = 0;
        const missed: string[] = [];
        for (const value of values) {
          const outcome = await accepts(() => service(value));
          if (!outcome) continue;
          accepted++;
          if (!schema.safeParse(value).success) missed.push(JSON.stringify(value));
        }
        expect(accepted).toBeGreaterThan(100);
        expect(missed).toEqual([]);
      },
    );
    it.each([
      [tools[1].input.shape.uniqueId, 'A 9999999'],
      [tools[1].input.shape.uniqueId, 'A９999999'],
      [tools[0].input.shape.zipCode, '99999–1234'],
      [tools[0].input.shape.zipCode, '99999 1234'],
    ] as const)('rejects malformed value %#', (schema, value) => {
      expect(schema.safeParse(value).success).toBe(false);
    });
  });
  it('clamps a limit above 50 on both surfaces and accepts descriptions and level/code ratings', async () => {
    await clean().initialize();
    const clamped = 'A limit above 50 returns at most 50.';
    const people = await runToolContract(tools[0], {
      mode: 'name',
      lastName: 'FIXTURE',
      limit: 100,
    });
    expect(noticeOf(people)).toBe(`${limits} ${locationOff} ${clamped}`);
    expect(people.structuredContent).toMatchObject({
      totalCount: 2,
      returnedCount: 2,
      appliedFilters: { limit: 50 },
    });
    const reference = await runToolContract(tools[5], { topic: 'ratings', limit: 1000 });
    // The size budget also cuts the 55 ratings short of the clamped 50.
    const { returnedCount } = reference.structuredContent as { returnedCount: number };
    expect(noticeOf(reference)).toBe(`${clamped} ${budgetCut(returnedCount)}`);
    expect(reference.structuredContent).toMatchObject({
      appliedFilters: { topic: 'ratings', limit: 50, offset: 0 },
    });
    const remote = await runToolContract(tools[0], {
      mode: 'id',
      uniqueId: 'A9999999',
      certificateType: 'Remote Pilot',
    });
    parity(remote);
    expect(remote.structuredContent).toMatchObject({
      totalCount: 1,
      appliedFilters: { certificateType: 'U' },
    });
    const flight = await runToolContract(tools[3], {
      state: 'WA',
      instructorType: 'flight',
      ratingCodes: ['c/insta', 'C / INSTA', 'asel'],
    });
    parity(flight);
    expect(flight.structuredContent).toMatchObject({
      totalCount: 1,
      appliedFilters: { ratingCodes: ['C/INSTA', 'ASEL'] },
    });
    const wrongLevel = await runToolContract(tools[3], {
      state: 'WA',
      instructorType: 'flight',
      ratingCodes: ['G/INSTA'],
    });
    expect(wrongLevel.structuredContent).toMatchObject({ totalCount: 0, returnedCount: 0 });
  });
  it('narrows verify candidates by level, rating, and type rating on both surfaces', async () => {
    await clean().initialize();
    const all = await runToolContract(tools[0], { mode: 'id', uniqueId: 'A9999999' });
    const narrowed = await runToolContract(tools[0], {
      mode: 'name',
      lastName: 'fixture',
      certificateType: 'pilot',
      certificateLevel: 'p',
      ratingCodes: ['p/asel', 'INST', ' inst '],
      typeRatings: ['synth-1'],
    });
    parity(narrowed);
    expect(domainBytes(narrowed)).toBe(domainBytes(all));
    expect(narrowed.structuredContent).toMatchObject({
      totalCount: 1,
      returnedCount: 1,
      appliedFilters: {
        certificateType: 'P',
        certificateLevel: 'P',
        ratingCodes: ['P/ASEL', 'INST'],
        typeRatings: ['SYNTH-1'],
      },
    });
    // The F certificate's ratings never combine with the P certificate's type rating.
    expect(
      (
        await runToolContract(tools[0], {
          mode: 'name',
          lastName: 'FIXTURE',
          ratingCodes: ['INSTA'],
          typeRatings: ['SYNTH-1'],
        })
      ).structuredContent,
    ).toMatchObject({ totalCount: 0, returnedCount: 0 });
    const past = await runToolContract(tools[0], {
      mode: 'name',
      lastName: 'FIXTURE',
      typeRatings: ['SYNTH-1'],
      offset: 1,
      limit: 100,
    });
    expect(noticeOf(past)).toBe(
      `${limits} ${locationOff} This page is past the available results; repeat the same tool with offset 0. A limit above 50 returns at most 50.`,
    );
    expect(past.structuredContent).toMatchObject({
      totalCount: 1,
      returnedCount: 0,
      nextOffset: null,
      appliedFilters: { limit: 50, typeRatings: ['SYNTH-1'] },
    });
    const eleven = Array.from({ length: 11 }, (_, index) => `SYNTH-${index}`);
    expect(
      (await runToolContract(tools[0], { mode: 'name', lastName: 'FIXTURE', typeRatings: eleven }))
        .structuredContent,
    ).toMatchObject({ totalCount: 0, appliedFilters: { typeRatings: eleven } });
    for (const field of ['ratingCodes', 'typeRatings'] as const) {
      const twelve = await runToolContract(tools[0], {
        mode: 'name',
        lastName: 'FIXTURE',
        [field]: [...eleven, 'SYNTH-11'],
      });
      expect(twelve.structuredContent).toMatchObject({
        error: { code: -32602, data: { reason: 'invalid_arguments' } },
      });
      expect(JSON.stringify(twelve.content)).toContain(field);
    }
  });
  it('serializes each tool domain output exactly, field order included, for a clean snapshot', async () => {
    await clean().initialize();
    const airman = {
      uniqueId: 'A9999999',
      firstName: 'SYNTHETIC',
      lastName: 'FIXTURE',
      state: 'WA',
      country: 'USA',
      region: 'NM',
      sourceFamilies: ['pilot', 'nonpilot'],
    };
    const rating = (code: string, description: string, raw: string, ordinal: number) => ({
      code,
      description,
      raw,
      ordinal,
      levelCode: raw[0],
    });
    const flight = {
      recordId: '<recordId>',
      sourceFamilies: ['pilot'],
      type: { code: 'F', description: 'Flight instructor' },
      ratings: [
        rating('ASEL', 'AIRPLANE SINGLE ENGINE LAND', 'C/ASEL', 1),
        rating('INSTA', 'INSTRUMENT AIRPLANE', 'C/INSTA', 2),
      ],
      typeRatings: [],
    };
    const pilot = {
      recordId: '<recordId>',
      sourceFamilies: ['pilot'],
      type: { code: 'P', description: 'Pilot' },
      level: { code: 'P', description: 'Private pilot' },
      ratings: [
        rating('ASEL', 'AIRPLANE SINGLE ENGINE LAND', 'P/ASEL', 1),
        rating('INST', 'INSTRUMENT', 'P/INST', 2),
      ],
      typeRatings: [{ code: 'SYNTH-1', raw: 'P/SYNTH-1', ordinal: 1, levelCode: 'P' }],
    };
    const remote = {
      recordId: '<recordId>',
      sourceFamilies: ['nonpilot'],
      type: { code: 'U', description: 'Remote pilot' },
      ratings: [],
      typeRatings: [],
    };
    const expected = [
      [
        tools[0],
        { mode: 'id', uniqueId: 'A9999999' },
        { matches: [{ airman, certificates: [flight, pilot, remote] }] },
      ],
      [tools[1], { uniqueId: 'A9999999' }, { found: true, airman, certificates: [flight, pilot] }],
      [
        tools[2],
        { uniqueId: 'A9999999' },
        {
          found: true,
          airman,
          medicalRecords: [
            {
              sourceFamilies: ['pilot', 'nonpilot'],
              medicalClass: { code: '3', description: 'Third' },
              medicalDateRaw: '102026',
              medicalExpireDateRaw: '102028',
            },
          ],
          hasReportedMedicalFields: true,
          disclaimer:
            'FAA medical fields are informational and are not authoritative evidence of medical certification, fitness, or eligibility to operate.',
        },
      ],
      [
        tools[3],
        { state: 'WA' },
        {
          matches: [
            {
              airman: {
                ...airman,
                uniqueId: 'C9999998',
                firstName: 'GROUND',
                sourceFamilies: ['pilot'],
              },
              instructorCertificates: [
                {
                  recordId: '<recordId>',
                  sourceFamilies: ['nonpilot'],
                  type: { code: 'G', description: 'Ground instructor' },
                  ratings: [rating('ADV', 'ADVANCED', 'G/ADV', 1)],
                  typeRatings: [],
                },
              ],
            },
            { airman, instructorCertificates: [flight] },
          ],
        },
      ],
      [
        tools[4],
        { mode: 'id', uniqueId: 'A9999999' },
        { matches: [{ airman, remotePilotCertificates: [remote] }] },
      ],
      [
        tools[5],
        { topic: 'type_ratings' },
        {
          topic: 'type_ratings',
          entries: [
            {
              code: 'SYNTH-1',
              sourceUrls: [
                'https://www.faa.gov/licenses_certificates/airmen_certification/releasable_airmen_download',
              ],
            },
          ],
        },
      ],
    ] as const;
    for (const [definition, input, domain] of expected) {
      const result = await runToolContract(definition, input);
      parity(result);
      expect(domainBytes(result)).toBe(JSON.stringify(domain));
    }
  });
  it('keeps the full mirror_status record and the past-end, found:false and empty-filter notices', async () => {
    const service = clean();
    await service.initialize();
    const status = await runToolContract(tools[5], { topic: 'mirror_status' });
    parity(status);
    const full = (status.structuredContent as { mirrorStatus: { provenance: object } }).mirrorStatus
      .provenance;
    expect(full).toEqual((await service.mirror.status()).provenance);
    expect(Object.keys(full)).toEqual([
      'archiveUrl',
      'complete',
      'counts',
      'downloadedAt',
      'fileCounts',
      'generationId',
      'importedAt',
      'includeLocation',
      'referenceVersion',
      'schemaVersion',
      'sha256',
      'snapshotMonth',
      'sourceName',
      'sourcePageUrl',
      'warnings',
      'ageBasis',
      'ageDays',
      'stale',
      'staleAfterDays',
    ]);
    const noPerson =
      'No person matched this snapshot; use faa_airmen_verify_certificate with mode name to discover candidate IDs.';
    const emptyFilter =
      'No reference entry matched; retry faa_airmen_list_reference without filter.';
    for (const [definition, input, notice] of [
      [tools[1], { uniqueId: 'C0000000' }, `${noPerson} ${limits} ${locationOff}`],
      [tools[2], { uniqueId: 'C0000000' }, `${noPerson} ${limits} ${locationOff}`],
      [
        tools[0],
        { mode: 'name', lastName: 'FIXTURE', offset: 50, limit: 50 },
        `${limits} ${locationOff} This page is past the available results; repeat the same tool with offset 0.`,
      ],
      [tools[5], { topic: 'ratings', filter: 'no such code' }, emptyFilter],
      [
        tools[5],
        { topic: 'type_ratings', filter: 'NOSUCH' },
        `${limits} ${locationOff} ${emptyFilter}`,
      ],
    ] as const)
      expect(noticeOf(await runToolContract(definition, input))).toBe(notice);
  });
  it('says on both surfaces whether a failed refresh published the served snapshot', async () => {
    await clean().initialize();
    const imported = Date.parse('2026-10-20T00:00:00Z');
    for (const [startedAt, sentence] of [
      [
        imported - 1000,
        'The latest refresh published this snapshot, then failed a later storage step.',
      ],
      [
        imported + 1000,
        'The latest refresh failed; this result uses the last complete published generation.',
      ],
    ] as const) {
      await writeFile(
        join(directory, 'REFRESH.json'),
        JSON.stringify({
          status: 'failed',
          stage: 'disk',
          startedAt: new Date(startedAt).toISOString(),
          finishedAt: new Date(startedAt + 2000).toISOString(),
        }),
      );
      expect(noticeOf(await runToolContract(tools[0], { mode: 'id', uniqueId: 'A9999999' }))).toBe(
        `${limits} ${locationOff} ${sentence}`,
      );
    }
  });
  it('carries an unreadable refresh record on both surfaces of mirror_status, with the generation still ready', async () => {
    const service = clean();
    await service.initialize();
    await writeFile(join(directory, 'REFRESH.json'), '{');
    const result = await runToolContract(tools[5], { topic: 'mirror_status' });
    parity(result);
    const structured = result.structuredContent as {
      entries: { guidance: string }[];
      mirrorStatus: Record<string, unknown>;
    };
    expect(structured.mirrorStatus).toMatchObject({ state: 'ready', refreshState: 'unreadable' });
    expect(structured.mirrorStatus).toHaveProperty('provenance');
    expect(structured.mirrorStatus).not.toHaveProperty('lastRefreshFailure');
    expect(structured.entries[0]!.guidance).toContain(
      'REFRESH.json in the mirror directory is unreadable; it records only the last refresh outcome, so the operator can remove it, and the next refresh rewrites it.',
    );
  });
  it('describes SUAS from 14 CFR Part 107 on reference entries and returned records', async () => {
    const service = mixed();
    const reference = await runToolContract(tools[5], { topic: 'ratings', filter: 'suas' });
    parity(reference);
    const [entry] = (reference.structuredContent as { entries: Record<string, unknown>[] }).entries;
    expect(entry).toMatchObject({
      code: 'SUAS',
      description: 'SMALL UNMANNED AIRCRAFT SYSTEM',
      sourceUrls: [
        'https://www.ecfr.gov/current/title-14/chapter-I/subchapter-F/part-107/subpart-B/section-107.12',
        'https://www.ecfr.gov/current/title-14/chapter-I/subchapter-F/part-107/subpart-A/section-107.3',
      ],
    });
    expect(entry!.guidance).toContain('Absent from FAA HelpComm');
    expect(entry!.guidance).toContain('14 CFR 107.12');
    await service.initialize();
    const remote = await runToolContract(tools[4], { mode: 'id', uniqueId: 'A9999999' });
    parity(remote);
    expect(remote.structuredContent).toMatchObject({
      matches: [
        {
          remotePilotCertificates: [
            {
              ratings: [
                {
                  code: 'SUAS',
                  description: 'SMALL UNMANNED AIRCRAFT SYSTEM',
                  raw: 'U/SUAS',
                  ordinal: 1,
                  levelCode: 'U',
                },
              ],
            },
          ],
        },
      ],
    });
  });
  it('puts the source-quality notice only on results whose returned records carry an issue', async () => {
    const service = mixed();
    await service.initialize();
    expect((await service.mirror.status()).provenance?.warnings.unknownCodes).toBeGreaterThan(0);
    const cases = [
      [tools[0], { mode: 'id', uniqueId: 'A9999999' }, false],
      [tools[0], { mode: 'id', uniqueId: 'A9999997' }, true],
      [tools[0], { mode: 'id', uniqueId: 'A9999995' }, true],
      [tools[0], { mode: 'name', lastName: 'FIXTURE', limit: 1 }, false],
      [tools[0], { mode: 'name', lastName: 'FIXTURE', limit: 1, offset: 1 }, true],
      [tools[0], { mode: 'name', lastName: 'ABSENT' }, false],
      [tools[0], { mode: 'name', lastName: 'FIXTURE', offset: 50 }, false],
      [tools[1], { uniqueId: 'A9999999' }, false],
      [tools[1], { uniqueId: 'A9999995' }, true],
      [tools[1], { uniqueId: 'A9999996' }, false],
      [tools[1], { uniqueId: 'C0000000' }, false],
      [tools[2], { uniqueId: 'A9999997' }, true],
      [tools[2], { uniqueId: 'A9999996' }, false],
      [tools[2], { uniqueId: 'A9999999' }, false],
      [tools[2], { uniqueId: 'C0000000' }, false],
      [tools[3], { lastName: 'FIXTURE', firstName: 'DIRTY' }, true],
      [tools[3], { lastName: 'FIXTURE', firstName: 'MIXED' }, false],
      [tools[4], { mode: 'id', uniqueId: 'A9999996' }, true],
      [tools[4], { mode: 'id', uniqueId: 'A9999995' }, false],
      [tools[4], { mode: 'id', uniqueId: 'A9999999' }, false],
      [tools[5], { topic: 'mirror_status' }, false],
      [tools[5], { topic: 'type_ratings' }, false],
      [tools[5], { topic: 'ratings', limit: 50 }, false],
    ] as const;
    for (const [definition, input, flagged] of cases) {
      const notice = noticeOf(await runToolContract(definition, input));
      // Any source-quality sentence, including the former snapshot-wide one, ends this way.
      const sentence = notice.includes('raw values are retained');
      expect({ tool: definition.name, input, sentence }).toEqual({
        tool: definition.name,
        input,
        sentence: flagged,
      });
      if (flagged) expect(notice).toContain(quality);
    }
  });
  it('routes each tool zero result by the filters it sent, on both surfaces', async () => {
    await clean().initialize();
    const base = `${limits} ${locationOff} No record matched this releasable snapshot. This does not establish that a person is uncertificated.`;
    const identifiers = 'Check faa_airmen_list_reference with topic identifiers.';
    const fewer =
      'Check faa_airmen_list_reference with topic identifiers, then retry with fewer name or location filters.';
    const idAbsent =
      'No person has this Unique ID in this snapshot; check its format with faa_airmen_list_reference topic identifiers, or rediscover it with faa_airmen_verify_certificate mode name.';
    const ratingsRoute = 'Check the rating codes with faa_airmen_list_reference topic ratings.';
    const typeRatingsRoute =
      'Check the type ratings with faa_airmen_list_reference topic type_ratings.';
    const sameCertificate = 'all must occur on the same certificate.';
    const inst: string[] = ['INST'];
    const synth: string[] = ['SYNTH-1'];
    const groundCodes: string[] = ['INST', 'ADV'];
    const mei: string[] = ['MEI'];
    const cfiiMei =
      'CFII is INSTA, INSTH, INSTI, or INSTP on a flight instructor (F) certificate, and MEI is AME or ASME on F; send one call per alternative';
    const alternatives = `${cfiiMei}.`;
    const alternativesOnF = `${cfiiMei}, with certificateType F.`;
    const alternativesFlight = `${cfiiMei}, with instructorType flight or both.`;
    const oneFlightInstructor = (codes: string) =>
      `1 flight instructor matches this search without ratingCodes, and none holds a flight instructor certificate carrying ${codes} in this snapshot.`;
    const several =
      'This Unique ID holds no single certificate carrying every requested credential; retry faa_airmen_verify_certificate in ID mode without';
    const cases = [
      [
        tools[0],
        { mode: 'id', uniqueId: 'A9999999', ratingCodes: ['ZZZ', ' zzz'] },
        "This Unique ID holds no certificate matching the requested rating codes; retry faa_airmen_verify_certificate in ID mode without ratingCodes to read the person's other certificates. Check the rating codes with faa_airmen_list_reference topic ratings.",
      ],
      [
        tools[0],
        { mode: 'id', uniqueId: 'A9999999', ratingCodes: ['ZZZ', 'YYY'] },
        `This Unique ID holds no certificate matching the requested rating codes; retry faa_airmen_verify_certificate in ID mode without ratingCodes to read the person's other certificates. Check the rating codes with faa_airmen_list_reference topic ratings; ${sameCertificate}`,
      ],
      [
        tools[0],
        { mode: 'id', uniqueId: 'A9999999', ratingCodes: ['ZZZ'], typeRatings: ['ZZ-9'] },
        `${several} ratingCodes or typeRatings to read the person's other certificates. Check the rating codes with faa_airmen_list_reference topic ratings and the type ratings with faa_airmen_list_reference topic type_ratings; ${sameCertificate}`,
      ],
      [
        tools[0],
        {
          mode: 'id',
          uniqueId: 'A9999999',
          certificateType: 'P',
          certificateLevel: 'A',
          ratingCodes: ['ZZZ', 'YYY'],
          typeRatings: ['ZZ-9', 'ZZ-8'],
        },
        `${several} certificateType, certificateLevel, ratingCodes or typeRatings to read the person's other certificates. Check the certificate level with faa_airmen_list_reference topic certificate_levels. Check the rating codes with faa_airmen_list_reference topic ratings and the type ratings with faa_airmen_list_reference topic type_ratings; ${sameCertificate}`,
      ],
      [
        tools[3],
        { state: 'WA', instructorType: 'flight', ratingCodes: groundCodes },
        `${oneFlightInstructor('every requested code')} Check the rating codes with faa_airmen_list_reference topic ratings; ${sameCertificate}`,
      ],
      [tools[0], { mode: 'id', uniqueId: 'A0000001' }, idAbsent],
      [tools[0], { mode: 'id', uniqueId: 'A0000001', certificateType: 'P' }, idAbsent],
      [tools[0], { mode: 'id', uniqueId: 'A0000001', typeRatings: synth }, idAbsent],
      [
        tools[0],
        { mode: 'id', uniqueId: 'A9999999', certificateType: 'F', ratingCodes: ['P/INST'] },
        `This Unique ID holds no single certificate carrying every requested credential; retry faa_airmen_verify_certificate in ID mode without certificateType or ratingCodes to read the person's other certificates. ${ratingsRoute}`,
      ],
      [
        tools[0],
        {
          mode: 'name',
          lastName: 'FIXTURE',
          certificateType: 'P',
          certificateLevel: 'A',
          typeRatings: synth,
        },
        `2 people match this name search without certificateType, certificateLevel or typeRatings, and none holds a single certificate carrying every requested credential in this snapshot. Check the certificate level with faa_airmen_list_reference topic certificate_levels. ${typeRatingsRoute}`,
      ],
      [
        tools[0],
        { mode: 'name', lastName: 'ABSENT', typeRatings: synth },
        `No person matches this name search even without typeRatings. ${identifiers}`,
      ],
      [
        tools[0],
        { mode: 'id', uniqueId: 'A9999999', certificateType: 'mechanic' },
        "This Unique ID holds no certificate matching the requested certificate type; retry faa_airmen_verify_certificate in ID mode without certificateType to read the person's other certificates.",
      ],
      [tools[4], { mode: 'id', uniqueId: 'A0000001' }, idAbsent],
      [
        tools[4],
        { mode: 'id', uniqueId: 'C9999998' },
        "This Unique ID holds no remote pilot (U) certificate; use faa_airmen_verify_certificate in ID mode to read the person's other certificates.",
      ],
      [tools[0], { mode: 'name', lastName: 'ABSENT' }, identifiers],
      [tools[0], { mode: 'name', lastName: 'ABSENT', state: 'WA' }, fewer],
      [
        tools[0],
        { mode: 'name', lastName: 'FIXTURE', certificateType: 'W' },
        '2 people match this name search without certificateType, and none holds a certificate matching the requested certificate type in this snapshot.',
      ],
      [
        tools[4],
        { mode: 'name', lastName: 'FIXTURE', firstName: 'GROUND' },
        `No candidate matching the name holds a remote pilot (U) certificate; use faa_airmen_verify_certificate in name mode to check the name and other certificates. ${fewer}`,
      ],
      [
        tools[3],
        { state: 'WA', instructorType: 'flight', ratingCodes: inst },
        `${oneFlightInstructor('the requested code')} ${ratingsRoute}`,
      ],
      [
        tools[3],
        { state: 'WA', firstName: 'SYNTHETIC', instructorType: 'flight', ratingCodes: mei },
        `${oneFlightInstructor('the requested code')} ${ratingsRoute} ${alternatives}`,
      ],
      [
        tools[3],
        { lastName: 'FIXTURE', firstName: 'GROUND', instructorType: 'flight', ratingCodes: mei },
        `No flight instructor matches this search even without ratingCodes. ${fewer}`,
      ],
      [
        tools[3],
        { lastName: 'FIXTURE', firstName: 'GROUND', instructorType: 'ground', ratingCodes: mei },
        `1 ground instructor matches this search without ratingCodes, and none holds a ground instructor certificate carrying the requested code in this snapshot. ${ratingsRoute} ${alternativesFlight}`,
      ],
      [tools[3], { ratingCodes: mei }, `${ratingsRoute} ${alternatives}`],
      [
        tools[0],
        { mode: 'id', uniqueId: 'A9999999', ratingCodes: ['F/INSTH'] },
        `This Unique ID holds no certificate matching the requested rating codes; retry faa_airmen_verify_certificate in ID mode without ratingCodes to read the person's other certificates. ${ratingsRoute} ${alternativesOnF}`,
      ],
      [
        tools[0],
        { mode: 'name', lastName: 'FIXTURE', ratingCodes: ['INSTH'] },
        `2 people match this name search without ratingCodes, and none holds a certificate matching the requested rating codes in this snapshot. ${ratingsRoute} ${alternativesOnF}`,
      ],
      [
        tools[0],
        { mode: 'name', lastName: 'FIXTURE', certificateType: 'F', ratingCodes: ['INSTH'] },
        `2 people match this name search without certificateType or ratingCodes, and none holds a single certificate carrying every requested credential in this snapshot. ${ratingsRoute} ${alternatives}`,
      ],
      [tools[3], { lastName: 'ABSENT' }, identifiers],
    ] as const;
    for (const [definition, input, route] of cases) {
      const result = await runToolContract(definition, input);
      expect({ tool: definition.name, input, notice: noticeOf(result) }).toEqual({
        tool: definition.name,
        input,
        notice: `${base} ${route}`,
      });
      expect(result.structuredContent).toMatchObject({ totalCount: 0, returnedCount: 0 });
    }
  });
  it('carries exactly the eight per-call provenance fields on both surfaces of every snapshot-backed call', async () => {
    const service = clean();
    await service.initialize();
    const full = (await service.mirror.status()).provenance!;
    const slim = {
      sourceName: 'FAA Releasable Airmen Database',
      snapshotMonth: '2026-10',
      ageDays: 19,
      ageBasis: 'snapshot_month_start',
      stale: false,
      staleAfterDays: 45,
      generationId: full.generationId,
      includeLocation: false,
    };
    for (const [definition, input] of [
      [tools[0], { mode: 'id', uniqueId: 'A9999999' }],
      [tools[0], { mode: 'name', lastName: 'ABSENT' }],
      [tools[1], { uniqueId: 'A9999999' }],
      [tools[1], { uniqueId: 'C0000000' }],
      [tools[2], { uniqueId: 'A9999999' }],
      [tools[3], { state: 'WA' }],
      [tools[4], { mode: 'id', uniqueId: 'A9999999' }],
      [tools[5], { topic: 'type_ratings' }],
      [tools[5], { topic: 'mirror_status' }],
    ] as const) {
      const result = await runToolContract(definition, input);
      parity(result);
      for (const surface of [result.structuredContent, renderedResult(result.content)] as {
        provenance: Record<string, unknown>;
      }[]) {
        expect(Object.keys(surface.provenance)).toEqual(Object.keys(slim));
        expect(surface.provenance).toEqual(slim);
      }
    }
    for (const topic of ['ratings', 'identifiers'] as const)
      expect((await runToolContract(tools[5], { topic })).structuredContent).toMatchObject({
        provenance: null,
      });
  });
  it('names the CFII and MEI codes once in each ratingCodes schema and on the ten relevant rating entries', async () => {
    init();
    const mapping =
      'CFII is INSTA, INSTH, INSTI, or INSTP on a flight instructor (F) certificate; MEI is AME or ASME on F; INST, ADV, and BASIC occur only on ground instructor (G) certificates.';
    for (const definition of [tools[0], tools[3]]) {
      const description = definition.input.shape.ratingCodes.description ?? '';
      expect({ tool: definition.name, mapping: description.split(mapping).length - 1 }).toEqual({
        tool: definition.name,
        mapping: 1,
      });
    }
    const entries: { code: string; guidance?: string; sourceUrls: string[] }[] = [];
    for (let offset: number | null = 0; offset !== null; ) {
      const page = await runToolContract(tools[5], { topic: 'ratings', limit: 50, offset });
      parity(page);
      const structured = page.structuredContent as {
        entries: typeof entries;
        nextOffset: number | null;
      };
      entries.push(...structured.entries);
      offset = structured.nextOffset;
    }
    expect(entries).toHaveLength(55);
    const part61 =
      'https://www.ecfr.gov/current/title-14/chapter-I/subchapter-D/part-61/subpart-A/section-61.5';
    const expected: Record<string, string> = {
      INSTA: 'CFII',
      INSTH: 'CFII',
      INSTI: 'CFII',
      INSTP: 'CFII',
      AME: 'MEI',
      ASME: 'MEI',
      ASE: 'not MEI',
      INST: 'ground instructor (G)',
      ADV: 'ground instructor (G)',
      BASIC: 'ground instructor (G)',
    };
    for (const entry of entries) {
      const marker = expected[entry.code];
      if (marker) {
        expect(entry.guidance).toContain(marker);
        expect(entry.sourceUrls).toContain(part61);
      } else {
        expect(entry.guidance).not.toMatch(/CFII|MEI/);
        expect(entry.sourceUrls).not.toContain(part61);
      }
    }
  });
  it('names the pilot-file scope of type ratings and every tool whose results carry a Unique ID', () => {
    const from =
      'from a faa_airmen_verify_certificate, faa_airmen_search_instructors, or faa_airmen_verify_remote_pilot result';
    expect(tools[1].description).toBe(
      `Read one FAA airman's certificates from the FAA pilot file, by Unique ID: pilot, flight instructor, authorized aircraft instructor, remote pilot, and flight engineer, each with every aircraft type, category/class, and instrument rating. Ground instructor, mechanic, and other non-pilot certificates are excluded; faa_airmen_verify_certificate mode id returns every certificate. Get the ID ${from}. Ratings retain their source certificate type and level and do not establish current operating privileges.`,
    );
    expect(tools[2].description).toBe(
      `Read the FAA snapshot's informational medical class, medical dates, and BasicMed dates for one airman Unique ID. These fields are not authoritative medical certification or fitness determinations. Get the ID ${from}. Every call is rejected while the operator's personal-data redaction is on (the default).`,
    );
    const id = 'A or C plus seven digits, for example A9999999; not a certificate number.';
    for (const definition of [tools[1], tools[2]])
      expect(definition.input.shape.uniqueId.description).toBe(
        `Opaque FAA Unique ID ${from}, ${id}`,
      );
    for (const definition of [tools[0], tools[4]])
      expect(definition.input.shape.uniqueId.description).toBe(
        `Opaque FAA Unique ID ${from}, ${id} Trimmed and uppercased.`,
      );
  });
  it('reads type ratings and medical fields by the Unique ID an instructor or remote pilot result carries', async () => {
    await clean().initialize();
    const instructor = (await runToolContract(tools[3], { state: 'WA', instructorType: 'flight' }))
      .structuredContent as { matches: { airman: { uniqueId: string } }[] };
    const remote = (await runToolContract(tools[4], { mode: 'name', lastName: 'FIXTURE' }))
      .structuredContent as { matches: { airman: { uniqueId: string } }[] };
    const ids = [...instructor.matches, ...remote.matches].map((match) => match.airman.uniqueId);
    expect(ids).toEqual(['A9999999', 'A9999999']);
    for (const uniqueId of ids)
      for (const definition of [tools[1], tools[2]]) {
        const result = await runToolContract(definition, { uniqueId });
        parity(result);
        expect(result.structuredContent).toMatchObject({
          found: true,
          appliedFilters: { uniqueId },
        });
      }
  });
  const redactedOn = 'while personal-data redaction (FAA_AIRMEN_REDACT_PII) is on.';
  const redactionNotice =
    'Personal-data redaction is on: city, ZIP, and medical fields are withheld, and name searches require both lastName and firstName.';
  function contentText(result: Awaited<ReturnType<typeof runToolContract>>): string {
    return result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
  }
  it.each([false, true])(
    'carries piiRedacted %s as a top-level trailer field on both surfaces of every tool success',
    async (redactPii) => {
      await init(false, redactPii).initialize();
      const fullName = { lastName: 'FIXTURE', firstName: 'SYNTHETIC' } as const;
      const cases = [
        ...tools.map((definition, index) => ({
          definition,
          input:
            redactPii && definition.name === 'faa_airmen_search_instructors'
              ? fullName
              : inputs[index]!,
        })),
        { definition: tools[0], input: { mode: 'name', ...fullName } as const },
        { definition: tools[5], input: { topic: 'mirror_status' } as const },
      ].filter(
        ({ definition }) => !(redactPii && definition.name === 'faa_airmen_check_medical_status'),
      );
      expect(new Set(cases.map(({ definition }) => definition.name)).size).toBe(redactPii ? 5 : 6);
      for (const { definition, input } of cases) {
        const result = await runToolContract(definition, input);
        parity(result);
        const structured = result.structuredContent as {
          piiRedacted: boolean;
          provenance: Record<string, unknown> | null;
        };
        expect({ tool: definition.name, piiRedacted: structured.piiRedacted }).toEqual({
          tool: definition.name,
          piiRedacted: redactPii,
        });
        expect(renderedResult(result.content).piiRedacted).toBe(redactPii);
        expect(contentText(result)).toContain(
          `**piiRedacted**\n\n\`\`\`json\n${redactPii}\n\`\`\``,
        );
        expect(structured.provenance ?? {}).not.toHaveProperty('piiRedacted');
      }
      const id = noticeOf(await runToolContract(tools[0], { mode: 'id', uniqueId: 'A9999999' }));
      expect({
        redaction: id.includes(redactionNotice),
        location: id.includes(locationOff),
      }).toEqual({ redaction: redactPii, location: !redactPii });
      const zero = await runToolContract(tools[0], {
        mode: 'name',
        lastName: 'ABSENT',
        firstName: 'NOBODY',
      });
      expect(noticeOf(zero)).toBe(
        `${limits} ${redactPii ? redactionNotice : locationOff} No record matched this releasable snapshot. This does not establish that a person is uncertificated. Check faa_airmen_list_reference with topic identifiers${redactPii ? '' : ', then retry with fewer name or location filters'}.`,
      );
    },
  );
  it('puts pii_redacted, its field-named message, and its recovery on both surfaces before any mirror read', async () => {
    init(true, true);
    const insta: string[] = ['INSTA'];
    for (const [definition, input, message] of [
      [
        tools[0],
        { mode: 'name', lastName: 'PRIVATE INPUT' },
        `firstName is required ${redactedOn}`,
      ],
      [
        tools[0],
        {
          mode: 'name',
          lastName: 'PRIVATE INPUT',
          firstName: 'PRIVATE INPUT',
          nameMatch: 'prefix',
        },
        `nameMatch must be words or exact ${redactedOn}`,
      ],
      [
        tools[0],
        { mode: 'name', lastName: 'PRIVATE INPUT', firstName: 'PRIVATE', city: 'PRIVATE CITY' },
        `city is unavailable ${redactedOn}`,
      ],
      [
        tools[4],
        { mode: 'name', lastName: 'PRIVATE INPUT', zipCode: '99999' },
        `zipCode is unavailable ${redactedOn}`,
      ],
      [
        tools[3],
        { state: 'WA', ratingCodes: insta },
        `lastName and firstName are required ${redactedOn}`,
      ],
      [tools[2], { uniqueId: 'C0000000' }, `Medical fields are withheld ${redactedOn}`],
      [tools[2], { uniqueId: 'A9999999\t' }, `Medical fields are withheld ${redactedOn}`],
    ] as const) {
      const result = await runToolContract(definition, input);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: -32005,
          message,
          data: {
            reason: 'pii_redacted',
            retryable: false,
            recovery: { hint: expect.stringContaining('FAA_AIRMEN_REDACT_PII=false') },
          },
        },
      });
      const { hint } = (
        result.structuredContent as { error: { data: { recovery: { hint: string } } } }
      ).error.data.recovery;
      expect(contentText(result)).toContain(`Error: ${message}`);
      expect(contentText(result)).toContain(`Recovery: ${hint}`);
      for (const value of ['PRIVATE', '99999', 'C0000000', directory])
        expect(JSON.stringify(result)).not.toContain(value);
    }
    // The schema gate still precedes every handler; an invalid ID never reaches the service.
    for (const redactPii of [true, false]) {
      init(false, redactPii);
      expect(
        (await runToolContract(tools[2], { uniqueId: '123' })).structuredContent,
      ).toMatchObject({ error: { code: -32602, data: { reason: 'invalid_arguments' } } });
    }
    // With redaction off, the same calls reach validation or the missing mirror.
    for (const [input, reason] of [
      [{ uniqueId: 'C0000000' }, 'mirror_missing'],
      [{ uniqueId: 'A9999999\t' }, 'invalid_identity'],
    ] as const)
      expect((await runToolContract(tools[2], input)).structuredContent).toMatchObject({
        error: { data: { reason } },
      });
    await init(true, true).initialize();
    expect(
      (await runToolContract(tools[2], { uniqueId: 'C0000000' })).structuredContent,
    ).toMatchObject({ error: { code: -32005, data: { reason: 'pii_redacted' } } });
  });
  it('offers only an allowed retry in each serving mode, on both surfaces', async () => {
    const lastName = {
      message: 'mode name requires lastName.',
      off: 'In mode name send a nonblank lastName, or use mode id with a uniqueId.',
      on: 'In mode name send both lastName and firstName, or use mode id with a uniqueId.',
    };
    const uniqueId = {
      message: 'mode id requires uniqueId.',
      off: 'Send the uniqueId from a faa_airmen_verify_certificate, faa_airmen_search_instructors, or faa_airmen_verify_remote_pilot result, or search with mode name and lastName.',
      on: 'Send the uniqueId from a faa_airmen_verify_certificate, faa_airmen_search_instructors, or faa_airmen_verify_remote_pilot result, or search with mode name and both lastName and firstName.',
    };
    const firstName = {
      message: 'firstName must be at most 60 characters with no control or format characters.',
      off: 'Retry with firstName as written in the FAA FIRST NAME field, at most 60 characters, or omit it.',
      on: 'Retry with firstName as written in the FAA FIRST NAME field, at most 60 characters.',
    };
    const badFirstName = { lastName: 'FIXTURE', firstName: 'PRIVATE INPUT\u0000' };
    // A name search redaction will refuse adds the full search to the rejection it raises first.
    const namesToo =
      'While personal-data redaction is on, a name search also needs both lastName and firstName, with nameMatch words or exact.';
    const typeHint =
      'Call faa_airmen_list_reference with topic certificate_types and send a listed code or description, or omit certificateType together with any certificateLevel.';
    const stateHint =
      'Send state as a two-letter USPS code: a state such as WA, or DC, PR, GU, VI, MP, AS, FM, MH, PW, AA, AE or AP; omit it otherwise, since airmen with foreign addresses carry no state.';
    const certificateType = {
      message:
        'certificateType must be one certificate type letter, a certificate_types description, or CFI.',
      off: typeHint,
      on: `${typeHint} ${namesToo}`,
    };
    const state = {
      message: 'state must be a two-letter USPS state, territory, or military code.',
      off: stateHint,
      on: `${stateHint} ${namesToo}`,
    };
    for (const [definition, input, reason, expected] of [
      [tools[0], { mode: 'name', lastName: ' ', firstName: 'X' }, 'invalid_identity', lastName],
      [tools[4], { mode: 'name', lastName: ' ' }, 'invalid_identity', lastName],
      [tools[0], { mode: 'id', uniqueId: ' ' }, 'invalid_identity', uniqueId],
      [tools[4], { mode: 'id', uniqueId: ' ' }, 'invalid_identity', uniqueId],
      [tools[0], { mode: 'name', ...badFirstName }, 'invalid_identity', firstName],
      [tools[3], badFirstName, 'invalid_identity', firstName],
      [
        tools[3],
        {},
        'missing_search_filter',
        {
          message: {
            off: 'Instructor search requires lastName, firstName, state, or ratingCodes.',
            on: 'Instructor search requires both lastName and firstName.',
          },
          // The declared recovery fills a throw with redaction off.
          off: 'Call faa_airmen_search_instructors with a name, state, or rating code from faa_airmen_list_reference.',
          on: 'Call faa_airmen_search_instructors with both lastName and firstName; for a personal install, the operator can set FAA_AIRMEN_REDACT_PII=false to search by state or rating alone.',
        },
      ],
      [
        tools[0],
        { mode: 'name', lastName: 'FIXTURE', certificateType: 'Q9', certificateLevel: 'A' },
        'invalid_filter',
        certificateType,
      ],
      [tools[3], { lastName: 'FIXTURE', state: 'Washington' }, 'invalid_filter', state],
      [
        tools[4],
        { mode: 'name', lastName: 'FIXTURE', state: 'Washington' },
        'invalid_filter',
        state,
      ],
      [
        tools[0],
        { mode: 'name', lastName: 'FIXTURE', firstName: 'SYNTHETIC', certificateType: 'Q9' },
        'invalid_filter',
        { ...certificateType, on: typeHint },
      ],
    ] as const)
      for (const redactPii of [false, true]) {
        init(false, redactPii);
        const mode = redactPii ? 'on' : 'off';
        const message =
          typeof expected.message === 'string' ? expected.message : expected.message[mode];
        const hint = expected[mode];
        const result = await runToolContract(definition, input);
        expect
          .soft({ tool: definition.name, redactPii, error: result.structuredContent })
          .toMatchObject({
            tool: definition.name,
            redactPii,
            error: { error: { code: -32007, message, data: { reason, recovery: { hint } } } },
          });
        expect.soft(contentText(result)).toContain(`Error: ${message}`);
        expect.soft(contentText(result)).toContain(`Recovery: ${hint}`);
        expect(JSON.stringify(result)).not.toContain('PRIVATE INPUT');
      }
    // A redacted city or ZIP refusal names the whole retry its search shape allows, and that retry succeeds.
    await init(false, true).initialize();
    const operator =
      'for a personal install, the operator can set FAA_AIRMEN_REDACT_PII=false, and city and ZIP filters also need FAA_AIRMEN_INCLUDE_LOCATION=true.';
    const fullName = { lastName: 'FIXTURE', firstName: 'SYNTHETIC' } as const;
    for (const [definition, input, hint, retry] of [
      [
        tools[0],
        { mode: 'id', uniqueId: 'A9999999', state: 'WA', city: 'PRIVATE CITY' },
        `Retry in mode id without name, location, or nameMatch fields; ${operator}`,
        { mode: 'id', uniqueId: 'A9999999' },
      ],
      [
        tools[4],
        { mode: 'name', lastName: 'FIXTURE', city: 'PRIVATE CITY' },
        `Retry in mode name without city or zipCode, with both lastName and firstName and nameMatch words or exact, narrowing with state if needed; ${operator}`,
        { mode: 'name', ...fullName },
      ],
      [
        tools[3],
        { state: 'WA', city: 'PRIVATE CITY' },
        `Retry without city or zipCode, with both lastName and firstName and nameMatch words or exact, narrowing with state, instructorType, or ratingCodes if needed; ${operator}`,
        fullName,
      ],
    ] as const) {
      const result = await runToolContract(definition, input);
      expect.soft({ tool: definition.name, error: result.structuredContent }).toMatchObject({
        tool: definition.name,
        error: {
          error: {
            code: -32005,
            message: `city is unavailable ${redactedOn}`,
            data: { reason: 'pii_redacted', recovery: { hint } },
          },
        },
      });
      expect.soft(contentText(result)).toContain(`Recovery: ${hint}`);
      expect(JSON.stringify(result)).not.toContain('PRIVATE CITY');
      const accepted = await runToolContract(definition, retry);
      expect({ tool: definition.name, isError: accepted.isError === true }).toEqual({
        tool: definition.name,
        isError: false,
      });
      parity(accepted);
    }
    // A redacted zero result offers back only the filter its full-name retry may drop.
    for (const redactPii of [false, true]) {
      await init(false, redactPii).initialize();
      const zero = await runToolContract(tools[0], {
        mode: 'name',
        lastName: 'ABSENT',
        firstName: 'NOBODY',
        state: 'WA',
      });
      expect(noticeOf(zero)).toBe(
        `${limits} ${redactPii ? redactionNotice : locationOff} No record matched this releasable snapshot. This does not establish that a person is uncertificated. Check faa_airmen_list_reference with topic identifiers, then retry ${redactPii ? 'without state' : 'with fewer name or location filters'}.`,
      );
    }
  });
  it('never carries city, ZIP, or medical fields on either surface under redaction, even with location access on', async () => {
    await init(true, true).initialize();
    for (const [definition, input] of [
      [tools[0], { mode: 'id', uniqueId: 'A9999999' }],
      [tools[0], { mode: 'name', lastName: 'FIXTURE', firstName: 'SYNTHETIC' }],
      [tools[1], { uniqueId: 'A9999999' }],
      [tools[3], { lastName: 'FIXTURE', firstName: 'SYNTHETIC' }],
      [tools[4], { mode: 'id', uniqueId: 'A9999999' }],
    ] as const) {
      const result = await runToolContract(definition, input);
      parity(result);
      for (const surface of [JSON.stringify(result.structuredContent), contentText(result)])
        for (const value of [
          'TEST CITY SENTINEL',
          '"city"',
          '"zipCode"',
          '"99999"',
          'MEDICAL-ONLY',
          'medicalRecords',
          'PRIVATE STREET',
        ])
          expect({ tool: definition.name, value, found: surface.includes(value) }).toEqual({
            tool: definition.name,
            value,
            found: false,
          });
    }
    init(true, false);
    const located = await runToolContract(tools[0], { mode: 'id', uniqueId: 'A9999999' });
    parity(located);
    for (const surface of [JSON.stringify(located.structuredContent), contentText(located)])
      expect(surface).toContain('TEST CITY SENTINEL');
  });
});
