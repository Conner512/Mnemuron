// Cloudflare Tunnels, editable from the console and the CLI (bin/mnemuron-config.mjs) alike. Tunnel only: connector
// tokens and the state of each cloudflared; no Cloudflare API is used.
// - 'main' is the tunnel the console is served through (unit cloudflared-mnemuron, metrics 127.0.0.1:47834). More can be
//   added; each runs as cloudflared-mnemuron@<id> with its own token file and metrics port, and can be removed.
// - Tokens are stored sealed with the console key; only short fingerprints are shown. Account and tunnel IDs are read
//   from the token.
// - The service writes the desired state of every tunnel to one request file; a privileged helper
//   (bin/mnemuron-tunnel-apply.mjs, run by a systemd path unit) installs tokens, starts/restarts or removes instances,
//   waits for each to connect, rolls back a token that does not and reports per tunnel. Its discover mode reports the
//   tokens cloudflared actually runs with, so a token changed from a shell shows here too. This service never gets root.
// - Connection state and configuration version come read-only from each instance's local metrics port.
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import {ValidationError, ConflictError, NotFoundError} from '../errors.mjs';

export const MAIN_METRICS_PORT = 47834, EXTRA_METRICS_BASE = 47840, MAX_TUNNELS = 8;
const fail = (message, code) => { throw new ValidationError(message, code); };
export const fingerprint = value => createHash('sha256').update(value).digest('hex').slice(0, 12);
export const metricsUrl = port => `http://127.0.0.1:${port}`;
export const TUNNEL_ID = /^(main|t[0-9a-f]{6})$/;

/** A connector token is base64 JSON {a: account tag, t: tunnel ID, s: secret}. */
export function decodeTunnelToken(token) {
  if (typeof token !== 'string' || !token.trim() || token.length > 4096) fail('A tunnel token is required.', 'INVALID_TUNNEL_TOKEN');
  let data;
  try { data = JSON.parse(Buffer.from(token.trim(), 'base64').toString('utf8')); } catch { fail('This is not a Cloudflare tunnel token.', 'INVALID_TUNNEL_TOKEN'); }
  if (!/^[0-9a-f]{32}$/.test(data?.a || '') || !/^[0-9a-f-]{36}$/.test(data?.t || '') || typeof data?.s !== 'string' || !data.s)
    fail('This is not a Cloudflare tunnel token.', 'INVALID_TUNNEL_TOKEN');
  return {account_id: data.a, tunnel_id: data.t};
}

