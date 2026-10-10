import {memoryFixture} from './helpers/core-memory-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,organizer,embedder} from './helpers/memory-models.mjs';
import {MemoryWorker} from '../lib/memory-jobs/worker.mjs';
import {explicitEquivalence,ENTITY_LIMITS} from '../lib/memory-entities/contracts.mjs';
import {CONSOLE_WRITE_SCOPES} from '../../shared/console-contract.mjs';
import {VectorIndex,surrogate} from '../lib/vector-stores/index.mjs';
import {MockVectorStore} from './helpers/vector-mock.mjs';
import {consoleRead} from '../lib/console-read.mjs';
import {MnemuronStore} from '../lib/store.mjs';
import {applyMigrations} from '../lib/store/migrations.mjs';
import {CORE_MIGRATIONS} from '../lib/store/schema.mjs';
const ids=r=>r.results.map(x=>x.memory_id);
function setup(t){const f=fixture(t),c=f.s.issueCredential({userId:f.auth.user_id,deviceId:'synthetic-console',agentId:'mnemuron-console',agentInstanceId:randomUUID(),scopes:CONSOLE_WRITE_SCOPES});
  const auth=f.s.authenticate(c.api_key),g=f.s.entities,api=f.s.consoleService.entities;
  const get=(entity_id)=>api.read(auth,{entity_id}),list=(memory_id)=>api.read(auth,{memory_id}),act=(action,p)=>f.s.consoleService.execute(auth,{action,payload:p,operation_id:randomUUID()});
  const change=(action,entity,p)=>act(action,{entity_id:entity,...p,expected_version:get(entity).entity.expected_version});
  const search=query=>f.s.queryMemories(auth,{query,limit:20});
  const derive=async(specs,patch={},hook=null)=>{const calls=[];const model=organizer(input=>{calls.push(input);assert.equal(f.s.db.isTransaction,false);if(hook)hook(input);return {results:input.sources.map(s=>({memory_id:s.memory_id,revision:s.revision,objects:(specs[s.memory_id]||[]).map(o=>({kind:'server',quote:s.content,aliases:[],...o}))}))};},patch);
    const scheduled=g.schedule(auth.user_id,model),worker=new MemoryWorker(f.s,f.s.memoryJobs,model,{userId:auth.user_id,profileFilter:model.profile.fingerprint});const jobs=await worker.drain();return {calls,scheduled,jobs,model};};
  const entity=memory=>list(memory.memory_id).entities[0].entity_id;
  return {...f,auth,g,api,get,list,act,change,search,derive,entity};}
const named=(name,alias,relation='same_entity')=>({name,aliases:alias?[{name:alias,relation}]:[]});

test('ENT-01: writes enqueue locally, no source rewrite, <=10 sources per call, no search-time models',async t=>{
  const f=setup(t),memories=Array.from({length:23},(_,i)=>f.save(`node-${i} (aka machine-${i})`)),before=f.s.db.prepare('SELECT * FROM memories ORDER BY memory_id').all();
  assert.equal(f.s.db.prepare("SELECT COUNT(*) n FROM memory_processing_outbox WHERE job_type='entities' AND state='pending'").get().n,23);
  assert.equal(f.s.db.prepare('SELECT COUNT(*) n FROM memory_entities').get().n,0);
  const specs=Object.fromEntries(memories.map((m,i)=>[m.memory_id,[named(`node-${i}`,`machine-${i}`)]])),run=await f.derive(specs);
  assert.deepEqual(run.calls.map(c=>c.sources.length),[10,10,3]);assert.ok(run.jobs.every(j=>j.state==='succeeded'));
  assert.deepEqual(f.s.db.prepare('SELECT * FROM memories ORDER BY memory_id').all(),before);
  assert.equal(ids(f.search('machine-0'))[0],memories[0].memory_id);assert.equal(run.calls.length,3);
});

test('ENT-02: deterministic whole-source proof alone auto-accepts equivalence',()=>{
  for(const text of ['Alpha (aka Beta)','Alpha 又称 Beta','Alpha 也叫 Beta。','Alpha（又称 Beta）'])assert.equal(explicitEquivalence(text,'Alpha','Beta'),true,text);
  for(const text of ['Alpha is not Beta','If Alpha (aka Beta)','"Alpha (aka Beta)"','Someone said Alpha (aka Beta)','Alpha (aka Beta). Extra context','Alpha is Beta','Alpha (aka Beta)\nDo not identify them'])assert.equal(explicitEquivalence(text,'Alpha','Beta'),false,text);
  assert.equal(explicitEquivalence("'Alpha aka Beta'","'Alpha","Beta'"),false);
  for(const [open,close] of [['「','」'],['『','』'],['《','》'],['«','»'],['‹','›'],['＂','＂'],['[',']'],['*','*'],['【','】']])assert.equal(explicitEquivalence(`${open}Alpha aka Beta${close}`,`${open}Alpha`,`Beta${close}`),false);
  assert.equal(explicitEquivalence('Alibaba Cloud (aka ali-vps)','Alibaba Cloud','ali-vps'),false);
  assert.equal(explicitEquivalence('Alpha (aka Beta)','Alpha','Beta',{relation:'related'}),false);
  assert.equal(explicitEquivalence('Acme (aka web-01)','Acme','web-01',{kind:'vendor'}),false);
  assert.equal(explicitEquivalence('Alpha (aka Beta) (aka Gamma)','Alpha (aka Beta)','Gamma'),false);
  for(const [source,name,alias] of [['张三说甲又称乙','张三说甲','乙'],['我认为甲又称乙','我认为甲','乙'],['甲又称乙但张三不同意','甲','乙但张三不同意'],['张三说甲（又称 乙）','张三说甲','乙']])assert.equal(explicitEquivalence(source,name,alias),false);
  assert.equal(explicitEquivalence('甲 又称 乙','甲','乙'),true);
});

