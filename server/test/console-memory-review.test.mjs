import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {MnemuronStore} from '../lib/store.mjs';
import {consoleRead} from '../lib/console-read.mjs';
import {ConsoleMemoryReview} from '../lib/console/memory-review.mjs';
import {CONSOLE_READ_SCOPES,CONSOLE_BASIC_SCOPES,CONSOLE_WRITE_SCOPES} from '../../shared/console-contract.mjs';

function setup(t,{handoff=false}={}){const root=mkdtempSync(path.join(os.tmpdir(),'mnemuron-review-test-'));
  const store=new MnemuronStore(path.join(root,'synthetic.sqlite3'),{memoryConfig:{config_version:'mnemuron-memory-first-v1',deployment_mode:'test',development:{synthetic_data:true},
    modules:{memory:{enabled:true},handoff:{enabled:handoff,existing_inflight_policy:'drain_before_disable'}},memory:{capture_extraction:{enabled:false}}}});
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const issue=(user,scopes,agent='mnemuron-console')=>store.authenticate(store.issueCredential({userId:user,deviceId:'synthetic-console',agentId:agent,agentInstanceId:randomUUID(),scopes}).api_key);
  const a=issue('synthetic-review-a',CONSOLE_WRITE_SCOPES),b=issue('synthetic-review-b',CONSOLE_WRITE_SCOPES),read=issue(a.user_id,CONSOLE_READ_SCOPES),basic=issue(a.user_id,CONSOLE_BASIC_SCOPES),mcp=issue(a.user_id,['memory:read','resume:read'],'chatgpt-web');
  const capture=issue(a.user_id,['capture:write','memory:read'],'synthetic-capture');
  const act=(action,payload,auth=a,operation_id=randomUUID())=>store.consoleService.execute(auth,{action,payload,operation_id});
  const get=(view,params={},auth=a)=>consoleRead(store,auth,view,params);
  const append=(event_id,content,event_type='user_message')=>store.appendEvents(capture,{event:{event_id,event_type,session_id:'synthetic-review-session',captured_at:new Date().toISOString(),content}});
  const save=(content,scope={scope:'user'},auth=a)=>store.saveMemory(auth,{content,...scope}).memory.memory_id;
  return {root,store,a,b,read,basic,mcp,capture,act,get,append,save};
}
const code=c=>error=>error.errorCode===c;
const counts=store=>Object.fromEntries(['memories','memory_revisions','memory_processing_outbox','memory_index_outbox','memory_entity_members','memory_summaries'].map(table=>[table,store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]));
async function preview(f,id='synthetic-event',content='事实：合成设备版本是 17.12.3。'){
  f.append(id,content);const before=await f.get('review-candidates'),event=before.events.find(e=>e.event_id===id);
  assert.ok(event);const payload={event_id:id,source_hash:event.source_hash};await f.act('review.extract',payload);
  return {payload,candidates:(await f.get('review-candidates',{event_id:id})).candidates};
}
function summary(f,contents=['合成设备版本是 17.12.3。🙂 已经完成测试。','第二个合成来源保留否定：尚未部署。']){
  const sources=contents.map(text=>{const memoryId=f.save(text.slice(0,4096));
    // Historical/imported records may exceed the explicit-save limit; seed only this isolated synthetic fixture.
    if(text.length>4096){f.store.db.prepare('UPDATE memories SET content=? WHERE user_id=? AND memory_id=?').run(text,f.a.user_id,memoryId);f.store.revisions.record(f.store.db.prepare('SELECT * FROM memories WHERE memory_id=?').get(memoryId),'synthetic_import');}
    return f.store.derivedMemory.currentSource(f.a.user_id,memoryId);}),version=f.store.consoleService.taxonomy(f.a.user_id).version;
  const claims=sources.slice(0,1).map(s=>({memory_id:s.memory_id,revision:s.revision,start:0,end:s.content.length,quote:s.content}));
  const job={job_id:randomUUID(),group_key:randomUUID(),user_id:f.a.user_id,scope_key:sources[0].scope_key,profile:'synthetic',metadata:{category:'all',window:{period:'daily'},taxonomy:{version}}};
  const id=f.store.memoryTransaction(()=>f.store.derivedMemory.publishSummary(job,sources,claims,Date.now()));return {id,sources,claims};
}

