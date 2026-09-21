import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {identityFixture} from './helpers/identity-fixture.mjs';
test('BASE-02: every OAuth table has an account or protocol owner classification',t=>{
 const f=identityFixture(t),inventory=JSON.parse(fs.readFileSync(new URL('../../../docs/architecture/account-ownership.json',import.meta.url),'utf8'));
 const actual=f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);
 const classified=Object.values(inventory.oauth).flat();assert.equal(new Set(classified).size,classified.length);assert.deepEqual(classified.sort(),actual);
});
