// Custom host records for model requests (HOSTS-01..04). A synthetic loopback "relay" and a resolver that must not be
// called: the record, not DNS, decides where the model request goes. No real provider or key.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {randomBytes, randomUUID} from 'node:crypto';
import {memoryFixture} from './helpers/core-memory-fixture.mjs';
import {CONSOLE_WRITE_SCOPES} from '../../shared/console-contract.mjs';
import {MAX_HOSTS} from '../lib/console/hosts.mjs';

async function setup(t) {
  const f = await memoryFixture(t), key = f.root + '/hosts.key'; fs.writeFileSync(key, randomBytes(32).toString('base64url'), {mode: 0o600});
  const calls = [];
  const relay = http.createServer((req, res) => { calls.push({url: req.url, host: req.headers.host}); res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({object: 'list', data: [{id: 'synthetic-relayed'}]})); });
  await new Promise(r => relay.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => { relay.closeAllConnections(); relay.close(r); }));
  // No operator-approved private origins: only a host record can make the loopback relay reachable.
  f.store.memoryConfig.console = {key_file: key, worker_enabled: false};
  const issue = user => { const c = f.store.issueCredential({userId: user, deviceId: 'synthetic-hosts', agentId: 'mnemuron-console', agentInstanceId: randomUUID(), scopes: CONSOLE_WRITE_SCOPES}); return f.store.authenticate(c.api_key); };
  const a = issue(f.a.user_id), b = issue(f.other.auth.user_id), service = f.store.consoleService, models = service.models;
  let dnsCalls = 0; models.lookup = async () => { dnsCalls++; throw new Error('DNS must not be used'); };
  const act = (action, payload, auth = a) => service.execute(auth, {action, payload, operation_id: randomUUID()});
  const base = `http://relay.synthetic.test:${relay.address().port}/v1`;
  const discover = (auth = a) => act('models.discover', {kind: 'organizer', expected_revision: 0, protocol: 'openai_compatible', base_url: base, key_source: 'none', consent: true}, auth);
  return {...f, a, b, service, models, act, base, discover, calls, dns: () => dnsCalls};
}
const code = expected => error => { assert.equal(error.errorCode || error.code, expected, error.message); return true; };

test('HOSTS-01: records are validated; reserved addresses, IPs as names and too many records are refused', async t => {
  const f = await setup(t);
  for (const [hostname, address, expected] of [['not a host', '10.0.0.2', 'INVALID_HOSTNAME'], ['10.0.0.1', '10.0.0.2', 'INVALID_HOSTNAME'], ['api.example.com', 'nope', 'INVALID_HOST_ADDRESS'],
    ['api.example.com', '169.254.169.254', 'HOST_ADDRESS_DENIED'], ['api.example.com', '0.0.0.0', 'HOST_ADDRESS_DENIED'], ['api.example.com', '::ffff:127.0.0.1', 'HOST_ADDRESS_DENIED']])
    await assert.rejects(f.act('hosts.set', {hostname, address}), code(expected), `${hostname} ${address}`);
  const r = await f.act('hosts.set', {hostname: ' API.Example.com. ', address: '192.168.1.20'});
  assert.deepEqual(r.host, {hostname: 'api.example.com', address: '192.168.1.20'}, 'names are normalised');
  await f.act('hosts.set', {hostname: 'api.example.com', address: '192.168.1.21'});
  assert.deepEqual(f.models.hosts.list(f.a.user_id).map(h => [h.hostname, h.address]), [['api.example.com', '192.168.1.21']], 'saving again changes the record');
  for (let i = 1; i < MAX_HOSTS; i++) f.models.hosts.set(f.a.user_id, {hostname: `h${i}.example.com`, address: '10.0.0.1'}, 'test');
  await assert.rejects(f.act('hosts.set', {hostname: 'one-more.example.com', address: '10.0.0.1'}), code('HOST_LIMIT'));
  await f.act('hosts.remove', {hostname: 'api.example.com'});
  await assert.rejects(f.act('hosts.remove', {hostname: 'api.example.com'}), code('HOST_NOT_FOUND'));
});

