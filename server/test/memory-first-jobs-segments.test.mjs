import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,organizer,profile,taxonomy} from './helpers/memory-models.mjs';
import {MemoryJobs} from '../lib/memory-jobs/store.mjs';
import {MemoryWorker,scheduleLibrary} from '../lib/memory-jobs/worker.mjs';
import {SUMMARY_SEGMENTS,summaryBoundaries,summarySegmentRanges,mergeSummarySegments} from '../lib/memory-jobs/summary-segments.mjs';
import {ModelError} from '../lib/model-providers/contracts.mjs';

const content='合成试验，尚未获准上线。😀\n'+'重复背景不表示已验证。'.repeat(290)+'最终决定：保留 17.9.8，不部署 17.12.3。';
const limits={...profile().limits,input_bytes:8500,input_tokens:8500};
const quote=input=>({results:input.sources.map(s=>({memory_id:s.memory_id,revision:s.revision,start:0,end:s.content.length,quote:s.content}))});
const plan=(f,jobs,model)=>scheduleLibrary(f.s,jobs,{userId:f.auth.user_id,organizer:model,taxonomy,type:'summary',periods:['daily'],includeOpen:true});
const published=f=>f.s.db.prepare('SELECT claim_json FROM memory_summary_claims ORDER BY ordinal').all().map(row=>JSON.parse(row.claim_json));
const retry=(f,id)=>f.s.db.prepare("UPDATE memory_jobs SET state='pending',run_after=0 WHERE job_id=?").run(id);
const checkpoint=(jobs,id)=>JSON.parse(jobs.items(jobs.get(id))[0].result_json);

test('SEG-01 conservative boundaries preserve UTF-16 pairs, dotted identifiers, fenced and inline code',()=>{
  const source='😀 保留 17.9.8 和 192.0.2.1。\n```sh\necho "do not. deploy!"\n```\n引用 `not. complete!` 不是授权。\n\n最后决定。';
  const ends=summaryBoundaries(source),fenceStart=source.indexOf('```'),fenceEnd=source.lastIndexOf('```')+3;
  assert.ok(ends.length>=3);assert.ok(ends.every(end=>end!==1&&!(end>fenceStart&&end<fenceEnd)));
  for(const text of ['17.9.8','192.0.2.1','`not. complete!`']){const start=source.indexOf(text);assert.ok(ends.every(end=>end<=start||end>=start+text.length));}
  const ranges=summarySegmentRanges(source,(start,end)=>end-start<=65);assert.equal(ranges.map(s=>source.slice(s.start,s.end)).join(''),source);
  assert.deepEqual(summarySegmentRanges(source,()=>true,ranges),ranges);
  assert.throws(()=>summarySegmentRanges(source,()=>false,ranges),e=>e.code==='INPUT_TOO_LARGE');
  assert.throws(()=>summarySegmentRanges(source,()=>true,[{start:0,end:1},{start:1,end:source.length}]),e=>e.code==='INVALID_SOURCE_SET');
  const identifier='查询 https://example.com/run?confirm=false&version=17.9.8 后仍需审批。';
  assert.deepEqual(summaryBoundaries(identifier),[identifier.length]);
  assert.throws(()=>summarySegmentRanges(identifier,(start,end)=>end-start<=40),e=>e.code==='INPUT_TOO_LARGE');
  const email='地址 synthetic!test@example.com 不表示同意。';assert.deepEqual(summaryBoundaries(email),[email.length]);
});

test('SEG-02 one oversized CJK source is completely planned, grounded and published as one original dependency',async t=>{
  const f=fixture(t),memory=f.save(content),seen=[],requests=[],model=organizer(input=>{seen.push(input);return quote(input);},{limits});
  const generate=model.generateStructured.bind(model);model.generateStructured=(input,schema,options)=>{requests.push(model.measureRequest(input,schema));return generate(input,schema,options);};
  const jobs=new MemoryJobs(f.s);plan(f,jobs,model);const result=await new MemoryWorker(f.s,jobs,model).runOne();
  assert.equal(result.state,'succeeded');assert.equal(result.processed,1);assert.ok(seen.length>=2);assert.ok(requests.every(r=>r.fits));
  assert.equal(seen.map(input=>input.sources[0].content).join(''),memory.content);
  let end=0;for(const input of seen){const s=input.sources[0];assert.equal(s.segment.source_start,end);end=s.segment.source_end;assert.equal(s.segment.source_length,memory.content.length);assert.equal(s.memory_id,memory.memory_id);assert.match(input.instruction,/not an independent fact/);}
  const claims=published(f);assert.equal(claims.map(c=>c.quote).join(''),memory.content);assert.ok(claims.length<=4);
  assert.ok(claims.every(c=>c.quote===memory.content.slice(c.start,c.end)&&c.independently_fact_checked===false&&c.source_segmentation.segments===seen.length));
  assert.deepEqual({...f.s.db.prepare('SELECT coverage,omitted FROM memory_summaries').get()},{coverage:1,omitted:0});
  assert.equal(f.s.db.prepare('SELECT COUNT(*) n FROM memory_summary_dependencies').get().n,1);
  assert.equal(f.s.db.prepare('SELECT reserved_calls FROM memory_model_budget').get().reserved_calls,seen.length);
  assert.equal(jobs.items(result)[0].state,'done');assert.ok(Array.isArray(JSON.parse(jobs.items(result)[0].result_json)));
});

