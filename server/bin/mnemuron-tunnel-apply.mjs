#!/usr/bin/env node
// Privileged tunnel applier (root, started by mnemuron-tunnel-apply.path when the request file changes).
// The request holds the desired state of every tunnel (revision, owner, sealed connector token, metrics port). For each
// tunnel whose revision is newer than its last outcome it opens the token with the console key, installs it, starts or
// restarts that cloudflared and waits for it to connect. The main tunnel (unit cloudflared-mnemuron) keeps its
// credential path; added tunnels run as cloudflared-mnemuron@<id> with a token and an env file under tunnels/. A token
// that does not connect is rolled back (the previous token restored; a new tunnel stopped and cleaned up), so a bad token
// never cuts the console off. Removals stop the instance and delete its files. Outcomes go to the status file the service
// reads; discover mode reports the tokens cloudflared runs with. It never opens the database.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {loadMemoryRuntimeFile} from '../lib/memory-runtime.mjs';
import {readConsoleKey, unsealWith, sealWith} from '../lib/console/state.mjs';
import {decodeTunnelToken, fingerprint, metricsUrl, MAIN_METRICS_PORT, TUNNEL_ID} from '../lib/tunnel/settings.mjs';

// MNEMURON_CONSOLE_KEY_FILE / MNEMURON_TUNNEL_DIR / MNEMURON_SYSTEMCTL / MNEMURON_TUNNEL_CREDENTIAL / MNEMURON_TUNNEL_ETC /
// MNEMURON_TUNNEL_METRICS_URL override the runtime file, unit manager, paths and metrics endpoint (tests).
const env = process.env;
const config = env.MNEMURON_CONSOLE_KEY_FILE && env.MNEMURON_TUNNEL_DIR ? {console: {key_file: env.MNEMURON_CONSOLE_KEY_FILE}}
  : loadMemoryRuntimeFile(env.MNEMURON_MEMORY_CONFIG || '/etc/mnemuron/memory-first.runtime.json');
const dir = env.MNEMURON_TUNNEL_DIR || path.join(path.dirname(env.MNEMURON_DATABASE_PATH || config.storage?.sqlite_path || '/var/lib/mnemuron/mnemuron.sqlite3'), 'tunnel');
const requestFile = path.join(dir, 'apply.request'), statusFile = path.join(dir, 'apply.status');
const mainCredential = env.MNEMURON_TUNNEL_CREDENTIAL || '/etc/cloudflared-mnemuron/tunnel-token';
const extraDir = env.MNEMURON_TUNNEL_ETC || path.join(path.dirname(mainCredential), 'tunnels');
const waitSeconds = Number(env.MNEMURON_TUNNEL_WAIT_SECONDS || 40);
const systemctl = (...args) => execFileSync(env.MNEMURON_SYSTEMCTL || 'systemctl', args, {stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60000});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const unitOf = id => id === 'main' ? 'cloudflared-mnemuron.service' : `cloudflared-mnemuron@${id}.service`;
const credentialOf = id => id === 'main' ? mainCredential : path.join(extraDir, `${id}.token`);
const envFileOf = id => path.join(extraDir, `${id}.env`);
const metricsOf = (id, port) => env.MNEMURON_TUNNEL_METRICS_URL || metricsUrl(id === 'main' ? MAIN_METRICS_PORT : port);

function writePrivate(file, text) { fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700}); const tmp = `${file}.tmp`; fs.writeFileSync(tmp, text, {mode: 0o600}); fs.renameSync(tmp, file); }
function writeOwned(file, value) {
  const owner = fs.statSync(dir), tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value) + '\n', {mode: 0o600});
  fs.chownSync(tmp, owner.uid, owner.gid);
  fs.renameSync(tmp, file);
}
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const readToken = file => { try { return fs.readFileSync(file, 'utf8').trim() || null; } catch { return null; } };
function stopInstance(unit) {
  try { systemctl('disable', '--now', unit); return; } catch { /* verify an already stopped and disabled/absent instance */ }
  try {
    const properties = systemctl('show', '--property=LoadState,ActiveState,UnitFileState', unit);
    const state = Object.fromEntries(properties.trim().split('\n').map(line => line.split('=')));
    if (state.ActiveState === 'inactive' && (state.LoadState === 'not-found' || ['disabled', 'masked'].includes(state.UnitFileState))) return;
  } catch { /* an unavailable manager or unknown state cannot confirm a stop */ }
  throw Object.assign(new Error('Could not confirm the tunnel was stopped and disabled.'), {errorCode: 'TUNNEL_STOP_FAILED'});
}
function removeInstanceFiles(id) {
  for (const file of [credentialOf(id), envFileOf(id)]) fs.rmSync(file, {force: true});
}
async function connected(url) {
  const until = Date.now() + waitSeconds * 1000;
  while (Date.now() < until) {
    await sleep(Number(env.MNEMURON_TUNNEL_POLL_MS || 2000));
    try {
      const response = await fetch(url + '/ready', {signal: AbortSignal.timeout(1500)});
      const body = await response.json().catch(() => ({}));
      if (response.status === 200 && body.readyConnections > 0) return true;
    } catch { /* not up yet */ }
  }
  return false;
}

