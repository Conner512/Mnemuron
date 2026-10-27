#!/usr/bin/env node
// Owner configuration from the command line: the same settings, validation and change log as the console
// (lib/config/center.mjs, lib/tunnel/settings.mjs). Changes made here show up in the console right away and console
// changes show up here; `history` lists both with their source. Run it as the service user (deploy/mnemuron-config wraps
// this), never as root, so the database files keep their owner.
import fs from 'node:fs';
import os from 'node:os';
import {MnemuronStore} from '../lib/store.mjs';
import {loadMemoryRuntimeFile} from '../lib/memory-runtime.mjs';
import {CONFIG_KEYS} from '../lib/config/center.mjs';

const USAGE = `Usage: mnemuron-config <command> [--json] [--actor NAME]
  list                         every setting with its value (secrets as fingerprints)
  get KEY                      one setting
  set KEY VALUE                change a setting (keys: see 'keys')
  keys                         settings that can be changed here
  history [--limit N]          recent changes from the console and the CLI
  models                       model settings (organizer, embedder) and call limits
  models set KIND FIELD VALUE [FIELD VALUE ...]   change model settings (enabled, base_url, model, ...)
  models key KIND --file F | --remove             set (from a file, or - for stdin) or remove a model API key
  models quota KIND [--daily N|none] [--total N|none]
  hosts                        host records (written to /etc/hosts) and the server's other entries
  hosts set HOST ADDRESS       add or change a record (an existing /etc/hosts line is taken over)
  hosts remove HOST            remove a record or an existing /etc/hosts line
  agents                       active agent keys by agent instance
  agents revoke INSTANCE       revoke an agent's keys (managed keys are refused)
  connections ...              agent connections (ChatGPT, MCP tokens): see mnemuron-config connections --help
  tunnel list                  every tunnel: connection, token fingerprint and apply state
  tunnel add --name N --file F add a tunnel (its token from a file, or - for stdin)
  tunnel set-token [--id ID] --file F   replace a tunnel's token (default: main)
  tunnel remove --id ID        stop and remove an added tunnel
  tunnel reapply [--id ID]     ask the applier to apply a tunnel's stored token again
Environment: MNEMURON_MEMORY_CONFIG (default /etc/mnemuron/memory-first.runtime.json), MNEMURON_DATABASE_PATH`;

const argv = process.argv.slice(2), flags = {}, rest = [];
for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) { const key = argv[i].slice(2); const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; flags[key] ??= value; } else rest.push(argv[i]); }
if (!rest.length || flags.help) { process.stdout.write(USAGE + '\n'); process.exit(rest.length ? 0 : 2); }
if (process.getuid?.() === 0) { process.stderr.write('Run as the service user (mnemuron-config wrapper), not root.\n'); process.exit(2); }

const configPath = process.env.MNEMURON_MEMORY_CONFIG || '/etc/mnemuron/memory-first.runtime.json';
const memoryConfig = loadMemoryRuntimeFile(configPath);
if (memoryConfig.console) memoryConfig.console.worker_enabled = false;
const databasePath = process.env.MNEMURON_DATABASE_PATH || memoryConfig.storage?.sqlite_path || '/var/lib/mnemuron/mnemuron.sqlite3';
const store = new MnemuronStore(databasePath, {memoryConfig, memoryConfigPath: configPath});
const user = store.consoleService.owner.user;
const actor = `cli:${typeof flags.actor === 'string' ? flags.actor : os.userInfo().username}`;
const readSecret = file => { if (typeof file !== 'string') throw new Error('--file is required (a path, or - for stdin).'); return fs.readFileSync(file === '-' ? 0 : file, 'utf8').trim(); };
const show = value => typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);