test('SEG-03 daily budget pauses private partial segments; a larger-budget restart does not resend completed prefixes',async t=>{
  const f=fixture(t);f.save(content);let now=Date.now();const seen=[],model=organizer(input=>{seen.push(input.sources[0].segment);return quote(input);},{limits:{...limits,daily_requests:1}});
  const jobs=new MemoryJobs(f.s,{clock:()=>now});plan(f,jobs,model);const blocked=await new MemoryWorker(f.s,jobs,model).runOne();
  assert.equal(blocked.state,'blocked_budget');assert.equal(blocked.processed,0);assert.equal(published(f).length,0);
  const saved=checkpoint(jobs,blocked.job_id);assert.equal(saved.schema,SUMMARY_SEGMENTS);assert.equal(saved.completed.length,1);assert.ok(saved.segments.length>1);
  now+=86400000;jobs.resumeProfile(model.profile.fingerprint);
  const larger=organizer(input=>{seen.push(input.sources[0].segment);return quote(input);},{limits:{...limits,input_bytes:100000,input_tokens:100000}});
  assert.equal(larger.profile.fingerprint,model.profile.fingerprint);const done=await new MemoryWorker(f.s,jobs,larger).runOne();assert.equal(done.state,'succeeded');
  assert.deepEqual(seen.map(s=>({start:s.source_start,end:s.source_end})),saved.segments);assert.equal(published(f).map(c=>c.quote).join(''),content);
});

test('SEG-04 a failed later segment retries only the unconfirmed attempt without publishing a partial summary',async t=>{
  const f=fixture(t);f.save(content);const seen=[];let fail=true;
  const model=organizer(input=>{const s=input.sources[0];seen.push(s.segment.source_start);if(fail&&seen.length===2)throw new ModelError('REMOTE_UNAVAILABLE');return quote(input);},{limits});
  const jobs=new MemoryJobs(f.s);plan(f,jobs,model);const worker=new MemoryWorker(f.s,jobs,model),first=await worker.runOne();
  assert.equal(first.state,'retry_wait');assert.equal(checkpoint(jobs,first.job_id).completed.length,1);assert.equal(published(f).length,0);
  fail=false;retry(f,first.job_id);const done=await worker.runOne();assert.equal(done.state,'succeeded');assert.equal(seen.filter(start=>start===0).length,1);assert.equal(seen[1],seen[2]);
  assert.equal(f.s.db.prepare('SELECT reserved_calls FROM memory_model_budget').get().reserved_calls,seen.length);
});

test('SEG-05 a frozen checkpoint that no longer fits stays explicit, and corrupt offsets never get silently replayed',async t=>{
  for(const kind of ['budget','layout','offset']){
    const f=fixture(t);f.save(content);let calls=0;const model=organizer(input=>{calls++;return quote(input);},{limits:{...limits,daily_requests:1}}),jobs=new MemoryJobs(f.s);plan(f,jobs,model);
    const first=await new MemoryWorker(f.s,jobs,model).runOne(),saved=checkpoint(jobs,first.job_id);assert.equal(saved.completed.length,1);
    if(kind==='layout')saved.layout='mismatched-layout';if(kind==='offset')saved.completed[0].results[0].start++;
    if(kind!=='budget')f.s.db.prepare('UPDATE memory_job_items SET result_json=? WHERE job_id=?').run(JSON.stringify(saved),first.job_id);
    retry(f,first.job_id);
    const next=organizer(input=>{calls++;return quote(input);},{limits:{...limits,...(kind==='budget'?{input_bytes:6000}:{})}});
    const result=await new MemoryWorker(f.s,jobs,next).runOne();assert.equal(result.state,'review_required',kind);assert.equal(result.last_error_code,kind==='budget'?'INPUT_TOO_LARGE':'INVALID_SOURCE_SET');
    assert.equal(calls,1);assert.equal(published(f).length,0);
  }
});