test('review previews are explicit, explainable, raw-source bounded and never become active memory before acceptance',async t=>{
  const f=setup(t),before=counts(f.store),{payload,candidates}=await preview(f);
  assert.deepEqual(counts(f.store),before);assert.equal(candidates.length,1);const c=candidates[0];
  assert.equal(c.content,'合成设备版本是 17.12.3。');assert.equal(c.source_context.slice(c.span_start,c.span_end),c.content);
  assert.equal(c.independently_verified,false);assert.equal(c.role,'user_message');
  await f.act('review.extract',payload);assert.equal((await f.get('review-candidates')).candidates.length,1);
  const accepted=await f.act('review.candidate',{candidate_id:c.candidate_id,revision:c.revision,decision:'accept',confirmed:true,content:'合成设备版本是 17.12.3，已人工确认。'});
  assert.ok(accepted.memory_id);assert.equal(counts(f.store).memories,1);assert.equal((await f.get('review-candidates')).candidates.length,0);
  const sources=f.store.revisions.detail(f.a.user_id,accepted.memory_id).sources;
  assert.equal(sources.find(s=>s.source_kind==='captured_event').span_start,c.span_start);
  assert.equal((await f.get('memory-review',{memory_id:accepted.memory_id})).left.text,'合成设备版本是 17.12.3，已人工确认。');
  await assert.rejects(f.act('review.candidate',{candidate_id:c.candidate_id,revision:c.revision,decision:'accept',confirmed:true}),code('STALE_INPUT'));
});

test('preview rejects forged sources, scope elevation and foreign ownership, and no read silently changes capture',async t=>{
  const f=setup(t),{payload,candidates:[c]}=await preview(f);
  for(const auth of [f.read,f.basic,f.mcp]){
    await assert.rejects(f.act('review.extract',payload,auth));
    await assert.rejects(f.get('review-candidates',{},auth));
  }
  await assert.rejects(f.act('review.extract',payload,f.b));
  await assert.rejects(f.act('review.extract',{...payload,content:'fabricated'}),code('INVALID_CONSOLE_INPUT'));
  await assert.rejects(f.act('review.candidate',{candidate_id:c.candidate_id,revision:1,decision:'accept',confirmed:true,scope:'user'}),code('INVALID_CONSOLE_INPUT'));
  await assert.rejects(f.act('review.candidate',{candidate_id:c.candidate_id,revision:1,decision:'accept'}),code('CONFIRMATION_MISMATCH'));
  await f.act('review.candidate',{candidate_id:c.candidate_id,revision:1,decision:'dismiss'});
  await f.act('review.extract',payload);assert.equal((await f.get('review-candidates')).candidates.length,0);
  assert.equal(f.store.memoryConfig.memory.capture_extraction.enabled,false);assert.equal(counts(f.store).memories,0);
});

test('source expiry, edits, changed scope and withdrawn saved result invalidate new decisions and replay receipts',async t=>{
  for(const change of ['expired','edited','scope','retracted']){const f=setup(t),{candidates:[c]}=await preview(f,'synthetic-event-'+change);
    const payload={candidate_id:c.candidate_id,revision:1,decision:'accept',confirmed:true},op=randomUUID(),saved=await f.act('review.candidate',payload,f.a,op);
    assert.equal((await f.act('review.candidate',payload,f.a,op)).replayed,true);
    if(change==='expired')f.store.db.prepare('UPDATE events SET expires_at=? WHERE event_id=?').run('2000-01-01T00:00:00.000Z',c.event_id);
    if(change==='edited')f.store.db.prepare('UPDATE events SET content=? WHERE event_id=?').run(JSON.stringify('different synthetic body'),c.event_id);
    if(change==='scope')f.store.db.prepare('UPDATE events SET session_id=? WHERE event_id=?').run('other-synthetic-session',c.event_id);
    if(change==='retracted')f.store.retractMemory(f.a,saved.memory_id);
    await assert.rejects(f.act('review.candidate',payload,f.a,op),code('STALE_INPUT'));
  }
});

test('summary comparison counts exact UTF-16 characters, omitted sources and only version-matched manual feedback',async t=>{
  const f=setup(t),s=summary(f),view=await f.get('summary-quality',{summary_id:s.id});
  assert.equal(view.metrics.source_characters,s.sources.reduce((n,x)=>n+x.content.length,0));
  assert.equal(view.metrics.excerpt_characters,s.claims[0].quote.length);assert.equal(view.metrics.omitted_sources,1);
  assert.equal(view.metrics.semantic_completeness_verified,false);assert.equal(view.claims[0].exact_match,true);
  const payload={summary_id:s.id,revision:view.revision,source_digest:view.source_digest,decision:'missing_context'};
  await f.act('review.summary',payload);assert.equal((await f.get('summary-quality',{summary_id:s.id})).feedback.decision,'missing_context');
  await assert.rejects(f.act('review.summary',{...payload,source_digest:'0'.repeat(64)}),code('STALE_INPUT'));
  await assert.rejects(f.get('summary-quality',{summary_id:s.id},f.b));
  f.store.supersedeMemory(f.a,s.sources[0].memory_id,{content:'新的合成版本。'});
  await assert.rejects(f.get('summary-quality',{summary_id:s.id}),code('SUMMARY_VERSION_CHANGED'));
  await assert.rejects(f.act('review.summary',payload),code('SUMMARY_VERSION_CHANGED'));
});

