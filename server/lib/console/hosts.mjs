// Host records (/etc/hosts) for the owner, managed from the console and mnemuron-config. The records are kept here and
// written to the server's /etc/hosts by a root applier (bin/mnemuron-hosts-apply.mjs, started by a path unit when the
// request file changes), so every process on the server, model requests included, resolves them. Lines Proxmox manages
// (between its BEGIN/END PVE markers) are left alone and not shown. Other existing lines are shown as the server's; editing
// or deleting one takes it over: the applier removes the old line and writes the record in Mnemuron's own block.
// Model requests also use a record directly (before it reaches the file) and pin the socket to it; HTTPS still verifies
// the certificate for the hostname. A record pointing at a private or loopback address is the owner's approval to reach
// it for that hostname; link-local, metadata and reserved addresses are refused.
import fs from 'node:fs';
import path from 'node:path';
import {isIP} from 'node:net';
import {ValidationError, NotFoundError, ConflictError} from '../errors.mjs';
import {addressClass} from '../model-providers/transport.mjs';

export const MAX_HOSTS = 50;
export const PVE_BEGIN = '# --- BEGIN PVE ---', PVE_END = '# --- END PVE ---';
export const OWN_BEGIN = '# --- BEGIN MNEMURON (managed from the Mnemuron console) ---', OWN_END = '# --- END MNEMURON ---';
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED = new Set(['localhost', 'ip6-localhost', 'ip6-loopback', 'ip6-allnodes', 'ip6-allrouters']);

export function normalizeHost(value) {
  const host = typeof value === 'string' ? value.trim().toLowerCase().replace(/\.$/, '') : '';
  if (!HOSTNAME.test(host) || isIP(host) || !/[a-z]/.test(host)) throw new ValidationError('Use a hostname such as api.example.com.', 'INVALID_HOSTNAME');
  if (RESERVED.has(host)) throw new ValidationError('System names cannot be changed here.', 'HOST_RESERVED');
  return host;
}
export function normalizeAddress(value) {
  const address = typeof value === 'string' ? value.trim().toLowerCase().replace(/^\[|\]$/g, '') : '';
  if (!isIP(address)) throw new ValidationError('Use an IPv4 or IPv6 address.', 'INVALID_HOST_ADDRESS');
  if (addressClass(address) === 'denied') throw new ValidationError('Link-local, metadata and reserved addresses are not allowed.', 'HOST_ADDRESS_DENIED');
  return address;
}

/** Parse a host file into its sections: Proxmox's block, Mnemuron's block and everything else ("system"). */
export function parseHosts(text) {
  const out = {pve: [], own: [], system: []};
  let section = 'system';
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (trimmed === PVE_BEGIN) { section = 'pve'; continue; } if (trimmed === PVE_END) { section = 'system'; continue; }
    if (trimmed === OWN_BEGIN) { section = 'own'; continue; } if (trimmed === OWN_END) { section = 'system'; continue; }
    const [address, ...names] = line.replace(/#.*/, '').trim().split(/\s+/);
    if (!address || !isIP(address)) continue;
    for (const raw of names) { const name = raw.toLowerCase(); if (name && /[a-z]/.test(name)) out[section].push({hostname: name, address: address.toLowerCase()}); }
  }
  return out;
}
/** Entries a person would recognise as theirs: not loopback, multicast or the standard localhost names. */
const visible = h => !RESERVED.has(h.hostname) && !/^(127\.|::1$|ff0|fe80)/i.test(h.address);
/** The server's own entries outside Proxmox's and Mnemuron's blocks, as shown read-write in the console. */
export function systemHosts(file) {
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const seen = new Set();
  return parseHosts(text).system.filter(h => visible(h) && !seen.has(h.hostname) && seen.add(h.hostname)).slice(0, 200);
}