test('ENT-03: uncertain, quoted, conditional and vendor-host proposals remain pending; related never expands',async t=>{
  const f=setup(t),m=f.save('Alibaba Cloud hosts ali-vps.'),target=f.save('A backup must run every night.'),run=await f.derive({[m.memory_id]:[{name:'Alibaba Cloud',kind:'vendor',aliases:[{name:'ali-vps',relation:'related'}]}]});
  assert.equal(run.jobs[0].state,'succeeded');const e=f.entity(m),detail=f.get(e),proposal=detail.proposals[0];assert.equal(proposal.state,'pending');assert.equal(proposal.relation,'related');
  await f.change('entity.link',e,{memory_id:target.memory_id,revision:1});assert.ok(!ids(f.search('ali-vps')).includes(target.memory_id));
  const fresh=f.get(e).proposals[0];await f.act('entity.resolve',{proposal_id:fresh.proposal_id,decision:'accept',expected_version:fresh.expected_version});
  assert.equal(f.get(e).aliases.find(n=>n.name==='ali-vps').state,'related');assert.ok(!ids(f.search('ali-vps')).includes(target.memory_id));
});

test('ENT-04: equal names are distinct anchors, ambiguity disclosed, person/place and environment collisions never merge',async t=>{
  const f=setup(t),a=f.save('Ali is a person.'),b=f.save('Ali is a place.'),c=f.save('web-01 production'),d=f.save('web-01 staging');
  await f.derive({[a.memory_id]:[{name:'Ali',kind:'person'}],[b.memory_id]:[{name:'Ali',kind:'place'}],[c.memory_id]:[named('web-01')],[d.memory_id]:[named('web-01')]});
  assert.notEqual(f.entity(a),f.entity(b));assert.equal(f.search('Ali').retrieval.aliases.ambiguous,true);
  const proposals=f.api.read(f.auth,{status:'pending'}).proposals;assert.equal(proposals.length,2);assert.ok(proposals.every(p=>p.source.kind==='server'&&p.state==='pending'));
  assert.equal(f.s.db.prepare("SELECT COUNT(*) n FROM memory_entity_proposals WHERE state='accepted'").get().n,0);
});

test('ENT-05: alias recall preserves engineering tokens and never broadens ali into ali-vps',async t=>{
  const f=setup(t),a=f.save('ali-vps (aka aliyun-machine)'),b=f.save('Backup disk configuration');await f.derive({[a.memory_id]:[named('ali-vps','aliyun-machine')]});
  await f.change('entity.link',f.entity(a),{memory_id:b.memory_id,revision:1});
  const found=f.search('aliyun-machine');assert.ok(ids(found).includes(b.memory_id));assert.equal(found.results.find(x=>x.memory_id===b.memory_id).ranking.match_kind,'alias');
  assert.equal(found.results.find(x=>x.memory_id===b.memory_id).ranking.alias.matched_name,'aliyun-machine');assert.ok(!ids(f.search('ali')).includes(b.memory_id));
});

test('ENT-06: exact owner and full project/context isolation applies to manual associations and proposals',async t=>{
  const f=setup(t);f.s.ensureProject(f.auth,'p-a','Synthetic A');f.s.ensureProject(f.auth,'p-b','Synthetic B');
  const a=f.save('web-01 (aka machine-one)',{scope:'project',project_id:'p-a'}),b=f.save('web-01 backup',{scope:'project',project_id:'p-b'}),neutral=f.save('web-01 session',{scope:'session',session_id:'isolated-session'});
  await f.derive({[a.memory_id]:[named('web-01','machine-one')],[b.memory_id]:[named('web-01')],[neutral.memory_id]:[named('web-01')]});
  await assert.rejects(f.change('entity.link',f.entity(a),{memory_id:b.memory_id,revision:1}),{errorCode:'ENTITY_SCOPE_MISMATCH'});
  await assert.rejects(f.change('entity.link',f.entity(a),{memory_id:neutral.memory_id,revision:1}),{errorCode:'ENTITY_SCOPE_MISMATCH'});
  assert.equal(f.api.read(f.auth,{status:'pending'}).proposals.length,0);
  const foreign={...f.auth,user_id:'other-owner'};assert.throws(()=>f.api.read(foreign,{entity_id:f.entity(a)}),{errorCode:'ENTITY_NOT_FOUND'});
});

test('ENT-07: reverse arrival and same timestamp tie produce stable directed pending proposals',async t=>{
  const f=setup(t),a=f.save('shared-node first'),b=f.save('shared-node second');f.s.db.prepare('UPDATE memories SET created_at=? WHERE memory_id IN (?,?)').run('2026-01-01T00:00:00.000Z',a.memory_id,b.memory_id);
  const sourceA=f.g.source(f.auth.user_id,a.memory_id),sourceB=f.g.source(f.auth.user_id,b.memory_id),ea=f.g.createFromSource(sourceB,'shared-node','server');f.g.reconcile(f.auth.user_id);assert.equal(f.api.read(f.auth,{status:'pending'}).proposals.length,0);
  const eb=f.g.createFromSource(sourceA,'shared-node','server');f.g.reconcile(f.auth.user_id);const first=f.api.read(f.auth,{status:'pending'}).proposals.map(p=>[p.proposal_id,p.source.entity_id,p.target.entity_id]).sort();
  f.g.reconcile(f.auth.user_id);assert.deepEqual(f.api.read(f.auth,{status:'pending'}).proposals.map(p=>[p.proposal_id,p.source.entity_id,p.target.entity_id]).sort(),first);assert.equal(first.length,2);assert.notEqual(ea.entity_id,eb.entity_id);
});

