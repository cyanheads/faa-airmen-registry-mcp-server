#!/usr/bin/env node
/**
 * @fileoverview Installed Node/Bun mirror lifecycle command, separate from MCP startup.
 * @module cli/mirror
 */
import { getServerConfig } from '../config/server-config.js';
import { AirmenMirror } from '../services/airmen/airmen-mirror.js';
import { safeMirrorError } from '../services/airmen/mirror-error.js';

const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  const mirror = new AirmenMirror(getServerConfig());
  const command = process.argv[2];
  if (
    process.argv.length !== 3 ||
    !['init', 'refresh', 'verify', 'status'].includes(command ?? '')
  ) {
    process.stderr.write('Usage: faa-airmen-registry-mirror <init|refresh|verify|status>\n');
    process.exitCode = 1;
  } else {
    if (command === 'init' || command === 'refresh')
      process.stderr.write(`Mirror ${command} started.\n`);
    const result =
      command === 'init'
        ? await mirror.initialize(controller.signal)
        : command === 'refresh'
          ? await mirror.refresh(controller.signal)
          : command === 'verify'
            ? await mirror.verifyMirror()
            : await mirror.status();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if ('ok' in result && !result.ok) process.exitCode = 1;
    if ('status' in result && result.status === 'unavailable') process.exitCode = 1;
  }
} catch (error) {
  const safe = safeMirrorError(error, 'unavailable');
  process.stderr.write(`${safe.stage}: ${safe.message}\n`);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
