import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryFixture} from './helpers/core-memory-fixture.mjs';
import {GRAPH_MEMORY_LIMIT,GRAPH_RESPONSE_BYTES,GRAPH_KINDS,memoryGraph} from '../lib/console/memory-graph.mjs';

// Overview memory map: active memories of this account only, with their kind, keywords and topic; no memory content.
// Entities were replaced by keywords, so the graph carries no entity layer (entities/links stay empty for old clients).
test('attention graph: own active memories with kind, keywords and topic, without content or entities',async t=>{
  const f=await memoryFixture(t),store=f.store,auth=f.a.auth;
  const kept=store.saveMemory(auth,{scope:'user',content:'Synthetic graph memory kept on the map.'}).memory;
  const tagged=store.saveMemory(auth,{scope:'user',content:'Synthetic graph memory naming Synthetic Server.',kind:'architecture',concepts:['Synthetic Server','PVE']}).memory;
  const gone=store.saveMemory(auth,{scope:'user',content:'Synthetic graph memory that is retracted.'}).memory;
  store.saveMemory(f.other.auth,{scope:'user',content:'Synthetic graph memory of another account.',concepts:['Foreign']});
  store.retractMemory(auth,gone.memory_id,{reason:'synthetic'});
  const g=store.consoleService.features.read(auth,'attention',{}).graph;
  const ids=g.memories.map(m=>m.id);
  assert.ok(ids.includes(kept.memory_id)&&ids.includes(tagged.memory_id));
  assert.ok(!ids.includes(gone.memory_id),'retracted memories are not drawn');
  assert.equal(g.memories.length,2,'other accounts are never drawn');
  assert.ok(g.memories.every(m=>Object.keys(m).sort().join()==='concepts,day,id,kind,topic'&&/^\d{4}-\d{2}-\d{2}$/.test(m.day)));
  assert.deepEqual(g.memories.find(m=>m.id===tagged.memory_id),{id:tagged.memory_id,kind:'architecture',concepts:['Synthetic Server','PVE'],topic:null,day:tagged.created_at.slice(0,10)});
  assert.deepEqual([g.entities,g.links,g.truncated],[[],[],false]);
  assert.equal(g.filtered_total,2);assert.equal(g.returned,2);assert.equal(g.active_total,2);assert.equal(g.active_with_concepts,1);
  assert.equal(g.kind_counts.architecture,1);assert.equal(g.kind_counts.none,1);
  assert.doesNotMatch(JSON.stringify(g),/Synthetic graph memory|Foreign/,'no memory content and nothing of another account');
  assert.equal(store.consoleService.features.read(auth,'attention',{}).activity_7d.redacted,0);
});

test('attention graph filters the full account before limits and ranks recent keyword completion by activity',async t=>{
  const f=await memoryFixture(t),{store,a}=f,old='2020-01-01T00:00:00.000Z';
  const target=store.saveMemory(a.auth,{scope:'user',content:'Synthetic old architecture with a recent keyword completion.',kind:'architecture',concepts:['专用／网络','Équipe']}).memory;
  store.db.prepare('UPDATE memories SET created_at=?,updated_at=? WHERE memory_id=?').run(old,old,target.memory_id);
  store.memoryTransaction(()=>{for(let i=0;i<GRAPH_MEMORY_LIMIT+2;i++)store.saveMemory(a.auth,{scope:'user',content:`Synthetic ordinary record ${i}.`,kind:'fact'});});
  const now=Date.now()+1000;
  store.traits.set(a.auth.user_id,target.memory_id,{concepts:['专用／网络','Équipe']},new Date(now).toISOString());
  const get=p=>memoryGraph(store.consoleService,a.auth,p,now);
  const all=get({graph_days:'0'});
  assert.equal(all.memories[0].id,target.memory_id,'old creation with fresh traits is ordered by actual activity');
  assert.equal(all.filtered_total,GRAPH_MEMORY_LIMIT+3);assert.equal(all.returned,GRAPH_MEMORY_LIMIT);
  assert.equal(all.truncated,true);assert.equal(all.truncation_reason,'record_limit');
  for(const p of [{graph_days:7,graph_kinds:'architecture'},{graph_days:'30',graph_query:'专用/网络'},{graph_days:'90',graph_query:'éQUIPE'}]){
    const g=get(p);assert.deepEqual(g.memories.map(m=>m.id),[target.memory_id]);
    assert.equal(g.filtered_total,1);assert.equal(g.returned,1);assert.equal(g.truncated,false);assert.equal(g.truncation_reason,null);
  }
  const kind=get({graph_kinds:'architecture,architecture'});
  assert.deepEqual(kind.scope.kinds,['architecture']);assert.equal(kind.kind_counts.fact,GRAPH_MEMORY_LIMIT+2,'hidden types remain available in the legend');
  assert.equal(kind.scope.time_basis,'latest_activity');assert.equal(kind.scope.as_of,new Date(now).toISOString());
  const empty=get({graph_query:'only-in-the-memory-body-not-metadata'});
  assert.equal(empty.filtered_total,0);assert.equal(empty.active_total,GRAPH_MEMORY_LIMIT+3);assert.equal(empty.truncated,false);
});