test('ENT-08: rejection and unlink tombstones survive a new job and never recreate associations',async t=>{
  const f=setup(t),a=f.save('shared first'),b=f.save('shared second');await f.derive({[a.memory_id]:[named('shared')],[b.memory_id]:[named('shared')]});
  const proposal=f.api.read(f.auth,{status:'pending'}).proposals[0];await f.act('entity.resolve',{proposal_id:proposal.proposal_id,decision:'reject',expected_version:proposal.expected_version});
  f.g.reconcile(f.auth.user_id);const reversed=f.api.read(f.auth,{status:'pending'}).proposals.find(p=>p.source.entity_id===proposal.target.entity_id);assert.equal(reversed.confirmable,false);await assert.rejects(f.act('entity.resolve',{proposal_id:reversed.proposal_id,decision:'accept',expected_version:reversed.expected_version}),{errorCode:'ENTITY_STALE'});await assert.rejects(f.change('entity.link',proposal.source.entity_id,{target_entity_id:proposal.target.entity_id}),{errorCode:'ENTITY_TOMBSTONED'});
  const m=f.save('Different dependent source');await f.change('entity.link',f.entity(a),{memory_id:m.memory_id,revision:1});await f.change('entity.unlink',f.entity(a),{memory_id:m.memory_id});
  await assert.rejects(f.change('entity.link',f.entity(a),{memory_id:m.memory_id,revision:1}),{errorCode:'ENTITY_TOMBSTONED'});assert.ok(!ids(f.search('shared')).includes(m.memory_id));
});

test('ENT-09: each query rechecks target revision and every alias proof; stale confirmations denied',async t=>{
  const f=setup(t),a=f.save('alpha (aka bravo)'),b=f.save('Independent backup data');await f.derive({[a.memory_id]:[named('alpha','bravo')]});const e=f.entity(a);
  await f.change('entity.link',e,{memory_id:b.memory_id,revision:1});const version=f.get(e).entity.expected_version;assert.ok(ids(f.search('bravo')).includes(b.memory_id));
  f.s.retractMemory(f.auth,b.memory_id);assert.ok(!ids(f.search('bravo')).includes(b.memory_id));await assert.rejects(f.act('entity.alias',{entity_id:e,name:'charlie',expected_version:version}),{errorCode:'ENTITY_VERSION_CHANGED'});
  f.s.supersedeMemory(f.auth,a.memory_id,{content:'Alpha is not bravo.'});assert.equal(f.get(e).entity.anchor.content,null);assert.equal(f.get(e).entity.confirmable,false);assert.notEqual(f.get(e).entity.state,'current');
});

test('ENT-10: restricted web readers receive evidence-backed names only and recheck all visibility dependencies',async t=>{
  const f=setup(t),a=f.save('alpha (aka bravo)'),b=f.save('Backup data');for(const m of [a,b])f.s.memorySources.setSensitivity(f.auth,m.memory_id,'public');
  await f.derive({[a.memory_id]:[named('alpha','bravo')]});const e=f.entity(a);await f.change('entity.link',e,{memory_id:b.memory_id,revision:1});await f.change('entity.alias',e,{name:'owner-private-hint'});
  const web={...f.auth,agent_id:'chatgpt-web'};assert.ok(ids(f.s.queryMemories(web,{query:'bravo'})).includes(b.memory_id));assert.equal(f.s.queryMemories(web,{query:'owner-private-hint'}).results.length,0);
  f.s.webVisibility.keepPrivate(f.auth.user_id,a.memory_id,f.s.revisions.latest(f.auth.user_id,a.memory_id));const result=f.s.queryMemories(web,{query:'bravo'});assert.equal(result.results.length,0);assert.ok(!JSON.stringify(result).includes('owner-private-hint'));
});

test('ENT-11: confirmed one-hop bridge retains proven alias provenance and retires owner-typed names',async t=>{
  const f=setup(t),a=f.save('alpha (aka bravo)'),b=f.save('charlie node backup');await f.derive({[a.memory_id]:[named('alpha','bravo')],[b.memory_id]:[named('charlie')]});const ea=f.entity(a),eb=f.entity(b);
  await f.change('entity.alias',ea,{name:'my-private-label'});await f.change('entity.alias',eb,{name:'private-target-label'});await f.change('entity.link',ea,{target_entity_id:eb});
  const alias=f.search('bravo').results.find(x=>x.memory_id===b.memory_id);assert.equal(alias.ranking.match_kind,'alias');assert.ok(alias.ranking.alias.bridge_id);assert.equal(f.get(ea).aliases.find(n=>n.name==='my-private-label').state,'retired');assert.equal(f.search('my-private-label').results.length,0);assert.equal(f.get(eb).aliases.find(n=>n.name==='private-target-label').state,'retired');assert.equal(f.search('private-target-label').results.length,0);
  await f.change('entity.unlink',ea,{target_entity_id:eb});assert.ok(!ids(f.search('bravo')).includes(b.memory_id));assert.equal(f.search('my-private-label').results.length,0);
});

test('ENT-12: bridge expansion is exactly one step, never a transitive identity merge',async t=>{
  const f=setup(t),a=f.save('alpha (aka bravo)'),b=f.save('charlie object'),c=f.save('delta object');await f.derive({[a.memory_id]:[named('alpha','bravo')],[b.memory_id]:[named('charlie')],[c.memory_id]:[named('delta')]});
  await f.change('entity.link',f.entity(a),{target_entity_id:f.entity(b)});await f.change('entity.link',f.entity(b),{target_entity_id:f.entity(c)});
  const result=f.search('bravo');assert.ok(ids(result).includes(b.memory_id));assert.ok(!ids(result).includes(c.memory_id));assert.equal(f.s.db.prepare('SELECT COUNT(*) n FROM memories').get().n,3);
});

