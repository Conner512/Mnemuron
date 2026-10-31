import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {ModelUsageLedger,normalizeUsage,validateUsagePricing} from '../lib/model-providers/usage.mjs';
import {Organizer,Embedder} from '../lib/model-providers/providers.mjs';
import {ModelError} from '../lib/model-providers/contracts.mjs';
import {profile} from './helpers/memory-models.mjs';
import {memoryFixture} from './helpers/core-memory-fixture.mjs';

const schema={type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false};
const pricing={currency:'USD',version:'synthetic-v1',input_per_million:2,output_per_million:4};
const context=(overrides={})=>({user_id:'synthetic-owner',kind:'organizer',profile_fingerprint:'synthetic-profile',model:'synthetic-model',pricing,...overrides});
function ledger(t){const db=new DatabaseSync(':memory:');t.after(()=>db.close());return new ModelUsageLedger(db);}
const live=(kind,overrides={})=>profile(kind,{protocol:'openai_compatible',base_url:'https://model.example',...overrides});
const reply=(value='{"ok":true}',usage={prompt_tokens:100,completion_tokens:20})=>({choices:[{finish_reason:'stop',message:{content:value}}],usage});
const events=(observer,started=Date.now(),outcome='succeeded',usage={input_tokens:100,output_tokens:20})=>{
  const base={attempt_id:randomUUID(),started_at:started,purpose:'summary'};
  observer({...base,phase:'started'});const finish={...base,phase:'finished',finished_at:started+2,duration_ms:2,outcome,usage};observer(finish);return {base,finish};
};

test('ledger initialization is repeatable, adds exactly one empty table and never backfills historical reservations',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec("CREATE TABLE console_model_usage_daily(user_id TEXT,kind TEXT,day TEXT,used INTEGER);INSERT INTO console_model_usage_daily VALUES('synthetic-owner','organizer','2026-01-01',9)");
  const before=db.prepare('SELECT * FROM console_model_usage_daily').all(),tables=()=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r=>r.name);
  assert.deepEqual(tables(),['console_model_usage_daily']);new ModelUsageLedger(db);new ModelUsageLedger(db);
  assert.deepEqual(tables(),['console_model_usage_daily','memory_model_attempts']);assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_model_attempts').get().n,0);
  assert.deepEqual(db.prepare('SELECT * FROM console_model_usage_daily').all(),before);
});

test('usage counters are nonnegative safe integers; malformed, absent and excessive cached counts remain unknown',()=>{
  for(const value of [-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'123',{},[]]){
    const u=normalizeUsage({input_tokens:value,output_tokens:0});assert.equal(u.input_tokens,null);assert.equal(u.output_tokens,0);assert.equal(u.status,'invalid');
  }
  assert.equal(normalizeUsage(null).status,'unknown');assert.equal(normalizeUsage({input_tokens:0,output_tokens:0}).status,'reported');
  const invalid=normalizeUsage({input_tokens:4,output_tokens:2,cached_input_tokens:5});assert.equal(invalid.cached_input_tokens,null);assert.equal(normalizeUsage(invalid).status,'invalid');
  for(const p of [{...pricing,input_per_million:-1},{...pricing,output_per_million:'4'},{...pricing,currency:'usd'},{...pricing,version:''},{...pricing,version:'private\ntext'},{...pricing,other:'secret'}])assert.throws(()=>validateUsagePricing(p),e=>e.errorCode==='MODEL_PRICING_INVALID');
});

