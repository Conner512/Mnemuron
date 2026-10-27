import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {memoryFixture} from './helpers/core-memory-fixture.mjs';
import {VectorIndex} from '../lib/vector-stores/index.mjs';
import {MockVectorStore} from './helpers/vector-mock.mjs';
import {Embedder} from '../lib/model-providers/providers.mjs';
import {profile} from './helpers/memory-models.mjs';
import {CLOUD_CORE_SCOPES} from '../lib/memory/cloud.mjs';
import {redactText} from '../lib/redaction.mjs';

async function setup(t) {
  const f=await memoryFixture(t);
  Object.assign(f.store.runtime,{cloudMemory:true,cloudSubmittedGrant:true});
  const calls=[];
  // Exercise real provider serialization, with an in-memory transport and no external endpoint.
  const e=new Embedder(profile('embedder',{protocol:'openai_compatible',base_url:'https://synthetic-provider.invalid/v1'}),{
    transport:async (_profile,route,body)=>{
      calls.push({route,input:[...body.input]});
      return {data:body.input.map((_,index)=>({index,embedding:[1,0,0]}))};
    },
  });
  const index=new VectorIndex(f.store,new MockVectorStore(),new Map([[e.profile.fingerprint,e]]));
  const generation=index.begin(e.profile.fingerprint);await index.sync(generation);index.activate(generation);
  f.store.vectorIndex=index;
  const writer=f.store.issueCredential({userId:f.a.auth.user_id,deviceId:'synthetic-cloud-hints',agentId:'chatgpt-web',agentInstanceId:randomUUID(),scopes:CLOUD_CORE_SCOPES});
  writer.auth=f.store.authenticate(writer.api_key);
  const connection='d'.repeat(64);
  f.store.cloudMemory.bind(writer.auth,{connection_id:connection,account_id:'synthetic-account',security_version:1,allow_submitted_revision_grant:true});
  const input=(content)=>({connection_id:connection,action:'memory.save',operation_id:randomUUID(),payload:{scope:'user',content,cloud_read:'keep_private'}});
  const submit=operation=>f.request('POST','/v1/cloud-memory/operations',operation,writer);
  return {...f,writer,calls,index,generation,input,submit};
}

test('cloud save hints serialize only committed scrubbed text, including private spans crossing query truncation',async t=>{
  const f=await setup(t);
  const key='sk-'+'proj-'+'Q7'.repeat(14);
  const inputs=[`Synthetic setup ${key} and <private>synthetic-private-marker</private>`,
    'Synthetic ordinary '.repeat(100)+'<PRIVATE>\n'+'synthetic-private-text '.repeat(30)+'\n</PRIVATE> finish',
    'Synthetic configuration api_key='+'SyntheticCredential'.repeat(2)];
  for(const content of inputs){
    f.calls.length=0;
    const saved=await f.submit(f.input(content));
    assert.equal(saved.status,200,JSON.stringify(saved.body));
    assert.equal(saved.body.cloud_readable,false);
    const stored=f.store.db.prepare('SELECT content FROM memories WHERE memory_id=?').get(saved.body.memory_id).content;
    assert.equal(stored,redactText(content).text);
    assert.notEqual(stored,content);
    assert.deepEqual(f.calls,[{route:'/embeddings',input:[stored.slice(0,2000)]}]);
    const receipt=f.store.cloudMemory.get(f.writer.auth,'d'.repeat(64),saved.body.operation_id);
    assert.equal(receipt.content,undefined);assert.equal(receipt.savedMemory,undefined);
    assert.equal(JSON.stringify(saved.body).includes('synthetic-private'),false);
  }
});

test('cloud replay preserves exact receipt without embedding, including after policy and lifecycle changes',async t=>{
  const f=await setup(t),operation=f.input('Synthetic hint <private>private replay marker</private>');
  const saved=await f.submit(operation);assert.equal(saved.status,200);
  await f.index.sync(f.generation);f.store.runtime.agentReadPolicy='active_uniform_v1';f.calls.length=0;
  assert.deepEqual((await f.submit(operation)).body,saved.body);
  assert.deepEqual(f.calls,[]);
  f.store.retractMemory(f.a.auth,saved.body.memory_id);
  assert.deepEqual((await f.submit(operation)).body,saved.body);
  assert.deepEqual(f.calls,[]);
  // Raw intent identity is still exact even when both forms scrub to the same text.
  const conflict=await f.submit({...operation,payload:{...operation.payload,content:'Synthetic hint <private>different private marker</private>'}});
  assert.equal(conflict.status,409);assert.equal(conflict.body.error_code,'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(f.calls,[]);
});

test('ordinary text and direct saves retain hints; a failed cloud commit never queries the model',async t=>{
  const f=await setup(t),content='Synthetic ordinary backup note stays unchanged.';
  const cloud=await f.submit(f.input(content));assert.equal(cloud.status,200);
  assert.deepEqual(f.calls,[{route:'/embeddings',input:[content]}]);
  f.calls.length=0;
  const direct=await f.request('POST','/v1/memories',{scope:'user',content:'Synthetic direct <private>hidden marker</private>'});
  assert.equal(direct.status,201);
  assert.deepEqual(f.calls,[{route:'/embeddings',input:['Synthetic direct [REDACTED:private]']}]);
  f.calls.length=0;
  f.store.db.exec("CREATE TRIGGER synthetic_hint_receipt_failure BEFORE INSERT ON cloud_memory_operations BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  const failed=await f.submit(f.input('Synthetic failed write'));
  assert.ok(failed.status>=400);assert.deepEqual(f.calls,[]);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memories WHERE content=?').get('Synthetic failed write').n,0);
});