test('ENT-13: deterministic hybrid ranking preserves alias source even when semantic also returns it',async t=>{
  // Fixed logical fixture and forced semantic order. This verifies the reconstructed contract;
  // the lost implementation's historical intermittent cause is unknown and is not claimed here.
  const f=setup(t),a=f.save('alpha (aka bravo)'),b=f.save('Remote backup metadata'),c=f.save('bravo exact direct note'),partial=f.save('a bravo other note');
  const extraction=await f.derive({[a.memory_id]:[named('alpha','bravo')]});assert.ok(extraction.jobs.every(j=>j.state==='succeeded'));await f.change('entity.link',f.entity(a),{memory_id:b.memory_id,revision:1});
  const e=embedder(()=>[[0,0,1]]),backend=new MockVectorStore(),index=new VectorIndex(f.s,backend,new Map([[e.profile.fingerprint,e]]));
  // Fixed response per batch, independent of document order.
  e.mock=texts=>texts.map(()=>[0,0,1]);const generation=index.begin(e.profile.fingerprint);await index.sync(generation);index.activate(generation);
  const roles=new Map([[a.memory_id,'source'],[b.memory_id,'alias_member'],[c.memory_id,'exact'],[partial.memory_id,'other_exact']]),semanticOrder=[b,c,a,partial].map(m=>surrogate([f.auth.user_id,m.memory_id])),baseSearch=backend.search.bind(backend);
  backend.search=async(...args)=>(await baseSearch(...args)).sort((a,b)=>semanticOrder.indexOf(a.payload.document)-semanticOrder.indexOf(b.payload.document));
  const lexical=f.search('bravo'),lexicalAlias=lexical.results.find(m=>m.memory_id===b.memory_id);assert.equal(lexicalAlias.ranking.match_kind,'alias');assert.equal(lexicalAlias.ranking.lexical_score,0);
  const result=await index.search(f.auth,{query:'bravo',mode:'hybrid',limit:20}),alias=result.results.find(x=>x.memory_id===b.memory_id);
  t.diagnostic(JSON.stringify({fixture_seed:'ENT13-alias-semantic-overlap-v1',insertion_order:['source','alias_member','exact','other_exact'],semantic_order:['alias_member','exact','source','other_exact'],
    lexical:lexical.results.map(m=>({role:roles.get(m.memory_id),match_kind:m.ranking.match_kind,lexical_score:m.ranking.lexical_score})),hybrid:result.results.map(m=>({role:roles.get(m.memory_id),match_kind:m.ranking.match_kind,matched_by:m.ranking.matched_by,alias_source:m.ranking.alias?.source})),
    jobs:f.s.db.prepare('SELECT job_id,job_type,state,total,processed FROM memory_jobs ORDER BY rowid').all()}));
  assert.equal(alias.ranking.match_kind,'alias',JSON.stringify({generation,ids:ids(result),jobs:f.s.db.prepare('SELECT job_id,state FROM memory_jobs').all()}));assert.equal(alias.ranking.alias.source,'alias');assert.ok(alias.ranking.matched_by.includes('semantic'));
  assert.ok(result.results.filter(x=>x.ranking.match_kind==='raw_query').every(x=>ids(result).indexOf(x.memory_id)<ids(result).indexOf(b.memory_id)));
  backend.down=true;const fallback=await index.search(f.auth,{query:'bravo',mode:'hybrid'});assert.equal(fallback.results.find(x=>x.memory_id===b.memory_id).ranking.match_kind,'alias');
});

test('ENT-14: organizer browse/preview/apply share alias selection and bind otherwise-unseen evidence changes',async t=>{
  const f=setup(t),a=f.save('alpha (aka bravo)'),b=f.save('Backup metadata');await f.derive({[a.memory_id]:[named('alpha','bravo')]});const e=f.entity(a);await f.change('entity.link',e,{memory_id:b.memory_id,revision:1});
  const browse=await consoleRead(f.s,f.auth,'memories',{query:'bravo'}),pv=await consoleRead(f.s,f.auth,'memories',{part:'preview',target:'technical',query:'bravo'});
  assert.deepEqual(new Set(ids(browse)),new Set([a.memory_id,b.memory_id]));assert.equal(pv.matched,2);assert.equal(browse.results.find(x=>x.memory_id===b.memory_id).ranking.match_kind,'alias');
  await f.change('entity.alias',e,{name:'unseen-proof-name'});await assert.rejects(f.act('memory.organize',{category:'technical',query:'bravo',preview_token:pv.preview_token}),{errorCode:'PREVIEW_CHANGED'});
  const next=await consoleRead(f.s,f.auth,'memories',{part:'preview',target:'technical',query:'bravo'});const applied=await f.act('memory.organize',{category:'technical',query:'bravo',preview_token:next.preview_token});assert.equal(applied.changed,2);assert.equal(f.get(e).entity.state,'current','category changes preserve identity evidence');assert.ok(ids(f.search('bravo')).includes(b.memory_id));
});

test('ENT-15: naming/term bounds fail closed and disclose truncation together with ambiguity',async t=>{
  const f=setup(t),a=f.save('alpha (aka bravo)'),b=f.save('Backup metadata');await f.derive({[a.memory_id]:[named('alpha','bravo')]});const e=f.entity(a);await f.change('entity.link',e,{memory_id:b.memory_id,revision:1});
  for(let i=0;i<65;i++)await f.change('entity.alias',e,{name:`name-${i}`});const terms=f.search('bravo');assert.equal(terms.retrieval.aliases.truncated,true);assert.ok(!ids(terms).includes(b.memory_id));
  const base=f.s.db.prepare('SELECT * FROM memory_entity_names LIMIT 1').get();f.s.memoryTransaction(()=>{for(let i=0;i<1001;i++)f.s.db.prepare('INSERT INTO memory_entity_names VALUES(?,?,?,?,?,?,?,?,?)').run('overflow-'+i,base.user_id,base.entity_id,'x'+i,'x'+i,'manual','accepted',base.proof_json,base.created_at);});
  const bounded=f.search('bravo');assert.equal(bounded.retrieval.aliases.truncated,true);assert.equal(typeof bounded.retrieval.aliases.ambiguous,'boolean');assert.ok(!ids(bounded).includes(b.memory_id));
});

