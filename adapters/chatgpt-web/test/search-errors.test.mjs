import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createMnemuronApp} from '../../../server/lib/app.mjs';
import {config} from '../../../server/test/helpers/memory-models.mjs';
import {ReadonlyCoreClient} from '../src/core-client.mjs';
import {writePrivate} from '../../../shared/oauth-common.mjs';

test('R-07: disabled semantic retrieval is unavailable, not an invalid user query', async t => {
  const root=mkdtempSync(path.join(os.tmpdir(),'mnemuron-search-errors-'));
  const app=createMnemuronApp({databasePath:root+'/synthetic.sqlite3',memoryConfig:config});
  t.after(async()=>{await app.close();rmSync(root,{recursive:true,force:true});});
  const credential=app.store.issueCredential({userId:'synthetic-owner',deviceId:'synthetic-device',agentId:'synthetic',agentInstanceId:'synthetic-reader',scopes:['memory:read']});
  const address=await app.listen({host:'127.0.0.1',port:0});
  const query=async mode=>{
    const response=await fetch(`http://127.0.0.1:${address.port}/v1/memories/query`,{method:'POST',headers:{authorization:`Bearer ${credential.api_key}`,'content-type':'application/json'},body:JSON.stringify({query:'synthetic',mode})});
    return {status:response.status,data:await response.json()};
  };
  const semantic=await query('semantic');
  assert.equal(semantic.status,503);assert.equal(semantic.data.error_code,'SEMANTIC_UNAVAILABLE');
  const hybrid=await query('hybrid');assert.equal(hybrid.status,200);
  assert.equal(hybrid.data.retrieval.degraded,true);assert.equal(hybrid.data.retrieval.degradation_code,'VECTOR_DISABLED');
  assert.equal((await query('lexical')).status,200);
  assert.equal((await query('invalid')).status,400);
});

test('R-07: readonly gateway preserves only safe Core search availability codes', async t => {
  const root=mkdtempSync(path.join(os.tmpdir(),'mnemuron-search-errors-'));
  let status=503,code='SEMANTIC_UNAVAILABLE';
  const server=http.createServer((req,res)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({error_code:code,error:'synthetic private diagnostic must not escape'}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});});
  writePrivate(root+'/key','mnm_synthetic_only');
  const client=new ReadonlyCoreClient({core:{base_url:`http://127.0.0.1:${server.address().port}`,credential_file:root+'/key',timeout_ms:1000,max_response_bytes:4096}});
  for(const value of ['SEMANTIC_UNAVAILABLE','SEARCH_UNAVAILABLE','SEARCH_RETRYABLE']){
    code=value;await assert.rejects(client.request('/v1/memories/query',{query:'synthetic'}),error=>error.status===503 && error.code===value);
  }
  code='PRIVATE_DIAGNOSTIC';await assert.rejects(client.request('/v1/memories/query',{}),error=>error.code==='CORE_UNAVAILABLE' && !error.message.includes('private'));
  status=400;code='SEMANTIC_UNAVAILABLE';await assert.rejects(client.request('/v1/memories/query',{}),error=>error.code==='INVALID_CORE_QUERY');
});
