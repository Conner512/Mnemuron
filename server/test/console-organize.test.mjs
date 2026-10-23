import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomBytes,randomUUID} from 'node:crypto';
import {memoryFixture,businessSnapshot} from './helpers/core-memory-fixture.mjs';
import {CONSOLE_WRITE_SCOPES,CONSOLE_BASIC_SCOPES,CONSOLE_READ_SCOPES} from '../../shared/console-contract.mjs';
import {organizer,taxonomy as syntheticTaxonomy} from './helpers/memory-models.mjs';
import {MemoryWorker} from '../lib/memory-jobs/worker.mjs';
import {CORE_SCHEMA_VERSION} from '../lib/store/schema.mjs';

// Synthetic accounts and memories only; disposable loopback store per test.
async function setup(t){
  const f=await memoryFixture(t);const key=f.root+'/console.key';fs.writeFileSync(key,randomBytes(32).toString('base64url'),{mode:0o600});
  f.store.memoryConfig.console={key_file:key,worker_enabled:false};
  const issue=(user,scopes=CONSOLE_WRITE_SCOPES)=>{const c=f.store.issueCredential({userId:user,label:'Synthetic console',deviceId:'synthetic-console',agentId:'mnemuron-console',agentInstanceId:randomUUID(),scopes});return {...c,auth:f.store.authenticate(c.api_key)};};
  const A=issue(f.a.auth.user_id),B=issue(f.other.auth.user_id);
  const act=(action,payload,owner=A,operation_id=randomUUID())=>f.request('POST','/v1/console/action',{action,payload,operation_id},owner);
  const get=(view,p={},owner=A)=>f.request('GET','/v1/console/'+view+'?'+new URLSearchParams(p),undefined,owner);
  const create=async(content,owner=A,extra={})=>{const r=await act('memory.create',{content,scope:'user',memory_type:'fact',sensitivity:'sensitive',...extra},owner);assert.equal(r.status,200,JSON.stringify(r.body));return r.body.memory_id;};
  const preview=async(target,p={},owner=A)=>{const r=await get('memories',{part:'preview',target,...p},owner);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  const organize=async(target,p={},owner=A,op)=>{const pv=await preview(target,p,owner);return act('memory.organize',{category:target,...p,preview_token:pv.preview_token},owner,op);};
  const categoryOf=async(memory_id,owner=A)=>(await get('memory-meta',{memory_id},owner)).body.category;
  const taxonomy=async(owner=A)=>(await get('taxonomy',{},owner)).body;
  const importRecords=async(records,owner=A)=>{for(let i=0;i<records.length;i+=20){const r=await act('storage.import',{format:'mnemuron-personal-portable-v1',records:records.slice(i,i+20),confirm_personal_scope:true},owner);assert.equal(r.status,200,JSON.stringify(r.body));}};
  return {...f,A,B,issue,act,get,create,preview,organize,categoryOf,taxonomy,importRecords};
}
const topics=['router','billing','travel','garden','reading'];
const portable=(n,prefix='synthetic-orig')=>Array.from({length:n},(_,i)=>({original_id:`${prefix}-${i}`,revision:1,content:`Synthetic imported note ${i} about ${topics[i%5]}`,memory_type:'fact',
  status:i%20===0?'retracted':'active',topic:topics[i%5],sensitivity:'sensitive',original_scope:{scope:'user'},created_at:new Date(Date.UTC(2025,0,1)+i*86400000).toISOString()}));
const annotate=(f,user,memoryId,version,category)=>f.store.db.prepare('INSERT OR REPLACE INTO memory_annotations VALUES (?,?,?,?,?,?,?,?,?)')
  .run(user,memoryId,f.store.revisions.latest(user,memoryId).revision,version,category,'[]',null,'synthetic-profile','synthetic-job');

test('ORG-01: a large import is browsable by facets, topic, origin and original date; tombstones are counted separately',async t=>{
  const f=await setup(t);await f.importRecords(portable(300));await f.create('Synthetic console-created note');
  const facets=(await f.get('memories',{part:'facets'})).body;
  assert.equal(facets.statuses.active,286);assert.equal(facets.statuses.retracted,15);
  assert.deepEqual(facets.origins,{imported:285,other:1});
  assert.equal(facets.kinds.find(c=>c.kind==='none').count,286,'imports carry no type until their writer or a correction sets one');
  assert.ok(facets.kinds.every(c=>Number.isSafeInteger(c.count)),'every type is listed, empty ones with 0');assert.equal(facets.categories,undefined);
  assert.deepEqual(facets.topics.map(x=>x.topic).sort(),[...topics].sort());assert.equal(facets.topics.find(x=>x.topic==='router').count,45,'retracted imports are not counted as active');
  assert.equal(facets.import_days.reduce((n,d)=>n+d.count,0),300);
  const router=(await f.get('memories',{topic:'router',status:'active',limit:25})).body;
  assert.equal(router.results.length,25);assert.equal(router.next_offset,25);assert.ok(router.results.every(m=>m.topic==='router'&&m.imported===true));
  assert.ok(router.results.every(m=>/^2025|^2026/.test(m.original_created_at)),'original capture dates are kept beside the import time');
  const newest=(await f.get('memories',{origin:'imported',limit:4})).body.results.map(m=>Number(m.content.match(/note (\d+)/)[1]));
  assert.deepEqual(newest,[299,298,297,296],'records written in the same second keep their import order (newest first)');
  const other=(await f.get('memories',{origin:'other'})).body.results;assert.deepEqual(other.map(m=>m.content),['Synthetic console-created note']);
  const search=(await f.get('memories',{query:'imported note',topic:'garden',status:'active',limit:50})).body;
  assert.ok(search.results.length>0&&search.results.every(m=>m.topic==='garden'));assert.equal(search.retrieval.requested_mode,'hybrid');assert.equal(search.retrieval.effective_mode,'lexical');assert.equal(search.retrieval.degraded,true);
  for(const p of [{origin:'elsewhere'},{topic:'x'.repeat(201)},{part:'anything'},{part:'facets',topic:'router'},{target:'technical'},{memory_ids:'a'}])assert.equal((await f.get('memories',p)).status,400,JSON.stringify(p));
  assert.equal((await f.get('memories',{part:'facets'},f.B)).body.origins.imported,0);
});

test('ORG-12: list rows carry a display split of a leading path; stored content and revisions are unchanged',async t=>{
  const f=await setup(t),text='/Users/example/app/src/modules/billing/invoices/generator/nightly-invoice-generator.ts: Invoices are generated nightly and retried three times before alerting.';
  const id=await f.create(text),plain=await f.create('Synthetic plain memory');
  const rows=(await f.get('memories',{limit:10})).body.results,row=rows.find(r=>r.memory_id===id);
  assert.equal(row.path,'/Users/example/app/src/modules/billing/invoices/generator/nightly-invoice-generator.ts');
  assert.equal(row.body,'Invoices are generated nightly and retried three times before alerting.','the whole body reaches the list even though the path is long');
  assert.equal(row.content,[...text].slice(0,160).join(''),'content keeps its previous meaning');
  assert.equal(rows.find(r=>r.memory_id===plain).path,undefined);
  assert.equal(f.store.db.prepare('SELECT content FROM memories WHERE memory_id=?').get(id).content,text);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memory_revisions WHERE memory_id=?').get(id).n,1);
  assert.equal((await f.get('overview')).body.recent.find(r=>r.memory_id===id).body,row.body);
});

test('ORG-13: category filing is retired: classify, organize, category and taxonomy writes, classification scheduling and retries are refused',async t=>{
  const f=await setup(t);const id=await f.create('Synthetic retired-category note');
  for(const [action,payload] of [['memory.classify',{memory_id:id,revision:1,category:'technical'}],['memory.organize',{category:'technical',memory_ids:[id]}],['memory.organize_undo',{batch_id:'synthetic'}],
    ['category.create',{label:'Synthetic'}],['category.rename',{category:'technical',label:'x'}],['category.delete',{category:'technical',move_to:'uncategorized'}],
    ['memory.batch_classify',{items:[{memory_id:id,revision:1}],category:'technical'}],['taxonomy.save',{expected_revision:0,categories:['technical']}]]){
    const r=await f.act(action,payload);assert.ok(r.status>=400&&r.status<500,`${action}: ${r.status}`);}
  const caps=(await f.get('capabilities')).body;
  assert.ok(caps.actions.length&&!caps.actions.some(a=>/^(memory\.(classify|organize|organize_undo|batch_classify)|category\.|taxonomy\.save)/.test(a)),'none of them is offered');
  assert.equal((await f.get('memories',{part:'preview',target:'technical'})).status,400,'the organize preview read is gone');
  const schedule=await f.act('jobs.schedule',{type:'classification',timezone:'UTC',periods:['daily']});assert.equal(schedule.status,400);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM memory_category_overrides").get().n,0,'nothing was filed');
});