test('HOSTS-02: a model request goes to the recorded address without DNS; a private record also allows HTTP for that name', async t => {
  const f = await setup(t);
  await assert.rejects(f.discover(), code('MODEL_URL_DENIED'), 'without a record, plain HTTP to an unknown host is refused');
  await f.act('hosts.set', {hostname: 'relay.synthetic.test', address: '127.0.0.1'});
  const listed = await f.discover();
  assert.deepEqual(listed.models.map(m => m.id ?? m), ['synthetic-relayed']);
  assert.equal(f.calls.length, 1); assert.match(f.calls[0].host, /^relay\.synthetic\.test:\d+$/, 'the request still names the host');
  assert.equal(f.dns(), 0, 'DNS was never asked');
  const saved = await f.act('models.save', {kind: 'organizer', expected_revision: 0, config: {enabled: true, protocol: 'openai_compatible', base_url: f.base, model: 'synthetic-model', profile_revision: '1', daily_requests: 10, output_tokens: 4096, batch_size: 5, egress_approved: true, query_approved: true}});
  assert.equal(saved.model.config.base_url, f.base, 'a model can be saved on the relayed address');
});

test('HOSTS-03: records belong to one account; another account\'s request is not redirected', async t => {
  const f = await setup(t);
  await f.act('hosts.set', {hostname: 'relay.synthetic.test', address: '127.0.0.1'});
  await assert.rejects(f.discover(f.b), code('MODEL_URL_DENIED'));
  assert.deepEqual(f.models.hosts.list(f.other.auth.user_id), []);
  assert.equal(f.calls.length, 0);
});

test('HOSTS-04: console and CLI changes to records are logged as configuration and seen by both sides', async t => {
  const f = await setup(t), user = f.a.user_id;
  const {migrateOwner, OwnerControls} = await import('../lib/console/owner.mjs');
  f.store.memoryConfig.console = {...f.store.memoryConfig.console, owner_user_id: user};
  f.store.memoryTransaction(() => migrateOwner(f.store.db, user, {memory: true, capture: false, handoff: false, connections: true}));
  f.service.owner = new OwnerControls(f.service);
  await f.act('hosts.set', {hostname: 'relay.synthetic.test', address: '127.0.0.1'});
  f.store.config.hostSet(user, 'relay.synthetic.test', '10.0.0.5', 'cli:test');
  assert.equal(f.store.config.snapshot(user)['hosts.relay.synthetic.test'], '10.0.0.5');
  f.store.config.hostRemove(user, 'relay.synthetic.test', 'cli:test');
  assert.deepEqual(f.store.config.history(user).filter(h => h.key === 'hosts.relay.synthetic.test').map(h => [h.source, h.old, h.new]).reverse(),
    [['web', null, '127.0.0.1'], ['cli', '127.0.0.1', '10.0.0.5'], ['cli', '10.0.0.5', null]]);
});

const PVE_FILE = '127.0.0.1\tlocalhost\n::1\t\tlocalhost ip6-localhost ip6-loopback\nff02::1\t\tip6-allnodes\n# --- BEGIN PVE ---\n10.0.0.31 console.synthetic.test console\n# --- END PVE ---\n10.0.0.52 relay.synthetic.test # relay\n10.0.0.9 a.synthetic.test b.synthetic.test\n';

test('HOSTS-05: the server\'s other entries are listed; Proxmox\'s block, localhost lines and names taken over are not', async t => {
  const f = await setup(t), file = f.root + '/etc-hosts';
  fs.writeFileSync(file, PVE_FILE); f.models.hosts.hostsFile = file;
  assert.deepEqual(f.models.hosts.view(f.a.user_id).system.map(h => [h.hostname, h.address]), [['relay.synthetic.test', '10.0.0.52'], ['a.synthetic.test', '10.0.0.9'], ['b.synthetic.test', '10.0.0.9']]);
  await f.act('hosts.set', {hostname: 'relay.synthetic.test', address: '127.0.0.1'});
  await f.act('hosts.remove', {hostname: 'a.synthetic.test'});
  const v = f.models.hosts.view(f.a.user_id);
  assert.deepEqual(v.records.map(h => h.hostname), ['relay.synthetic.test'], 'a removed line is not a record');
  assert.deepEqual(v.system.map(h => h.hostname), ['b.synthetic.test'], 'taken-over and removed names leave the system list');
  await assert.rejects(f.act('hosts.remove', {hostname: 'nowhere.synthetic.test'}), code('HOST_NOT_FOUND'));
  await assert.rejects(f.act('hosts.set', {hostname: 'localhost', address: '10.0.0.1'}), code('HOST_RESERVED'));
  f.models.hosts.hostsFile = f.root + '/missing'; assert.deepEqual(f.models.hosts.view(f.a.user_id).system, [], 'no host file: nothing listed');
});

