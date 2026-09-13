import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {MnemuronStore} from '../lib/store.mjs';
import {createMnemuronApp} from '../lib/app.mjs';
import {toolsForRuntime,listRuntimeTools,callTool} from '../../plugins/mnemuron/scripts/mcp-core.mjs';
import {copyLegacyFixture} from './helpers/legacy-fixture.mjs';

const config={config_version:'mnemuron-memory-first-v1',deployment_mode:'production',modules:{memory:{enabled:true},handoff:{enabled:false,existing_inflight_policy:'drain_before_disable'}},memory:{capture_extraction:{enabled:true}}};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scopes=['memory:read','memory:write','capture:write','resume:read','resume:confirm','admin:tasks','admin:devices','task:reconcile:read','task:reconcile:confirm'];
const syntheticKey=store=>store.issueCredential({label:'Synthetic fixture',userId:'owner-fixture',deviceId:'device-fixture',agentId:'test',agentInstanceId:'agent-fixture',scopes});
function setup(t,memoryConfig=config) {
  const root=mkdtempSync(path.join(os.tmpdir(),'mnemuron-memory-first-')),databasePath=root+'/synthetic.sqlite3';
  const app=createMnemuronApp({databasePath,memoryConfig});
  t.after(async()=>{if(app.server.listening) await app.close();else app.store.close();rmSync(root,{recursive:true,force:true});});
  const credential=syntheticKey(app.store),auth=app.store.authenticate(credential.api_key);
  return {root,databasePath,app,store:app.store,auth,credential};
}
const count=(store,table)=>store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const row=(store,id)=>store.db.prepare('SELECT * FROM memories WHERE memory_id=?').get(id);
const task={task_id:'task-memory-first',project_id:'project-memory-first',project_name:'Example',title:'Example: memory-first',goal:'Synthetic goal',status:'active',workstreams:[{workstream_id:'work-a',name:'Example',status:'active'}]};