test('summary source pages retain all Unicode and stale claim offsets fail closed',async t=>{
  const f=setup(t),s=summary(f,['🙂'.repeat(5000)]),first=await f.get('summary-quality',{summary_id:s.id}),next=await f.get('summary-quality',{summary_id:s.id,source_offset:first.source.next_offset});
  assert.equal(first.source.text+next.source.text,s.sources[0].content);assert.equal(first.claims[0].quote_truncated,true);
  const broken={...s.claims[0],end:s.claims[0].end-1};f.store.db.prepare('UPDATE memory_summary_claims SET claim_json=? WHERE summary_id=?').run(JSON.stringify(broken),s.id);
  await assert.rejects(f.get('summary-quality',{summary_id:s.id}),code('STALE_INPUT'));
});

test('pair review keeps truth manual, requires exact CAS and preserves both records or established supersede history',async t=>{
  const f=setup(t),one=f.save('Synthetic controller version 1.'),two=f.save('Synthetic controller version 2.');
  const view=await f.get('memory-review',{memory_id:one,counterpart_id:two});assert.equal(view.same_scope,true);
  const p={memory_id:one,revision:view.left.revision,source_version:view.left.source_version,counterpart_id:two,counterpart_revision:view.right.revision,counterpart_source_version:view.right.source_version,decision:'keep_both'};
  await f.act('review.resolve',p);assert.equal(counts(f.store).memories,2);
  await f.act('review.verify',{memory_id:one,revision:view.left.revision,source_version:view.left.source_version,review_due_at:new Date(Date.now()+86400000).toISOString()});
  assert.ok((await f.get('memory-review',{memory_id:one})).left.review.last_verified_at);
  await assert.rejects(f.act('review.resolve',{...p,revision:99,decision:'replace',confirmed:true}),code('MEMORY_VERSION_CHANGED'));
  const op=randomUUID(),replaced=await f.act('review.resolve',{...p,decision:'replace',confirmed:true},f.a,op);
  assert.notEqual(replaced.memory_id,one);assert.notEqual(replaced.memory_id,two);
  assert.equal(f.store.revisions.latest(f.a.user_id,one).status,'superseded');assert.equal(f.store.revisions.latest(f.a.user_id,two).status,'active');
  assert.equal((await f.act('review.resolve',{...p,decision:'replace',confirmed:true},f.a,op)).replayed,true);
});

test('pair retraction cannot cross scope and never treats similarity as an automatic authority',async t=>{
  const f=setup(t),one=f.save('Same synthetic text',{scope:'session',session_id:'synthetic-session-a'}),two=f.save('Same synthetic text',{scope:'session',session_id:'synthetic-session-b'});
  const view=await f.get('memory-review',{memory_id:one,counterpart_id:two});assert.equal(view.same_scope,false);
  const p={memory_id:one,revision:view.left.revision,source_version:view.left.source_version,counterpart_id:two,counterpart_revision:view.right.revision,counterpart_source_version:view.right.source_version,decision:'retract_duplicate',confirmed:true};
  await assert.rejects(f.act('review.resolve',p),code('RECONCILIATION_CONFLICT'));
  assert.equal(f.store.revisions.latest(f.a.user_id,one).status,'active');assert.equal(counts(f.store).memories,2);
  await assert.rejects(f.get('memory-review',{memory_id:one,counterpart_id:two},f.b));
});

test('candidate pagination is byte bounded without skipping pending rows',async t=>{
  const f=setup(t),body=Array.from({length:30},(_,i)=>'事实：'+String(i).padStart(2,'0')+'合'.repeat(3980)).join('\n');
  const {candidates}=await preview(f,'synthetic-large-review-event',body);assert.ok(candidates.length<20);
  let offset=0;const found=[];do{const page=await f.get('review-candidates',{offset,limit:30});assert.ok(Buffer.byteLength(JSON.stringify(page))<236*1024);found.push(...page.candidates.map(c=>c.candidate_id));offset=page.next_offset;}while(offset!==null);
  assert.equal(found.length,30);assert.equal(new Set(found).size,30);assert.equal(counts(f.store).memories,0);
});

