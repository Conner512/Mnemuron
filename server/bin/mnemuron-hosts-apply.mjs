#!/usr/bin/env node
// Privileged host file applier (root, started by mnemuron-hosts-apply.path when the request file changes). The request
// holds the owner's full set of host records and the names whose old lines must go (console/hosts.mjs). Each entry is
// validated again here; Proxmox's block and unrelated lines are kept, and the records are written in Mnemuron's own
// block. The file is replaced atomically with its mode kept. The outcome goes to the status file the service reads.
// It never opens the database.
import fs from 'node:fs';
import path from 'node:path';
import {loadMemoryRuntimeFile} from '../lib/memory-runtime.mjs';
import {normalizeHost, normalizeAddress, renderHosts, MAX_HOSTS} from '../lib/console/hosts.mjs';

// MNEMURON_HOSTS_DIR / MNEMURON_HOSTS_FILE override the request directory and the host file (tests).
const env = process.env;
const dir = env.MNEMURON_HOSTS_DIR || path.join(path.dirname(env.MNEMURON_DATABASE_PATH
  || loadMemoryRuntimeFile(env.MNEMURON_MEMORY_CONFIG || '/etc/mnemuron/memory-first.runtime.json').storage?.sqlite_path || '/var/lib/mnemuron/mnemuron.sqlite3'), 'hosts');
const hostsFile = env.MNEMURON_HOSTS_FILE || '/etc/hosts';
const requestFile = path.join(dir, 'apply.request'), statusFile = path.join(dir, 'apply.status');
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
function writeOwned(file, value) {
  const owner = fs.statSync(dir), tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value) + '\n', {mode: 0o600});
  fs.chownSync(tmp, owner.uid, owner.gid);
  fs.renameSync(tmp, file);
}

const request = readJson(requestFile);
if (!Number.isInteger(request?.revision)) process.exit(0);
if (request.revision <= (readJson(statusFile)?.revision || 0)) process.exit(0);
let outcome;
try {
  if (!Array.isArray(request.hosts) || !Array.isArray(request.remove) || request.hosts.length > MAX_HOSTS || request.remove.length > 500) throw Object.assign(new Error('bad request'), {code: 'INVALID_REQUEST'});
  const hosts = request.hosts.map(h => ({hostname: normalizeHost(h.hostname), address: normalizeAddress(h.address)})), remove = request.remove.map(normalizeHost);
  const current = fs.readFileSync(hostsFile, 'utf8'), next = renderHosts(current, {hosts, remove});
  if (next !== current) {
    const stat = fs.statSync(hostsFile), tmp = `${hostsFile}.mnemuron.tmp`;
    fs.writeFileSync(tmp, next, {mode: stat.mode & 0o777});
    fs.chownSync(tmp, stat.uid, stat.gid);
    fs.renameSync(tmp, hostsFile);
  }
  outcome = {state: 'applied', changed: next !== current};
} catch (error) {
  outcome = {state: 'failed', error: error.errorCode || error.code || 'APPLY_FAILED'};
  process.exitCode = 1;
}
writeOwned(statusFile, {version: 1, revision: request.revision, ...outcome, at: new Date().toISOString()});