test('ENT-16: queue scan is bounded and carries a deterministic cursor beyond 5000 ineligible rows',async t=>{
  const f=setup(t),m=f.save('eligible node');f.s.db.prepare("DELETE FROM memory_processing_outbox WHERE job_type='entities'").run();
  f.s.memoryTransaction(()=>{for(let i=0;i<5001;i++)f.s.db.prepare('INSERT INTO memory_processing_outbox VALUES(?,?,?,?,?,?,?)').run(f.auth.user_id,'missing-'+i,1,'entities','pending','hash','2026-01-01');
    f.s.db.prepare('INSERT INTO memory_processing_outbox VALUES(?,?,?,?,?,?,?)').run(f.auth.user_id,m.memory_id,1,'entities','pending','hash','2026-01-01');});
  const model=organizer(),first=f.g.schedule(f.auth.user_id,model);assert.equal(first.scanned,5000);assert.equal(first.truncated,true);assert.ok(first.cursor>0);assert.equal(first.jobs.length,0);
  const second=f.g.schedule(f.auth.user_id,model);assert.equal(second.scanned,2);assert.equal(second.truncated,false);assert.equal(second.jobs.length,1);assert.equal(second.cursor,null);
});

test('ENT-17: existing quota, egress, sensitivity and stale-source fences protect extraction',async t=>{
  const f=setup(t),a=f.save('alpha (aka bravo)'),secret=f.save('secret-source');f.s.memorySources.setSensitivity(f.auth,secret.memory_id,'secret');
  const denied=organizer(undefined,{egress:{...organizer().profile.egress,approved:false}});assert.equal(f.g.schedule(f.auth.user_id,denied).blocked,true);
  const run=await f.derive({[a.memory_id]:[named('alpha','bravo')]},{},()=>f.s.retractMemory(f.auth,a.memory_id));assert.equal(run.jobs[0].state,'stale');assert.equal(f.s.db.prepare('SELECT COUNT(*) n FROM memory_entities').get().n,0);assert.equal(run.calls.flatMap(c=>c.sources).some(s=>s.memory_id===secret.memory_id),false);
  const q=setup(t),m=q.save('budgeted node'),model=organizer(input=>({results:input.sources.map(s=>({memory_id:s.memory_id,revision:s.revision,objects:[]}))}));q.g.schedule(q.auth.user_id,model);
  const worker=new MemoryWorker(q.s,q.s.memoryJobs,model,{userId:q.auth.user_id,profileFilter:model.profile.fingerprint,quota:()=>{const e=new Error('Synthetic exhausted');e.code='BUDGET_EXHAUSTED';throw e;}});
  assert.equal((await worker.runOne()).state,'blocked_budget');assert.equal(q.s.db.prepare('SELECT COUNT(*) n FROM memory_entities').get().n,0);
});

test('ENT-18: historical memory is never backfilled on open; schema v11 refuses a v10 reader unchanged',async t=>{
  const f=setup(t),m=f.save('historical alpha');f.s.db.prepare("DELETE FROM memory_processing_outbox WHERE job_type='entities'").run();f.g.migrate();assert.equal(f.g.schedule(f.auth.user_id,organizer()).scanned,0);
  assert.equal(f.s.db.prepare('PRAGMA user_version').get().user_version,11);const before=f.s.db.prepare('SELECT COUNT(*) n FROM sqlite_master').get().n;
  assert.throws(()=>applyMigrations(f.s.db,CORE_MIGRATIONS.slice(0,10)),{code:'SCHEMA_VERSION_UNSUPPORTED'});assert.equal(f.s.db.prepare('SELECT COUNT(*) n FROM sqlite_master').get().n,before);assert.equal(f.s.memoryDetail(f.auth,m.memory_id).memory.content,'historical alpha');
});

test('ENT-19: lifecycle delete blocks anchor/bridge/target and stale dialogs withhold old source text',async t=>{
  const f=setup(t);f.s.ensureProject(f.auth,'entity-project','Synthetic project');const a=f.save('alpha (aka bravo)',{scope:'project',project_id:'entity-project'}),b=f.save('backup node',{scope:'project',project_id:'entity-project'});
  await f.derive({[a.memory_id]:[named('alpha','bravo')]});const e=f.entity(a);await f.change('entity.link',e,{memory_id:b.memory_id,revision:1});const version=f.get(e).entity.expected_version;
  f.s.memoryTransaction(()=>{f.s.db.prepare('INSERT INTO project_lifecycle VALUES(?,?,?,NULL,1,?)').run(f.auth.user_id,'entity-project','deleted','2026-01-01');f.s.lifecycle.bumpGeneration(f.auth.user_id);});
  assert.equal(f.search('bravo').results.length,0);const detail=f.get(e);assert.equal(detail.entity.anchor.content,null);assert.equal(detail.entity.state,'unavailable');assert.equal(detail.entity.confirmable,false);
  await assert.rejects(f.act('entity.alias',{entity_id:e,name:'obsolete',expected_version:version}),{errorCode:'ENTITY_STALE'});
});

