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
