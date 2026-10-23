import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {memoryRuntime} from '../lib/memory-runtime.mjs';
import {profile,config} from './helpers/memory-models.mjs';
import {vectorConfig} from '../lib/vector-stores/qdrant.mjs';
test('Q-06: published config, profile requirements, runtime schema and CLI agree',()=>{
  const example=JSON.parse(readFileSync(new URL('../../docs/memory-first-v0.1/memory.runtime.example.json',import.meta.url))),schema=JSON.parse(readFileSync(new URL('../../docs/memory-first-v0.1/memory.runtime.schema.json',import.meta.url)));
  assert.equal(memoryRuntime(example).memory,true);assert.equal(memoryRuntime(example).workerConfigured,false);
  assert.equal(schema.properties.config_version.const,example.config_version);
  const enabled={...config,providers:{organizer:profile(),embedder:profile('embedder')}};
  assert.equal(memoryRuntime(enabled).organizerConfigured,true);assert.equal(memoryRuntime(enabled).embedderConfigured,true);
  for(const key of schema.$defs.profile.then.required){const p=profile();delete p[key];assert.throws(()=>memoryRuntime({...config,providers:{organizer:p}}),undefined,key);}
  for(const key of schema.$defs.embeddingProfile.allOf[1].then.required){const p=profile('embedder');delete p[key];assert.throws(()=>memoryRuntime({...config,providers:{embedder:p}}),undefined,key);}
  assert.throws(()=>memoryRuntime({...config,providers:{organizer:{enabled:'true'}}}));
  assert.throws(()=>memoryRuntime({...config,jobs:{enabled:true,periods:[]}}));
});

test('Q-06 L-01: empty or non-string credential references fail before provider use',()=>{
  for(const key of ['env','secret_file'])for(const value of ['',null,0,false,[],{}]){
    assert.throws(()=>memoryRuntime({...config,providers:{organizer:profile('organizer',{auth:{[key]:value}})}}),undefined,key+':'+JSON.stringify(value));
  }
  for(const key of ['env','secret_file'])for(const value of ['',null,0,false]){
    assert.throws(()=>vectorConfig({enabled:true,protocol:'qdrant-rest-v1.19',base_url:'http://127.0.0.1:6333',auth:{[key]:value},collection_prefix:'synthetic',
      egress:{approved:true,allow_private:true,origins:['http://127.0.0.1:6333'],addresses:['127.0.0.1']},timeouts:{request_ms:1000},limits:{input_bytes:1000,output_bytes:1000}}));
  }
});

test('Q-06: optional config sections and safety flags reject malformed or coerced values',()=>{
  for(const key of ['storage','memory','privacy','providers','vector_store','jobs','development'])for(const value of [null,[],false,'']){
    assert.throws(()=>memoryRuntime({...config,[key]:value}),undefined,key+':'+JSON.stringify(value));
  }
  for(const patch of [
    {privacy:{automatic_export:0}},{privacy:{include_body_in_logs:0}},
    {memory:{automatic_fact_overwrite:0}},{memory:{preserve_atomic_records:'true'}},
    {storage:{reject_private_paths_inside_git_worktree:0}},
    {memory:{retrieval:{mode:''}}},{memory:{capture_extraction:[]}},
    {jobs:{enabled:false,timezone:''}},{jobs:{enabled:false,periods:null}},
    {development:{synthetic_data:'true'}},
  ])assert.throws(()=>memoryRuntime({...config,...patch}),undefined,JSON.stringify(patch));
});
