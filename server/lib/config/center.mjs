// Configuration center: one view of the owner's settings for the console and the CLI (bin/mnemuron-config.mjs).
// The database is the single source of truth and both sides change it through the same service functions (owner
// switches and schedule, models and their call limits, host records, agent keys, tunnels), so validation and side effects match. Every change is logged with its source
// ('web' or 'cli') and actor; secrets are logged by fingerprint only. The console polls the snapshot fingerprint and
// refreshes when a change came from elsewhere. Infrastructure settings stay in the runtime file and are read-only here.
import {createHash} from 'node:crypto';
import {ValidationError, ConflictError} from '../errors.mjs';
import {OWNER_FLAGS} from '../console/owner.mjs';
import {credentialView} from '../console/credentials.mjs';
import {CONSOLE_WRITE_SCOPES} from '../../../shared/console-contract.mjs';

const SCHEDULE_FIELDS = ['enabled', 'interval_minutes', 'max_items', 'budget'];
const MODEL_FIELDS = {enabled: 'boolean', protocol: 'string', base_url: 'string', model: 'string', profile_revision: 'string', dimensions: 'integer', daily_requests: 'integer',
  output_tokens: 'integer', batch_size: 'integer', egress_approved: 'boolean', query_approved: 'boolean', native_schema: 'boolean'};
const limit = value => value === 'none' || value === null ? null : Number(value);
const parseBool = value => { if (value === true || value === 'true' || value === 'on' || value === '1') return true; if (value === false || value === 'false' || value === 'off' || value === '0') return false; throw new ValidationError('Use on or off.', 'INVALID_CONFIG_VALUE'); };

/** Settings the CLI can change, with how. Everything else in the snapshot is read-only here. */
export const CONFIG_KEYS = Object.freeze([
  ...OWNER_FLAGS.map(flag => ({key: `feature.${flag}`, type: 'boolean'})),
  {key: 'search.default_mode', type: 'enum', values: ['lexical', 'hybrid', 'semantic']},
  {key: 'chatgpt.read_policy', type: 'enum', values: ['chatgpt_per_memory_v1', 'active_uniform_v1']},
  {key: 'schedule.enabled', type: 'boolean'}, {key: 'schedule.interval_minutes', type: 'integer'},
  {key: 'schedule.max_items', type: 'integer'}, {key: 'schedule.budget', type: 'integer'},
]);

