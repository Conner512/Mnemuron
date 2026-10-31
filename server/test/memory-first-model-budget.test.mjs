import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {Organizer,Embedder} from '../lib/model-providers/providers.mjs';
import {profile} from './helpers/memory-models.mjs';

const schema={type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false};
async function endpoint(t,reply){
  const calls=[],server=http.createServer(async(request,response)=>{
    const chunks=[];for await(const chunk of request)chunks.push(chunk);const raw=Buffer.concat(chunks),body=JSON.parse(raw);
    calls.push({route:request.url,body,bytes:raw.length});response.setHeader('content-type','application/json');response.end(JSON.stringify(reply(body,request.url,calls.length)));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const origin='http://127.0.0.1:'+server.address().port;
  const config=(kind,protocol='openai_compatible',patch={})=>profile(kind,{protocol,base_url:origin,egress:{approved:true,origins:[origin],addresses:['127.0.0.1'],allow_private:true,query_approved:true},...patch});
  return {calls,config};
}
const chatReply=(protocol,content='{"ok":true}')=>protocol==='ollama'?{done:true,message:{content}}:{choices:[{finish_reason:'stop',message:{content}}]};

test('complete organizer byte and conservative token limits reject before quota reservation or HTTP delivery',async t=>{
  const f=await endpoint(t,()=>chatReply('openai_compatible'));
  for(const field of ['input_bytes','input_tokens']){
    let reserved=0;
    const model=new Organizer(f.config('organizer','openai_compatible',{limits:{...profile().limits,[field]:128}}));
    await assert.rejects(model.generateStructured({text:'合成测试'},schema,{reserve:()=>reserved++}),{code:'INPUT_TOO_LARGE'});
    assert.equal(reserved,0);assert.equal(f.calls.length,0);
  }
});

test('pure request measurements equal real OpenAI and Ollama wire bytes, including schema, prefixes and envelope',async t=>{
  for(const protocol of ['openai_compatible','ollama']){
    const f=await endpoint(t,(_body,route)=>/embed/.test(route)?(protocol==='ollama'?{embeddings:[[1,0,0]]}:{data:[{index:0,embedding:[1,0,0]}]}):chatReply(protocol));
    for(const native_schema of [true,false]){
      const model=new Organizer(f.config('organizer',protocol,{capabilities:{native_schema}})),input={text:'精确版本 17.9.8；引号 " 原样保留。'};
      const before=f.calls.length,cost=model.measureRequest(input,schema);assert.equal(f.calls.length,before);assert.equal(cost.fits,true);
      assert.equal(cost.input_tokens,cost.input_bytes);assert.ok(cost.input_bytes>Buffer.byteLength(JSON.stringify(input)));
      let reserved=0;await model.generateStructured(input,schema,{reserve:()=>reserved++});assert.equal(reserved,1);assert.equal(f.calls.at(-1).bytes,cost.input_bytes);
    }
    const embedding=new Embedder(f.config('embedder',protocol,{document_prefix:'文档前缀：',query_prefix:'查询前缀：'}));
    for(const type of ['document','query']){
      const cost=embedding.measureRequest(['合成来源 1.5 TB'],type),before=f.calls.length;assert.equal(cost.fits,true);assert.equal(f.calls.length,before);
      await embedding.embed(['合成来源 1.5 TB'],type);assert.equal(f.calls.at(-1).bytes,cost.input_bytes);
      assert.deepEqual(f.calls.at(-1).body.input,[(type==='query'?'查询前缀：':'文档前缀：')+'合成来源 1.5 TB']);
    }
  }
});

test('an oversized repair does not consume a second reservation; a fitting repair still counts each real request',async t=>{
  for(const fitsRepair of [false,true]){
    const f=await endpoint(t,(_body,_route,count)=>chatReply('openai_compatible',count===1?'{broken':'{"ok":true}'));
    const base=f.config('organizer','openai_compatible',{retry:{max_attempts:2,base_ms:1,max_ms:10,repair_once:true}}),probe=new Organizer(base),input={text:'Synthetic repair input'};
    const first=probe.measureRequest(input,schema),repair=probe.measureRequest(input,schema,{repair:true});assert.ok(repair.input_bytes>first.input_bytes);
    const maximum=(fitsRepair?repair:first).input_bytes,model=new Organizer({...base,limits:{...base.limits,input_bytes:maximum,input_tokens:maximum}});let reserved=0;
    const generated=model.generateStructured(input,schema,{reserve:()=>reserved++});
    if(fitsRepair)assert.equal((await generated).data.ok,true);else await assert.rejects(generated,{code:'INPUT_TOO_LARGE'});
    assert.equal(reserved,fitsRepair?2:1);assert.equal(f.calls.length,reserved);assert.ok(f.calls.every(call=>call.bytes<=maximum));
  }
});

test('embedding envelope limits are also checked before charging a request',async t=>{
  const f=await endpoint(t,()=>({data:[{index:0,embedding:[1,0,0]}]}));
  for(const field of ['input_bytes','input_tokens']){
    const model=new Embedder(f.config('embedder','openai_compatible',{document_prefix:'prefix: ',limits:{...profile('embedder').limits,[field]:64}}));let reserved=0;
    await assert.rejects(model.embed(['short'],'document',{reserve:()=>reserved++}),{code:'INPUT_TOO_LARGE'});assert.equal(reserved,0);assert.equal(f.calls.length,0);
  }
});
