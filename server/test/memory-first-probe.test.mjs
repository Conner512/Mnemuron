import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {memoryCommand} from '../bin/mnemuron-memory.mjs';
import {config,profile} from './helpers/memory-models.mjs';

async function fixture(t,{ok=true,authError=false,enabled=true}={}){
  const root=mkdtempSync(path.join(os.tmpdir(),'mnemuron-probe-')),requests=[];
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);requests.push({route:req.url,body});res.setHeader('content-type','application/json');
    if(req.url==='/chat/completions'){
      if(authError){res.writeHead(401);res.end('SYNTHETIC-PRIVATE-ERROR');}
      else res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({ok})}}]}));
    }else res.end(JSON.stringify({data:body.input.map((_,index)=>({index,embedding:[1,0,0]}))}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();server.close();rmSync(root,{recursive:true,force:true});});
  const origin='http://127.0.0.1:'+server.address().port;
  const p=kind=>enabled?profile(kind,{protocol:'openai_compatible',base_url:origin,egress:{approved:true,origins:[origin],addresses:['127.0.0.1'],allow_private:true,sensitivities:['public'],query_approved:true}}):{enabled:false};
  const database=root+'/never-open.sqlite3',filename=root+'/synthetic-config.json';
  writeFileSync(filename,JSON.stringify({...config,storage:{sqlite_path:database},providers:{organizer:p('organizer'),embedder:p('embedder')}}),{mode:0o600});
  return {filename,database,requests};
}

test('L-10: provider validation is offline by default and does not create a memory database',async t=>{
  const f=await fixture(t),r=await memoryCommand(['provider-validate','--config',f.filename]);
  assert.equal(r.network_called,false);assert.equal(f.requests.length,0);assert.equal(existsSync(f.database),false);
});
test('L-10: explicit synthetic probe checks organizer plus document and query embeddings without a database',async t=>{
  const f=await fixture(t),r=await memoryCommand(['provider-validate','--config',f.filename,'--allow-network','true']);
  assert.equal(r.status,'passed');assert.equal(r.database_opened,false);assert.equal(existsSync(f.database),false);
  assert.equal(r.quality_acceptance,'not_evaluated');assert.equal(r.checks[1].dimensions,3);assert.equal(r.checks[1].query_dimensions,3);
  assert.deepEqual(f.requests.map(r=>r.route),['/chat/completions','/embeddings','/embeddings']);
});
test('L-10: false probe content cannot pass, and a failed organizer does not suppress embedder checks',async t=>{
  for(const options of [{ok:false},{authError:true}]){
    const f=await fixture(t,options),r=await memoryCommand(['provider-validate','--config',f.filename,'--allow-network','true']);
    assert.equal(r.status,'failed');assert.equal(r.checks[0].error_code,options.authError?'AUTH_FAILED':'PROBE_OUTPUT_MISMATCH');
    assert.equal(r.checks[1].status,'passed');assert.equal(f.requests.length,3);assert.equal(existsSync(f.database),false);
    assert.ok(!JSON.stringify(r).includes('SYNTHETIC-PRIVATE-ERROR'));
  }
});
test('L-10 Q-02: missing models produce a blocked CLI exit, not a false successful acceptance',async t=>{
  const f=await fixture(t,{enabled:false});
  const result=spawnSync(process.execPath,['server/bin/mnemuron-memory.mjs','provider-validate','--config',f.filename,'--allow-network','true'],{cwd:path.resolve(import.meta.dirname,'../..'),encoding:'utf8'});
  assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).status,'blocked');
  assert.equal(f.requests.length,0);assert.equal(existsSync(f.database),false);
});
