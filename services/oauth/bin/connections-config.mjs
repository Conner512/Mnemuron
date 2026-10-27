#!/usr/bin/env node
// Owner connections from the command line (mnemuron-config connections ...): the same changes as the console's
// connection page, logged as configuration changes with source 'cli' so the console shows them and refreshes. Runs on
// the server as the OAuth service user; a new token or client secret is printed once, never stored here.
import os from 'node:os';
import {loadAuthConfig} from '../src/config.mjs';
import {AuthStore} from '../src/sqlite-adapter.mjs';
import {IdentityRepository} from '../src/identity-repository.mjs';
import {requireConfig} from '../../../shared/oauth-common.mjs';

const USAGE = `Usage: mnemuron-config connections <command> [--json] [--actor NAME]
  list                         connections (ID prefix, label, agent, access, state, version)
  history [--limit N]          connection changes from the console and the CLI
  create --agent A --label L [--access read|read_write] [--redirect-uri URL]
                               agents: chatgpt, claude-code, codex, cursor, muse, other
  rename ID --label L [--description D]
  access ID read|read_write    change what the connection may do (issues new credentials)
  disable ID | enable ID | rotate ID | revoke ID
ID is the connection ID or a unique prefix of at least 6 characters (as list shows it).`;

const argv = process.argv.slice(2), flags = {}, rest = [];
for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) { const key = argv[i].slice(2); const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; flags[key] ??= value; } else rest.push(argv[i]); }
if (!rest.length || flags.help) { process.stdout.write(USAGE + '\n'); process.exit(rest.length ? 0 : 2); }

const config = loadAuthConfig(process.env.MNEMURON_OAUTH_CONFIG || '/etc/mnemuron-oauth/auth.runtime.json', {isolated: flags['isolated-fixture'] === true});
requireConfig(config.identity_mode === 'multi_account_v1', 'multi-account mode');
const store = new AuthStore(config.database_file, {identity: true});
const ids = new IdentityRepository(store, {keyFile: config.identity.encryption_key_file, issuer: config.issuer, batchLimit: config.identity.invitation_batch_limit, sessionTtl: config.identity.console_session_ttl_seconds});
ids.connections.config = config;
const actor = `cli:${typeof flags.actor === 'string' ? flags.actor : os.userInfo().username}`;
const PROFILE = {read: 'readonly', read_write: 'memory_readwrite'};

try {
  const account = config.identity.owner_account_id;
  if (!account) throw new Error('No owner account (identity.owner_account_id).');
  const c = ids.connections, [command, target] = rest, id = () => c.resolve(account, target);
  const change = (action, p) => c.operatorChange(account, action, p, actor);
  let result;
  if (command === 'list') result = c.snapshot(account);
  else if (command === 'history') result = c.history(account, Number(flags.limit || 30));
  else if (command === 'create') {
    const agent = flags.agent, kind = agent === 'chatgpt' ? 'chatgpt_oauth' : 'generic_mcp';
    result = change('connections.create', {kind, agent, label: flags.label, profile: PROFILE[flags.access || 'read'], ...(typeof flags['redirect-uri'] === 'string' ? {redirect_uri: flags['redirect-uri']} : {})});
  }
  else if (command === 'rename') result = change('connections.update', {connection_id: id(), label: flags.label, ...(typeof flags.description === 'string' ? {description: flags.description} : {})});
  else if (command === 'access') { if (!PROFILE[rest[2]]) throw new Error('access ID read|read_write'); result = change('connections.update', {connection_id: id(), profile: PROFILE[rest[2]]}); }
  else if (['disable', 'enable', 'rotate', 'revoke'].includes(command)) result = change(`connections.${command}`, {connection_id: id()});
  else throw new Error(`Unknown command ${command}.`);
  if (result?.secret) process.stderr.write(`New ${result.secret_kind === 'personal_token' ? 'token' : 'client secret'}: shown once, store it now.\n`);
  if (flags.json || Array.isArray(result) || result?.connection) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else for (const [key, value] of Object.entries(result)) process.stdout.write(`${key} = ${JSON.stringify(value)}\n`);
} catch (error) {
  const code = error.code || error.errorCode;
  process.stderr.write(`${code && code !== error.message ? `${code}: ` : ''}${error.message}\n`);
  process.exitCode = 1;
} finally { store.close(); }