try {
  if (!user) throw new Error('Owner mode is not configured (console.owner_user_id).');
  const [command, sub, ...args] = rest;
  let result;
  if (command === 'list') result = store.config.snapshot(user);
  else if (command === 'get') { const snapshot = store.config.snapshot(user); if (!(sub in snapshot)) throw new Error(`Unknown key ${sub}.`); result = {[sub]: snapshot[sub]}; }
  else if (command === 'set') { if (!sub || args[0] === undefined) throw new Error('set KEY VALUE'); store.config.set(user, sub, args[0], actor); result = {[sub]: store.config.snapshot(user)[sub]}; }
  else if (command === 'keys') result = Object.fromEntries(CONFIG_KEYS.map(k => [k.key, k.values ? k.values.join('|') : k.type]));
  else if (command === 'history') result = store.config.history(user, {limit: Number(flags.limit || 30)});
  else if (command === 'models') {
    const c = store.config, pick = () => Object.fromEntries(Object.entries(c.snapshot(user)).filter(([k]) => k.startsWith('models.')));
    if (!sub || sub === 'list') result = pick();
    else if (sub === 'set') { const [kind, ...pairs] = args; if (!kind || !pairs.length || pairs.length % 2) throw new Error('models set KIND FIELD VALUE [FIELD VALUE ...]');
      c.modelSet(user, kind, Object.fromEntries(Array.from({length: pairs.length / 2}, (_, i) => [pairs[2 * i], pairs[2 * i + 1]])), {}, actor); result = pick(); }
    else if (sub === 'key') { const [kind] = args; if (!kind) throw new Error('models key KIND --file F | --remove');
      c.modelSet(user, kind, {}, flags.remove ? {removeKey: true} : {apiKey: readSecret(flags.file)}, actor); result = pick(); }
    else if (sub === 'quota') { const [kind] = args; if (!kind) throw new Error('models quota KIND [--daily N|none] [--total N|none]');
      c.modelQuota(user, kind, {daily: flags.daily, total: flags.total}, actor); result = pick(); }
    else throw new Error(`Unknown models command ${sub}.`);
  }
  else if (command === 'hosts') {
    const c = store.config, pick = () => Object.fromEntries(Object.entries(c.snapshot(user)).filter(([k]) => k.startsWith('hosts.')));
    if (!sub || sub === 'list') { const v = store.consoleService.models.hosts.view(user); result = pick();
      for (const h of v.system) result[`system.${h.hostname}`] = `${h.address} (/etc/hosts)`;
      result.apply = v.apply.pending ? 'writing to /etc/hosts' : v.apply.state === 'failed' ? `failed: ${v.apply.error}` : v.apply.state === 'applied' ? `written ${v.apply.applied_at}` : '—'; }
    else if (sub === 'set') { if (!args[0] || !args[1]) throw new Error('hosts set HOST ADDRESS'); c.hostSet(user, args[0], args[1], actor); result = pick(); }
    else if (sub === 'remove') { if (!args[0]) throw new Error('hosts remove HOST'); c.hostRemove(user, args[0], actor); result = pick(); }
    else throw new Error(`Unknown hosts command ${sub}.`);
  }
  else if (command === 'agents') {
    const c = store.config, pick = () => Object.fromEntries(Object.entries(c.snapshot(user)).filter(([k]) => k.startsWith('agents.')));
    if (!sub || sub === 'list') result = pick();
    else if (sub === 'revoke') { if (!args[0]) throw new Error('agents revoke INSTANCE'); result = c.agentRevoke(user, args[0], actor); }
    else throw new Error(`Unknown agents command ${sub}.`);
  }
  else if (command === 'tunnel') {
    const t = store.tunnel, c = store.config;
    const id = typeof flags.id === 'string' ? flags.id : 'main';
    if (sub === 'list' || sub === 'status' || !sub) {
      result = await t.view();
      // One line per tunnel unless --json.
      if (!flags.json) result = Object.fromEntries(result.tunnels.map(x => [x.id, `${x.name} · ${x.state === 'removing' ? 'removing' : !x.connection?.reachable ? 'cloudflared unreachable' : x.connection.ready ? `connected (${x.connection.connections})` : 'not connected'}`
        + ` · token ${x.token_fingerprint || '—'} · tunnel ${x.tunnel_id || '—'} · ${x.apply_state || '—'}${x.apply_error ? ` ${x.apply_error}` : ''}${x.pending ? ' (pending)' : ''} · ${x.unit}`]));
    }
    else if (sub === 'add') result = c.track(user, 'cli', actor, () => t.add(user, {name: flags.name, token: readSecret(flags.file)}, actor));
    else if (sub === 'set-token') result = c.track(user, 'cli', actor, () => t.setToken(user, id, readSecret(flags.file), actor));
    else if (sub === 'reapply') result = c.track(user, 'cli', actor, () => t.reapply(id, actor));
    else if (sub === 'remove') result = c.track(user, 'cli', actor, () => t.remove(flags.id, actor));
    else throw new Error(`Unknown tunnel command ${sub}.`);
  } else throw new Error(`Unknown command ${command}.`);
  if (flags.json || typeof result !== 'object' || Array.isArray(result)) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else for (const [key, value] of Object.entries(result)) process.stdout.write(`${key} = ${show(value)}\n`);
} catch (error) {
  process.stderr.write(`${error.errorCode ? `${error.errorCode}: ` : ''}${error.message}\n`);
  process.exitCode = 1;
} finally { store.close(); }
