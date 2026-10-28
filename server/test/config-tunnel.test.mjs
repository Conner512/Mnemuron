import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID, randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture} from './helpers/memory-models.mjs';
import {OwnerControls, migrateOwner} from '../lib/console/owner.mjs';
import {CONSOLE_WRITE_SCOPES} from '../../shared/console-contract.mjs';
import {TunnelSettings, decodeTunnelToken} from '../lib/tunnel/settings.mjs';
import {sealWith} from '../lib/console/state.mjs';

const APPLIER = fileURLToPath(new URL('../bin/mnemuron-tunnel-apply.mjs', import.meta.url));
const token = (tunnel = '11111111-2222-3333-4444-555555555555') => Buffer.from(JSON.stringify({a: 'a'.repeat(32), t: tunnel, s: 'c2VjcmV0'})).toString('base64');

function setup(t, {fetchImpl} = {}) {
  const f = fixture(t), {s} = f, user = f.auth.user_id, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnm-cfg-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const keyFile = path.join(dir, 'console.key'); fs.writeFileSync(keyFile, randomBytes(32).toString('base64url'), {mode: 0o600});
  const c = s.issueCredential({userId: user, label: 'Synthetic owner', deviceId: 'synthetic', agentId: 'mnemuron-console', agentInstanceId: 'synthetic', scopes: CONSOLE_WRITE_SCOPES});
  const auth = s.authenticate(c.api_key), service = s.consoleService;
  s.memoryConfig = {...s.memoryConfig, console: {owner_user_id: user, worker_enabled: false, key_file: keyFile}};
  s.memoryTransaction(() => migrateOwner(s.db, user, {memory: true, capture: false, handoff: false, connections: true}));
  service.owner = new OwnerControls(service);
  if (fetchImpl) s.tunnel = new TunnelSettings(s, {fetchImpl});
  // Hand-off files go to a private temp directory in tests.
  s.tunnel.requestFile = () => path.join(dir, 'tunnel', 'apply.request'); s.tunnel.statusFile = () => path.join(dir, 'tunnel', 'apply.status');
  s.tunnel.discoveredFile = () => path.join(dir, 'tunnel', 'discovered.json');
  const act = (action, payload) => service.execute(auth, {action, payload, operation_id: randomUUID()});
  return {...f, s, user, auth, service, act, dir, keyFile, cleanup: callback => t.after(callback)};
}

test('CFG-01: a CLI change and a console change go through the same owner functions and are both logged with their source', async t => {
  const f = setup(t), before = f.s.config.fingerprint(f.user);
  f.s.config.set(f.user, 'feature.summary', 'on', 'cli:codex');
  assert.equal(f.service.owner.policy().flags.summary, true, 'the CLI changed the stored switch');
  assert.notEqual(f.s.config.fingerprint(f.user), before, 'the console sees a new fingerprint');
  await f.act('features.save', {expected_revision: f.service.owner.policy().revision, flags: {summary: false}});
  assert.equal(f.s.config.snapshot(f.user)['feature.summary'], false, 'the CLI reads the console change');
  f.s.config.set(f.user, 'search.default_mode', 'lexical', 'cli:root');
  f.s.config.set(f.user, 'schedule.interval_minutes', '30', 'cli:root');
  const history = f.s.config.history(f.user), of = key => history.filter(h => h.key === key);
  assert.deepEqual(of('feature.summary').map(h => [h.source, h.old, h.new, h.actor]), [['web', true, false, 'console'], ['cli', false, true, 'cli:codex']]);
  assert.deepEqual(of('schedule.enabled').map(h => h.source), ['web', 'cli'], 'side effects of a switch (the automatic rule) are logged too');
  assert.deepEqual([of('search.default_mode')[0].source, of('schedule.interval_minutes')[0].new], ['cli', 30]);
  assert.equal(f.service.owner.policy().schedule.interval_minutes, 30);
});

