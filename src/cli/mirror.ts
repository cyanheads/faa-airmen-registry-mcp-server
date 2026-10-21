#!/usr/bin/env node
/**
 * @fileoverview Installed Node/Bun mirror lifecycle command, separate from MCP startup.
 * @module cli/mirror
 */
import { runMirrorCommand } from './mirror-command.js';

process.exitCode = await runMirrorCommand(process.argv.slice(2));
