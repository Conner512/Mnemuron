import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {memoryFixture} from './helpers/core-memory-fixture.mjs';
import {VectorIndex} from '../lib/vector-stores/index.mjs';
test('BASE-02: every Core table is classified, including derived indices and operator-only state',async t=>{
 const f=await memoryFixture(t);new VectorIndex(f.store,null,new Map());
 const inventory=JSON.parse(fs.readFileSync(new URL('../../docs/architecture/account-ownership.json',import.meta.url),'utf8'));
 const tables=f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);
 const classified=Object.values(inventory.core).flat();assert.equal(new Set(classified).size,classified.length);
 assert.deepEqual(classified.sort(),tables);
 for(const table of inventory.core.user_id)assert.ok(f.store.db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name==='user_id'),table);
});
