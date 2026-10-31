// Summary list/detail context comes from stored scope keys and windows. Malformed or foreign keys must
// read as an unknown scope without throwing, binding non-string IDs or exposing another owner's names.
// Synthetic summary rows only, in a disposable fixture database.
import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryFixture} from './helpers/core-memory-fixture.mjs';
import {consoleRead} from '../lib/console-read.mjs';

const WINDOW=JSON.stringify({period:'daily',timezone:'Asia/Shanghai',local_start:'2026-10-02',start:'2026-10-01T16:00:00.000Z',end:'2026-10-02T16:00:00.000Z'});

async function setup(t) {
  const f=await memoryFixture(t);
  const credential=f.store.issueCredential({userId:f.a.auth.user_id,deviceId:'synthetic-console',agentId:'mnemuron-console',agentInstanceId:'summaries-A',scopes:['memory:read','console:read']});
  const reader=f.store.authenticate(credential.api_key);
  let n=0;
  // Each case publishes a real summary through the derived store (real source dependency and claim, so
  // the unchanged detail path accepts it), then corrupts only the stored scope key/window under test.
  const insert=(scopeKey,windowJson=WINDOW,owner=f.a)=>{
    const user=owner.auth.user_id,version=f.store.consoleService.taxonomy(user).version;
    const memory=f.store.saveMemory(owner.auth,{scope:'user',content:`Synthetic summary source ${++n}`}).memory;
    f.store.db.prepare('INSERT INTO memory_category_overrides VALUES (?,?,?,1)').run(user,memory.memory_id,'technical');
    const {memory_id,revision,state_hash,scope_key,content}=f.store.derivedMemory.currentSource(user,memory.memory_id);
    const job={job_id:`synthetic-job-${n}`,group_key:`synthetic-group-${n}`,user_id:user,scope_key,profile:'synthetic',
      metadata:{category:'technical',window:JSON.parse(WINDOW),taxonomy:{version}}};
    const id=f.store.memoryTransaction(()=>f.store.derivedMemory.publishSummary(job,[{user_id:user,memory_id,revision,state_hash,scope_key}],
      [{memory_id,revision,start:0,end:[...content].length,quote:content}],Date.UTC(2026,9,1,0,n)));
    f.store.db.prepare('UPDATE memory_summaries SET scope_key=?,window_json=? WHERE summary_id=?').run(scopeKey,windowJson,id);
    return id;
  };
  const list=async()=>new Map((await consoleRead(f.store,reader,'summaries',{limit:50})).summaries.map(s=>[s.summary_id,s]));
  const detail=async id=>(await consoleRead(f.store,reader,'summary',{summary_id:id})).context;
  return {...f,reader,insert,list,detail,user:f.a.auth.user_id};
}

test('SUM-CTX-01: a valid workstream key resolves owner names and keeps every scope ID', async t => {
  const f=await setup(t);
  const id=f.insert(JSON.stringify([f.user,'workstream',f.alpha.project_id,f.alpha.task_id,`${f.alpha.task_id}-one`,null]));
  const expected={kind:'workstream',project_id:f.alpha.project_id,task_id:f.alpha.task_id,workstream_id:`${f.alpha.task_id}-one`,session_id:null,
    project_name:f.alpha.project_name,task_title:f.alpha.title,workstream_name:'one'};
  const row=(await f.list()).get(id);
  assert.deepEqual(row.scope,expected);
  assert.deepEqual(row.window,JSON.parse(WINDOW));
  assert.equal('scope_key' in row,false);assert.equal('window_json' in row,false);
  assert.deepEqual((await f.detail(id)).scope,expected);
});