export class ConfigCenter {
  constructor(store) {
    this.store = store; this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS config_changes(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, key TEXT NOT NULL,
      old_json TEXT, new_json TEXT, source TEXT NOT NULL, actor TEXT, at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS config_changes_user ON config_changes(user_id, id DESC);`);
  }
  get owner() { return this.store.consoleService.owner; }
  get tunnel() { return this.store.tunnel; }
  /** Current values by key. Secrets appear as fingerprints; models without their keys. */
  snapshot(user) {
    const out = {};
    if (this.owner?.user === user) {
      const policy = this.owner.policy(), preferences = this.owner.preferences();
      for (const flag of OWNER_FLAGS) out[`feature.${flag}`] = policy.flags[flag] === true;
      out['search.default_mode'] = preferences.retrieval_mode; out['chatgpt.read_policy'] = preferences.read_policy;
      for (const field of SCHEDULE_FIELDS) out[`schedule.${field}`] = policy.schedule?.[field] ?? null;
      out['schedule.kinds'] = policy.schedule?.kinds || [];
    }
    const models = this.store.consoleService.models;
    for (const m of models.list(user)) {
      const {sensitivities, ...config} = m.config;
      out[`models.${m.kind}`] = {...config, key: m.has_key, revision: m.revision};
      const q = models.quotas.setting(user, m.kind);
      out[`models.${m.kind}.quota`] = q ? {daily: q.daily_limit, total: q.total_limit} : 'default';
    }
    for (const h of models.hosts.list(user)) out[`hosts.${h.hostname}`] = h.address;
    // Agent keys: active, unmanaged ones only (the console's own login keys come and go), by agent instance; a
    // rotation shows as a new credential ID.
    for (const row of this.db.prepare('SELECT credential_id,label,device_id,agent_id,agent_instance_id,scopes_json,revoked_at,expires_at FROM credentials WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at').all(user)) {
      const c = credentialView(row);
      if (c.state === 'active' && !c.managed) out[`agents.${c.agent_instance_id}`] = {label: c.label, agent: c.agent_id, device: c.device_id, access: c.scopes.includes('memory:write') ? 'read_write' : 'read', credential: c.credential_id};
    }
    if (this.tunnel) for (const t of this.tunnel.list()) { out[`tunnel.${t.id}.name`] = t.name; out[`tunnel.${t.id}.token`] = t.token_fingerprint; out[`tunnel.${t.id}.tunnel_id`] = t.tunnel_id; out[`tunnel.${t.id}.apply_state`] = t.apply_state; }
    return out;
  }
  fingerprint(user) { return createHash('sha256').update(JSON.stringify(this.snapshot(user))).digest('hex').slice(0, 16); }
  /** Run a change and log every key it altered. Works for sync and async changes. */
  track(user, source, actor, change) {
    const before = this.snapshot(user), finish = result => { this.diff(user, before, this.snapshot(user), source, actor); return result; };
    const result = change();
    return result && typeof result.then === 'function' ? result.then(finish) : finish(result);
  }
  diff(user, before, after, source, actor) {
    const at = new Date().toISOString(), insert = this.db.prepare('INSERT INTO config_changes(user_id,key,old_json,new_json,source,actor,at) VALUES(?,?,?,?,?,?,?)');
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) insert.run(user, key, JSON.stringify(before[key] ?? null), JSON.stringify(after[key] ?? null), source, actor || null, at);
  }
  /** Changes that are not snapshot values (tunnel hostnames live at Cloudflare). */
  log(user, key, oldValue, newValue, source, actor) {
    this.db.prepare('INSERT INTO config_changes(user_id,key,old_json,new_json,source,actor,at) VALUES(?,?,?,?,?,?,?)')
      .run(user, key, JSON.stringify(oldValue ?? null), JSON.stringify(newValue ?? null), source, actor || null, new Date().toISOString());
  }
  history(user, {limit = 50, after = 0} = {}) {
    return this.db.prepare('SELECT id,key,old_json,new_json,source,actor,at FROM config_changes WHERE user_id=? AND id>? ORDER BY id DESC LIMIT ?').all(user, after, Math.min(Math.max(limit, 1), 200))
      .map(({old_json, new_json, ...r}) => ({...r, old: JSON.parse(old_json), new: JSON.parse(new_json)}));
  }
  state(user) { const last = this.db.prepare('SELECT max(id) id FROM config_changes WHERE user_id=?').get(user).id || 0; return {fingerprint: this.fingerprint(user), last_change_id: last, latest: this.history(user, {limit: 5})}; }
  /** The owner's newest console credential, so CLI schedule changes keep a runnable automatic rule. */
  consoleCredential(user) { return this.db.prepare("SELECT credential_id FROM credentials WHERE user_id=? AND agent_id='mnemuron-console' AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1").get(user)?.credential_id || null; }
  /** Who a CLI change is made as: the owner, through their console credential, named mnemuron-config in the audit. */
  cliAuth(user) { return {user_id: user, credential_id: this.consoleCredential(user), agent_id: 'mnemuron-config', agent_instance_id: 'mnemuron-config', device_id: 'cli', scopes: [...CONSOLE_WRITE_SCOPES]}; }
  /** CLI model change: fields merged into the stored configuration, then the console's own save (same validation). */
  modelSet(user, kind, changes, {apiKey, removeKey} = {}, actor) {
    const models = this.store.consoleService.models, row = models.raw(user, kind), config = row ? JSON.parse(row.config_json) : {enabled: false, protocol: 'openai_compatible', daily_requests: 100, output_tokens: 4096, batch_size: 5, egress_approved: false, query_approved: false, profile_revision: '1'};
    for (const [field, raw] of Object.entries(changes)) {
      const type = MODEL_FIELDS[field];
      if (!type) throw new ValidationError(`Unknown model field ${field}. Use ${Object.keys(MODEL_FIELDS).join(', ')}.`, 'INVALID_CONFIG_VALUE');
      config[field] = type === 'boolean' ? parseBool(raw) : type === 'integer' ? Number(raw) : String(raw);
      if (type === 'integer' && !Number.isInteger(config[field])) throw new ValidationError(`${field} must be a whole number.`, 'INVALID_CONFIG_VALUE');
    }
    const p = {kind, expected_revision: row?.revision || 0, config, ...(apiKey ? {api_key: apiKey} : {}), ...(removeKey ? {remove_key: true} : {})};
    return this.track(user, 'cli', actor, () => models.save(this.cliAuth(user), p));
  }
  /** CLI call limits: a number, or none for no limit. */
  modelQuota(user, kind, {daily, total}, actor) {
    const quotas = this.store.consoleService.models.quotas, current = quotas.setting(user, quotas.kind(kind));
    const p = {kind, expected_revision: current?.revision || 0, daily_limit: daily === undefined ? current?.daily_limit ?? null : limit(daily), total_limit: total === undefined ? current?.total_limit ?? null : limit(total)};
    return this.track(user, 'cli', actor, () => quotas.save(this.cliAuth(user), p));
  }
  /** CLI host records for model requests (console hosts.mjs). */
  hostSet(user, hostname, address, actor) { return this.track(user, 'cli', actor, () => this.store.consoleService.models.hosts.set(user, {hostname, address}, actor)); }
  hostRemove(user, hostname, actor) { return this.track(user, 'cli', actor, () => this.store.consoleService.models.hosts.remove(user, hostname, actor)); }
  /** CLI revoke of an agent's keys: the console's own revoke (managed keys are refused there). */
  agentRevoke(user, instance, actor) { return this.track(user, 'cli', actor, () => this.store.consoleService.apply(this.cliAuth(user), 'devices.revoke', {agent_instance_id: instance})); }
  /** CLI write: the same owner functions the console calls. */
  set(user, key, raw, actor) {
    const spec = CONFIG_KEYS.find(k => k.key === key);
    if (!spec) throw new ValidationError(`${key} cannot be changed here.`, 'CONFIG_READ_ONLY');
    if (this.owner?.user !== user) throw new ConflictError('Owner mode is not configured.', 'OWNER_REQUIRED');
    const value = spec.type === 'boolean' ? parseBool(raw) : spec.type === 'integer' ? Number(raw) : String(raw);
    if (spec.type === 'integer' && !Number.isInteger(value)) throw new ValidationError('A whole number is required.', 'INVALID_CONFIG_VALUE');
    if (spec.type === 'enum' && !spec.values.includes(value)) throw new ValidationError(`Use one of ${spec.values.join(', ')}.`, 'INVALID_CONFIG_VALUE');
    const credential = this.consoleCredential(user);
    return this.track(user, 'cli', actor, () => {
      const policy = this.owner.policy();
      if (key.startsWith('feature.')) return this.owner.save(user, {expected_revision: policy.revision, flags: {[key.slice(8)]: value}}, credential);
      if (key === 'search.default_mode') return this.owner.save(user, {expected_revision: policy.revision, flags: {}, retrieval_mode: value}, credential);
      if (key === 'chatgpt.read_policy') return this.owner.save(user, {expected_revision: policy.revision, flags: {}, read_policy: value}, credential);
      const s = policy.schedule || {}, next = {enabled: s.enabled === true, kinds: s.kinds || [], interval_minutes: s.interval_minutes || 60, max_items: s.max_items || 20, budget: s.budget || 100, [key.slice(9)]: value};
      return this.owner.schedule(user, {expected_revision: policy.revision, ...next}, credential);
    });
  }
}