test('SEG-06 oversized indivisible code and impossible minimum wire budgets fail before any attempt or truncation',async t=>{
  for(const text of ['```text\n'+'完整命令。'.repeat(700)+'\n```', '短记忆，不得截断。']){
    const f=fixture(t),memory=f.save(text);let calls=0;const model=organizer(input=>{calls++;return quote(input);},{limits:{...limits,...(text.length<1024?{input_bytes:1000}:{})}}),jobs=new MemoryJobs(f.s);plan(f,jobs,model);
    const result=await new MemoryWorker(f.s,jobs,model).runOne();assert.equal(result.last_error_code,'INPUT_TOO_LARGE');assert.equal(result.state,'review_required');assert.equal(calls,0);assert.equal(jobs.items(result)[0].state,'pending');
    assert.equal(f.s.db.prepare('SELECT content FROM memories WHERE memory_id=?').get(memory.memory_id).content,text);assert.equal(published(f).length,0);
  }
});

test('SEG-07 withdrawal, revision changes and cancellation while awaiting a segment fence both checkpoint and publication',async t=>{
  for(const change of ['withdraw','correct','cancel']){
    const f=fixture(t),memory=f.save(content);let calls=0,id;const jobs=new MemoryJobs(f.s);
    const model=organizer(input=>{assert.equal(f.s.db.isTransaction,false);calls++;if(calls===2){if(change==='withdraw')f.s.retractMemory(f.auth,memory.memory_id);else if(change==='correct')f.s.supersedeMemory(f.auth,memory.memory_id,{content:'合成修改后的来源。'});else jobs.cancel(id);}return quote(input);},{limits});
    id=plan(f,jobs,model).jobs[0];const result=await new MemoryWorker(f.s,jobs,model).runOne();assert.equal(result.state,change==='cancel'?'cancelled':'stale',change);assert.equal(calls,2);assert.equal(published(f).length,0);assert.equal(checkpoint(jobs,id).completed.length,1);
  }
});

test('SEG-08 a deleted project fences resumed partial work before another model call',async t=>{
  const f=fixture(t),now=new Date().toISOString(),project='synthetic-segment-project';
  f.s.db.prepare("INSERT INTO projects VALUES (?,?,?,'[]','[]','[]','[]',?,?)").run(project,f.auth.user_id,'Synthetic segment project',now,now);
  f.save(content,{scope:'project',project_id:project});let calls=0;const model=organizer(input=>{calls++;return quote(input);},{limits:{...limits,daily_requests:1}}),jobs=new MemoryJobs(f.s);plan(f,jobs,model);
  const first=await new MemoryWorker(f.s,jobs,model).runOne();assert.equal(first.state,'blocked_budget');
  f.s.db.prepare('INSERT INTO project_lifecycle VALUES (?,?,?,?,1,?)').run(f.auth.user_id,project,'deleted',null,now);jobs.resumeProfile(model.profile.fingerprint);
  assert.equal((await new MemoryWorker(f.s,jobs,model).runOne()).state,'stale');assert.equal(calls,1);assert.equal(published(f).length,0);
});

test('SEG-09 wrong segment text, missing outputs and wrong revisions cannot be saved as grounded checkpoints',async t=>{
  for(const wrong of ['outside','empty','revision']){
    const f=fixture(t);f.save(content);const model=organizer(input=>{
      const result=quote(input);if(wrong==='empty')result.results=[];else if(wrong==='revision')result.results[0].revision++;else result.results[0].quote='不存在的外部内容。';return result;
    },{limits}),jobs=new MemoryJobs(f.s);plan(f,jobs,model);const result=await new MemoryWorker(f.s,jobs,model).runOne();
    assert.equal(result.state,'review_required',wrong);assert.equal(checkpoint(jobs,result.job_id).completed.length,0);assert.equal(published(f).length,0);
  }
});

