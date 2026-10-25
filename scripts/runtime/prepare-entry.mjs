#!/usr/bin/env node
// `npm run runtime:prepare` entry. prepare.mjs statically imports node:sqlite
// (artifact leases), so the host Node is checked here first; prepare.mjs and its
// imports load only on a supported host.
import { guardedMain } from './host-node.mjs';

process.exitCode = await guardedMain('runtime:prepare', './prepare.mjs', process.argv.slice(2), { consequence: 'nothing was prepared' });