export class ConsoleHosts {
  constructor(store, {hostsFile = process.env.MNEMURON_HOSTS_FILE || '/etc/hosts'} = {}) {
    this.store = store; this.db = store.db; this.hostsFile = hostsFile;
    // state: 'active' records are written to the file; 'removed' marks a name whose old line the applier must drop.
    this.db.exec(`CREATE TABLE IF NOT EXISTS console_hosts(user_id TEXT NOT NULL, hostname TEXT NOT NULL, address TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT, PRIMARY KEY(user_id, hostname));
      CREATE TABLE IF NOT EXISTS console_hosts_apply(id INTEGER PRIMARY KEY CHECK(id=1), desired_revision INTEGER NOT NULL DEFAULT 0,
      applied_revision INTEGER NOT NULL DEFAULT 0, apply_state TEXT, apply_error TEXT, applied_at TEXT);`);
    if (!this.db.prepare('PRAGMA table_info(console_hosts)').all().some(c => c.name === 'state')) this.db.exec("ALTER TABLE console_hosts ADD COLUMN state TEXT NOT NULL DEFAULT 'active'");
  }
  dir() { return path.join(path.dirname(this.store.databasePath), 'hosts'); }
  requestFile() { return path.join(this.dir(), 'apply.request'); }
  statusFile() { return path.join(this.dir(), 'apply.status'); }
  /** Only the owner's records go to the server file (single-owner deployments). */
  owner() { return this.store.consoleService?.owner?.user || null; }
  list(user) { return this.db.prepare("SELECT hostname,address,created_at,updated_at,updated_by FROM console_hosts WHERE user_id=? AND state='active' ORDER BY hostname").all(user); }
  removed(user) { return this.db.prepare("SELECT hostname FROM console_hosts WHERE user_id=? AND state='removed' ORDER BY hostname").all(user).map(r => r.hostname); }
  get(user, hostname) { return this.db.prepare("SELECT hostname,address FROM console_hosts WHERE user_id=? AND hostname=? AND state='active'").get(user, hostname) || null; }
  applyRow() { return this.db.prepare('SELECT * FROM console_hosts_apply WHERE id=1').get() || {desired_revision: 0, applied_revision: 0, apply_state: null, apply_error: null, applied_at: null}; }
  /** Read the applier's outcome for the newest request. */
  syncStatus() {
    let status; try { status = JSON.parse(fs.readFileSync(this.statusFile(), 'utf8')); } catch { return; }
    const row = this.applyRow();
    if (!Number.isInteger(status?.revision) || status.revision > row.desired_revision || status.revision < row.applied_revision) return;
    if (status.revision === row.applied_revision && status.state === row.apply_state) return;
    this.db.prepare('UPDATE console_hosts_apply SET applied_revision=?,apply_state=?,apply_error=?,applied_at=? WHERE id=1')
      .run(status.revision, status.state, status.error || null, status.at || null);
  }
  /** Records, the server's other entries, and whether the newest change has reached the file. */
  view(user) {
    this.syncStatus();
    const own = this.list(user), mine = new Set([...own.map(h => h.hostname), ...this.removed(user)]), a = this.applyRow();
    return {records: own, system: systemHosts(this.hostsFile).filter(h => !mine.has(h.hostname)),
      apply: {writes_file: this.owner() === user, revision: a.desired_revision, pending: a.desired_revision > a.applied_revision, state: a.apply_state, error: a.apply_error, applied_at: a.applied_at}};
  }
  /** Add or change a record (also one that so far only existed in the server file: it is taken over). */
  set(user, {hostname, address}, actor) {
    const host = normalizeHost(hostname), ip = normalizeAddress(address), at = new Date().toISOString();
    const result = this.store.memoryTransaction(() => {
      const existing = this.get(user, host);
      if (!existing && this.db.prepare("SELECT COUNT(*) n FROM console_hosts WHERE user_id=? AND state='active'").get(user).n >= MAX_HOSTS) throw new ConflictError(`At most ${MAX_HOSTS} host records.`, 'HOST_LIMIT');
      this.db.prepare(`INSERT INTO console_hosts(user_id,hostname,address,created_at,updated_at,updated_by,state) VALUES(?,?,?,?,?,?,'active')
        ON CONFLICT(user_id,hostname) DO UPDATE SET address=excluded.address,updated_at=excluded.updated_at,updated_by=excluded.updated_by,state='active'`).run(user, host, ip, at, at, actor || null);
      return {status: existing ? 'updated' : 'added', host: {hostname: host, address: ip}};
    });
    this.requestApply(user);
    return result;
  }
  /** Remove a record, or a line that so far only existed in the server file. */
  remove(user, hostname, actor) {
    const host = normalizeHost(hostname), at = new Date().toISOString();
    this.store.memoryTransaction(() => {
      const known = this.get(user, host) || systemHosts(this.hostsFile).some(h => h.hostname === host);
      if (!known) throw new NotFoundError('Host record not found.', 'HOST_NOT_FOUND');
      this.db.prepare(`INSERT INTO console_hosts(user_id,hostname,address,created_at,updated_at,updated_by,state) VALUES(?,?,'',?,?,?,'removed')
        ON CONFLICT(user_id,hostname) DO UPDATE SET address='',updated_at=excluded.updated_at,updated_by=excluded.updated_by,state='removed'`).run(user, host, at, at, actor || null);
    });
    this.requestApply(user);
    return {status: 'removed', hostname: host};
  }
  /** Hand the owner's records to the root applier: the full desired set plus names whose old lines must go. */
  requestApply(user) {
    if (this.owner() !== user) return;
    const revision = this.store.memoryTransaction(() => {
      this.db.prepare("INSERT INTO console_hosts_apply(id,desired_revision,apply_state) VALUES(1,1,'pending') ON CONFLICT(id) DO UPDATE SET desired_revision=desired_revision+1,apply_state='pending',apply_error=NULL").run();
      return this.applyRow().desired_revision;
    });
    const file = this.requestFile();
    try {
      fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({version: 1, revision, hosts: this.list(user).map(({hostname, address}) => ({hostname, address})), remove: this.removed(user)}) + '\n', {mode: 0o600});
      fs.renameSync(tmp, file);
    } catch {
      throw new ConflictError('The host change was saved but could not be handed to the applier.', 'APPLY_REQUEST_FAILED');
    }
  }
  /** Addresses for a model request: the record when there is one, otherwise DNS (dns.lookup shape). */
  async resolve(user, hostname, lookup) {
    const record = this.get(user, String(hostname).toLowerCase());
    return record ? [{address: record.address, family: isIP(record.address)}] : lookup(hostname, {all: true, verbatim: true});
  }
  /** True when a record points the hostname at a private or loopback address (the owner's approval to reach it). */
  privateRecord(user, hostname) { const record = this.get(user, String(hostname).toLowerCase()); return !!record && addressClass(record.address) === 'private'; }
}