test('ENT-20: manual alias correction/removal persist tombstones and owner-only provenance',async t=>{
  const f=setup(t),a=f.save('alpha (aka bravo)'),b=f.save('backup node');await f.derive({[a.memory_id]:[named('alpha','bravo')]});const e=f.entity(a);await f.change('entity.link',e,{memory_id:b.memory_id,revision:1});const n=await f.change('entity.alias',e,{name:'private-mispelling'});
  await f.change('entity.alias_correct',e,{name_id:n.name_id,name:'private-corrected'});assert.equal(f.search('private-mispelling').results.length,0);assert.ok(ids(f.search('private-corrected')).includes(b.memory_id));
  const next=f.get(e).aliases.find(x=>x.name==='private-corrected');assert.equal(next.evidence_backed,false);await f.change('entity.alias_remove',e,{name_id:next.name_id});assert.equal(f.search('private-corrected').results.length,0);
  await assert.rejects(f.change('entity.alias',e,{name:'private-corrected'}),{errorCode:'ENTITY_TOMBSTONED'});assert.equal(f.s.memoryDetail(f.auth,a.memory_id).memory.content,a.content);
});


test('ENT-13b: original engineering token boundaries survive semantic hits and Console hybrid top-20 filtering is disclosed',async t=>{
  const f=setup(t),a=f.save('ali is a person'),b=f.save('ali-vps is a hostname'),path=f.save('/var/ali/log is a path');
  const e=embedder(texts=>texts.map(()=>[0,0,1])),backend=new MockVectorStore(),index=new VectorIndex(f.s,backend,new Map([[e.profile.fingerprint,e]]));const generation=index.begin(e.profile.fingerprint);await index.sync(generation);index.activate(generation);
  const result=await index.search(f.auth,{query:'ali',mode:'hybrid'});assert.equal(result.results[0].memory_id,a.memory_id);assert.equal(result.results.find(r=>r.memory_id===b.memory_id).ranking.match_kind,'semantic');assert.equal(result.results.find(r=>r.memory_id===path.memory_id).ranking.match_kind,'semantic');
  f.s.searchMemories=(auth,p)=>index.search(auth,p);const page=await consoleRead(f.s,f.auth,'memories',{query:'ali',mode:'hybrid',topic:'not-a-topic'});assert.equal(page.results.length,0);assert.equal(page.retrieval.window_limited,true);assert.equal(page.retrieval.candidate_limit,20);
});

test('ENT-20b: malformed stored proof fails closed without poisoning unrelated lexical searches',async t=>{
  const f=setup(t),a=f.save('alpha (aka bravo)');await f.derive({[a.memory_id]:[named('alpha','bravo')]});const e=f.entity(a),name=f.get(e).aliases.find(n=>n.name==='bravo');f.s.db.prepare('UPDATE memory_entity_names SET proof_json=? WHERE name_id=?').run('{broken',name.name_id);
  assert.throws(()=>f.search('bravo'),{errorCode:'ENTITY_PROOF_INVALID'});assert.equal(f.s.memorySearch.status().state,'ready');
  f.s.db.prepare("UPDATE memory_entity_names SET state='retired' WHERE name_id=?").run(name.name_id);assert.ok(ids(f.search('alpha')).includes(a.memory_id));assert.equal(f.s.memorySearch.status().state,'ready');
});


test('ENT-04b: substring hallucinations and duplicate same-name objects in one source never become identity evidence',async t=>{
  const f=setup(t),a=f.save('Alice operates ali-vps.'),b=f.save('web-01 in production is distinct from web-01 in staging.');
  const invalid=await f.derive({[a.memory_id]:[named('Ali')],[b.memory_id]:[named('web-01'),named('web-01')]});assert.ok(invalid.jobs.every(j=>j.state==='review_required'));assert.equal(f.s.db.prepare('SELECT COUNT(*) n FROM memory_entities').get().n,0);
});


test('ENT-21: Core Console entities allowlist supports authorized reads, refuses readonly writes and cross-owner details',async t=>{
  const f=await memoryFixture(t),credential=user=>{const c=f.store.issueCredential({userId:user,deviceId:'synthetic-entity-route',agentId:'mnemuron-console',agentInstanceId:randomUUID(),scopes:CONSOLE_WRITE_SCOPES});return {...c,auth:f.store.authenticate(c.api_key)};},a=credential(f.a.auth.user_id),b=credential(f.other.auth.user_id);
  const read=await f.request('GET','/v1/console/entities',undefined,a);assert.equal(read.status,200);assert.deepEqual(read.body.entities,[]);
  const m=f.store.saveMemory(a.auth,{content:'Synthetic source object',scope:'user'}).memory,created=await f.store.consoleService.execute(a.auth,{action:'entity.create',operation_id:randomUUID(),payload:{memory_id:m.memory_id,revision:1,name:'Owner chosen label'}});
  const detail=await f.request('GET','/v1/console/entities?entity_id='+created.entity_id,undefined,a);assert.equal(detail.status,200);assert.equal(detail.body.entity.anchor.current,true);assert.equal(detail.body.entity.anchor.current_revision,1);
  assert.equal((await f.request('GET','/v1/console/entities?entity_id='+created.entity_id,undefined,b)).status,404);
  const ro=f.store.issueCredential({userId:a.auth.user_id,deviceId:'synthetic-entity-reader',agentId:'mnemuron-console',agentInstanceId:randomUUID(),scopes:['memory:read','resume:read','console:read']});assert.equal((await f.request('GET','/v1/console/entities',undefined,ro)).status,200);
  assert.equal((await f.request('POST','/v1/console/action',{action:'entity.alias',operation_id:randomUUID(),payload:{entity_id:created.entity_id,name:'Denied',expected_version:detail.body.entity.expected_version}},ro)).status,403);
});

