import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {evaluateApplication} from '../acceptance/memory-vector.mjs';
import {applicationAcceptanceCli} from '../acceptance/run-memory-vector.mjs';
import {MockVectorStore} from '../../../server/test/helpers/vector-mock.mjs';
import {close} from '../../../services/oauth/test/fixture.mjs';
import {writePrivate} from '../../../shared/oauth-common.mjs';

test('application acceptance refuses implicit network and production configuration before reading it',async()=>{
  await assert.rejects(evaluateApplication({config:null,output:'/absent'}),e=>e.code==='NETWORK_NOT_ALLOWED');
  await assert.rejects(applicationAcceptanceCli(['--config','/absent','--output','/absent']),e=>e.code==='NETWORK_NOT_ALLOWED');
  await assert.rejects(applicationAcceptanceCli(['--allow-network','true','--allow-network','true']),e=>e.code==='INVALID_ARGUMENTS');
  await assert.rejects(evaluateApplication({allowNetwork:true,config:{storage:{sqlite_path:'/private-production.sqlite3'}}}),e=>e.code==='INVALID_SCHEMA');
});

test('R-02/04/07 C-03: Core HTTP and OAuth MCP acceptance crosses an authenticated vector REST fixture',async t=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'mnemuron-application-test-')),mock=new MockVectorStore(),key=randomBytes(32).toString('hex'),calls=[];
  const server=http.createServer(async(req,res)=>{
    try{
      if(req.headers['api-key']!==key){res.writeHead(401);res.end('{}');return;}
      let text='';for await(const part of req)text+=part;const data=text?JSON.parse(text):undefined;
      const route=new URL(req.url,'http://127.0.0.1').pathname,segments=route.split('/'),name=segments[2];calls.push({method:req.method,route});
      let result;
      if(route==='/'){res.setHeader('content-type','application/json');res.end(JSON.stringify({version:'1.19.0'}));return;}
      if(route==='/collections')result={collections:[...mock.collections.keys()].map(name=>({name}))};
      else if(route.endsWith('/exists'))result={exists:mock.collections.has(name)};
      else if(req.method==='DELETE' && segments.length===3){mock.collections.delete(name);result=true;}
      else if(req.method==='PUT' && segments.length===3){await mock.ensureCollection(name,{dimensions:data.vectors.size,distance:data.vectors.distance});result=true;}
      else if(req.method==='GET' && segments.length===3){const c=mock.collections.get(name).config;result={config:{params:{vectors:{size:c.dimensions,distance:c.distance}}}};}
      else if(req.method==='PUT' && route.endsWith('/points')){await mock.upsert(name,data.points);result={status:'completed'};}
      else if(route.endsWith('/points/query'))result={points:(await mock.search(name,data.query,data.filter,data.limit)).map(({vector,...point})=>point)};
      else if(route.endsWith('/points/delete')){await mock.deleteByDocumentRevision(name,data.filter);result={status:'completed'};}
      else if(route.endsWith('/points/scroll')){result=await mock.scroll(name,data.offset);result.points=result.points.map(({vector,...point})=>point);}
      else throw new Error('Unexpected synthetic route');
      res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',result}));
    }catch{res.writeHead(500);res.end('{}');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await close(server);rmSync(root,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${server.address().port}`;writePrivate(root+'/vector-key',key);
  const config={enabled:true,protocol:'qdrant-rest-v1.19',base_url:origin,collection_prefix:'synthetic',auth:{secret_file:root+'/vector-key'},
    egress:{approved:true,origins:[origin],addresses:['127.0.0.1'],allow_private:true},timeouts:{request_ms:1500},limits:{input_bytes:1000000,output_bytes:1000000}};
  const result=await evaluateApplication({config,output:root,allowNetwork:true});
  assert.equal(result.status,'passed',JSON.stringify(result));assert.equal(result.cases.length,15);assert.ok(result.cases.every(c=>c.status==='passed'));
  assert.ok(calls.some(c=>c.route.endsWith('/points/query')));assert.equal(mock.collections.size,0);
  assert.equal(result.real_model_calls,0);assert.equal(result.production_ready,false);assert.deepEqual(result.cleanup.errors,[]);
  assert.ok(!readdirSync(result.run).includes('model-key'));assert.ok(!readdirSync(result.run).includes('proxy-key'));
});