test('M-01 M-02 M-08: memory-only saves, reads, revises and enqueues without any handoff scope',async t=>{
  const f=setup(t),s=f.store;
  for (const method of ['createCheckpointFromTrigger','runReconciliation','createPreview']) s[method]=()=>{throw new Error('Unexpected handoff dispatch');};
  const saved=s.saveMemory(f.auth,{content:'Device firmware is version 1.2.3',scope:'user',operation_id:'save-1'}).memory;
  assert.equal(s.queryMemories(f.auth,{query:'1.2.3'}).results[0].memory_id,saved.memory_id);
  const detail=s.memoryDetail(f.auth,saved.memory_id);
  assert.equal(detail.content_complete,true);assert.equal(detail.source_manifest.revision,1);
  assert.equal(detail.source_manifest.sources[0].source_kind,'explicit_memory');
  assert.equal(count(s,'memory_processing_outbox'),2);assert.equal(count(s,'memory_index_outbox'),1);
  assert.deepEqual(s.db.prepare('SELECT DISTINCT state FROM memory_processing_outbox').all().map(r=>r.state),['blocked_config']);
  s.saveMemory(f.auth,{content:saved.content,scope:'user',operation_id:'save-1'});
  assert.equal(count(s,'memory_processing_outbox'),2);
  s.appendEvents(f.auth,{event:{event_id:'independent-source',event_type:'assistant_message',content:'事实：来源保留完整标点 1-2-3。'}});
  assert.equal(count(s,'memories'),2);assert.equal(count(s,'checkpoints'),0);assert.equal(count(s,'task_reconciliation_proposals'),0);
  assert.equal(count(s,'tasks'),0);assert.equal(count(s,'resumes'),0);
  const correction=s.supersedeMemory(f.auth,saved.memory_id,{content:'Device firmware is version 2.0.1'});
  s.retractMemory(f.auth,correction.replacement_memory.memory_id);
  assert.equal(s.queryMemories(f.auth,{query:'2.0.1'}).results.length,0);
  assert.equal(s.status(f.auth).production_ready,false);
  for (const file of readdirSync(new URL('../lib/memory/',import.meta.url))) {
    assert.doesNotMatch(readFileSync(new URL('../lib/memory/'+file,import.meta.url),'utf8'),/from\s+["'][^"']*handoff/);
  }
});
test('M-03 M-05: handoff writes reject explicitly, existing installations retain legacy behavior and a notice',t=>{
  const f=setup(t);
  for(const method of ['upsertTask','upsertProject','createPreview','confirmPreview','createTaskBootstrapPreview','confirmTaskBootstrap',
    'createProjectBootstrapPreview','confirmProjectBootstrap','createCheckpoint','runReconciliation','resolveReconciliation']) {
    assert.throws(()=>f.store[method](f.auth,{}),e=>e.errorCode==='HANDOFF_DISABLED',method);
  }
  const legacy=setup(t,null);
  assert.equal(legacy.store.handoffPolicy.enabled(),true);
  assert.equal(legacy.store.status(legacy.auth).memory_runtime.legacy_compatibility,true);
  assert.match(legacy.store.status(legacy.auth).memory_runtime.migration_notice,/Legacy/);
});
test('M-03: local tool discovery follows central memory-only policy without invoking Resume',async t=>{
  const f=setup(t),address=await f.app.listen({host:'127.0.0.1',port:0});
  const env={MNEMURON_MODE:'remote',MNEMURON_CONFIG_PATH:f.root+'/absent',MNEMURON_SERVER_URL:`http://127.0.0.1:${address.port}`,
    MNEMURON_API_KEY:f.credential.api_key,MNEMURON_ALLOW_INSECURE_HTTP:'true'};
  const tools=await listRuntimeTools(env);
  assert.ok(tools.some(t=>t.name==='mnemuron_remember'));assert.ok(!tools.some(t=>t.name==='mnemuron_preview_resume'));
  assert.ok(!tools.some(t=>t.name==='mnemuron_take_pending_resume'));
  const local={MNEMURON_CONFIG_PATH:f.root+'/absent',MNEMURON_HANDOFF_ENABLED:'false'};
  assert.ok(!toolsForRuntime(local).some(t=>t.name==='mnemuron_confirm_resume'));
  await assert.rejects(callTool('mnemuron_confirm_resume',{},local),e=>e.errorCode==='HANDOFF_DISABLED');
  assert.equal(count(f.store,'resumes'),0);
});
test('M-04 M-06: disabling drains the same in-flight attempt, retaining failed history and exact ownership across restart',t=>{
  const f=setup(t,null),s=f.store;s.upsertTask(f.auth,task);
  const preview=s.createPreview(f.auth,{query:task.task_id});s.confirmPreview(f.auth,preview.resume_id,1,true);
  const common={preview_version:1,session_id:'session-real-fixture',workstream_id:'work-a',delivery_method:'codex-mcp-tool-result',occurred_at:new Date().toISOString()};
  s.recordDeliveryReceipt(f.auth,preview.resume_id,{...common,receipt_id:'attempt-old',receipt_event_id:'old-delivered',phase:'delivered'});
  s.recordDeliveryReceipt(f.auth,preview.resume_id,{...common,receipt_id:'attempt-old',receipt_event_id:'old-failed',phase:'failed',error_code:'adapter_restarted'});
  s.recordDeliveryReceipt(f.auth,preview.resume_id,{...common,receipt_id:'attempt-current',receipt_event_id:'new-delivered',phase:'delivered'});
  const before=digest(['tasks','resumes','resume_delivery_receipts'].map(table=>s.db.prepare(`SELECT * FROM ${table}`).all()));
  const draining=new MnemuronStore(f.databasePath,{memoryConfig:config});t.after(()=>draining.close());
  assert.equal(before,digest(['tasks','resumes','resume_delivery_receipts'].map(table=>draining.db.prepare(`SELECT * FROM ${table}`).all())));
  assert.equal(draining.handoffPolicy.status(f.auth.user_id).state,'draining');
  const ack={...common,receipt_id:'attempt-current',receipt_event_id:'new-ack',phase:'acknowledged',turn_id:'synthetic-host-stop-turn'};
  assert.throws(()=>draining.recordDeliveryReceipt(f.auth,preview.resume_id,{...ack,session_id:'wrong-session'}),e=>e.statusCode===409);
  assert.throws(()=>draining.recordDeliveryReceipt(f.auth,preview.resume_id,{...ack,phase:'delivered',receipt_id:'third-attempt'}),e=>e.errorCode==='HANDOFF_DRAIN_RETRY_DENIED');
  draining.recordDeliveryReceipt(f.auth,preview.resume_id,ack);
  assert.equal(draining.handoffPolicy.status(f.auth.user_id).state,'disabled');
  const restarted=new MnemuronStore(f.databasePath,{memoryConfig:config});t.after(()=>restarted.close());
  assert.equal(restarted.recordDeliveryReceipt(f.auth,preview.resume_id,ack).duplicate,1);
  assert.equal(count(restarted,'resume_delivery_receipts'),4);assert.equal(restarted.deliveryReceiptStatus(f.auth,preview.resume_id).ack_complete,true);
  assert.equal(restarted.handoffPolicy.enabled(),false);
});
test('D-01 D-02: migration from the frozen pre-Memory First source preserves original row digests and legacy dedup IDs',async t=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'mnemuron-legacy-head-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const oldCode=copyLegacyFixture('pre-memory-first',path.join(root,'old-code'));
  const {MnemuronStore:LegacyStore}=await import(pathToFileURL(path.join(oldCode,'store.mjs')));
  const database=root+'/legacy.sqlite3',legacy=new LegacyStore(database),key=syntheticKey(legacy),auth=legacy.authenticate(key.api_key);
  legacy.upsertTask(auth,task);
  const original=legacy.saveMemory(auth,{content:'Original explicit content',scope:'user'}).memory;
  legacy.supersedeMemory(auth,original.memory_id,{content:'Corrected explicit content'});
  const removed=legacy.saveMemory(auth,{content:'Retracted fixture',scope:'user'}).memory;legacy.retractMemory(auth,removed.memory_id);
  const event={event_id:'legacy-source',event_type:'assistant_message',task_id:task.task_id,project_id:task.project_id,workstream_id:'work-a',session_id:'legacy-session',content:'事实：设备版本：1.2.3'};
  legacy.appendEvents(auth,{event});
  const tables=['memories','events','tasks','checkpoints','resumes','resume_delivery_receipts'];
  const before=tables.map(table=>digest(legacy.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const derivedId=legacy.db.prepare("SELECT memory_id FROM memories WHERE source='checkpoint_derived'").get().memory_id;
  legacy.close();
  const migrated=new MnemuronStore(database);t.after(()=>migrated.close());
  assert.deepEqual(tables.map(table=>digest(migrated.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())),before);
  const revisions=digest(migrated.db.prepare('SELECT * FROM memory_revisions ORDER BY memory_id').all());
  const reopened=new MnemuronStore(database);t.after(()=>reopened.close());
  assert.equal(digest(reopened.db.prepare('SELECT * FROM memory_revisions ORDER BY memory_id').all()),revisions);
  assert.equal(reopened.memorySearch.status().state,'ready');
  reopened.appendEvents(auth,{event});assert.equal(count(reopened,'memories'),4);
  assert.equal(reopened.db.prepare("SELECT memory_id FROM memories WHERE content='设备版本：1.2.3'").get().memory_id,derivedId);
  assert.equal(row(reopened,derivedId).content_fingerprint.length,64);
});
test('D-04 D-05 D-08: source replay links additional exact sources without cross-owner merges; expired raw is unavailable',t=>{
  const f=setup(t),s=f.store,content='事实：设备版本：1.2.3';
  for(const id of ['source-one','source-two']) s.appendEvents(f.auth,{event:{event_id:id,event_type:'user_message',content}});
  assert.equal(count(s,'memories'),1);
  const id=s.db.prepare('SELECT memory_id FROM memories').get().memory_id;
  assert.equal(s.memoryDetail(f.auth,id).source_manifest.sources.length,2);
  const other=s.issueCredential({userId:'other-owner',agentInstanceId:'other-agent',deviceId:'other-device',agentId:'test',scopes:['capture:write','memory:read']});
  s.appendEvents(s.authenticate(other.api_key),{event:{event_id:'other-source',event_type:'user_message',content}});
  assert.equal(count(s,'memories'),2);
  s.appendEvents(f.auth,{event:{event_id:'source-one',event_type:'user_message',content}});assert.equal(count(s,'memories'),2);
  s.db.prepare("UPDATE events SET expired_at='2000-01-01',content=NULL,raw_payload_json=NULL WHERE event_id='source-one'").run();
  const source=s.memoryDetail(f.auth,id).source_manifest.sources.find(x=>x.source_event_id==='source-one');
  assert.equal(source.source_status,'unavailable');assert.ok(source.content_hash);assert.equal(row(s,id).content,'设备版本：1.2.3');
});
test('D-06 D-07: revision/outbox/audit failures roll back save, correction and retraction; suggestions never overwrite',t=>{
  const f=setup(t),s=f.store;
  s.db.exec("CREATE TEMP TRIGGER fail_job BEFORE INSERT ON memory_processing_outbox BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  assert.throws(()=>s.saveMemory(f.auth,{content:'must rollback',scope:'user'}));
  for(const table of ['memories','memory_revisions','memory_sources','memory_index_outbox']) assert.equal(count(s,table),0);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='memory.create'").get().n,0);
  s.db.exec('DROP TRIGGER fail_job');
  const saved=s.saveMemory(f.auth,{content:'Authoritative version 1.2.3',scope:'user'}).memory;
  s.appendEvents(f.auth,{event:{event_id:'assistant-advice',event_type:'assistant_message',content:'事实：Authoritative version 1-2-3'}});
  const advice=s.db.prepare("SELECT memory_id FROM memories WHERE source='capture_derived'").get();
  assert.equal(s.memoryDetail(f.auth,advice.memory_id).source_manifest.evidence_kind,'assistant_suggestion');
  assert.equal(s.memoryDetail(f.auth,saved.memory_id).source_manifest.evidence_kind,'explicit_user_assertion');
  assert.equal(row(s,saved.memory_id).status,'active');assert.equal(row(s,saved.memory_id).content,saved.content);
  const before=digest(s.db.prepare('SELECT * FROM memories ORDER BY memory_id').all());
  s.db.exec("CREATE TEMP TRIGGER fail_revision BEFORE INSERT ON memory_revisions BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  assert.throws(()=>s.retractMemory(f.auth,saved.memory_id));assert.throws(()=>s.supersedeMemory(f.auth,saved.memory_id,{content:'Rejected correction'}));
  assert.equal(digest(s.db.prepare('SELECT * FROM memories ORDER BY memory_id').all()),before);
});

test('D-04 D-05: exact source versions and Unicode spans remain unambiguous across source formats and scopes',t=>{
  const f=setup(t),s=f.store,body='事实：固件 😀 v1.2.3，不是 v1-2-3';
  for (const [eventId,session,content] of [['span-string','session-a',body],['span-object','session-a',{text:body}],['other-scope','session-b',body]]) {
    s.appendEvents(f.auth,{event:{event_id:eventId,event_type:'user_message',session_id:session,content}});
  }
  assert.equal(count(s,'memories'),2);
  const memory=s.db.prepare("SELECT * FROM memories WHERE session_id='session-a'").get();
  const manifest=s.memoryDetail(f.auth,memory.memory_id).source_manifest;
  assert.equal(manifest.sources.length,2);assert.equal(manifest.evidence_kind,'observed_user_statement');
  for(const source of manifest.sources) {
    assert.equal(source.source_revision,1);assert.equal(source.span_available,true);
    assert.equal(body.slice(source.span_start,source.span_end),memory.content);
    assert.equal(source.text_selector,source.source_event_id==='span-string'?'$':'$.text');
  }
  const explicit=s.saveMemory(f.auth,{content:'😀 exact original',scope:'user'}).memory;
  const source=s.memoryDetail(f.auth,explicit.memory_id).source_manifest.sources[0];
  assert.equal(explicit.content.slice(source.span_start,source.span_end),explicit.content);
  s.db.prepare("UPDATE events SET content=NULL,expired_at='2000-01-01' WHERE event_id='span-string'").run();
  assert.equal(s.memoryDetail(f.auth,memory.memory_id).source_manifest.sources.find(x=>x.source_event_id==='span-string').source_status,'unavailable');
});

test('M-03 M-04 M-06: confirmed but undelivered handoff can drain once; disabling memory preserves authorized reads',t=>{
  const f=setup(t,null),s=f.store;s.upsertTask(f.auth,task);
  const saved=s.saveMemory(f.auth,{content:'Keep readable',scope:'user'}).memory;
  const preview=s.createPreview(f.auth,{query:task.task_id});s.confirmPreview(f.auth,preview.resume_id,1,true);
  const disabled=new MnemuronStore(f.databasePath,{memoryConfig:{...config,modules:{...config.modules,memory:{enabled:false}}}});t.after(()=>disabled.close());
  assert.equal(disabled.memoryDetail(f.auth,saved.memory_id).memory.content,saved.content);
  assert.throws(()=>disabled.saveMemory(f.auth,{content:'not allowed'}),e=>e.errorCode==='MEMORY_DISABLED');
  assert.throws(()=>disabled.retractMemory(f.auth,saved.memory_id),e=>e.errorCode==='MEMORY_DISABLED');
  assert.equal(disabled.handoffPolicy.status(f.auth.user_id).state,'draining');
  const receipt={preview_version:1,receipt_id:'first-drain',session_id:'real-drain-session',workstream_id:'work-a',delivery_method:'codex-mcp-tool-result',occurred_at:new Date().toISOString()};
  disabled.recordDeliveryReceipt(f.auth,preview.resume_id,{...receipt,receipt_event_id:'first-delivery',phase:'delivered'});
  disabled.recordDeliveryReceipt(f.auth,preview.resume_id,{...receipt,receipt_event_id:'first-ack',phase:'acknowledged',turn_id:'real-stop-fixture'});
  assert.equal(disabled.handoffPolicy.status(f.auth.user_id).state,'disabled');
  assert.equal(disabled.deliveryReceiptStatus(f.auth,preview.resume_id).ack_complete,true);
  assert.equal(count(disabled,'resume_delivery_receipts'),2);
});

test('D-02 D-06: aborted companion migration rolls back and closes its connection before a clean restart',t=>{
  const f=setup(t),s=f.store;
  const saved=s.saveMemory(f.auth,{content:'Unchanged migration fixture',scope:'user'}).memory;
  const before=digest(s.db.prepare('SELECT * FROM memories').all());
  s.db.exec("DELETE FROM memory_revisions; CREATE TRIGGER reject_backfill BEFORE INSERT ON memory_revisions BEGIN SELECT RAISE(ABORT,'fixture migration interruption'); END");
  assert.throws(()=>new MnemuronStore(f.databasePath,{memoryConfig:config}),/fixture migration interruption/);
  assert.equal(count(s,'memory_revisions'),0);assert.equal(digest(s.db.prepare('SELECT * FROM memories').all()),before);
  s.db.exec('DROP TRIGGER reject_backfill');
  const reopened=new MnemuronStore(f.databasePath,{memoryConfig:config});t.after(()=>reopened.close());
  assert.equal(reopened.memoryDetail(f.auth,saved.memory_id).source_manifest.revision,1);
  assert.equal(digest(reopened.db.prepare('SELECT * FROM memories').all()),before);
});