test('ENT-22: all manual anchor/member selections require exact revisions and a single target',async t=>{
  const f=setup(t),a=f.save('Synthetic source object'),b=f.save('Synthetic target object');
  await assert.rejects(f.act('entity.create',{memory_id:a.memory_id,name:'My object'}),{errorCode:'INVALID_CONSOLE_INPUT'});
  const made=await f.act('entity.create',{memory_id:a.memory_id,revision:1,name:'My object'});
  await assert.rejects(f.change('entity.link',made.entity_id,{memory_id:b.memory_id}),{errorCode:'INVALID_CONSOLE_INPUT'});
  await assert.rejects(f.change('entity.link',made.entity_id,{memory_id:b.memory_id,revision:1,target_entity_id:made.entity_id}),{errorCode:'INVALID_ENTITY_TARGET'});
});


test('ENT-04c: model quote clipping cannot invent a name token at an internal identifier boundary',async t=>{
  const f=setup(t),a=f.save('Alice operates ali-vps.');const run=await f.derive({[a.memory_id]:[{name:'Ali',kind:'person',quote:'Ali'}]});assert.equal(run.jobs[0].state,'review_required');assert.equal(f.s.db.prepare('SELECT COUNT(*) n FROM memory_entities').get().n,0);assert.equal(f.search('Ali').results.length,0);
});


test('ENT-05b: aliases inside unspaced Chinese queries expand without splitting engineering identifiers',async t=>{
  const f=setup(t),a=f.save('主机甲（又称 别称乙）'),b=f.save('磁盘备份配置');await f.derive({[a.memory_id]:[named('主机甲','别称乙')]});await f.change('entity.link',f.entity(a),{memory_id:b.memory_id,revision:1});
  assert.ok(ids(f.search('别称乙')).includes(b.memory_id));assert.ok(ids(f.search('查看别称乙配置')).includes(b.memory_id));assert.equal(f.search('查看别称乙配置').results.find(r=>r.memory_id===b.memory_id).ranking.match_kind,'alias');
});


test('ENT-08b: tombstones distinguish separate object pairs sharing the same two source memories',async t=>{
  const f=setup(t),a=f.save('Alice and Bob work in the first team.'),b=f.save('Alice and Bob work in the second team.');const objects=[{name:'Alice',kind:'person'},{name:'Bob',kind:'person'}];
  await f.derive({[a.memory_id]:objects,[b.memory_id]:objects});const pending=f.api.read(f.auth,{status:'pending'}).proposals;assert.equal(pending.length,4);
  const alice=pending.find(p=>p.source.name==='Alice');await f.act('entity.resolve',{proposal_id:alice.proposal_id,decision:'reject',expected_version:alice.expected_version});
  const updated=f.api.read(f.auth,{status:'pending'}).proposals,bob=updated.find(p=>p.source.name==='Bob');assert.equal(bob.confirmable,true);assert.equal(updated.find(p=>p.source.name==='Alice').confirmable,false);
  assert.equal((await f.act('entity.resolve',{proposal_id:bob.proposal_id,decision:'accept',expected_version:bob.expected_version})).status,'accepted');
});


test('ENT-23: a changed organizer configuration requeues unfinished extraction intents with new fences and no historical backfill',async t=>{
  const f=setup(t),a=f.save('alpha (aka bravo)'),historic=f.save('Historical unrelated source');f.s.db.prepare("DELETE FROM memory_processing_outbox WHERE memory_id=? AND job_type='entities'").run(historic.memory_id);
  const config={enabled:true,protocol:'openai_compatible',base_url:'https://synthetic.example.invalid/v1',model:'synthetic-configured',profile_revision:'1',daily_requests:100,output_tokens:4096,batch_size:5,sensitivities:['public','internal','sensitive'],egress_approved:true,query_approved:true};
  await f.act('models.save',{kind:'organizer',expected_revision:0,config});const firstProvider=f.s.consoleService.models.provider(f.auth.user_id,'organizer'),first=f.g.schedule(f.auth.user_id,firstProvider).jobs[0],lease=f.s.memoryJobs.claim('old-synthetic-worker',{userId:f.auth.user_id,profile:firstProvider.profile.fingerprint});assert.equal(lease.job_id,first);
  // Batch-size-only edits retain the profile/budget fingerprint but must still fence the old configuration.
  await f.act('models.save',{kind:'organizer',expected_revision:1,config:{...config,batch_size:2}});assert.equal(f.s.memoryJobs.get(first).state,'blocked_config');assert.throws(()=>f.s.memoryJobs.publish(lease,()=>{}),{code:'LEASE_LOST'});
  const nextProvider=f.s.consoleService.models.provider(f.auth.user_id,'organizer');assert.equal(firstProvider.profile.fingerprint,nextProvider.profile.fingerprint);const next=f.g.schedule(f.auth.user_id,nextProvider).jobs[0];assert.ok(next);assert.notEqual(next,first);const retried=await f.act('jobs.retry',{job_id:first});assert.deepEqual(retried.jobs,[next],'retrying the superseded job reuses the already scheduled current intent');assert.equal(f.s.db.prepare("SELECT COUNT(*) n FROM memory_jobs WHERE job_type='entities' AND state='pending'").get().n,1);assert.deepEqual(f.s.memoryJobs.items(f.s.memoryJobs.get(next)).map(i=>i.memory_id),[a.memory_id]);
  const mock=organizer(input=>({results:input.sources.map(s=>({memory_id:s.memory_id,revision:s.revision,objects:[{...named('alpha','bravo'),kind:'server',quote:s.content}]}))}));mock.profile={...mock.profile,fingerprint:nextProvider.profile.fingerprint};
  assert.equal((await new MemoryWorker(f.s,f.s.memoryJobs,mock,{userId:f.auth.user_id,profileFilter:mock.profile.fingerprint}).runOne()).state,'succeeded');assert.equal(f.s.db.prepare("SELECT state FROM memory_processing_outbox WHERE memory_id=? AND job_type='entities'").get(a.memory_id).state,'done');
  await f.act('models.save',{kind:'organizer',expected_revision:2,config:{...config,batch_size:3}});assert.equal(f.g.schedule(f.auth.user_id,f.s.consoleService.models.provider(f.auth.user_id,'organizer')).jobs.length,0,'finished and historical memories are not requeued');
});