test('SUM-CTX-02: malformed owned keys become unknown without throwing or returning raw structures', async t => {
  const f=await setup(t);
  const malformed=[
    [f.user,'task',f.alpha.project_id,{task:'object'},null,null],
    [f.user,'project',[f.alpha.project_id],null,null,null],
    [f.user,'session',null,null,null,true],
    [f.user,'workstream',f.alpha.project_id,f.alpha.task_id,{name:'raw'},null],
    [f.user,'session',null,null,null,{session:'raw'}],
    [f.user,'project',null,null,null,null],
    [f.user,'workstream',f.alpha.project_id,f.alpha.task_id,null,null],
    [f.user,'task',f.alpha.project_id,f.alpha.task_id,null],
    [f.user,'task',f.alpha.project_id,f.alpha.task_id,null,null,'extra'],
    [f.user,'unknown-kind',null,null,null,null],
    [f.user,['task'],f.alpha.project_id,f.alpha.task_id,null,null],
    [f.user,{toString:null},null,null,null,null],
    [f.user,null,null,null,null,null],
    [f.user,true,null,null,null,null],
    [f.user,'project','x'.repeat(201),null,null,null],
    [f.user,'project','',null,null,null],
  ].map(key=>f.insert(JSON.stringify(key)));
  malformed.push(f.insert('not json'),f.insert(JSON.stringify({user:f.user,scope:'user'})),f.insert('null'));
  const rows=await f.list();
  for(const id of malformed){
    assert.deepEqual(rows.get(id).scope,{kind:'unknown'},id);
    assert.deepEqual((await f.detail(id)).scope,{kind:'unknown'},id);
  }
});

test('SUM-CTX-03: foreign-owner keys and foreign IDs inside an owned key never expose the other owner', async t => {
  const f=await setup(t);
  f.store.upsertProject(f.other.auth,{project_id:f.foreign.project_id,name:'Foreign synthetic project name'});
  f.store.upsertTask(f.other.auth,{...f.foreign,title:'Foreign synthetic task title'});
  const foreignKey=f.insert(JSON.stringify([f.other.auth.user_id,'task',f.foreign.project_id,f.foreign.task_id,null,null]));
  const foreignIds=f.insert(JSON.stringify([f.user,'task',f.foreign.project_id,f.foreign.task_id,null,null]));
  const otherOwnersRow=f.insert(JSON.stringify([f.other.auth.user_id,'user',null,null,null,null]),WINDOW,f.other);
  const rows=await f.list();
  assert.deepEqual(rows.get(foreignKey).scope,{kind:'unknown'});
  assert.deepEqual((await f.detail(foreignKey)).scope,{kind:'unknown'});
  // Stored IDs are this summary's own key data; names are looked up for the reader only, so none resolve.
  for(const scope of [rows.get(foreignIds).scope,(await f.detail(foreignIds)).scope]){
    assert.equal(scope.project_name,null);assert.equal(scope.task_title,null);
    assert.doesNotMatch(JSON.stringify(scope),/Foreign synthetic/);
  }
  assert.equal(rows.has(otherOwnersRow),false);
  await assert.rejects(f.detail(otherOwnersRow),{statusCode:404});
});

test('SUM-CTX-04: malformed windows read as unknown or partial facts, never raw values', async t => {
  const f=await setup(t);
  const key=JSON.stringify([f.user,'user',null,null,null,null]);
  const cases=[
    ['not json',null],
    [JSON.stringify(['daily']),null],
    [JSON.stringify({period:'monthly',timezone:'UTC',local_start:'2026-10-01'}),null],
    [JSON.stringify({period:'daily',timezone:{zone:'UTC'},local_start:'2026/10/01',start:7,end:'x'.repeat(41)}),{period:'daily',timezone:null,local_start:null,start:null,end:null}],
    [JSON.stringify({period:'weekly',timezone:'UTC',local_start:'2026-09-28',start:'2026-09-28T00:00:00.000Z',end:'2026-10-05T00:00:00.000Z'}),
      {period:'weekly',timezone:'UTC',local_start:'2026-09-28',start:'2026-09-28T00:00:00.000Z',end:'2026-10-05T00:00:00.000Z'}],
  ];
  const ids=cases.map(([window])=>f.insert(key,window));
  const rows=await f.list();
  for(const [index,[,expected]] of cases.entries())assert.deepEqual(rows.get(ids[index]).window,expected,cases[index][0]);
});

