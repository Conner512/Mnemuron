import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readdirSync,chmodSync,symlinkSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {evaluateVector,vectorAcceptanceTarget} from '../lib/memory-evaluation/vector.mjs';
import {vectorAcceptanceCli} from '../bin/mnemuron-vector-acceptance.mjs';
const config={enabled:true,protocol:'qdrant-rest-v1.19',base_url:'http://127.0.0.1:6333',collection_prefix:'synthetic',auth:{env:'SYNTHETIC_VECTOR_KEY'},
  egress:{approved:true,origins:['http://127.0.0.1:6333'],addresses:['127.0.0.1'],allow_private:true},timeouts:{request_ms:100},limits:{input_bytes:10000,output_bytes:10000}};
function directory(t){const root=mkdtempSync(path.join(os.tmpdir(),'mnemuron-vector-guard-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
test('V-09: real-backend acceptance requires explicit network approval before reading configuration',async t=>{
  const root=directory(t);await assert.rejects(vectorAcceptanceCli(['--output',root,'--config',root+'/must-not-read.json']),e=>e.code==='NETWORK_NOT_ALLOWED');
  await assert.rejects(evaluateVector({output:root,get config(){throw new Error('must not read');}}),e=>e.code==='NETWORK_NOT_ALLOWED');assert.deepEqual(readdirSync(root),[]);
});
test('V-09: synthetic acceptance refuses remote, unapproved or production-shaped config',()=>{
  assert.equal(vectorAcceptanceTarget(config).base_url,config.base_url);
  for(const patch of [{enabled:false},{base_url:'http://127.0.0.2:6333'},{base_url:'https://vector.example.test'},
    {egress:{...config.egress,addresses:['127.0.0.1','::1']}},{egress:{...config.egress,origins:[]}},{database_path:'/private/should-not-open.sqlite3'}]){
    assert.throws(()=>vectorAcceptanceTarget({...config,...patch}));
  }
});
test('P-02 V-09: evidence and config cannot be stored in source or broad-readable directories',async t=>{
  const root=directory(t),source=path.resolve(import.meta.dirname,'../..');
  await assert.rejects(evaluateVector({output:source,config,allowNetwork:true}),e=>e.errorCode==='PRIVATE_PATH_IN_SOURCE');
  symlinkSync(source,root+'/linked-source');await assert.rejects(evaluateVector({output:root+'/linked-source',config,allowNetwork:true}),e=>e.errorCode==='PRIVATE_PATH_IN_SOURCE');
  chmodSync(root,0o755);await assert.rejects(evaluateVector({output:root,config,allowNetwork:true}),e=>e.code==='PRIVATE_EVIDENCE_DIRECTORY_REQUIRED');chmodSync(root,0o700);
  const file=root+'/vector.json';writeFileSync(file,JSON.stringify(config),{mode:0o600});chmodSync(file,0o644);
  await assert.rejects(vectorAcceptanceCli(['--output',root,'--config',file,'--allow-network','true']),e=>e.code==='PRIVATE_CONFIG_REQUIRED');
  assert.deepEqual(readdirSync(root).sort(),['linked-source','vector.json']);
});
test('V-09: malformed flags never start a backend or create an evidence database',async t=>{
  const root=directory(t);for(const args of [['--allow-network','yes'],['--unknown','value'],['--output',root,'--output',root],['--allow-network','true']])await assert.rejects(vectorAcceptanceCli(args));
  assert.deepEqual(readdirSync(root),[]);
});