test('SEG-10 bounded stitching preserves every chosen exact quote, including final negation, without a model merge',()=>{
  const text=Array.from({length:12},(_,i)=>`完整限定 ${i}：不得部署。${'无关背景。'.repeat(i+1)}`).join('');
  const source={memory_id:'synthetic-source',revision:1,content:text};
  const claims=Array.from({length:12},(_,i)=>{const quote=`完整限定 ${i}：不得部署。`,start=text.indexOf(quote);return {memory_id:source.memory_id,revision:1,start,end:start+quote.length,quote};});
  const result=mergeSummarySegments(source,claims,4);assert.equal(result.length,4);assert.ok(result.every(c=>text.slice(c.start,c.end)===c.quote));
  assert.ok(claims.every(c=>result.some(r=>r.start<=c.start&&r.end>=c.end)));assert.equal(mergeSummarySegments(source,claims,1).length,1);
});

test('SEG-11 fallback-schema wire measurement includes the whole prompt and keeps other source items complete',async t=>{
  const f=fixture(t),saved=[f.save('完整首条，不是结论。'),f.save(content),f.save('完整末条，尚未授权。')],seen=[];
  const model=organizer(input=>{seen.push(input);return quote(input);},{limits,capabilities:{native_schema:false}}),jobs=new MemoryJobs(f.s);
  const generate=model.generateStructured.bind(model);model.generateStructured=(input,schema,options)=>{assert.equal(model.measureRequest(input,schema).fits,true);return generate(input,schema,options);};
  plan(f,jobs,model);const result=await new MemoryWorker(f.s,jobs,model).runOne();assert.equal(result.state,'succeeded');assert.equal(result.processed,3);
  const claims=published(f);for(const source of saved)assert.equal(claims.filter(c=>c.memory_id===source.memory_id).map(c=>c.quote).join(''),source.content);
  assert.equal(seen.flatMap(i=>i.sources).filter(s=>s.memory_id===saved[0].memory_id).length,1);assert.equal(seen.flatMap(i=>i.sources).filter(s=>s.memory_id===saved[2].memory_id).length,1);
});

test('SEG-12 a final private checkpoint survives interruption before saveChunk without repeating any segment',async t=>{
  const f=fixture(t);f.save(content);let calls=0;const model=organizer(input=>{calls++;return quote(input);},{limits}),jobs=new MemoryJobs(f.s);plan(f,jobs,model);
  const save=jobs.saveChunk.bind(jobs);jobs.saveChunk=()=>{throw new ModelError('NETWORK_ERROR');};
  const first=await new MemoryWorker(f.s,jobs,model).runOne(),saved=checkpoint(jobs,first.job_id);assert.equal(saved.completed.length,saved.segments.length);assert.equal(published(f).length,0);
  const before=calls;jobs.saveChunk=save;retry(f,first.job_id);const done=await new MemoryWorker(f.s,jobs,model).runOne();assert.equal(done.state,'succeeded');assert.equal(calls,before);
});

test('SEG-13 classification annotation changes do not poison a frozen summary layout or resend its confirmed prefix',async t=>{
  const f=fixture(t),memory=f.save(content),seen=[];let now=Date.now();
  const model=organizer(input=>{seen.push(input.sources[0]);return quote(input);},{limits:{...limits,daily_requests:1}}),jobs=new MemoryJobs(f.s,{clock:()=>now});plan(f,jobs,model);
  const original=f.s.derivedMemory.currentSource(f.auth.user_id,memory.memory_id),first=await new MemoryWorker(f.s,jobs,model).runOne();assert.equal(first.state,'blocked_budget');
  f.s.db.prepare('INSERT INTO memory_annotations VALUES (?,?,?,?,?,?,?,?,?)').run(f.auth.user_id,memory.memory_id,1,taxonomy.version,'engineering','[]',null,model.profile.fingerprint,'synthetic-classification');
  const current=f.s.derivedMemory.currentSource(f.auth.user_id,memory.memory_id);assert.equal(current.state_hash,original.state_hash);assert.equal(f.s.derivedMemory.category(current,taxonomy.version),'engineering');
  now+=86400000;jobs.resumeProfile(model.profile.fingerprint);
  const resumed=organizer(input=>{seen.push(input.sources[0]);return quote(input);},{limits}),done=await new MemoryWorker(f.s,jobs,resumed).runOne();assert.equal(done.state,'succeeded');
  assert.equal(seen.filter(s=>s.segment.source_start===0).length,1);assert.ok(seen.every(s=>s.current_category==='uncategorized'));assert.equal(published(f).map(c=>c.quote).join(''),content);
});
