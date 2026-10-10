import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryFixture} from './helpers/core-memory-fixture.mjs';
import {DEFAULT_TAXONOMY,LEGACY_TAXONOMY,adoptionPreview,classificationGuidance} from '../lib/memory-derived/taxonomy.mjs';
import {MnemuronStore} from '../lib/store.mjs';

test('Taxonomy v2: first credentials select eleven stable IDs; rotation and reopening preserve account choice',async t=>{
 const f=await memoryFixture(t),s=f.store,u=f.a.auth.user_id;
 assert.deepEqual(s.consoleService.taxonomy(u),DEFAULT_TAXONOMY);
 assert.equal(DEFAULT_TAXONOMY.categories.length,11);
 assert.ok(LEGACY_TAXONOMY.categories.every(c=>DEFAULT_TAXONOMY.categories.includes(c)));
 s.consoleService.features.save(u,'taxonomy',{expected_revision:0},{version:'custom',categories:['uncategorized','my-category'],labels:{'my-category':'My own label'}});
 f.issue(u,'another-agent');
 assert.deepEqual(s.consoleService.taxonomy(u),{version:'custom',categories:['uncategorized','my-category']});
 const reopened=new MnemuronStore(f.databasePath);try{assert.deepEqual(reopened.consoleService.taxonomy(u),s.consoleService.taxonomy(u));}finally{reopened.close();}
});

test('Taxonomy v2: legacy fallback and explicit operator taxonomy never change on credential issuance',async t=>{
 const f=await memoryFixture(t),s=f.store,u=f.a.auth.user_id;
 s.db.prepare("DELETE FROM console_preferences WHERE user_id=? AND kind IN ('taxonomy','taxonomy-default')").run(u);
 assert.deepEqual(s.consoleService.taxonomy(u),LEGACY_TAXONOMY);
 f.issue(u,'legacy-rotated');assert.deepEqual(s.consoleService.taxonomy(u),LEGACY_TAXONOMY);
 assert.equal(s.db.prepare("SELECT COUNT(*) n FROM console_preferences WHERE user_id=? AND kind IN ('taxonomy','taxonomy-default')").get(u).n,0);
 s.memoryConfig.memory={taxonomy:{version:'operator',categories:['uncategorized','engineering']}};
 const c=f.issue('new-configured-user','configured');assert.deepEqual(s.consoleService.taxonomy(c.auth.user_id),s.memoryConfig.memory.taxonomy);
});

test('Taxonomy v2: retained data protects a legacy owner even without a credential',async t=>{
 const f=await memoryFixture(t),s=f.store,u='retained-legacy-owner';
 s.db.prepare('INSERT INTO console_preferences VALUES(?,?,?,?)').run(u,'privacy',1,'{}');
 f.issue(u,'replacement');assert.deepEqual(s.consoleService.taxonomy(u),LEGACY_TAXONOMY);
});

test('Taxonomy v2: proposal is additive, label preserving, bounded and read-only',async t=>{
 const f=await memoryFixture(t),s=f.store,u=f.a.auth.user_id;
 const before=s.db.prepare('SELECT * FROM console_preferences').all();
 const p=adoptionPreview({version:'custom',categories:['uncategorized','personal','custom']},7,{personal:'My profile',custom:'Custom label'});
 assert.equal(p.expected_revision,7);assert.equal(p.categories[2],'custom');assert.equal(p.labels.personal,'My profile');assert.deepEqual(p.removed,[]);
 assert.equal(p.reclassify,false);assert.equal(p.model_calls,0);assert.deepEqual(p.label_review,['personal']);
 assert.equal(adoptionPreview({version:'full',categories:['uncategorized',...Array.from({length:63},(_,i)=>'c'+i)]}).within_limit,false);
 const result=s.consoleService.features.read(f.a.auth,'taxonomy',{});assert.equal(result.default_adoption.reclassify,false);
 assert.deepEqual(s.db.prepare('SELECT * FROM console_preferences').all(),before);
 assert.equal(s.db.prepare('SELECT COUNT(*) n FROM memory_jobs').get().n,0);
 assert.match(classificationGuidance(DEFAULT_TAXONOMY),/never infer semantics from an ID/);
 assert.match(classificationGuidance(DEFAULT_TAXONOMY),/up to 8/);
});

test('Taxonomy v2: failed credential issuance rolls back the new-owner preference',async t=>{
 const f=await memoryFixture(t),s=f.store,u='synthetic-failed-owner';
 s.db.exec("CREATE TEMP TRIGGER synthetic_credential_failure BEFORE INSERT ON credentials WHEN NEW.user_id='synthetic-failed-owner' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
 assert.throws(()=>f.issue(u,'new-agent'),/synthetic failure/);
 assert.equal(s.db.prepare('SELECT COUNT(*) n FROM console_preferences WHERE user_id=?').get(u).n,0);
 assert.equal(s.db.prepare('SELECT COUNT(*) n FROM credentials WHERE user_id=?').get(u).n,0);
});