export class TunnelSettings {
  constructor(store, {fetchImpl = globalThis.fetch} = {}) {
    this.store = store; this.db = store.db; this.fetch = fetchImpl;
    this.db.exec(`CREATE TABLE IF NOT EXISTS tunnels(id TEXT PRIMARY KEY, name TEXT NOT NULL, metrics_port INTEGER NOT NULL UNIQUE, state TEXT NOT NULL DEFAULT 'active',
      user_id TEXT, token_seal TEXT, token_fp TEXT, account_id TEXT, tunnel_id TEXT, desired_revision INTEGER NOT NULL DEFAULT 0, applied_revision INTEGER NOT NULL DEFAULT 0,
      apply_state TEXT, apply_error TEXT, applied_at TEXT, created_at TEXT NOT NULL, updated_at TEXT, updated_by TEXT)`);
    // One-time move of the single-tunnel settings (tunnel_settings, id=1) into the main tunnel; the old table is then dropped.
    if (!this.db.prepare("SELECT 1 FROM tunnels WHERE id='main'").get()) {
      const old = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tunnel_settings'").get() ? this.db.prepare('SELECT * FROM tunnel_settings WHERE id=1').get() : null;
      this.db.prepare(`INSERT INTO tunnels(id,name,metrics_port,user_id,token_seal,token_fp,account_id,tunnel_id,desired_revision,applied_revision,apply_state,apply_error,applied_at,created_at,updated_at,updated_by)
        VALUES('main','Cloudflare Tunnel',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(MAIN_METRICS_PORT, old?.user_id ?? null, old?.token_seal ?? null, old?.token_fp ?? null, old?.account_id ?? null, old?.tunnel_id ?? null,
        old?.desired_revision ?? 0, old?.applied_revision ?? 0, old?.apply_state ?? null, old?.apply_error ?? null, old?.applied_at ?? null, new Date().toISOString(), old?.updated_at ?? null, old?.updated_by ?? null);
    }
    this.db.exec('DROP TABLE IF EXISTS tunnel_settings');
    // The main tunnel's first name was 主 Tunnel; it is shown by its provider now.
    this.db.prepare("UPDATE tunnels SET name='Cloudflare Tunnel' WHERE id='main' AND name='主 Tunnel'").run();
  }
  dir() { return path.join(path.dirname(this.store.databasePath), 'tunnel'); }
  /** Hand-off files beside the database, owned by the service user; the applier (root) never opens the database. */
  requestFile() { return path.join(this.dir(), 'apply.request'); }
  statusFile() { return path.join(this.dir(), 'apply.status'); }
  discoveredFile() { return path.join(this.dir(), 'discovered.json'); }
  rows() { return this.db.prepare("SELECT * FROM tunnels ORDER BY CASE id WHEN 'main' THEN 0 ELSE 1 END, created_at").all(); }
  row(id) {
    if (typeof id !== 'string' || !TUNNEL_ID.test(id)) fail('Unknown tunnel.', 'INVALID_TUNNEL');
    const r = this.db.prepare('SELECT * FROM tunnels WHERE id=?').get(id);
    if (!r) throw new NotFoundError('Tunnel not found.');
    return r;
  }
  readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
  /** Copy newer applier outcomes into the rows; a confirmed removal deletes the row. */
  syncStatus() {
    const status = this.readJson(this.statusFile())?.tunnels;
    if (!status || typeof status !== 'object') return;
    for (const r of this.rows()) {
      const s = status[r.id];
      if (!Number.isInteger(s?.revision) || s.revision <= r.applied_revision || s.revision > r.desired_revision) continue;
      if (s.state === 'removed' && r.state === 'removing') { this.db.prepare('DELETE FROM tunnels WHERE id=?').run(r.id); continue; }
      if (['applied', 'rolled_back', 'failed'].includes(s.state))
        this.db.prepare('UPDATE tunnels SET applied_revision=?, apply_state=?, apply_error=?, applied_at=? WHERE id=?')
          .run(s.revision, s.state, s.error || null, typeof s.at === 'string' ? s.at : new Date().toISOString(), r.id);
    }
  }
  /** Adopt a token changed outside the console and the CLI (a shell edit, an older install), so both show what runs.
   * Never while a console/CLI change of that tunnel is still being applied. */
  syncDiscovery() {
    const found = this.readJson(this.discoveredFile())?.tunnels;
    if (!found || typeof found !== 'object') return;
    for (const r of this.rows()) {
      const d = found[r.id];
      if (!d?.token_fp || !d.token_seal || d.token_fp === r.token_fp || r.state !== 'active' || r.desired_revision > r.applied_revision) continue;
      if (r.updated_at && typeof d.at === 'string' && d.at < r.updated_at) continue;
      this.db.prepare(`UPDATE tunnels SET user_id=?, token_seal=?, token_fp=?, account_id=?, tunnel_id=?, apply_state='applied', apply_error=NULL, applied_at=?, updated_at=?, updated_by='server' WHERE id=?`)
        .run(d.user, d.token_seal, d.token_fp, d.account_id, d.tunnel_id, d.at, d.at, r.id);
      if (d.user && this.store.config) this.store.config.log(d.user, `tunnel.${r.id}.token`, r.token_fp || null, d.token_fp, 'cli', 'server:cloudflared');
    }
  }
  /** Readiness and configuration version of one instance, read-only from its local metrics port. */
  async probe(port) {
    let state;
    try {
      const response = await this.fetch(metricsUrl(port) + '/ready', {signal: AbortSignal.timeout(1500)});
      const body = await response.json().catch(() => ({}));
      state = {reachable: true, ready: response.status === 200, connections: Number.isInteger(body.readyConnections) ? body.readyConnections : null};
    } catch { return {reachable: false, ready: false, connections: null, config_version: null}; }
    try {
      const config = await (await this.fetch(metricsUrl(port) + '/config', {signal: AbortSignal.timeout(1500)})).json();
      state.config_version = Number.isInteger(config?.version) ? config.version : null;
    } catch { state.config_version = null; }
    return state;
  }
  publicRow(r) {
    return {id: r.id, name: r.name, main: r.id === 'main', unit: r.id === 'main' ? 'cloudflared-mnemuron' : `cloudflared-mnemuron@${r.id}`, metrics_port: r.metrics_port, state: r.state,
      configured: !!r.token_seal, token_fingerprint: r.token_fp || null, account_id: r.account_id || null, tunnel_id: r.tunnel_id || null,
      desired_revision: r.desired_revision, applied_revision: r.applied_revision, pending: r.desired_revision > r.applied_revision,
      apply_state: r.state === 'removing' ? 'removing' : r.apply_state || null, apply_error: r.apply_error || null, applied_at: r.applied_at || null, updated_at: r.updated_at || null, updated_by: r.updated_by || null};
  }
  /** Fingerprints and state only: never a token. */
  list() { this.syncStatus(); this.syncDiscovery(); return this.rows().map(r => this.publicRow(r)); }
  summary(id = 'main') { this.syncStatus(); this.syncDiscovery(); return this.publicRow(this.row(id)); }
  async view() { const tunnels = this.list(); return {tunnels: await Promise.all(tunnels.map(async t => ({...t, connection: await this.probe(t.metrics_port)})))}; }
  sealed(user, token) { return this.store.consoleService.state.seal(user, 'tunnel-token', token.trim()); }
  duplicate(tunnelId, except) { return this.rows().some(r => r.id !== except && r.tunnel_id === tunnelId && r.state === 'active'); }
  /** Add a tunnel: a new cloudflared instance with its own token and metrics port. */
  add(user, {name, token}, actor) {
    const label = String(name || '').trim();
    if (!label || [...label].length > 40) fail('A name of up to 40 characters is required.', 'INVALID_TUNNEL_NAME');
    const ids = decodeTunnelToken(token);
    if (this.duplicate(ids.tunnel_id)) throw new ConflictError('This tunnel is already configured.', 'TUNNEL_EXISTS');
    const rows = this.rows();
    if (rows.length >= MAX_TUNNELS) throw new ConflictError(`At most ${MAX_TUNNELS} tunnels.`, 'TUNNEL_LIMIT');
    let id; do { id = 't' + randomBytes(3).toString('hex'); } while (rows.some(r => r.id === id));
    const port = Math.max(EXTRA_METRICS_BASE - 1, ...rows.filter(r => r.id !== 'main').map(r => r.metrics_port)) + 1, now = new Date().toISOString();
    this.db.prepare(`INSERT INTO tunnels(id,name,metrics_port,user_id,token_seal,token_fp,account_id,tunnel_id,desired_revision,apply_state,created_at,updated_at,updated_by)
      VALUES(?,?,?,?,?,?,?,?,1,'pending',?,?,?)`).run(id, label, port, user, this.sealed(user, token), fingerprint(token.trim()), ids.account_id, ids.tunnel_id, now, now, actor);
    this.requestApply();
    return this.summary(id);
  }
  setToken(user, id, token, actor) {
    const r = this.row(id), ids = decodeTunnelToken(token);
    if (r.state !== 'active') throw new ConflictError('This tunnel is being removed.', 'TUNNEL_REMOVING');
    if (this.duplicate(ids.tunnel_id, id)) throw new ConflictError('This tunnel is already configured under another entry.', 'TUNNEL_EXISTS');
    this.db.prepare(`UPDATE tunnels SET user_id=?, token_seal=?, token_fp=?, account_id=?, tunnel_id=?, desired_revision=desired_revision+1, apply_state='pending', apply_error=NULL, updated_at=?, updated_by=? WHERE id=?`)
      .run(user, this.sealed(user, token), fingerprint(token.trim()), ids.account_id, ids.tunnel_id, new Date().toISOString(), actor, id);
    this.requestApply();
    return this.summary(id);
  }
  /** Apply the stored token again (after a rollback or a failed attempt) under a new revision. */
  reapply(id, actor) {
    const r = this.row(id);
    if (!r.token_seal) throw new ConflictError('Add the tunnel token first.', 'TUNNEL_TOKEN_REQUIRED');
    if (r.state !== 'active') throw new ConflictError('This tunnel is being removed.', 'TUNNEL_REMOVING');
    this.db.prepare("UPDATE tunnels SET desired_revision=desired_revision+1, apply_state='pending', apply_error=NULL, updated_at=?, updated_by=? WHERE id=?").run(new Date().toISOString(), actor, id);
    this.requestApply();
    return this.summary(id);
  }
  /** Stop and remove an added tunnel; the main one (the console's own entry) cannot be removed. */
  remove(id, actor) {
    const r = this.row(id);
    if (id === 'main') throw new ConflictError('The main tunnel serves this console and cannot be removed.', 'TUNNEL_MAIN');
    this.db.prepare("UPDATE tunnels SET state='removing', desired_revision=desired_revision+1, apply_state='removing', apply_error=NULL, updated_at=?, updated_by=? WHERE id=?").run(new Date().toISOString(), actor, id);
    this.requestApply();
    return {id, name: r.name, removing: true};
  }
  /** Write the desired state of every tunnel; the applier acts on each whose revision is newer than its last outcome. */
  requestApply() {
    const file = this.requestFile(), tunnels = {};
    for (const r of this.rows()) if (r.token_seal || r.state === 'removing')
      tunnels[r.id] = {revision: r.desired_revision, state: r.state, user: r.user_id, token_seal: r.token_seal, metrics_port: r.metrics_port};
    try {
      fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({version: 2, tunnels}) + '\n', {mode: 0o600});
      fs.renameSync(tmp, file);
    } catch {
      throw new ConflictError('The tunnel change was saved but could not be handed to the applier.', 'APPLY_REQUEST_FAILED');
    }
  }
}