test('attention graph applies UTC day windows before the cap, with explicit all-time and kind scopes',async t=>{
  const f=await memoryFixture(t),{store,a}=f,now=Date.parse('2026-10-30T13:00:00.000Z');
  const write=(content,date,traits={})=>{const m=store.saveMemory(a.auth,{scope:'user',content,...traits}).memory;
    store.db.prepare('UPDATE memories SET created_at=?,updated_at=? WHERE memory_id=?').run(date,date,m.memory_id);
    store.db.prepare('UPDATE memory_traits SET updated_at=? WHERE user_id=? AND memory_id=?').run(date,a.auth.user_id,m.memory_id);return m.memory_id;};
  const included=write('Synthetic at beginning of seventh UTC day.','2026-10-24T00:00:00.000Z');
  const excluded=write('Synthetic before seventh UTC day.','2026-10-23T23:59:59.999Z',{kind:'bug'});
  const get=p=>memoryGraph(store.consoleService,a.auth,p,now);
  assert.deepEqual(get({graph_days:7}).memories.map(m=>m.id),[included]);
  assert.deepEqual(new Set(get({graph_days:0}).memories.map(m=>m.id)),new Set([included,excluded]));
  assert.deepEqual(get({graph_days:0,graph_kinds:'none'}).memories.map(m=>m.id),[included]);
  assert.deepEqual(get({}).scope.kinds,GRAPH_KINDS);assert.equal(get({}).scope.days,30);
});

test('attention graph stays within the Console byte budget with maximum CJK labels and reports omissions',async t=>{
  const f=await memoryFixture(t),{store,a}=f;
  const keywords=Array.from({length:8},(_,i)=>`${i}${'图'.repeat(39)}`),topic='网络'.repeat(60);
  store.memoryTransaction(()=>{for(let i=0;i<250;i++)store.saveMemory(a.auth,{scope:'user',content:`Synthetic long-label memory ${i}.`,concepts:keywords,topic});});
  const response=store.consoleService.features.read(a.auth,'attention',{graph_days:'0'}),g=response.graph;
  assert.ok(Buffer.byteLength(JSON.stringify(g))<=GRAPH_RESPONSE_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(response))<262144,'the real BFF transport ceiling must not reject attention');
  assert.equal(g.filtered_total,250);assert.equal(g.active_with_concepts,250);assert.equal(g.truncated,true);assert.equal(g.truncation_reason,'response_budget');
  assert.equal(g.returned,g.memories.length);assert.ok(g.returned>0&&g.returned<250);
  assert.ok(g.memories.every(m=>m.topic===topic&&JSON.stringify(m.concepts)===JSON.stringify(keywords)),'omit whole records, never silently clip labels');
});

test('graph counts, kinds and metadata search share live owner isolation and tolerate malformed legacy traits',async t=>{
  const f=await memoryFixture(t),{store,a,other}=f;
  const own=store.saveMemory(a.auth,{scope:'user',content:'Synthetic visible body.',concepts:['Visible 100%_match'],kind:'workflow'}).memory;
  const malformed=store.saveMemory(a.auth,{scope:'user',content:'Synthetic legacy labels.',concepts:['before']}).memory;
  store.db.prepare('UPDATE memory_traits SET concepts_json=? WHERE user_id=? AND memory_id=?').run('{"legacy":"before"}',a.auth.user_id,malformed.memory_id);
  store.saveMemory(other.auth,{scope:'user',content:'Synthetic foreign body.',concepts:['Foreign hidden concept'],kind:'bug'});
  store.saveMemory(a.auth,{scope:'project',project_id:f.alpha.project_id,content:'Synthetic deleted project memory.',concepts:['Deleted hidden concept'],kind:'bug'});
  store.db.prepare("INSERT OR REPLACE INTO project_lifecycle VALUES (?,?,'deleted',NULL,1,?)").run(a.auth.user_id,f.alpha.project_id,new Date().toISOString());
  const dangling=store.saveMemory(a.auth,{scope:'user',content:'Synthetic dangling scope.',concepts:['Dangling hidden concept'],kind:'bug'}).memory;
  store.db.prepare('UPDATE memories SET project_id=? WHERE user_id=? AND memory_id=?').run('nonexistent-graph-project',a.auth.user_id,dangling.memory_id);
  const get=p=>store.consoleService.features.read(a.auth,'attention',p).graph,g=get({});
  assert.equal(g.active_total,2);assert.equal(g.active_with_concepts,1);assert.equal(g.filtered_total,2);assert.equal(g.kind_counts.bug,0);
  assert.deepEqual(g.memories.find(m=>m.id===malformed.memory_id).concepts,[]);
  assert.doesNotMatch(JSON.stringify(g),/Foreign|Deleted|Dangling|Synthetic/);
  assert.deepEqual(get({graph_query:'100%_match'}).memories.map(m=>m.id),[own.memory_id],'query metacharacters are literal, not wildcard patterns');
  assert.equal(get({graph_query:'visible body'}).filtered_total,0,'metadata search must not read or reveal memory bodies');
  assert.equal(get({graph_query:'hidden concept'}).filtered_total,0);
});

test('graph filter validation rejects malformed or unbounded inputs without broadening their scope',async t=>{
  const {store,a}=await memoryFixture(t);
  const invalid=[...[-1,3651,1.2,'',' 7','07','NaN','Infinity',null,{},[]].map(graph_days=>({graph_days})),
    ...['','bug,','BUG','bug,foreign',null,[]].map(graph_kinds=>({graph_kinds})),
    ...['图'.repeat(201),'line\nbreak',null,{}].map(graph_query=>({graph_query})),{foreign_user:'not-allowed'}];
  for(const params of invalid)assert.throws(()=>store.consoleService.features.read(a.auth,'attention',params),e=>e.errorCode==='INVALID_CONSOLE_INPUT',JSON.stringify(params));
  const graph=store.consoleService.features.read(a.auth,'attention',{graph_query:'图'.repeat(200)}).graph;
  assert.equal(graph.scope.query.length,200);assert.equal(graph.filtered_total,0);
});