test('CFG-02: unknown keys, read-only keys and bad values are refused without a change', t => {
  const f = setup(t), before = f.s.config.fingerprint(f.user);
  for (const [key, value, code] of [['models.organizer', 'x', 'CONFIG_READ_ONLY'], ['feature.nope', 'on', 'CONFIG_READ_ONLY'], ['feature.summary', 'maybe', 'INVALID_CONFIG_VALUE'],
    ['search.default_mode', 'fuzzy', 'INVALID_CONFIG_VALUE'], ['schedule.max_items', '1.5', 'INVALID_CONFIG_VALUE']])
    assert.throws(() => f.s.config.set(f.user, key, value, 'cli:test'), e => e.errorCode === code, key);
  assert.equal(f.s.config.fingerprint(f.user), before);
  assert.equal(f.s.config.history(f.user).length, 0);
});

test('CFG-03: models, call limits and agent keys change from either side, with the same validation, and both are logged', async t => {
  const f = setup(t);
  const config = {enabled: true, protocol: 'openai_compatible', base_url: 'https://model.example.invalid/v1', model: 'synthetic-model', profile_revision: '1', daily_requests: 10, output_tokens: 4096, batch_size: 5, egress_approved: true, query_approved: true};
  await f.act('models.save', {kind: 'organizer', expected_revision: 0, config, api_key: 'synthetic-key-1'});
  const snap = () => f.s.config.snapshot(f.user);
  assert.deepEqual([snap()['models.organizer'].model, snap()['models.organizer'].key, snap()['models.organizer.quota']], ['synthetic-model', true, 'default']);
  assert.doesNotMatch(JSON.stringify(snap()), /synthetic-key-1/, 'keys never appear in the snapshot');
  f.s.config.modelSet(f.user, 'organizer', {model: 'synthetic-model-2', batch_size: '3'}, {}, 'cli:test');
  assert.deepEqual([snap()['models.organizer'].model, snap()['models.organizer'].batch_size, snap()['models.organizer'].key], ['synthetic-model-2', 3, true]);
  assert.throws(() => f.s.config.modelSet(f.user, 'organizer', {batch_size: '99'}, {}, 'cli:test'));
  assert.throws(() => f.s.config.modelSet(f.user, 'organizer', {colour: 'blue'}, {}, 'cli:test'), e => e.errorCode === 'INVALID_CONFIG_VALUE');
  f.s.config.modelSet(f.user, 'organizer', {}, {removeKey: true}, 'cli:test');
  assert.equal(snap()['models.organizer'].key, false);
  f.s.config.modelQuota(f.user, 'organizer', {daily: '50', total: 'none'}, 'cli:test');
  assert.deepEqual(snap()['models.organizer.quota'], {daily: 50, total: null});
  // The console sees the CLI's revision and saves on top of it.
  await f.act('models.save', {kind: 'organizer', expected_revision: f.service.models.raw(f.user, 'organizer').revision, config: {...config, enabled: false}});
  const issued = f.s.issueCredential({userId: f.user, label: 'Synthetic laptop', deviceId: 'laptop', agentId: 'claude-code', agentInstanceId: 'synthetic-instance', scopes: ['memory:read', 'memory:write']});
  assert.deepEqual(snap()['agents.synthetic-instance'], {label: 'Synthetic laptop', agent: 'claude-code', device: 'laptop', access: 'read_write', credential: issued.credential.credential_id});
  assert.ok(!Object.keys(snap()).some(k => k.startsWith('agents.') && snap()[k].agent === 'mnemuron-console'), 'the console\'s own keys are not configuration');
  f.s.config.agentRevoke(f.user, 'synthetic-instance', 'cli:test');
  assert.equal(snap()['agents.synthetic-instance'], undefined);
  const history = f.s.config.history(f.user, {limit: 100}), of = key => history.filter(h => h.key === key).map(h => h.source);
  assert.deepEqual(of('models.organizer'), ['web', 'cli', 'cli', 'web']);
  assert.deepEqual(of('models.organizer.quota'), ['cli']);
  assert.deepEqual(of('agents.synthetic-instance'), ['cli']);
});