test('each repair request is durably recorded, including rejected response usage, while reservations stay unchanged',async t=>{
  const l=ledger(t);let calls=0,reservations=0;const p=new Organizer(live('organizer',{retry:{max_attempts:2,base_ms:10,max_ms:100,repair_once:true}}),{
    attemptObserver:l.observer(context()),transport:async()=>++calls===1?reply('{broken'):reply()});
  await p.generateStructured({operation:'summary',content:'Synthetic private prompt sentinel'},schema,{reserve:async()=>{reservations++;}});
  const rows=l.db.prepare('SELECT * FROM memory_model_attempts ORDER BY rowid').all();assert.equal(calls,2);assert.equal(reservations,2);assert.equal(rows.length,2);
  assert.deepEqual(rows.map(r=>r.outcome),['failed','succeeded']);assert.deepEqual(rows.map(r=>r.input_tokens),[100,100]);assert.equal(rows[0].error_code,'INVALID_JSON');
  assert.ok(rows.every(r=>r.purpose==='summary'&&r.duration_ms>=0&&r.estimated_amount===0.00028));assert.notEqual(rows[0].attempt_id,rows[1].attempt_id);
  assert.doesNotMatch(JSON.stringify(rows),/private prompt|broken|messages|api_key|https:/);
});

test('oversize, denied quota and failed started persistence never dispatch or invent a request observation',async t=>{
  const l=ledger(t);let calls=0;const transport=async()=>{calls++;return reply();};const observer=l.observer(context());
  const tooBig=new Organizer(live('organizer',{limits:{...profile().limits,input_bytes:10,input_tokens:10}}),{transport,attemptObserver:observer});
  await assert.rejects(tooBig.generateStructured({content:'Synthetic oversized'},schema),e=>e.code==='INPUT_TOO_LARGE');
  const p=new Organizer(live('organizer'),{transport,attemptObserver:observer});
  await assert.rejects(p.generateStructured({},schema,{reserve:()=>{throw new ModelError('BUDGET_EXHAUSTED');}}),e=>e.code==='BUDGET_EXHAUSTED');
  const unavailable=new Organizer(live('organizer'),{transport,attemptObserver:()=>{throw new Error('Synthetic private SQLite path');}});
  await assert.rejects(unavailable.generateStructured({},schema),e=>e.code==='USAGE_RECORD_FAILED'&&!e.message.includes('SQLite'));
  assert.equal(calls,0);assert.equal(l.db.prepare('SELECT count(*) n FROM memory_model_attempts').get().n,0);
});

test('failed completion persistence and interrupted attempts remain pending with unknown tokens, not successful zero-cost',async t=>{
  const l=ledger(t),observe=l.observer(context());let dispatched=0;
  const p=new Organizer(live('organizer'),{transport:async()=>{dispatched++;return reply();},attemptObserver:event=>{if(event.phase==='finished')throw new Error('Synthetic private failure');observe(event);}});
  await assert.rejects(p.generateStructured({},schema),e=>e.code==='USAGE_RECORD_FAILED');assert.equal(dispatched,1);
  const rows=l.report('synthetic-owner').recent;assert.equal(rows.length,1);assert.equal(rows[0].outcome,'pending');assert.equal(rows[0].input_tokens,null);assert.equal(rows[0].estimated_amount,null);
});

test('network and supplier errors persist only fixed codes; response loss does not fabricate token counts',async t=>{
  const l=ledger(t),p=new Organizer(live('organizer'),{attemptObserver:l.observer(context()),transport:async()=>{const e=new Error('Synthetic private provider body and key');e.code='Synthetic private error';throw e;}});
  await assert.rejects(p.generateStructured({},schema));const r=l.report('synthetic-owner').recent[0];
  assert.equal(r.outcome,'failed');assert.equal(r.error_code,'REQUEST_FAILED');assert.equal(r.usage_status,'unknown');assert.equal(r.input_tokens,null);assert.equal(r.estimate_status,'unknown_usage');assert.doesNotMatch(JSON.stringify(r),/private|provider body/);
});

