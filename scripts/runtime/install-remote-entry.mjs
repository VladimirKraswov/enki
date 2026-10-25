#!/usr/bin/env node
// Remote runtime installer entry (docs/REMOTE-RUNTIME.md). install-remote.mjs
// statically imports node:sqlite (paired backups, artifact lease), so the host
// Node is checked here first; on an unsupported host nothing is read or changed.
import { guardedMain } from './host-node.mjs';

process.exitCode = await guardedMain('install-remote', './install-remote.mjs', process.argv.slice(2), {
  action: 'The Enki Runtime installer', consequence: 'nothing was installed or changed' });