test('deleting and restoring a source project cannot revive an old candidate confirmation',async t=>{
  const f=setup(t,{handoff:true}),admin=f.store.authenticate(f.store.issueCredential({userId:f.a.user_id,deviceId:'synthetic-admin',agentId:'synthetic-admin',agentInstanceId:randomUUID(),scopes:['admin:tasks']}).api_key);
  f.store.upsertProject(admin,{project_id:'synthetic-review-project',name:'Synthetic Review Project'});
  f.store.appendEvents(f.capture,{event:{event_id:'synthetic-lifecycle-review',event_type:'user_message',project_id:'synthetic-review-project',session_id:'synthetic-review-session',content:'事实：合成项目的来源需要保持绑定。'}});
  const event=(await f.get('review-candidates')).events[0];await f.act('review.extract',{event_id:event.event_id,source_hash:event.source_hash});const c=(await f.get('review-candidates')).candidates[0];
  const deletion=await f.act('projects.lifecycle_preview',{action:'delete',project_id:'synthetic-review-project'});await f.act('projects.lifecycle_delete',{preview_id:deletion.preview_id,confirm_name:'Synthetic Review Project'});
  assert.equal((await f.get('review-candidates')).candidates.length,0);
  const restore=await f.act('projects.lifecycle_preview',{action:'restore',project_id:'synthetic-review-project'});await f.act('projects.lifecycle_restore',{preview_id:restore.preview_id});
  await assert.rejects(f.act('review.candidate',{candidate_id:c.candidate_id,revision:c.revision,decision:'accept',confirmed:true}),code('STALE_INPUT'));
});

test('source-manifest changes leave old summary feedback as stale, never current',async t=>{
  const f=setup(t),s=summary(f),view=await f.get('summary-quality',{summary_id:s.id});
  await f.act('review.summary',{summary_id:s.id,revision:view.revision,source_digest:view.source_digest,decision:'accurate'});
  f.append('synthetic-extra-evidence','A synthetic supporting source.');
  f.store.revisions.linkEvent(s.sources[0],s.sources[0].revision,'synthetic-extra-evidence',{start:0,end:29,selector:'$',version:'synthetic-evidence'});
  const changed=await f.get('summary-quality',{summary_id:s.id});assert.equal(changed.feedback,null);assert.equal(changed.feedback_stale,true);
  assert.notEqual(changed.source_digest,view.source_digest);
  assert.equal(changed.source.memory_id,changed.claims[0].memory_id);
  const range=changed.source.highlight_ranges[0];assert.equal([...changed.source.text].slice(range.start,range.end).join(''),s.claims[0].quote);
});

test('replacement preserves the reference memory privacy denial and writer-chosen traits',async t=>{
  const f=setup(t),left=f.save('Synthetic outdated entry'),right=f.store.saveMemory(f.a,{scope:'user',content:'Synthetic private reference',kind:'workflow',concepts:['Synthetic'],strength:8}).memory.memory_id;
  f.store.webVisibility.keepPrivate(f.a.user_id,right,f.store.revisions.latest(f.a.user_id,right));
  const pair=await f.get('memory-review',{memory_id:left,counterpart_id:right});
  const result=await f.act('review.resolve',{memory_id:left,revision:pair.left.revision,source_version:pair.left.source_version,counterpart_id:right,counterpart_revision:pair.right.revision,counterpart_source_version:pair.right.source_version,decision:'replace',confirmed:true});
  assert.equal(f.store.webVisibility.denied(f.a.user_id,result.memory_id),true);assert.deepEqual(f.store.traits.get(f.a.user_id,result.memory_id),f.store.traits.get(f.a.user_id,right));
});