/** The new host file: Proxmox's block and unrelated lines kept; lines for managed or removed names dropped; the
 * records written in Mnemuron's block. Pure, shared by the applier and its tests. */
export function renderHosts(text, {hosts, remove}) {
  const managed = new Set([...hosts.map(h => h.hostname), ...remove]), lines = String(text).split('\n'), out = [];
  let section = 'system';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === OWN_BEGIN) { section = 'own'; continue; } if (trimmed === OWN_END) { section = 'system'; continue; }
    if (section === 'own') continue;
    if (trimmed === PVE_BEGIN) section = 'pve'; else if (trimmed === PVE_END) { out.push(line); section = 'system'; continue; }
    if (section === 'pve') { out.push(line); continue; }
    const [address, ...names] = line.replace(/#.*/, '').trim().split(/\s+/);
    if (!address || !isIP(address) || !names.some(n => managed.has(n.toLowerCase()))) { out.push(line); continue; }
    // Drop only the managed names; a line naming other hosts too keeps them.
    const rest = names.filter(n => !managed.has(n.toLowerCase()));
    if (rest.length) out.push(`${address}\t${rest.join(' ')}`);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  if (hosts.length) out.push(OWN_BEGIN, ...hosts.map(h => `${h.address}\t${h.hostname}`), OWN_END);
  return out.join('\n') + '\n';
}
