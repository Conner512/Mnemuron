import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {MnemuronStore} from '../lib/store.mjs';
import {CORE_SCHEMA_VERSION,CORE_MIGRATIONS} from '../lib/store/schema.mjs';
import {applyMigrations,schemaVersion,SchemaVersionError} from '../lib/store/migrations.mjs';

const tempDb=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mnemuron-schema-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return path.join(dir,'core.sqlite3');};

test('SCHEMA-01: a new database records the latest core schema version',t=>{
 const store=new MnemuronStore(tempDb(t));t.after(()=>store.close());
 assert.equal(schemaVersion(store.db),CORE_SCHEMA_VERSION);
 assert.equal(store.schema.to,CORE_SCHEMA_VERSION);
 assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='memories_user_created_idx'").get());
});
test('SCHEMA-02: an unversioned legacy database adopts versioning additively',t=>{
 const file=tempDb(t),legacy=new DatabaseSync(file);
 legacy.exec(`CREATE TABLE memories (memory_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,credential_id TEXT NOT NULL,device_id TEXT NOT NULL,agent_id TEXT NOT NULL,agent_instance_id TEXT NOT NULL,content TEXT NOT NULL,scope TEXT NOT NULL,project_id TEXT,task_id TEXT,workstream_id TEXT,session_id TEXT,source TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT);
  INSERT INTO memories VALUES ('legacy-1','user-local','c','d','a','i','legacy content','user',NULL,NULL,NULL,NULL,'explicit','2026-01-01T00:00:00.000Z',NULL);`);
 legacy.close();
 const store=new MnemuronStore(file);t.after(()=>store.close());
 assert.equal(store.schema.from,0);assert.equal(schemaVersion(store.db),CORE_SCHEMA_VERSION);
 const row=store.db.prepare("SELECT content,memory_type,status FROM memories WHERE memory_id='legacy-1'").get();
 assert.deepEqual({...row},{content:'legacy content',memory_type:'fact',status:'active'});
});
test('SCHEMA-03: an older release refuses a newer schema instead of guessing',t=>{
 const file=tempDb(t),db=new DatabaseSync(file);db.exec(`PRAGMA user_version=${CORE_SCHEMA_VERSION+1}`);db.close();
 assert.throws(()=>new MnemuronStore(file),SchemaVersionError);
});
test('SCHEMA-04: a failing one-off step rolls back and keeps the prior version',t=>{
 const db=new DatabaseSync(tempDb(t));t.after(()=>db.close());
 const steps=[...CORE_MIGRATIONS,{version:CORE_SCHEMA_VERSION+1,name:'broken',up:d=>{d.exec('CREATE TABLE half_done (x INTEGER)');throw new Error('synthetic failure');}}];
 assert.throws(()=>applyMigrations(db,steps),/synthetic failure/);
 assert.equal(schemaVersion(db),CORE_SCHEMA_VERSION);
 assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='half_done'").get(),undefined);
 assert.throws(()=>applyMigrations(db,[{version:2,name:'gap',up(){}}]),/contiguous/);
});
test('SCHEMA-05: owner recency reads use the owner/time index',t=>{
 const store=new MnemuronStore(tempDb(t));t.after(()=>store.close());
 const plan=store.db.prepare('EXPLAIN QUERY PLAN SELECT memory_id FROM memories WHERE user_id=? ORDER BY created_at DESC,memory_id LIMIT 5').all('u').map(r=>r.detail).join(' ');
 assert.match(plan,/memories_user_created_idx/);assert.doesNotMatch(plan,/TEMP B-TREE/);
});
