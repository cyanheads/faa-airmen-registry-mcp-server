/**
 * @fileoverview Mirror lifecycle command: dispatch, cancellation, output and exit status.
 * @module cli/mirror-command
 */
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '../config/server-config.js';
import { AirmenMirror } from '../services/airmen/airmen-mirror.js';
import { safeMirrorError } from '../services/airmen/mirror-error.js';

const COMMANDS = ['init', 'refresh', 'verify', 'status', 'prune'] as const;
type Command = (typeof COMMANDS)[number];
const USAGE = `Usage: faa-airmen-registry-mirror <${COMMANDS.join('|')}>
  prune deletes every snapshot generation CURRENT does not name; stop every server process using this mirror first.
`;

function isCommand(value: string | undefined): value is Command {
  return COMMANDS.some((command) => command === value);
}

function dispatch(mirror: AirmenMirror, command: Command, signal: AbortSignal) {
  switch (command) {
    case 'init':
      return mirror.initialize(signal);
    case 'refresh':
      return mirror.refresh(signal);
    case 'verify':
      return mirror.verifyMirror();
    case 'status':
      return mirror.operatorStatus();
    case 'prune':
      return mirror.prune();
  }
}

/** Run one lifecycle command; SIGINT and SIGTERM cancel it. Resolves to the process exit code. */
export async function runMirrorCommand(args: readonly string[]): Promise<number> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const mirror = new AirmenMirror(getServerConfig());
    const command = args[0];
    if (args.length !== 1 || !isCommand(command)) {
      process.stderr.write(USAGE);
      return 1;
    }
    if (command === 'init' || command === 'refresh')
      process.stderr.write(`Mirror ${command} started.\n`);
    const result = await dispatch(mirror, command, controller.signal);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if ('ok' in result && !result.ok) return 1;
    if ('status' in result && result.status === 'unavailable') return 1;
    return 0;
  } catch (error) {
    // The framework's validation message names the variable and carries no paths or values.
    if (error instanceof McpError && error.code === JsonRpcErrorCode.ConfigurationError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    const safe = safeMirrorError(error, 'unavailable');
    process.stderr.write(`${safe.stage}: ${safe.message}\n`);
    return 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