test('HOSTS-06: rewriting the host file keeps Proxmox\'s block and unrelated lines, drops taken-over names and writes the records', async () => {
  const {renderHosts} = await import('../lib/console/hosts.mjs');
  const once = renderHosts(PVE_FILE, {hosts: [{hostname: 'relay.synthetic.test', address: '127.0.0.1'}, {hostname: 'new.synthetic.test', address: '10.0.0.7'}], remove: ['a.synthetic.test']});
  assert.match(once, /# --- BEGIN PVE ---\n10\.0\.0\.31 console\.synthetic\.test console\n# --- END PVE ---/);
  assert.doesNotMatch(once, /10\.0\.0\.52/, 'the old relay line is gone');
  assert.match(once, /^10\.0\.0\.9\tb\.synthetic\.test$/m, 'a line naming other hosts keeps them');
  assert.match(once, /# --- BEGIN MNEMURON \(managed from the Mnemuron console\) ---\n127\.0\.0\.1\trelay\.synthetic\.test\n10\.0\.0\.7\tnew\.synthetic\.test\n# --- END MNEMURON ---\n$/);
  assert.equal(renderHosts(once, {hosts: [{hostname: 'relay.synthetic.test', address: '127.0.0.1'}, {hostname: 'new.synthetic.test', address: '10.0.0.7'}], remove: ['a.synthetic.test']}), once, 'applying again changes nothing');
  assert.doesNotMatch(renderHosts(once, {hosts: [], remove: ['relay.synthetic.test', 'new.synthetic.test', 'a.synthetic.test']}), /MNEMURON|relay|new\.synthetic/, 'no records: no block');
});

test('HOSTS-07: the owner\'s changes reach the host file through the applier, which validates again and reports back', async t => {
  const f = await setup(t), user = f.a.user_id, file = f.root + '/etc-hosts';
  const {migrateOwner, OwnerControls} = await import('../lib/console/owner.mjs');
  f.store.memoryConfig.console = {...f.store.memoryConfig.console, owner_user_id: user};
  f.store.memoryTransaction(() => migrateOwner(f.store.db, user, {memory: true, capture: false, handoff: false, connections: true}));
  f.service.owner = new OwnerControls(f.service);
  fs.writeFileSync(file, PVE_FILE, {mode: 0o644}); f.models.hosts.hostsFile = file;
  const {spawnSync} = await import('node:child_process'), {fileURLToPath} = await import('node:url');
  const applier = fileURLToPath(new URL('../bin/mnemuron-hosts-apply.mjs', import.meta.url));
  const run = () => spawnSync(process.execPath, [applier], {env: {...process.env, MNEMURON_HOSTS_DIR: f.models.hosts.dir(), MNEMURON_HOSTS_FILE: file}, encoding: 'utf8'});
  await f.act('hosts.set', {hostname: 'relay.synthetic.test', address: '10.0.0.8'});
  assert.equal(f.models.hosts.view(user).apply.pending, true);
  assert.equal(run().status, 0);
  assert.match(fs.readFileSync(file, 'utf8'), /^10\.0\.0\.8\trelay\.synthetic\.test$/m);
  assert.equal(fs.statSync(file).mode & 0o777, 0o644, 'the file keeps its mode');
  const v = f.models.hosts.view(user).apply; assert.deepEqual([v.pending, v.state], [false, 'applied']);
  // A request edited to carry a reserved address is refused by the applier and the file is left alone.
  const before = fs.readFileSync(file, 'utf8'), req = JSON.parse(fs.readFileSync(f.models.hosts.requestFile(), 'utf8'));
  f.store.db.prepare('UPDATE console_hosts_apply SET desired_revision=desired_revision+1').run();
  fs.writeFileSync(f.models.hosts.requestFile(), JSON.stringify({...req, revision: req.revision + 1, hosts: [{hostname: 'evil.synthetic.test', address: '169.254.169.254'}]}));
  assert.equal(run().status, 1); assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual([f.models.hosts.view(user).apply.state, f.models.hosts.view(user).apply.error], ['failed', 'HOST_ADDRESS_DENIED']);
});
