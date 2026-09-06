import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, renameSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { memoryFixture, businessSnapshot } from './helpers/core-memory-fixture.mjs';
import { checkPublication, scanPublicationFile } from '../../scripts/check-publication.mjs';

test('publication guard rejects private artifacts and identifiers without echoing content', () => {
  const examples = [
    ['notes.txt', '/Users/' + 'fixture-person/workspace'],
    ['notes.txt', ['10', '23', '45', '67'].join('.')],
    ['notes.txt', ['ct', '123'].join('')],
    ['notes.txt', ['abcdefab', '1234', '4123', '8123', 'abcdefabcdef'].join('-')],
    ['notes.txt', ['+codex.', '20000101000000'].join('')],
    ['evidence/run.json', '{}'],
    ['private/history.md', 'synthetic private history'],
    ['runtime.sqlite3', 'synthetic'],
    ['client/.env', 'synthetic'],
  ];
  for (const [file, content] of examples) {
    const findings = scanPublicationFile(file, content);
    assert.ok(findings.length, file);
    for (const finding of findings) assert.deepEqual(Object.keys(finding), ['file', 'rule', 'line']);
    assert.ok(!JSON.stringify(findings).includes(content));
  }
});

test('publication history checks old paths even when a renamed blob is unchanged', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mnemuron-publication-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git(['init', '--quiet']);
  mkdirSync(path.join(root, 'private'));
  mkdirSync(path.join(root, 'docs'));
  writeFileSync(path.join(root, 'private', 'fixture.md'), 'Synthetic history fixture\n');
  git(['add', '.']);
  const commit = ['-c', 'user.name=Example', '-c', 'user.email=example@users.noreply.github.com', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m'];
  git([...commit, 'Add synthetic fixture']);
  renameSync(path.join(root, 'private', 'fixture.md'), path.join(root, 'docs', 'fixture.md'));
  git(['add', '-A']);
  git([...commit, 'Move synthetic fixture']);
  assert.equal(checkPublication(['--ref', 'HEAD'], root).status, 'passed');
  assert.ok(checkPublication(['--ref', 'HEAD', '--history'], root).findings.some(f => f.file === 'private/fixture.md' && f.rule === 'private-artifact'));
});

test('publication guard permits documented synthetic examples but rejects populated seed history', () => {
  assert.deepEqual(scanPublicationFile('docs/example.md', 'https://mnemuron.example.com /Users/example 192.0.2.1 11111111-1111-4111-8111-000000000007'), []);
  assert.deepEqual(scanPublicationFile('server/config/mnemuron.env.example', 'MNEMURON_HOST=127.0.0.1'), []);
  const seed = { task_id: 'example-task', title: 'Example: task', progress: [], decisions: [], blockers: [], next_steps: [], conflicts: [] };
  assert.deepEqual(scanPublicationFile('server/seed/example.json', JSON.stringify(seed)), []);
  assert.ok(scanPublicationFile('server/seed/example.json', JSON.stringify({ ...seed, progress: ['synthetic result that belongs in a private report'] })).some(f => f.rule === 'seed-history'));
});

test('database-copy smoke uses explicit synthetic targets and never overwrites an existing copy', async t => {
  const f = await memoryFixture(t);
  const before = businessSnapshot(f.store);
  const script = path.resolve(import.meta.dirname, 'database-copy-task-branches-smoke.mjs');
  const copy = path.join(f.root, 'new-copy.sqlite3');
  const args = [script, f.databasePath, copy, f.a.auth.user_id, f.alpha.project_id, f.alpha.task_id];
  const result = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(result.status, 'passed');
  assert.equal(result.task_id, f.alpha.task_id);
  assert.equal(result.production_changed, false);
  assert.deepEqual(businessSnapshot(f.store), before);
  const bytes = readFileSync(copy);
  assert.throws(() => execFileSync(process.execPath, args, { stdio: 'pipe' }));
  assert.deepEqual(readFileSync(copy), bytes);
  assert.throws(() => execFileSync(process.execPath, [script, f.databasePath, path.join(f.root, 'other.sqlite3')], { stdio: 'pipe' }));
  assert.deepEqual(businessSnapshot(f.store), before);
});
