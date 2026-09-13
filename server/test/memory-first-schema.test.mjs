import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compileMemorySchema} from '../../scripts/check-memory-schema.mjs';
import {memoryRuntime} from '../lib/memory-runtime.mjs';
import {config,profile,taxonomy} from './helpers/memory-models.mjs';

test('Q-06: full Draft 2020-12 meta-schema, formats and enabled profiles validate offline',()=>{
  const {schema,validate,versions}=compileMemorySchema();
  assert.equal(schema.$schema,'https://json-schema.org/draft/2020-12/schema');
  assert.ok(versions.ajv);assert.ok(versions['ajv-formats']);
  const example=JSON.parse(readFileSync(new URL('../../docs/memory-first-v0.1/memory.runtime.example.json',import.meta.url),'utf8'));
  for(const value of [example,config,{...config,memory:{taxonomy},providers:{organizer:profile(),embedder:profile('embedder')}}]){
    assert.equal(validate(value),true,JSON.stringify(validate.errors));assert.doesNotThrow(()=>memoryRuntime(value));
  }
});

test('Q-06: schema and runtime both reject malformed sections, unsafe switches and invalid credentials',()=>{
  const {validate}=compileMemorySchema();
  const invalid=[{providers:{organizer:profile('organizer',{auth:{env:''}})}},{providers:{embedder:profile('embedder',{dimensions:0})}},
    {providers:{organizer:profile('organizer',{auth:{secret_file:0}})}},{providers:{organizer:profile('organizer',{auth:{none:false}})}},
    {memory:{automatic_fact_overwrite:0}},{memory:{preserve_atomic_records:'true'}},{privacy:{include_body_in_logs:0}},
    {storage:{reject_private_paths_inside_git_worktree:0}},{jobs:{enabled:false,timezone:''}},
    {jobs:{enabled:false,periods:null}},{development:{synthetic_data:'true'}},{memory:{retrieval:{mode:''}}}];
  for(const key of ['storage','memory','privacy','providers','vector_store','jobs','development'])for(const value of [null,[],false,''])invalid.push({[key]:value});
  for(const patch of invalid){const value={...config,...patch};assert.equal(validate(value),false,JSON.stringify(patch));assert.throws(()=>memoryRuntime(value));}
});

test('Q-06: schema validates formats, bounds, disabled profiles and required provider fields',()=>{
  const {schema,validate}=compileMemorySchema();
  assert.equal(validate({...config,providers:{organizer:{enabled:false},embedder:{enabled:false}},vector_store:{enabled:false}}),true);
  for(const kind of ['organizer','embedder']){
    const required=[...schema.$defs.profile.then.required,...(kind==='embedder'?schema.$defs.embeddingProfile.allOf[1].then.required:[])];
    for(const key of required){const p=profile(kind);delete p[key];assert.equal(validate({...config,providers:{[kind]:p}}),false,key);}
  }
  const p=profile('organizer',{protocol:'openai_compatible',base_url:'not a uri'});
  assert.equal(validate({...config,providers:{organizer:p}}),false);
  assert.equal(validate({...config,memory:{taxonomy:{...taxonomy,categories:['engineering']}}}),false);
  assert.equal(validate({...config,providers:{organizer:{...profile(),shell:'synthetic'}}}),false);
});