test('SUM-PREVIEW-01: the list carries a short preview read through the validated detail path', async t => {
  const f=await setup(t),user=f.user,version=f.store.consoleService.taxonomy(user).version;
  const saved=f.store.saveMemory(f.a.auth,{scope:'user',content:'Synthetic preview: backups run nightly to the second disk.'}).memory;
  f.store.db.prepare('INSERT INTO memory_category_overrides VALUES (?,?,?,1)').run(user,saved.memory_id,'technical');
  const {memory_id,revision,state_hash,scope_key,content}=f.store.derivedMemory.currentSource(user,saved.memory_id);
  const job={job_id:'synthetic-preview-job',group_key:'synthetic-preview-group',user_id:user,scope_key,profile:'synthetic',metadata:{category:'technical',window:JSON.parse(WINDOW),taxonomy:{version}}};
  const id=f.store.memoryTransaction(()=>f.store.derivedMemory.publishSummary(job,[{user_id:user,memory_id,revision,state_hash,scope_key}],
    [{memory_id,revision,start:0,end:[...content].length,quote:content}],Date.UTC(2026,9,1,1)));
  const row=(await f.list()).get(id);
  assert.equal(row.preview.text,'Synthetic preview: backups run nightly to the second disk.');
  assert.equal(row.preview.claims,1);assert.equal(row.preview.more,false);
  assert.deepEqual(row.preview.excerpts,[{memory_id,revision,start:0,end:[...content].length,quote:content,quote_complete:true,quote_offset:0,quote_length:[...content].length}]);
  f.store.retractMemory(f.a.auth,memory_id,{reason:'synthetic'});
  assert.ok(!JSON.stringify(await f.list()).includes('backups run nightly'),'a withdrawn source never shows in a preview');
});

test('SUM-CTX-06: source-bound list excerpts preserve whitespace and Unicode while disclosing truncation',async t=>{
  const f=await setup(t),user=f.a.auth.user_id,version=f.store.consoleService.taxonomy(user).version;
  const bodies=['Synthetic paragraph one.\n\n  Keep this indentation.','合成😀'.repeat(61),'Synthetic source three.','Synthetic source four.'];
  const sources=bodies.map(content=>{
    const memory=f.store.saveMemory(f.a.auth,{scope:'user',content}).memory;
    f.store.db.prepare('INSERT INTO memory_category_overrides VALUES (?,?,?,1)').run(user,memory.memory_id,'technical');
    return f.store.derivedMemory.currentSource(user,memory.memory_id);
  });
  const job={job_id:'synthetic-excerpt-job',group_key:'synthetic-excerpt-group',user_id:user,scope_key:sources[0].scope_key,profile:'synthetic',metadata:{category:'technical',window:JSON.parse(WINDOW),taxonomy:{version}}};
  const id=f.store.memoryTransaction(()=>f.store.derivedMemory.publishSummary(job,sources.map(({memory_id,revision,state_hash,scope_key})=>({user_id:user,memory_id,revision,state_hash,scope_key})),
    sources.map(({memory_id,revision,content})=>({memory_id,revision,start:0,end:[...content].length,quote:content})),Date.UTC(2026,9,1,2)));
  const row=(await f.list()).get(id);assert.equal(row.preview.excerpts.length,3);assert.equal(row.preview.more,true);
  assert.equal(row.preview.excerpts[0].quote,bodies[0]);assert.equal(row.preview.excerpts[0].quote_complete,true);
  assert.equal(row.preview.excerpts[1].quote,[...bodies[1]].slice(0,120).join(''));assert.equal(row.preview.excerpts[1].quote_complete,false);
  assert.equal(row.preview.excerpts[1].quote_length,[...bodies[1]].length);assert.equal(row.preview.excerpts[1].end,[...bodies[1]].length);
  assert.deepEqual(row.preview.excerpts.map(c=>c.memory_id),sources.slice(0,3).map(c=>c.memory_id));
  const foreign=await f.store.issueCredential({userId:f.other.auth.user_id,deviceId:'synthetic-console-foreign',agentId:'mnemuron-console',agentInstanceId:'excerpt-foreign',scopes:['memory:read','console:read']});
  const other=await consoleRead(f.store,f.store.authenticate(foreign.api_key),'summaries',{});assert.ok(!JSON.stringify(other).includes(bodies[0]));
  f.store.retractMemory(f.a.auth,sources[0].memory_id,{reason:'synthetic excerpt withdrawal'});
  assert.ok(!JSON.stringify(await consoleRead(f.store,f.reader,'summaries',{limit:50})).includes('Synthetic paragraph one.'));
});