test('TUNNEL-01: a token is stored sealed, decoded for its IDs, handed to the applier and its outcome read back', async t => {
  const f = setup(t);
  assert.throws(() => decodeTunnelToken('not-a-token'), e => e.errorCode === 'INVALID_TUNNEL_TOKEN');
  const result = await f.act('tunnel.token', {id: 'main', token: token()});
  assert.equal(result.tunnel.tunnel_id, '11111111-2222-3333-4444-555555555555');
  assert.equal(result.tunnel.pending, true);
  const row = f.s.tunnel.row('main');
  assert.doesNotMatch(JSON.stringify(row), /c2VjcmV0/, 'the token is never stored in clear');
  const request = JSON.parse(fs.readFileSync(f.s.tunnel.requestFile(), 'utf8'));
  assert.equal(request.tunnels.main.revision, row.desired_revision);
  fs.writeFileSync(f.s.tunnel.statusFile(), JSON.stringify({version: 2, tunnels: {main: {revision: request.tunnels.main.revision, state: 'rolled_back', error: 'TUNNEL_NOT_CONNECTED', at: new Date().toISOString()}}}));
  assert.deepEqual([f.s.tunnel.summary().apply_state, f.s.tunnel.summary().pending], ['rolled_back', false]);
  await f.act('tunnel.reapply', {id: 'main'});
  assert.equal(f.s.tunnel.summary().pending, true, 'applying again asks for a new revision');
  assert.ok(f.s.config.history(f.user).some(h => h.key === 'tunnel.main.token' && h.source === 'web'));
});

test('TUNNEL-02: tunnels can be added and removed; the main one cannot be removed and bad input changes nothing', async t => {
  const f = setup(t);
  await f.act('tunnel.token', {id: 'main', token: token()});
  const added = await f.act('tunnel.add', {name: '家里 NAS', token: token('11111111-2222-3333-4444-222222225555')});
  const id = added.tunnel.id;
  assert.match(id, /^t[0-9a-f]{6}$/);
  assert.deepEqual([added.tunnel.name, added.tunnel.metrics_port, added.tunnel.unit], ['家里 NAS', 47840, `cloudflared-mnemuron@${id}`]);
  const request = JSON.parse(fs.readFileSync(f.s.tunnel.requestFile(), 'utf8'));
  assert.deepEqual(Object.keys(request.tunnels).sort(), [id, 'main'].sort());
  assert.equal(request.tunnels[id].metrics_port, 47840);
  for (const [action, payload, code] of [['tunnel.remove', {id: 'main'}, 'TUNNEL_MAIN'], ['tunnel.add', {name: '', token: token()}, 'INVALID_TUNNEL_NAME'],
    ['tunnel.add', {name: 'x', token: 'nope'}, 'INVALID_TUNNEL_TOKEN'], ['tunnel.token', {id: 'tzzzzzz', token: token()}, null]])
    await assert.rejects(f.act(action, payload), e => code === null || e.errorCode === code, action);
  assert.equal(f.s.tunnel.list().length, 2);
  await f.act('tunnel.remove', {id});
  assert.equal(f.s.tunnel.row(id).state, 'removing');
  const next = JSON.parse(fs.readFileSync(f.s.tunnel.requestFile(), 'utf8'));
  assert.equal(next.tunnels[id].state, 'removing');
  fs.writeFileSync(f.s.tunnel.statusFile(), JSON.stringify({version: 2, tunnels: {[id]: {revision: next.tunnels[id].revision, state: 'removed', at: new Date().toISOString()}}}));
  assert.deepEqual(f.s.tunnel.list().map(x => x.id), ['main'], 'a removal the applier confirmed deletes the row');
  assert.ok(f.s.config.history(f.user).some(h => h.key === `tunnel.${id}.name` && h.new === '家里 NAS'));
});