test('manual pair judgments become stale when either counterpart version, source manifest, scope or availability changes',async t=>{
  for(const change of ['retract','correct','expiry','manifest','scope']){const f=setup(t),one=f.save('Synthetic retained left'),two=f.save('Synthetic counterpart '+change),eventId='synthetic-pair-source-'+change;
    f.append(eventId,'Synthetic original pair evidence');f.store.revisions.linkEvent(f.store.derivedMemory.currentSource(f.a.user_id,two),1,eventId,{start:0,end:31,selector:'$',version:'synthetic-pair-source'});
    const pair=await f.get('memory-review',{memory_id:one,counterpart_id:two});await f.act('review.resolve',{memory_id:one,revision:pair.left.revision,source_version:pair.left.source_version,counterpart_id:two,counterpart_revision:pair.right.revision,counterpart_source_version:pair.right.source_version,decision:'keep_both'});
    assert.equal((await f.get('memory-review',{memory_id:one})).left.review.current,true);
    if(change==='retract')f.store.retractMemory(f.a,two);
    if(change==='correct')f.store.supersedeMemory(f.a,two,{content:'Synthetic corrected counterpart'});
    if(change==='expiry')f.store.db.prepare('UPDATE events SET expires_at=? WHERE user_id=? AND event_id=?').run('2000-01-01T00:00:00.000Z',f.a.user_id,eventId);
    if(change==='manifest'){f.append(eventId+'-new','Synthetic additional source');f.store.revisions.linkEvent(f.store.derivedMemory.currentSource(f.a.user_id,two),1,eventId+'-new',{start:0,end:27,selector:'$',version:'synthetic-added-source'});}
    if(change==='scope')f.store.db.prepare("UPDATE memories SET scope='session',session_id=? WHERE user_id=? AND memory_id=?").run('synthetic-changed-scope',f.a.user_id,two);
    const stale=await f.get('memory-review',{memory_id:one});assert.equal(stale.left.review.decision,'keep_both');assert.equal(stale.left.review.current,false,change);
    await f.act('review.verify',{memory_id:one,revision:stale.left.revision,source_version:stale.left.source_version});assert.equal((await f.get('memory-review',{memory_id:one})).left.review.current,true,'single-record verification is independent of an earlier counterpart');
  }
});

test('older one-sided pair rows migrate additively and remain stale until explicitly reviewed again',async t=>{
  const f=setup(t),one=f.save('Synthetic historical left'),two=f.save('Synthetic historical right'),pair=await f.get('memory-review',{memory_id:one,counterpart_id:two});
  const payload={memory_id:one,revision:pair.left.revision,source_version:pair.left.source_version,counterpart_id:two,counterpart_revision:pair.right.revision,counterpart_source_version:pair.right.source_version,decision:'keep_both'};
  await f.act('review.resolve',payload);f.store.db.exec('ALTER TABLE memory_manual_reviews DROP COLUMN counterpart_source_version');
  f.store.consoleService.review=new ConsoleMemoryReview(f.store.consoleService);
  const stale=await f.get('memory-review',{memory_id:one});assert.equal(stale.left.review.decision,'keep_both');assert.equal(stale.left.review.current,false);
  await f.act('review.resolve',payload);assert.equal((await f.get('memory-review',{memory_id:one})).left.review.current,true);
});

test('a retained pinned event stays previewable past ordinary expiry without changing stored retention',async t=>{
  const f=setup(t),eventId='synthetic-pinned-review';f.append(eventId,'事实：合成设备已经完成测试。');
  const retention=f.store.authenticate(f.store.issueCredential({userId:f.a.user_id,deviceId:'synthetic-retention',agentId:'synthetic-retention',agentInstanceId:randomUUID(),scopes:['memory:retention']}).api_key);
  f.store.memorySources.pin(retention,{event_ids:[eventId],pin_id:'synthetic-review-pin'});
  f.store.db.prepare('UPDATE events SET expires_at=? WHERE user_id=? AND event_id=?').run('2000-01-01T00:00:00.000Z',f.a.user_id,eventId);
  const event=(await f.get('review-candidates')).events.find(e=>e.event_id===eventId);assert.ok(event);
  await f.act('review.extract',{event_id:eventId,source_hash:event.source_hash});const candidate=(await f.get('review-candidates')).candidates[0];assert.equal(candidate.content,'合成设备已经完成测试。');
  assert.equal(f.store.db.prepare('SELECT expires_at FROM events WHERE event_id=?').get(eventId).expires_at,'2000-01-01T00:00:00.000Z');assert.equal(counts(f.store).memories,0);
  f.store.memorySources.unpin(retention,'synthetic-review-pin');await assert.rejects(f.act('review.candidate',{candidate_id:candidate.candidate_id,revision:1,decision:'accept',confirmed:true}),code('STALE_INPUT'));
  f.store.memorySources.pin(retention,{event_ids:[eventId],pin_id:'synthetic-review-pin-again'});f.store.db.prepare('UPDATE events SET content=NULL,expired_at=? WHERE event_id=?').run(new Date().toISOString(),eventId);
  await assert.rejects(f.act('review.extract',{event_id:eventId,source_hash:event.source_hash}),code('STALE_INPUT'));
});