test('malformed vectors and invalid token counters preserve known observations without trusting malformed metadata',async t=>{
  const l=ledger(t),observer=l.observer(context({kind:'embedder',pricing:{currency:'USD',version:'synthetic-free-input',input_per_million:0}}));
  const bad=new Embedder(live('embedder'),{attemptObserver:observer,transport:async()=>({data:[{index:9,embedding:[1,0,0]}],usage:{prompt_tokens:0}})});
  await assert.rejects(bad.embed(['Synthetic text'],'query'),e=>e.code==='INVALID_EMBEDDING_ORDER');
  const r=l.report('synthetic-owner').recent[0];assert.equal(r.input_tokens,0);assert.equal(r.output_tokens,null);assert.equal(r.estimated_amount,0);assert.equal(r.purpose,'query_embedding');
  const p=new Organizer(live('organizer'),{attemptObserver:l.observer(context()),transport:async()=>reply(undefined,{prompt_tokens:'Synthetic private token field',completion_tokens:2})});
  await p.generateStructured({},schema);const row=l.db.prepare("SELECT * FROM memory_model_attempts WHERE kind='organizer'").get();assert.equal(row.input_tokens,null);assert.equal(row.output_tokens,2);assert.equal(row.usage_status,'invalid');assert.doesNotMatch(JSON.stringify(row),/private token/);
});

test('observations are replay-idempotent and request-time price snapshots do not change with new configuration',t=>{
  const l=ledger(t),now=Date.now()-100,observe=l.observer(context()),{base,finish}=events(observe,now);
  observe({...base,phase:'started'});observe({...finish,usage:{input_tokens:9999,output_tokens:9999}});
  const next=l.observer(context({pricing:{...pricing,version:'synthetic-v2',input_per_million:100}}));events(next,now+5);
  const rows=l.db.prepare('SELECT * FROM memory_model_attempts ORDER BY started_at').all();assert.equal(rows.length,2);assert.equal(rows[0].input_tokens,100);assert.equal(rows[0].estimated_amount,0.00028);assert.equal(JSON.parse(rows[0].pricing_json).version,'synthetic-v1');assert.equal(rows[1].estimated_amount,0.01008);
  assert.throws(()=>l.observer(context({user_id:'other-owner'}))({...base,phase:'started'}),e=>e.code==='USAGE_OBSERVATION_CONFLICT');
  assert.throws(()=>observe({...base,attempt_id:randomUUID(),phase:'finished',finished_at:now+1,duration_ms:1,outcome:'succeeded'}),e=>e.code==='USAGE_OBSERVATION_CONFLICT');
});

test('read-only owner/date aggregation keeps incomplete and cached pricing unknown, separates currencies and never backfills',t=>{
  const l=ledger(t),now=Date.now()-1000;
  events(l.observer(context()),now);events(l.observer(context({user_id:'foreign-owner'})),now);
  events(l.observer(context()),now-30*86400000);
  events(l.observer(context({pricing:{...pricing,currency:'CNY'}})),now+1);
  events(l.observer(context({pricing:{...pricing,cached_input_per_million:0.2}})),now+2,'succeeded',{input_tokens:100,output_tokens:20});
  const pending={phase:'started',attempt_id:randomUUID(),started_at:now+3,purpose:'summary'};l.observer(context())(pending);
  const before=l.db.prepare('SELECT * FROM memory_model_attempts').all(),r=l.report('synthetic-owner');
  assert.equal(r.totals.attempts,4);assert.equal(r.totals.pending,1);assert.equal(r.totals.input_unknown,1);assert.equal(r.totals.input_tokens,300);assert.equal(r.totals.unestimated_attempts,2);
  assert.deepEqual(r.estimates.map(x=>x.currency),['CNY','USD']);assert.equal(r.billing_verified,false);assert.equal(r.historical_backfill,false);assert.equal(r.standalone_provider_usage,'unobserved');
  assert.deepEqual(l.db.prepare('SELECT * FROM memory_model_attempts').all(),before);assert.equal(l.report('synthetic-owner',{days:60}).totals.attempts,5);assert.equal(l.report('absent').totals.attempts,0);
});

test('cached-input estimates subtract only a validated count and preserve real explicit zero prices',t=>{
  const l=ledger(t),now=Date.now()-100,observe=l.observer(context({pricing:{...pricing,cached_input_per_million:0.2}}));
  events(observe,now,'succeeded',{input_tokens:100,output_tokens:20,cached_input_tokens:10});
  events(observe,now+1,'succeeded',{input_tokens:100,output_tokens:20,cached_input_tokens:101});
  events(l.observer(context({pricing:{...pricing,input_per_million:0,output_per_million:0}})),now+2);
  const rows=l.db.prepare('SELECT * FROM memory_model_attempts ORDER BY started_at').all();assert.equal(rows[0].estimated_amount,0.000262);assert.equal(rows[1].estimated_amount,null);assert.equal(rows[1].usage_status,'invalid');assert.equal(rows[2].estimated_amount,0);
});