async function runApplier(f, {connects = () => false, manager = {}, managerTimeout = 60000, discoverOwner = false} = {}) {
  const metrics = http.createServer((req, res) => { res.writeHead(connects() ? 200 : 503, {'content-type': 'application/json'}); res.end(JSON.stringify({readyConnections: connects() ? 2 : 0})); });
  await new Promise(resolve => metrics.listen(0, '127.0.0.1', resolve));
  f.cleanup(() => { metrics.closeAllConnections(); metrics.close(); });
  const log = path.join(f.dir, 'systemctl.log'), fake = path.join(f.dir, 'systemctl');
  fs.rmSync(log, {force: true});
  fs.writeFileSync(fake, `#!${process.execPath}\nimport fs from 'node:fs';\nconst args=process.argv.slice(2), manager=${JSON.stringify(manager)}, log=${JSON.stringify(log)};\nfs.appendFileSync(log,args.join(' ')+'\\n');\nconst attempt=fs.readFileSync(log,'utf8').trim().split('\\n').filter(line=>line.startsWith(args[0]+' ')).length;\nif(args[0]==='restart' && attempt===1 && manager.firstRestartDelay)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,manager.firstRestartDelay);\nif(args[0]==='disable')process.exit(manager.disableCode||0);\nif(args[0]==='show'){process.stdout.write(manager.showOutput||'');process.exit(manager.showCode||0);}\nprocess.exit(manager[args[0]+'Codes']?.[attempt-1]||0);\n`, {mode: 0o700});
  const child = spawn(process.execPath, [APPLIER], {env: {...process.env, MNEMURON_CONSOLE_KEY_FILE: f.keyFile, MNEMURON_TUNNEL_DIR: path.join(f.dir, 'tunnel'),
    MNEMURON_TUNNEL_CREDENTIAL: path.join(f.dir, 'credential'), MNEMURON_TUNNEL_ETC: path.join(f.dir, 'tunnels'), MNEMURON_SYSTEMCTL: fake, MNEMURON_TUNNEL_METRICS_URL: `http://127.0.0.1:${metrics.address().port}`,
    MNEMURON_TUNNEL_WAIT_SECONDS: '1', MNEMURON_TUNNEL_POLL_MS: '100', MNEMURON_SYSTEMCTL_TIMEOUT_MS: String(managerTimeout),
    ...(discoverOwner ? {MNEMURON_OWNER_USER_ID: f.user} : {})}});
  f.cleanup(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  let stderr = ''; child.stderr.on('data', d => stderr += d);
  const code = await new Promise(resolve => child.on('close', resolve));
  if (!fs.existsSync(path.join(f.dir, 'tunnel', 'apply.status'))) throw new Error('applier wrote no status: ' + stderr);
  metrics.closeAllConnections(); metrics.close();
  const read = file => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return null; } };
  return {code, status: JSON.parse(fs.readFileSync(path.join(f.dir, 'tunnel', 'apply.status'), 'utf8')).tunnels, credential: read(path.join(f.dir, 'credential')),
    extra: id => ({token: read(path.join(f.dir, 'tunnels', `${id}.token`)), env: read(path.join(f.dir, 'tunnels', `${id}.env`))}), calls: (read(log) || '').split('\n').filter(Boolean)};
}

test('TUNNEL-03: the applier installs a token that connects, and puts the previous one back when the new one does not', async t => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.dir, 'credential'), 'previous-token\n');
  await f.act('tunnel.token', {id: 'main', token: token()});
  const ok = await runApplier(f, {connects: () => true});
  assert.deepEqual([ok.code, ok.status.main.state, ok.credential, ok.calls], [0, 'applied', token(), ['restart cloudflared-mnemuron.service']]);
  assert.equal(f.s.tunnel.summary().apply_state, 'applied');
  await f.act('tunnel.token', {id: 'main', token: token('11111111-9999-3333-4444-999999995555')});
  const bad = await runApplier(f, {connects: () => fs.readFileSync(path.join(f.dir, 'credential'), 'utf8').trim() === token()});
  assert.equal(bad.status.main.restored, true);
  assert.deepEqual([bad.status.main.state, bad.status.main.error, bad.credential], ['rolled_back', 'TUNNEL_NOT_CONNECTED', token()], 'the working token is restored');
  assert.equal(bad.calls.filter(c => c.startsWith('restart')).length, 2);
  const again = await runApplier(f, {connects: () => true});
  assert.equal(again.status.main.revision, bad.status.main.revision, 'an applied or rolled back revision is not applied twice');
  assert.deepEqual(again.calls, []);
  assert.equal(sealWith.length, 4);
});