test('ENT-24: project restoration requeues only existing intents; graph impact counts are owner/project exact',async t=>{
  const f=setup(t);for(const id of ['restored-project','unaffected-project'])f.s.ensureProject(f.auth,id,id);
  const a=f.save('shared-object first',{scope:'project',project_id:'restored-project'}),b=f.save('shared-object second',{scope:'project',project_id:'restored-project'}),historical=f.save('unrequested-history',{scope:'project',project_id:'restored-project'}),other=f.save('shared-object elsewhere',{scope:'project',project_id:'unaffected-project'});
  f.s.db.prepare("DELETE FROM memory_processing_outbox WHERE memory_id=? AND job_type='entities'").run(historical.memory_id);
  await f.derive({[a.memory_id]:[named('shared-object')],[b.memory_id]:[named('shared-object')],[other.memory_id]:[named('shared-object')]});
  const dp=await f.act('projects.lifecycle_preview',{action:'delete',project_id:'restored-project'});assert.equal(dp.impact.totals.entities,2);assert.equal(dp.impact.totals.entity_proposals,2);assert.equal(dp.impact.totals.pending_entity_proposals,2);
  await f.act('projects.lifecycle_delete',{preview_id:dp.preview_id,confirm_name:'restored-project'});const rp=await f.act('projects.lifecycle_preview',{action:'restore',project_id:'restored-project'}),restored=await f.act('projects.lifecycle_restore',{preview_id:rp.preview_id});assert.equal(restored.rescheduled_entity_intents,2);
  const model=organizer(input=>({results:input.sources.map(s=>({memory_id:s.memory_id,revision:s.revision,objects:[]}))})),queued=f.g.schedule(f.auth.user_id,model);assert.equal(queued.jobs.length,1);assert.deepEqual(new Set(f.s.memoryJobs.items(f.s.memoryJobs.get(queued.jobs[0])).map(i=>i.memory_id)),new Set([a.memory_id,b.memory_id]));
  assert.equal(f.s.db.prepare("SELECT COUNT(*) n FROM memory_processing_outbox WHERE memory_id=? AND job_type='entities'").get(historical.memory_id).n,0);
});


test('ENT-25: restore supersedes pending and leased entity jobs before a fresh lifecycle-bound job can spend quota',async t=>{
  const f=setup(t);f.s.ensureProject(f.auth,'fenced-restore','fenced-restore');const a=f.save('restorable-node',{scope:'project',project_id:'fenced-restore'});let calls=0;
  const model=organizer(input=>{calls++;return {results:input.sources.map(s=>({memory_id:s.memory_id,revision:s.revision,objects:[{name:'restorable-node',kind:'server',quote:s.content,aliases:[]}]}))};});
  const old=f.g.schedule(f.auth.user_id,model).jobs[0],lease=f.s.memoryJobs.claim('old-before-restore',{userId:f.auth.user_id,profile:model.profile.fingerprint});
  const dp=await f.act('projects.lifecycle_preview',{action:'delete',project_id:'fenced-restore'});await f.act('projects.lifecycle_delete',{preview_id:dp.preview_id,confirm_name:'fenced-restore'});
  const rp=await f.act('projects.lifecycle_preview',{action:'restore',project_id:'fenced-restore'});await f.act('projects.lifecycle_restore',{preview_id:rp.preview_id});assert.equal(f.s.memoryJobs.get(old).state,'cancelled');assert.throws(()=>f.s.memoryJobs.publish(lease,()=>{}),{code:'LEASE_LOST'});
  const current=f.g.schedule(f.auth.user_id,model).jobs[0];assert.notEqual(current,old);await new MemoryWorker(f.s,f.s.memoryJobs,model,{userId:f.auth.user_id,profileFilter:model.profile.fingerprint}).drain();assert.equal(calls,1);assert.equal(f.list(a.memory_id).entities.length,1);
});

test('ENT-SEARCH-01: graph authority wins over text aliases, preserves subjects, and removal cannot be revived',async t=>{
 const f=setup(t),anchor=f.save('alpha (aka bravo)'),target=f.save('Network configuration backup'),noise=f.save('Invoice dates only');
 await f.derive({[anchor.memory_id]:[named('alpha','bravo')]});const entity=f.entity(anchor);
 for(const m of [target,noise])await f.change('entity.link',entity,{memory_id:m.memory_id,revision:1});
 f.save('bravo (星桥)');const conflict=f.save('星桥 network configuration');
 let found=f.search('bravo network configuration');assert.ok(ids(found).includes(target.memory_id));assert.ok(!ids(found).includes(noise.memory_id));assert.ok(!ids(found).includes(conflict.memory_id));
 assert.equal(found.results.find(m=>m.memory_id===target.memory_id).ranking.alias.matched_name,'bravo');
 await f.change('entity.alias_remove',entity,{name_id:f.get(entity).aliases.find(n=>n.name==='bravo').name_id});
 found=f.search('bravo network configuration');assert.ok(!ids(found).includes(target.memory_id));assert.ok(!ids(found).includes(conflict.memory_id));
 const e=embedder(),backend=new MockVectorStore(),index=new VectorIndex(f.s,backend,new Map([[e.profile.fingerprint,e]]));e.mock=texts=>texts.map(()=>[1,0,0]);const generation=index.begin(e.profile.fingerprint);await index.sync(generation);index.activate(generation);
 const semantic=await index.search(f.auth,{query:'bravo network configuration',mode:'semantic'});assert.equal(semantic.result_count,0,'high scores cannot resurrect removed authority');
});
