// Lifecycle write enforcement, 5C memory/cloud/Console independent review (LW-14..LW-19). Synthetic isolated fixtures
// only; no models. Fixture: see lifecycle-world (proj-lr-dead deleted, proj-lr-src merged into proj-lr-tgt).
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {world} from './helpers/lifecycle-world.mjs';
import {CONSOLE_WRITE_SCOPES} from '../../shared/console-contract.mjs';
import {CLOUD_CORE_SCOPES} from '../lib/memory/cloud.mjs';

const routes=w=>w.store.db.prepare('SELECT requested_project_id r,canonical_project_id c,entity_type e,entity_id id FROM project_route_log WHERE user_id=? ORDER BY rowid').all(w.user).map(row=>({...row}));
const count=(w,table,where='1',...params)=>w.store.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).get(...params).n;
const rows=(w,table)=>JSON.stringify(w.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
const writerOf=(w,name)=>w.store.authenticate(w.store.issueCredential({userId:w.user,deviceId:`d-${name}`,agentId:'mnemuron-console',agentInstanceId:name,scopes:[...CONSOLE_WRITE_SCOPES]}).api_key);
// Commits a lifecycle generation bump (an unrelated project deleted) on a second connection.
const otherWriter=(t,w)=>{const db=new DatabaseSync(w.store.databasePath);t.after(()=>{if(db.isOpen)db.close();});
  return projectId=>{db.exec('BEGIN IMMEDIATE');
    db.prepare("INSERT OR REPLACE INTO project_lifecycle VALUES (?,?,'deleted',NULL,1,?)").run(w.user,projectId,new Date().toISOString());
    db.prepare(`INSERT INTO owner_lifecycle_generation (user_id, generation) VALUES (?, COALESCE((SELECT generation FROM owner_lifecycle_generation WHERE user_id = ?), 0) + 1)
      ON CONFLICT (user_id) DO UPDATE SET generation = excluded.generation`).run(w.user,w.user);
    db.exec('COMMIT');};};
const beforeNextTransaction=(store,change)=>{const original=store.memoryTransaction;
  store.memoryTransaction=function(fn){store.memoryTransaction=original;change();return original.call(this,fn);};};

test('LW-14: organize apply compares its generation-bound token inside the transaction; delete then restore with an identical selection stays stale',async t=>{
  const w=await world(t),{store}=w,organizer=store.consoleService.organizer,writer=writerOf(w,'lw14'),change=otherWriter(t,w);
  const request={category:'technical',all:true},state=()=>[count(w,'memory_category_overrides'),count(w,'console_organize_batches')];
  // Delete then restore: the selection is identical again, only the lifecycle generation moved.
  let preview=organizer.preview(writer,request);
  w.mutate('proj-lr-live','deleted');w.mutate('proj-lr-live','active');
  const visible=v=>({total:v.total,matched:v.matched,by_category:v.by_category,sample:v.sample});
  assert.deepEqual(visible(organizer.preview(writer,request)),visible(preview),'the visible selection is unchanged');
  assert.ok(preview.matched>0);
  const before=state();
  assert.throws(()=>organizer.organize(writer,{...request,preview_token:preview.preview_token}),{errorCode:'PREVIEW_CHANGED'});
  assert.deepEqual(state(),before);
  // A lifecycle change committed on another connection after the token was read but before the apply transaction
  // begins: the comparison inside the transaction sees it (an unrelated project, so the selection is unchanged).
  store.upsertProject(w.a.auth,{project_id:'proj-lw14-probe',name:'LW14 probe'});
  preview=organizer.preview(writer,request);
  beforeNextTransaction(store,()=>change('proj-lw14-probe'));
  assert.throws(()=>organizer.organize(writer,{...request,preview_token:preview.preview_token}),{errorCode:'PREVIEW_CHANGED'});
  assert.deepEqual(state(),before);assert.equal(store.db.isTransaction,false);
  // Control: a fresh preview applies.
  preview=organizer.preview(writer,request);
  assert.equal(organizer.organize(writer,{...request,preview_token:preview.preview_token}).status,'organized');
});

test('LW-15: a supersede replay checks the replacement on its own: an unavailable replacement is never returned',async t=>{
  const w=await world(t),{store,a,m}=w;
  const first=store.supersedeMemory(a.auth,m.live,{content:'LW15 corrected live record'});
  const again=()=>store.supersedeMemory(a.auth,m.live,{content:'LW15 corrected live record'});
  assert.equal(again().replacement_memory.memory_id,first.replacement_memory.memory_id,'control: the replay returns the replacement while both are readable');
  // The original stays live; only the replacement's project reference becomes unavailable (dangling).
  store.db.prepare("UPDATE memories SET project_id='proj-lw15-never' WHERE memory_id=?").run(first.replacement_memory.memory_id);
  assert.equal(store.lifecycle.projectState(w.user,'proj-lr-live'),'live');
  assert.throws(again,{errorCode:'MEMORY_NOT_FOUND'});
});

test('LW-16: cloud supersede/retract denials (foreign, stale revision, removed grant, keep-private, ungranted merged sibling) leave nothing; a granted live merged member works',async t=>{
  const w=await world(t),{store,a}=w;Object.assign(store.runtime,{cloudMemory:true,cloudSubmittedGrant:true});
  const c=w.credential('chatgpt-web','cloud-lw16',[...CLOUD_CORE_SCOPES]),connection='e'.repeat(64);
  store.cloudMemory.bind(c.auth,{connection_id:connection,account_id:'synthetic-lw16',security_version:1,allow_submitted_revision_grant:true});
  const act=(action,payload)=>w.request('POST','/v1/cloud-memory/operations',{connection_id:connection,action,operation_id:randomUUID(),payload},c);
  const save=async(project,label,cloud_read)=>{const r=await act('memory.save',{scope:'project',project_id:project,content:`LW16 ${label}`,cloud_read});assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  const granted=await save('proj-lr-tgt','granted target record','allow_submitted_revision');
  const privateOne=await save('proj-lr-tgt','kept private record','keep_private');
  const revoked=await save('proj-lr-tgt','grant later removed','allow_submitted_revision');
  const latest=id=>store.revisions.latest(w.user,id);
  store.webVisibility.set(a.auth,revoked.memory_id,{allow:false,revision:latest(revoked.memory_id).revision,state_hash:latest(revoked.memory_id).state_hash});
  const foreign=w.foreignMemory;
  // An active record of the merged source, never granted: membership never lends it the target record's grant.
  const sibling=w.m.src;
  const snapshot=()=>JSON.stringify([count(w,'memories'),count(w,'memory_web_grants'),count(w,'memory_privacy'),count(w,'memory_revisions'),count(w,'project_route_log')]);
  const before=snapshot();
  const cases=[['foreign owner',foreign,1,404,'MEMORY_NOT_FOUND'],['stale expected revision',granted.memory_id,granted.revision+1,409,'MEMORY_VERSION_CHANGED'],
    ['removed exact grant',revoked.memory_id,revoked.revision,404,'MEMORY_NOT_FOUND'],['keep-private',privateOne.memory_id,privateOne.revision,404,'MEMORY_NOT_FOUND'],
    ['ungranted merged sibling',sibling,latest(sibling).revision,404,'MEMORY_NOT_FOUND']];
  for(const [label,id,revision,status,code] of cases)for(const action of ['memory.supersede','memory.retract']){
    const payload=action==='memory.retract'?{memory_id:id,expected_revision:revision,reason:'r'}:{memory_id:id,expected_revision:revision,content:'LW16 correction',reason:'r',cloud_read:'allow_submitted_revision'};
    const r=await act(action,payload);assert.deepEqual([r.status,r.body.error_code],[status,code],`${label}: ${action}`);
  }
  assert.equal(snapshot(),before,'no record, grant, privacy row, revision or route was written by any denial');
  // Control: the granted live record of the merged group can be corrected; the replacement stays in the canonical project.
  const ok=await act('memory.supersede',{memory_id:granted.memory_id,expected_revision:granted.revision,content:'LW16 granted correction',reason:'r',cloud_read:'keep_private'});
  assert.equal(ok.status,200,JSON.stringify(ok.body));
  assert.equal(store.db.prepare('SELECT project_id FROM memories WHERE memory_id=?').get(ok.body.memory_id).project_id,'proj-lr-tgt');
});

test('LW-17: an injected failure at the end of organize, classify, undo, web-grant and privacy writes rolls every row and success audit back',async t=>{
  const w=await world(t),{store,a,m}=w,organizer=store.consoleService.organizer,writer=writerOf(w,'lw17'),audit=store.audit.bind(store);
  const tables=['memory_category_overrides','console_organize_items','console_organize_batches','memory_derived_outbox','memory_summaries','memory_privacy','memory_web_grants','audit_events'];
  const snapshot=()=>tables.map(name=>rows(w,name)).join('\n');
  const failAt=action=>{store.audit=input=>{if(input.action===action)throw new Error(`synthetic failure at ${action}`);return audit(input);};};
  t.after(()=>{store.audit=audit;});
  const attempt=(action,run)=>{const before=snapshot();failAt(action);assert.throws(run,new RegExp(`synthetic failure at ${action.replace('.','\\.')}`));store.audit=audit;
    assert.equal(store.db.isTransaction,false,action);assert.equal(snapshot(),before,`${action}: nothing remains`);};
  const request={category:'technical',all:true};
  attempt('memory.category.batch',()=>organizer.organize(writer,{...request,preview_token:organizer.preview(writer,request).preview_token}));
  const live=store.revisions.latest(w.user,m.live);
  attempt('memory.category.batch',()=>organizer.classify(writer,[{memory_id:m.live,revision:live.revision}],'technical',{kind:'classify'}));
  const applied=organizer.organize(writer,{...request,preview_token:organizer.preview(writer,request).preview_token});
  attempt('memory.category.undo',()=>organizer.undo(writer,{batch_id:applied.batch_id}));
  attempt('memory.web_visibility',()=>store.webVisibility.set(a.auth,m.live,{allow:true,revision:live.revision,state_hash:live.state_hash}));
  attempt('memory.sensitivity.set',()=>store.memorySources.setSensitivity(writer,m.live,'internal'));
  // Controls: each write succeeds without the injected failure.
  assert.equal(organizer.undo(writer,{batch_id:applied.batch_id}).status,'undone');
  assert.equal(store.memorySources.setSensitivity(writer,m.live,'internal').sensitivity,'internal');
});

test('LW-18: a save first made through a project before its merge replays through the same old ID afterwards without conflict or retargeting',async t=>{
  const w=await world(t),{store,a}=w;
  for(const id of ['proj-lw18-s','proj-lw18-t'])store.upsertProject(a.auth,{project_id:id,name:`LW18 ${id}`});
  const request={scope:'project',project_id:'proj-lw18-s',content:'LW18 saved before the merge',operation_id:'lw18-op'};
  const first=store.saveMemory(a.auth,request).memory;
  w.mutate('proj-lw18-s','merged','proj-lw18-t');
  const routesBefore=routes(w).length,memoriesBefore=count(w,'memories');
  const replay=store.saveMemory(a.auth,request);
  assert.deepEqual([replay.idempotent,replay.memory.memory_id],[true,first.memory_id]);
  assert.equal(store.db.prepare('SELECT project_id FROM memories WHERE memory_id=?').get(first.memory_id).project_id,'proj-lw18-s','the original record is never retargeted');
  assert.deepEqual([routes(w).length,count(w,'memories')],[routesBefore,memoriesBefore]);
  assert.throws(()=>store.saveMemory(a.auth,{...request,content:'LW18 a different intent'}),{errorCode:'IDEMPOTENCY_CONFLICT'});
});

test('LW-19: deleting a category moves only live records in its counted, undoable batch; deleted-project records follow as maintenance',async t=>{
  const w=await world(t),{store,m}=w,service=store.consoleService,writer=writerOf(w,'lw19');
  const taxonomy=service.taxonomy(w.user);
  const created=service.features.categories.create(writer,{label:'LW19 temporary',expected_revision:taxonomy.revision??0});
  const category=created.category;
  const set=(id,value)=>store.db.prepare('INSERT OR REPLACE INTO memory_category_overrides VALUES (?,?,?,1)').run(w.user,id,value);
  set(m.live,category);set(m.dead,category);
  const removed=service.features.categories.remove(writer,{category,move_to:'uncategorized',expected_revision:created.revision},service.organizer);
  assert.equal(removed.moved,1,'only the live record is counted');
  const items=store.db.prepare('SELECT memory_id FROM console_organize_items WHERE batch_id=?').all(removed.batch_id).map(r=>r.memory_id);
  assert.deepEqual(items,[m.live],'the deleted-project record gets no organize item');
  const categoryOf=id=>store.db.prepare('SELECT category FROM memory_category_overrides WHERE memory_id=?').get(id)?.category;
  assert.equal(categoryOf(m.dead),'uncategorized','the hidden record does not keep a removed category');
  assert.equal(categoryOf(m.live),'uncategorized');
});

test('LW-20: a manual category write rechecks its target under the write lock (a deletion committed just before it begins)',async t=>{
  const w=await world(t),{store,m}=w,writer=writerOf(w,'lw20'),change=otherWriter(t,w);
  const taxonomy=store.consoleService.taxonomy(w.user),overrides=()=>count(w,'memory_category_overrides','memory_id=?',m.live);
  const before=overrides();
  // The pre-check passes (live); the project is deleted on another connection before the write transaction begins.
  beforeNextTransaction(store,()=>change('proj-lr-live'));
  assert.throws(()=>store.derivedMemory.setCategory(writer,m.live,'technical',taxonomy),{code:'INVALID_CATEGORY_TARGET'});
  assert.equal(overrides(),before,'no override for a record whose project was deleted');
  assert.equal(store.db.isTransaction,false);
  // Control: a live record still accepts a manual category.
  assert.equal(store.derivedMemory.setCategory(writer,m.tgt,'technical',taxonomy).category,'technical');
});