test('TUNNEL-05: an added tunnel runs as its own instance, a new one that does not connect is cleaned up, and removal stops it', async t => {
  const f = setup(t);
  const {tunnel: {id}} = await f.act('tunnel.add', {name: 'Lab', token: token('11111111-2222-3333-4444-222222225555')});
  const ok = await runApplier(f, {connects: () => true});
  assert.deepEqual([ok.status[id].state, ok.extra(id).token, ok.extra(id).env, ok.calls], ['applied', token('11111111-2222-3333-4444-222222225555'), 'MNEMURON_TUNNEL_METRICS=127.0.0.1:47840', [`enable --now cloudflared-mnemuron@${id}.service`]]);
  assert.equal(ok.status.main, undefined, 'tunnels without a new revision are left alone');
  assert.equal(f.s.tunnel.summary(id).apply_state, 'applied');
  const {tunnel: {id: other}} = await f.act('tunnel.add', {name: 'Broken', token: token('11111111-3333-3333-4444-333333335555')});
  const bad = await runApplier(f, {connects: () => false});
  assert.deepEqual([bad.status[other].state, bad.status[other].error, bad.extra(other).token], ['rolled_back', 'TUNNEL_NOT_CONNECTED_NO_PREVIOUS', null]);
  assert.deepEqual(bad.calls, [`enable --now cloudflared-mnemuron@${other}.service`, `disable --now cloudflared-mnemuron@${other}.service`]);
  await f.act('tunnel.remove', {id});
  const gone = await runApplier(f, {connects: () => true});
  assert.deepEqual([gone.status[id].state, gone.extra(id).token, gone.extra(id).env, gone.calls], ['removed', null, null, [`disable --now cloudflared-mnemuron@${id}.service`]]);
  assert.deepEqual(f.s.tunnel.list().map(x => x.id).sort(), ['main', other].sort());
});

test('TUNNEL-04: the token cloudflared runs with is discovered and shown, however it was set; a change in progress is not overwritten', async t => {
  const f = setup(t);
  fs.mkdirSync(path.join(f.dir, 'tunnel'), {recursive: true});
  fs.writeFileSync(path.join(f.dir, 'credential'), token() + '\n');
  const child = spawn(process.execPath, [APPLIER, '--discover'], {env: {...process.env, MNEMURON_CONSOLE_KEY_FILE: f.keyFile, MNEMURON_TUNNEL_DIR: path.join(f.dir, 'tunnel'),
    MNEMURON_TUNNEL_CREDENTIAL: path.join(f.dir, 'credential'), MNEMURON_TUNNEL_ETC: path.join(f.dir, 'tunnels'), MNEMURON_OWNER_USER_ID: f.user}});
  assert.equal(await new Promise(resolve => child.on('close', resolve)), 0);
  const found = f.s.tunnel.summary();
  assert.deepEqual([found.configured, found.tunnel_id, found.apply_state, found.updated_by], [true, '11111111-2222-3333-4444-555555555555', 'applied', 'server']);
  assert.deepEqual(f.s.config.history(f.user).filter(h => h.key === 'tunnel.main.token').map(h => [h.source, h.actor]), [['cli', 'server:cloudflared']]);
  // A console change still being applied keeps its own token even though the server still runs the old one.
  await f.act('tunnel.token', {id: 'main', token: token('11111111-9999-3333-4444-999999995555')});
  const later = JSON.parse(fs.readFileSync(f.s.tunnel.discoveredFile(), 'utf8'));
  later.tunnels.main.at = new Date(Date.now() + 1000).toISOString();
  fs.writeFileSync(f.s.tunnel.discoveredFile(), JSON.stringify(later));
  assert.equal(f.s.tunnel.summary().tunnel_id, '11111111-9999-3333-4444-999999995555');
});

async function removalFixture(t) {
  const f = setup(t), {tunnel: {id}} = await f.act('tunnel.add', {name: 'Synthetic removal', token: token()});
  fs.mkdirSync(path.join(f.dir, 'tunnels'), {recursive: true});
  fs.writeFileSync(path.join(f.dir, 'tunnels', `${id}.token`), token() + '\n', {mode: 0o600});
  fs.writeFileSync(path.join(f.dir, 'tunnels', `${id}.env`), 'MNEMURON_TUNNEL_METRICS=127.0.0.1:47840\n', {mode: 0o600});
  await f.act('tunnel.remove', {id});
  return {...f, id};
}

test('TUNNEL-09: a failed restart or manager timeout restores the previous credential and confirms recovery', async t => {
  for (const [name, manager, managerTimeout] of [
    ['restart failure', {restartCodes: [1, 0]}, 60000],
    ['restart timeout', {firstRestartDelay: 3000}, 1000],
  ]) await t.test(name, async t => {
    const f = setup(t), old = token('11111111-7777-3333-4444-555555555555');
    fs.writeFileSync(path.join(f.dir, 'credential'), old + '\n', {mode: 0o600});
    await f.act('tunnel.token', {id: 'main', token: token()});
    const result = await runApplier(f, {manager, managerTimeout, connects: () => fs.readFileSync(path.join(f.dir, 'credential'), 'utf8').trim() === old});
    assert.deepEqual([result.code, result.status.main.state, result.status.main.error, result.status.main.restored, result.credential],
      [0, 'rolled_back', 'TUNNEL_APPLY_FAILED', true, old]);
    assert.deepEqual(result.calls, ['restart cloudflared-mnemuron.service', 'restart cloudflared-mnemuron.service']);
  });
});