/** Discover mode (--discover, and after every run): the tokens cloudflared runs with, sealed for the owner. */
function discover() {
  const owner = env.MNEMURON_OWNER_USER_ID || config.console?.owner_user_id;
  if (!owner || !fs.existsSync(dir)) return;
  const key = readConsoleKey(config.console.key_file), tunnels = {}, ids = ['main'];
  try { for (const f of fs.readdirSync(extraDir)) { const id = f.replace(/\.token$/, ''); if (f.endsWith('.token') && TUNNEL_ID.test(id) && id !== 'main') ids.push(id); } } catch { /* no added tunnels */ }
  for (const id of ids) {
    const token = readToken(credentialOf(id));
    if (!token) continue;
    try { tunnels[id] = {user: owner, token_fp: fingerprint(token), token_seal: sealWith(key, owner, 'tunnel-token', token), ...decodeTunnelToken(token), at: new Date().toISOString()}; } catch { /* not a token */ }
  }
  writeOwned(path.join(dir, 'discovered.json'), {version: 2, tunnels});
}

async function applyOne(id, want, key) {
  const unit = unitOf(id), credential = credentialOf(id);
  if (want.state === 'removing') {
    if (id === 'main') return {state: 'failed', error: 'TUNNEL_MAIN'};
    stopInstance(unit);
    removeInstanceFiles(id);
    return {state: 'removed'};
  }
  const token = unsealWith(key, want.user, 'tunnel-token', want.token_seal);
  decodeTunnelToken(token);
  const previous = readToken(credential), url = metricsOf(id, want.metrics_port);
  if (id !== 'main') writePrivate(envFileOf(id), `MNEMURON_TUNNEL_METRICS=127.0.0.1:${want.metrics_port}\n`);
  if (previous === token) { if (id === 'main') systemctl('start', unit); else systemctl('enable', '--now', unit); return {state: 'applied', unchanged: true}; }
  writePrivate(credential, token + '\n');
  if (id === 'main' || previous) systemctl('restart', unit); else systemctl('enable', '--now', unit);
  if (await connected(url)) return {state: 'applied'};
  if (previous) { writePrivate(credential, previous + '\n'); systemctl('restart', unit); return {state: 'rolled_back', error: 'TUNNEL_NOT_CONNECTED', restored: await connected(url)}; }
  if (id !== 'main') { stopInstance(unit); removeInstanceFiles(id); }
  return {state: 'rolled_back', error: 'TUNNEL_NOT_CONNECTED_NO_PREVIOUS'};
}

if (process.argv.includes('--discover')) { discover(); process.exit(0); }
process.on('exit', () => { try { discover(); } catch { /* best effort */ } });

const request = readJson(requestFile);
if (!request?.tunnels) process.exit(0);
const status = readJson(statusFile)?.tunnels || {};
let key, failed = false;
for (const [id, want] of Object.entries(request.tunnels)) {
  if (!TUNNEL_ID.test(id) || !Number.isInteger(want?.revision) || want.revision <= (status[id]?.revision || 0)) continue;
  try { key ??= readConsoleKey(config.console.key_file); status[id] = {revision: want.revision, ...await applyOne(id, want, key)}; }
  catch (error) { status[id] = {revision: want.revision, state: 'failed', error: error.errorCode || error.code || 'APPLY_FAILED'}; failed = true; }
  status[id].at = new Date().toISOString();
  writeOwned(statusFile, {version: 2, tunnels: status});
}
if (failed) process.exitCode = 1;
