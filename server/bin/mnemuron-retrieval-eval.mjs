#!/usr/bin/env node
// Retrieval evaluation against a private, owner-labelled query set.
//
//   node server/bin/mnemuron-retrieval-eval.mjs --source DB --cases FILE [--modes lexical,hybrid] [--config RUNTIME.json] [--k 5,10]
//
// The live database is never opened for writing: it is copied read-only (VACUUM INTO) into a private temporary
// directory, evaluated there, and the copy is deleted. The background worker is always disabled, so no model or
// vector-store write happens; hybrid/semantic modes only send the case queries to the configured embedding model.
// Case file (kept private, never committed): {"user_id":"...","cases":[{"id":"q1","query":"...","gold":["<memory id or unique prefix>"]}]}
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {MnemuronStore} from '../lib/store.mjs';
import {loadMemoryRuntimeFile} from '../lib/memory-runtime.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => value.startsWith('--') ? [...pairs, [value.slice(2), all[index + 1]]] : pairs, []));
if (!args.source || !args.cases) throw new Error('usage: --source DB --cases FILE [--modes lexical,hybrid] [--config RUNTIME.json] [--k 5,10]');
const modes = (args.modes || 'lexical').split(','), ks = (args.k || '5,10').split(',').map(Number), depth = Math.max(...ks);
for (const mode of modes) if (!['lexical', 'hybrid', 'semantic'].includes(mode)) throw new Error(`unknown mode ${mode}`);
const spec = JSON.parse(fs.readFileSync(args.cases, 'utf8'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemuron-eval-'));
fs.chmodSync(dir, 0o700);
const copy = path.join(dir, 'copy.sqlite3');
let store;
try {
  const source = new DatabaseSync(args.source, {readOnly: true});
  source.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
  source.close();
  fs.chmodSync(copy, 0o600);

  let memoryConfig;
  if (args.config) {
    memoryConfig = structuredClone(loadMemoryRuntimeFile(args.config));
    memoryConfig.storage = {...memoryConfig.storage, sqlite_path: copy};
    if (memoryConfig.console) memoryConfig.console.worker_enabled = false;
  }
  store = new MnemuronStore(copy, {memoryConfig, memoryConfigPath: args.config});
  const issued = store.issueCredential({label: 'retrieval-eval', userId: spec.user_id, deviceId: 'retrieval-eval', agentId: 'retrieval-eval', agentInstanceId: 'retrieval-eval', scopes: ['memory:read']});
  const auth = store.authenticate(issued.api_key);

  // Gold labels may use unique ID prefixes; each must name exactly one active memory of the owner.
  const ids = store.db.prepare("SELECT memory_id FROM memories WHERE user_id=? AND status='active'").all(spec.user_id).map(r => r.memory_id);
  const resolve = prefix => {
    const found = ids.filter(id => id.startsWith(prefix));
    if (found.length !== 1) throw new Error(`gold "${prefix}" matches ${found.length} active memories`);
    return found[0];
  };
  const cases = spec.cases.map(c => ({...c, gold: new Set(c.gold.map(resolve))}));

  const report = {cases: cases.length, active_memories: ids.length, modes: {}};
  for (const mode of modes) {
    const totals = {hit: Object.fromEntries(ks.map(k => [k, 0])), recall: Object.fromEntries(ks.map(k => [k, 0])), mrr: 0, degraded: 0};
    const misses = [];
    for (const c of cases) {
      const result = await store.searchMemories(auth, {query: c.query, mode, limit: depth});
      if (result.retrieval?.degraded) totals.degraded++;
      const ranked = result.results.map(r => r.memory_id);
      const first = ranked.findIndex(id => c.gold.has(id));
      totals.mrr += first < 0 ? 0 : 1 / (first + 1);
      for (const k of ks) {
        const found = ranked.slice(0, k).filter(id => c.gold.has(id)).length;
        totals.recall[k] += found / c.gold.size;
        if (found) totals.hit[k]++;
      }
      if (first < 0 || first >= ks[0]) misses.push({id: c.id, first_gold_rank: first < 0 ? null : first + 1, returned: ranked.length});
    }
    const avg = value => Math.round(value / cases.length * 1000) / 1000;
    report.modes[mode] = {
      hit_rate: Object.fromEntries(ks.map(k => [`@${k}`, avg(totals.hit[k])])),
      recall: Object.fromEntries(ks.map(k => [`@${k}`, avg(totals.recall[k])])),
      mrr: avg(totals.mrr), degraded_queries: totals.degraded, misses,
    };
  }
  // Only case IDs, ranks and aggregates are printed; no memory text and no query text.
  console.log(JSON.stringify(report, null, 1));
} finally {
  store?.close();
  fs.rmSync(dir, {recursive: true, force: true});
}