test('Console current and retained providers record the authenticated owner; another model does not inherit its current price',async t=>{
  const f=await memoryFixture(t),models=f.store.consoleService.models;let calls=0;
  const server=http.createServer(async(req,res)=>{for await(const _ of req){}calls++;res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{index:0,embedding:[1,0,0]}],usage:{prompt_tokens:10}}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});const origin=`http://127.0.0.1:${server.address().port}`;
  f.store.memoryConfig.console={allowed_private_origins:[origin]};const config={enabled:true,protocol:'openai_compatible',base_url:origin,model:'synthetic-embedding',profile_revision:'1',dimensions:3,daily_requests:20,output_tokens:4096,batch_size:5,egress_approved:true,query_approved:true,pricing:{currency:'USD',version:'synthetic-old',input_per_million:1}};
  models.save(f.a.auth,{kind:'embedder',expected_revision:0,config});models.snapshot(f.a.auth.user_id,'synthetic-generation');
  await models.provider(f.a.auth.user_id,'embedder').embed(['Synthetic text'],'query');
  models.save(f.a.auth,{kind:'embedder',expected_revision:1,config:{...config,model:'synthetic-new',pricing:{...config.pricing,input_per_million:100}}});
  await models.snapshotProviders(f.a.auth.user_id)[0].embed(['Synthetic retained query'],'query');
  const r=f.store.consoleService.features.read(f.a.auth,'model-usage',{}).observed_usage;assert.equal(r.totals.attempts,2);assert.equal(r.totals.estimated_attempts,1);assert.ok(r.recent.some(x=>x.estimate_status==='unpriced'));
  assert.equal(f.store.consoleService.features.read(f.other.auth,'model-usage',{}).observed_usage.totals.attempts,0);assert.equal(calls,2);
  assert.equal(f.store.consoleService.features.read(f.a.auth,'model-usage',{days:1}).observed_usage.days,1);assert.equal(calls,2);
});

test('a response rejected by a post-response configuration fence still records its reported usage at the old price',async t=>{
  const f=await memoryFixture(t),models=f.store.consoleService.models;let reached,release;
  const arrived=new Promise(r=>{reached=r;}),held=new Promise(r=>{release=r;});
  const server=http.createServer(async(req,res)=>{for await(const _ of req){}reached();await held;res.setHeader('content-type','application/json');res.end(JSON.stringify(reply()));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{release();server.closeAllConnections();server.close();});const origin=`http://127.0.0.1:${server.address().port}`;
  f.store.memoryConfig.console={allowed_private_origins:[origin]};const config={enabled:true,protocol:'openai_compatible',base_url:origin,model:'synthetic-organizer',profile_revision:'1',daily_requests:20,output_tokens:4096,batch_size:5,egress_approved:true,query_approved:true,pricing};
  models.save(f.a.auth,{kind:'organizer',expected_revision:0,config});const pending=models.provider(f.a.auth.user_id,'organizer').generateStructured({operation:'summary'},schema);pending.catch(()=>{});await arrived;
  models.save(f.a.auth,{kind:'organizer',expected_revision:1,config:{...config,model:'synthetic-next',pricing:{...pricing,version:'synthetic-v2',input_per_million:99}}});release();
  await assert.rejects(pending,e=>e.code==='STALE_INPUT');const r=models.usage.report(f.a.auth.user_id).recent[0];assert.equal(r.outcome,'failed');assert.equal(r.error_code,'STALE_INPUT');assert.equal(r.input_tokens,100);assert.equal(r.estimated_amount,0.00028);assert.equal(r.pricing.version,'synthetic-v1');
});