test('TUNNEL-10: rollback restores an existing instance environment and reports an unconfirmed recovery as failed', async t => {
  const f = setup(t), old = token('11111111-7777-3333-4444-555555555555');
  const {tunnel: {id}} = await f.act('tunnel.add', {name: 'Synthetic recovery', token: token()});
  fs.mkdirSync(path.join(f.dir, 'tunnels'), {recursive: true});
  const oldEnv = 'MNEMURON_TUNNEL_METRICS=127.0.0.1:47850\n';
  fs.writeFileSync(path.join(f.dir, 'tunnels', `${id}.token`), old + '\n', {mode: 0o600});
  fs.writeFileSync(path.join(f.dir, 'tunnels', `${id}.env`), oldEnv, {mode: 0o600});
  const result = await runApplier(f, {manager: {restartCodes: [1, 1]}, connects: () => true});
  assert.deepEqual([result.code, result.status[id].state, result.status[id].error, result.status[id].restored], [1, 'failed', 'TUNNEL_RESTORE_START_FAILED', false]);
  assert.deepEqual(result.extra(id), {token: old, env: oldEnv.trim()});
  assert.equal(result.status[id].credential_restored, true);
  assert.equal(f.s.tunnel.summary(id).apply_state, 'failed');
});

test('TUNNEL-11: a failed new enable is cleaned up only after a confirmed stop', async t => {
  for (const stopped of [true, false]) await t.test(stopped ? 'stopped' : 'unconfirmed stop', async t => {
    const f = setup(t), {tunnel: {id}} = await f.act('tunnel.add', {name: 'Synthetic enable', token: token()});
    const result = await runApplier(f, {manager: {enableCodes: [1], disableCode: stopped ? 0 : 1, showCode: 1}});
    assert.deepEqual([result.code, result.status[id].state, result.status[id].error], stopped
      ? [0, 'rolled_back', 'TUNNEL_APPLY_FAILED'] : [1, 'failed', 'TUNNEL_STOP_FAILED']);
    assert.equal(result.extra(id).token, stopped ? null : token());
    assert.ok(result.calls.includes(`disable --now cloudflared-mnemuron@${id}.service`));
  });
});

test('TUNNEL-12: an unchanged token still requires readiness and does not claim an unsuccessful restore', async t => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.dir, 'credential'), token() + '\n', {mode: 0o600});
  await f.act('tunnel.token', {id: 'main', token: token()});
  const result = await runApplier(f);
  assert.deepEqual([result.code, result.status.main.state, result.status.main.error, result.status.main.restored, result.credential],
    [1, 'failed', 'TUNNEL_RESTORE_NOT_CONNECTED', false, token()]);
  assert.deepEqual(result.calls, ['start cloudflared-mnemuron.service', 'restart cloudflared-mnemuron.service']);
});

test('TUNNEL-13: post-rollback discovery updates the token without erasing the actual apply outcome', async t => {
  for (const recovered of [true, false]) await t.test(recovered ? 'recovered' : 'recovery failed', async t => {
    const f = setup(t), oldId = '11111111-7777-3333-4444-555555555555', old = token(oldId);
    fs.writeFileSync(path.join(f.dir, 'credential'), old + '\n', {mode: 0o600});
    await f.act('tunnel.token', {id: 'main', token: token()});
    const result = await runApplier(f, {manager: {restartCodes: [1, recovered ? 0 : 1]}, connects: () => true, discoverOwner: true});
    const summary = f.s.tunnel.summary();
    assert.equal(summary.token_fingerprint, result.status.main.credential_restored && f.s.tunnel.readJson(f.s.tunnel.discoveredFile()).tunnels.main.token_fp);
    assert.equal(summary.tunnel_id, oldId);
    assert.equal(summary.apply_state, recovered ? 'rolled_back' : 'failed');
    assert.equal(summary.apply_error, recovered ? 'TUNNEL_APPLY_FAILED' : 'TUNNEL_RESTORE_START_FAILED');
    await f.act('tunnel.reapply', {id: 'main'});
    const retried = await runApplier(f, {connects: () => true, discoverOwner: true});
    assert.equal(retried.status.main.state, 'applied');
    assert.equal(f.s.tunnel.summary().apply_state, 'applied');
    assert.equal(f.s.tunnel.summary().apply_error, null);
  });
});

test('TUNNEL-06: a failed stop preserves credentials and the failed removal row until an explicit retry succeeds', async t => {
  const f = await removalFixture(t), id = f.id;
  const failed = await runApplier(f, {manager: {disableCode: 1, showOutput: 'LoadState=loaded\nActiveState=active\nUnitFileState=disabled\n'}});
  assert.deepEqual([failed.code, failed.status[id].state, failed.status[id].error], [1, 'failed', 'TUNNEL_STOP_FAILED']);
  assert.deepEqual(failed.extra(id), {token: token(), env: 'MNEMURON_TUNNEL_METRICS=127.0.0.1:47840'});
  const summary = f.s.tunnel.summary(id);
  assert.deepEqual([summary.state, summary.apply_state, summary.apply_error, summary.pending], ['removing', 'failed', 'TUNNEL_STOP_FAILED', false]);
  assert.ok(f.s.tunnel.row(id).token_seal, 'sealed credential stays available for recovery');
  const same = await runApplier(f);
  assert.deepEqual(same.calls, [], 'a failed revision does not silently retry');
  assert.equal(same.status[id].state, 'failed');
  await f.act('tunnel.remove', {id});
  assert.equal(f.s.tunnel.summary(id).pending, true);
  const retried = await runApplier(f);
  assert.deepEqual([retried.code, retried.status[id].state, retried.extra(id)], [0, 'removed', {token: null, env: null}]);
  assert.deepEqual(f.s.tunnel.list().map(row => row.id), ['main']);
});

test('TUNNEL-07: only a confirmed inactive and absent or persistently disabled instance permits failed-stop cleanup', async t => {
  const cases = [
    ['absent', {disableCode: 1, showOutput: 'LoadState=not-found\nActiveState=inactive\nUnitFileState=\n'}, true],
    ['disabled', {disableCode: 1, showOutput: 'LoadState=loaded\nActiveState=inactive\nUnitFileState=disabled\n'}, true],
    ['masked', {disableCode: 1, showOutput: 'LoadState=masked\nActiveState=inactive\nUnitFileState=masked\n'}, true],
    ['still enabled', {disableCode: 1, showOutput: 'LoadState=loaded\nActiveState=inactive\nUnitFileState=enabled\n'}, false],
    ['unknown state', {disableCode: 1, showOutput: 'LoadState=not-found\n'}, false],
    ['manager unavailable', {disableCode: 1, showCode: 1, showOutput: 'LoadState=not-found\nActiveState=inactive\n'}, false],
  ];
  for (const [name, manager, removed] of cases) await t.test(name, async t => {
    const f = await removalFixture(t), result = await runApplier(f, {manager});
    assert.deepEqual([result.code, result.status[f.id].state], removed ? [0, 'removed'] : [1, 'failed']);
    assert.equal(result.extra(f.id).token, removed ? null : token());
    assert.equal(f.s.tunnel.list().some(row => row.id === f.id), !removed);
  });
});

test('TUNNEL-08: a new disconnected instance also retains its recovery files when rollback cannot stop it', async t => {
  const f = setup(t), {tunnel: {id}} = await f.act('tunnel.add', {name: 'Synthetic rollback', token: token()});
  const result = await runApplier(f, {manager: {disableCode: 1, showOutput: 'LoadState=loaded\nActiveState=active\nUnitFileState=disabled\n'}});
  assert.deepEqual([result.code, result.status[id].state, result.status[id].error], [1, 'failed', 'TUNNEL_STOP_FAILED']);
  assert.deepEqual(result.extra(id), {token: token(), env: 'MNEMURON_TUNNEL_METRICS=127.0.0.1:47840'});
  assert.equal(f.s.tunnel.summary(id).apply_state, 'failed');
});
