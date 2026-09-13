import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync, statSync, writeFileSync, unlinkSync} from 'node:fs';
import path from 'node:path';
import {randomBytes, randomUUID} from 'node:crypto';
import {createMnemuronApp} from '../../../server/lib/app.mjs';
import {loadMemoryRuntimeFile} from '../../../server/lib/memory-runtime.mjs';
import {storageDoctor, realDestination} from '../../../server/lib/storage-policy.mjs';
import {vectorAcceptanceTarget} from '../../../server/lib/memory-evaluation/vector.mjs';
import {QdrantStore} from '../../../server/lib/vector-stores/qdrant.mjs';
import {digest, fail} from '../../../server/lib/model-providers/contracts.mjs';
import {splitDocument} from '../../../server/lib/vector-stores/index.mjs';
import {gatewayFixture} from '../test/fixture.mjs';
import {close} from '../../../services/oauth/test/fixture.mjs';
import {writePrivate} from '../../../shared/oauth-common.mjs';

const cases=['backend_health','memory_only_http_save','default_lexical_no_embedding','unready_semantic_http',
  'configured_http_indexing','hybrid_http_scope_and_identifiers','oauth_mcp_discovery','web_search_then_full_read',
  'web_scope_and_write_denial','readonly_business_state','source_retraction_before_vector_cleanup',
  'dependency_failure_fallback','semantic_error_through_web','isolated_app_reopen','safe_logs_and_no_handoff'];
const bodies={router:'Synthetic router release 8.4.1 is approved.',near:'Synthetic router release 8.4.10 is not the pinned release.',
  disk:'Synthetic disk storage has 200 GB.',long:('Synthetic network Unicode source. '+('字段🙂 exact source stays in SQLite. '.repeat(90))).trim(),
  project:'Synthetic network project A',wrongProject:'Synthetic network project B',session:'Synthetic network session A',
  wrongSession:'Synthetic network session B',foreign:'Synthetic network other owner'};
const bindings={project_id:'project-synthetic-a',session_id:'synthetic-session-a'};
const write=(run,name,data)=>writeFileSync(path.join(run,name),JSON.stringify(data,null,2),{flag:'wx',mode:0o600});
const basis=text=>Array.from({length:768},(_,i)=>Number(i===(/storage|disk|磁盘/i.test(text)?1:/network|router|网络/i.test(text)?0:2)));
const safeError=error=>error?.code==='ERR_ASSERTION'?'ASSERTION_FAILED':/^[A-Z][A-Z0-9_]{1,60}$/.test(error?.code || '')?error.code:'ACCEPTANCE_FAILED';
async function body(req){let bytes=0,parts=[];for await(const part of req){bytes+=part.length;if(bytes>1024*1024)fail('BODY_TOO_LARGE');parts.push(part);}return bytes?JSON.parse(Buffer.concat(parts).toString('utf8')):undefined;}
async function loopback(handler){
  const server=http.createServer(async(req,res)=>{try{const result=await handler(req);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));}
    catch{res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'SYNTHETIC_DEPENDENCY_UNAVAILABLE'}));}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return {server,origin:`http://127.0.0.1:${server.address().port}`};
}

// Only newly created synthetic SQLite/OAuth accounts and owned vector collections
// are used. The model protocol fixture is loopback-only, not a real model call.
export async function evaluateApplication({config,output,allowNetwork=false,onProgress=()=>{}}={}){
  if(allowNetwork!==true)fail('NETWORK_NOT_ALLOWED');
  const target=vectorAcceptanceTarget(config);
  storageDoctor({evidence_dir:output});const destination=realDestination(output),info=statSync(destination);
  if(!info.isDirectory() || info.mode & 0o077)fail('PRIVATE_EVIDENCE_DIRECTORY_REQUIRED');
  const run=mkdtempSync(path.join(destination,'synthetic-application-')),prefix='appcheck_'+randomUUID().replaceAll('-','').slice(0,16);
  const result={version:'synthetic-application-acceptance-v1',at:new Date().toISOString(),synthetic_only:true,production_ready:false,
    real_model_calls:0,embedding:'deterministic-loopback-http-768',oauth:'isolated-real-protocol-fixture',chatgpt_ui:'not_run',
    cases:[],collections:[],cleanup:{},status:'failed'};
  write(run,'preflight.json',{...result,expected_cases:cases,thresholds:{required_case_pass_rate:1,scope_leaks:0,duplicate_memory_ids:0,raw_body_in_vector_payload:0},
    configured_database_opened:false,production_service_changed:false,collection_prefix:prefix,node:process.version});
  const cleanups=[],t={after:fn=>cleanups.push(fn)},backend=new QdrantStore(target),logs=[],memories={};
  let app,corePort=0,credential,otherCredential,auth,generation,web,token,relay,embedding,readSnapshot,lastHttpError;
  const credentials=[],collectionPattern=new RegExp(`^${prefix}_[a-f0-9]{32}$`);
  const runtimeFile=run+'/runtime.json',proxyKeyFile=run+'/proxy-key',modelKeyFile=run+'/model-key';
  const proxyKey=randomBytes(32).toString('hex'),modelKey=randomBytes(32).toString('hex');credentials.push(proxyKey,modelKey);
  const business=()=>digest(['memories','memory_revisions','memory_sources','memory_processing_outbox','tasks','events','checkpoints','resumes','resume_delivery_receipts']
    .map(table=>app.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const request=async(route,payload,{key=credential.api_key,method=payload===undefined?'GET':'POST'}={})=>{
    const response=await fetch(`http://127.0.0.1:${corePort}${route}`,{method,signal:AbortSignal.timeout(10000),headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},...(payload===undefined?{}:{body:JSON.stringify(payload)})});
    const data=await response.json();lastHttpError=response.status>=400?{status:response.status,error_code:/^[A-Z][A-Z0-9_]{1,60}$/.test(data.error_code || '')?data.error_code:'HTTP_ERROR'}:null;
    return {status:response.status,data};
  };
  const search=async(query,extra={})=>{const r=await request('/v1/memories/query',{query,...bindings,...extra});assert.equal(r.status,200);return r.data;};
  const call=async(name,args={})=>web.mcp('tools/call',{name,arguments:args},token);
  const tool=async(name,args)=>{const r=await call(name,args);assert.equal(r.status,200);assert.ok(r.data.result?.structuredContent);return r.data.result.structuredContent;};
  const forbid=()=>[memories.foreign,memories.wrongProject,memories.wrongSession].map(m=>m.memory_id);
  const assertScope=rows=>{assert.ok(rows.length);assert.ok(rows.every(r=>!forbid().includes(r.memory_id)));assert.equal(new Set(rows.map(r=>r.memory_id)).size,rows.length);};
  const check=async(name,fn)=>{
    const started=Date.now();try{const detail=await fn();const row={name,status:'passed',duration_ms:Date.now()-started,...(detail?{detail}:{})};result.cases.push(row);onProgress(row);}
    catch(error){const row={name,status:'failed',error_code:safeError(error),assertion_line:Number(error.stack?.match(/acceptance\/memory-vector\.mjs:(\d+):/)?.[1]) || null,last_http_error:lastHttpError};result.cases.push(row);onProgress(row);throw error;}
  };
  let runtime,beforeCollections;
  const start=async(mode='lexical')=>{
    runtime.memory.retrieval.mode=mode;writePrivate(runtimeFile,runtime,{replace:!!app});
    app=createMnemuronApp({databasePath:run+'/synthetic.sqlite3',memoryConfig:loadMemoryRuntimeFile(runtimeFile),memoryConfigPath:runtimeFile,logger:event=>logs.push(event)});
    corePort=(await app.listen({host:'127.0.0.1',port:corePort})).port;
  };
  const restart=async mode=>{app.server.closeAllConnections();await app.close();await start(mode);};
  try{
    await check('backend_health',async()=>{
      const health=await backend.health();assert.equal(health.version,'1.19.0');
      beforeCollections=(await backend.call('/collections',undefined,'GET')).collections.map(c=>c.name).sort();return health;
    });
    writePrivate(proxyKeyFile,proxyKey);writePrivate(modelKeyFile,modelKey);
    let forwarded=0,embeddingCalls=0,embeddingItems=0;
    relay=await loopback(async req=>{
      if(req.headers['api-key']!==proxyKey || relay.offline)fail('SYNTHETIC_DEPENDENCY_UNAVAILABLE');
      const name=new URL(req.url,'http://127.0.0.1').pathname.split('/')[2];
      if(!collectionPattern.test(name || '') || !['GET','PUT','POST'].includes(req.method))fail('SYNTHETIC_ROUTE_DENIED');
      const data=await body(req);forwarded++;
      return {status:'ok',result:await backend.call(req.url,data,req.method)};
    });
    t.after(()=>close(relay.server));
    const allowed=new Set([...Object.values(bodies).flatMap(text=>splitDocument(text,1024)),...Object.values(bodies),'network','网络设备','8.4.1','disk']);
    embedding=await loopback(async req=>{
      if(req.method!=='POST' || req.url!=='/embeddings' || req.headers.authorization!==`Bearer ${modelKey}`)fail('SYNTHETIC_ROUTE_DENIED');
      const data=await body(req);
      assert.equal(data.model,'synthetic-deterministic-basis');assert.equal(data.dimensions,768);
      assert.ok(Array.isArray(data.input) && data.input.length>0 && data.input.length<=8 && data.input.every(text=>allowed.has(text)));
      if(embeddingCalls>=100)fail('SYNTHETIC_BUDGET_EXHAUSTED');embeddingCalls++;embeddingItems+=data.input.length;
      return {data:data.input.map((text,index)=>({index,embedding:basis(text)})),usage:{prompt_tokens:data.input.length}};
    });
    t.after(()=>close(embedding.server));
    runtime={config_version:'mnemuron-memory-first-v1',deployment_mode:'test',development:{synthetic_data:true},
      modules:{memory:{enabled:true},handoff:{enabled:false,existing_inflight_policy:'drain_before_disable'}},
      memory:{capture_extraction:{enabled:false},retrieval:{mode:'lexical'}},jobs:{enabled:false},providers:{organizer:{enabled:false},embedder:{
        enabled:true,provider_id:'synthetic-http-embedder',protocol:'openai_compatible',base_url:embedding.origin,model:'synthetic-deterministic-basis',profile_revision:'v1',auth:{secret_file:modelKeyFile},
        timeouts:{request_ms:1000},limits:{input_bytes:1000000,input_tokens:4096,output_bytes:1000000,output_tokens:10000,batch_size:8,concurrency:1,daily_requests:100},
        retry:{max_attempts:1,base_ms:100,max_ms:100,repair_once:false},capabilities:{native_schema:true},
        egress:{approved:true,origins:[embedding.origin],addresses:['127.0.0.1'],allow_private:true,sensitivities:['public','internal','sensitive'],query_approved:true},
        dimensions:768,distance:'Cosine',query_prefix:'',document_prefix:'',normalization:'l2',chunker_version:'utf8-chunks-v1'}},
      vector_store:{...target,base_url:relay.origin,collection_prefix:prefix,auth:{secret_file:proxyKeyFile},egress:{approved:true,origins:[relay.origin],addresses:['127.0.0.1'],allow_private:true}}};
    await start();t.after(async()=>{if(app?.server.listening){app.server.closeAllConnections();await app.close();}});
    const issue=userId=>app.store.issueCredential({userId,label:'Synthetic application acceptance',deviceId:'synthetic-device',agentId:'synthetic',agentInstanceId:userId+'-agent',scopes:['memory:read','memory:write']});
    credential=issue('synthetic-owner');otherCredential=issue('synthetic-other-owner');credentials.push(credential.api_key,otherCredential.api_key);auth=app.store.authenticate(credential.api_key);
    app.store.ensureProject(auth,bindings.project_id,'Synthetic A');app.store.ensureProject(auth,'project-synthetic-b','Synthetic B');
    await check('memory_only_http_save',async()=>{
      for(const [name,content] of Object.entries(bodies)){
        const extras=name==='project'?{scope:'project',project_id:bindings.project_id}:name==='wrongProject'?{scope:'project',project_id:'project-synthetic-b'}:
          name==='session'?{scope:'session',...bindings}:name==='wrongSession'?{scope:'session',...bindings,session_id:'synthetic-session-b'}:{};
        const payload={scope:'user',content,operation_id:'synthetic-save-'+name,...extras},key=name==='foreign'?otherCredential.api_key:credential.api_key;
        const first=await request('/v1/memories',payload,{key}),repeat=await request('/v1/memories',payload,{key});
        assert.equal(first.status,201);
        assert.equal(repeat.status,201);
        assert.equal(first.data.memory.memory_id,repeat.data.memory.memory_id);memories[name]=first.data.memory;
      }
      assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n,9);
      assert.equal(embeddingCalls,0);assert.equal(forwarded,0);return {memories:9,replayed_saves:9,embedding_calls:0};
    });
    await check('default_lexical_no_embedding',async()=>{
      const r=await search('8.4.1');assert.equal(r.results[0].memory_id,memories.router.memory_id);
      const detail=await request('/v1/memories/'+memories.long.memory_id);assert.equal(detail.status,200);
      assert.equal((await request('/v1/status')).data.production_ready,false);assert.equal(embeddingCalls,0);assert.equal(forwarded,0);
    });
    await check('unready_semantic_http',async()=>{
      const r=await request('/v1/memories/query',{query:'network',mode:'semantic'});assert.equal(r.status,503);assert.equal(r.data.error_code,'SEMANTIC_UNAVAILABLE');
      assert.equal((await search('8.4.1',{mode:'hybrid'})).retrieval.degraded,true);assert.equal(embeddingCalls,0);
    });
    await check('configured_http_indexing',async()=>{
      generation=app.store.vectorIndex.begin(app.store.embedder.profile.fingerprint);
      const name=app.store.db.prepare('SELECT collection_name FROM memory_vector_generations WHERE generation=?').get(generation).collection_name;
      assert.ok(collectionPattern.test(name));result.collections.push(name);
      await app.store.vectorIndex.sync(generation);app.store.vectorIndex.activate(generation);
      const before=embeddingCalls;assert.ok(before>0);assert.equal((await app.store.vectorIndex.sync(generation)).processed,0);assert.equal(embeddingCalls,before);
      let offset=null,points=[];do{const page=await backend.scroll(name,offset);points.push(...page.points);offset=page.next_page_offset ?? null;}while(offset!==null);
      assert.ok(points.length>9);for(const point of points){assert.deepEqual(Object.keys(point.payload).sort(),['content_hash','document','lifecycle','owner','profile','revision','scope']);assert.doesNotMatch(JSON.stringify(point.payload),/Synthetic|字段|synthetic-owner|network/);}
      return {points:points.length,synthetic_embedding_http_calls:embeddingCalls,repeat_processed:0};
    });
    await check('hybrid_http_scope_and_identifiers',async()=>{
      for(const mode of ['lexical','hybrid','semantic']){const r=await search('network',{mode,limit:20});assertScope(r.results);assert.ok(r.results.some(m=>m.memory_id===memories.project.memory_id));assert.ok(r.results.some(m=>m.memory_id===memories.session.memory_id));}
      const semantic=await search('网络设备',{mode:'semantic'});assertScope(semantic.results);assert.equal(semantic.retrieval.degraded,false);
      assert.equal((await search('8.4.1',{mode:'hybrid'})).results[0].memory_id,memories.router.memory_id);
    });
    await restart('hybrid');
    await check('oauth_mcp_discovery',async()=>{
      web=await gatewayFixture(t,{profile:'readonly',coreFixture:{store:app.store,baseUrl:`http://127.0.0.1:${corePort}`,a:{auth}},mutate:c=>{c.core.timeout_ms=5000;}});
      assert.equal((await web.mcp('tools/list')).status,401);
      const exchange=await web.exchange(await web.authorize());assert.equal(exchange.status,200);token=exchange.data.access_token;assert.ok(token);
      credentials.push(token,web.coreCredential.api_key,web.secret,web.introspectionSecret);
      const list=await web.mcp('tools/list',undefined,token);assert.equal(list.status,200);
      assert.deepEqual(list.data.result.tools.map(x=>x.name).sort(),['mnemuron_auth_status','mnemuron_get_memory','mnemuron_preview_project_context','mnemuron_search_memories']);
      assert.ok(list.data.result.tools.every(x=>x.annotations.readOnlyHint===true && x.annotations.destructiveHint===false));
      const status=await tool('mnemuron_auth_status',{});assert.equal(status.authenticated,true);assert.equal(status.tool_profile,'readonly');readSnapshot=business();
    });
    await check('web_search_then_full_read',async()=>{
      const searchResult=await tool('mnemuron_search_memories',{query:'网络设备',...bindings,limit:20});assertScope(searchResult.results);
      assert.equal(searchResult.retrieval.mode,'hybrid');assert.equal(searchResult.retrieval.degraded,false);
      const selected=searchResult.results.find(m=>m.memory_id===memories.long.memory_id);assert.ok(selected);
      let offset=0,content='',pages=0;do{
        const detail=await tool('mnemuron_get_memory',{memory_id:selected.memory_id,content_offset:offset,content_limit:700});
        assert.equal(detail.content_offset,offset);assert.equal(detail.source_manifest.sources[0].source_kind,'explicit_memory');
        assert.ok(detail.source_manifest.revision>=1);content+=detail.memory.content;pages++;assert.ok(pages<20);
        if(detail.content_complete){assert.equal(detail.next_offset,null);break;}assert.ok(detail.next_offset>offset);offset=detail.next_offset;
      }while(true);
      assert.equal(content,bodies.long);assert.ok(pages>1);return {search_returned_id_used:true,pages,unicode_code_points:Array.from(content).length,full_source_exact:true};
    });
    await check('web_scope_and_write_denial',async()=>{
      assert.equal((await call('mnemuron_get_memory',{memory_id:memories.foreign.memory_id})).status,404);
      assert.equal((await call('mnemuron_search_memories',{query:'network',user_id:'synthetic-other-owner'})).status,400);
      assert.equal((await call('mnemuron_search_memories',{query:'network',mode:'semantic'})).status,400);
      for(const name of ['mnemuron_remember','mnemuron_confirm_resume','mnemuron_delete_memory']){const r=await call(name,{});assert.ok(r.data.error || r.data.result?.isError);}
      assert.equal((await request('/v1/memories',{scope:'user',content:'Synthetic forbidden write'},{key:web.coreCredential.api_key})).status,403);
      const preview=await tool('mnemuron_preview_project_context',{query:bindings.project_id});assert.equal(preview.safety.resume_created,false);
    });
    await check('readonly_business_state',async()=>{assert.equal(business(),readSnapshot);return {memory_and_handoff_mutations:0};});
    await check('source_retraction_before_vector_cleanup',async()=>{
      assert.equal((await request('/v1/memories/'+memories.disk.memory_id+'/retract',{})).status,200);
      const r=await tool('mnemuron_search_memories',{query:'disk',...bindings,limit:20});assert.ok(!r.results.some(m=>m.memory_id===memories.disk.memory_id));
      assert.equal((await call('mnemuron_get_memory',{memory_id:memories.disk.memory_id})).status,404);
      const history=await tool('mnemuron_get_memory',{memory_id:memories.disk.memory_id,include_history:true});assert.equal(history.memory.status,'retracted');
      await app.store.vectorIndex.sync(generation);
    });
    await check('dependency_failure_fallback',async()=>{
      relay.offline=true;const before=forwarded;
      const fallback=await tool('mnemuron_search_memories',{query:'8.4.1',...bindings});assert.equal(fallback.retrieval.degraded,true);assert.equal(fallback.retrieval.fallback,'lexical');
      assert.equal(fallback.results[0].memory_id,memories.router.memory_id);assert.equal(forwarded,before);
      const r=await request('/v1/memories/query',{query:'network',mode:'semantic'});assert.equal(r.status,503);assert.equal(r.data.error_code,'SEMANTIC_UNAVAILABLE');
      return {fault:'owned-relay-503',qdrant_service_stopped:false,lexical_source_retained:true};
    });
    await check('semantic_error_through_web',async()=>{
      await restart('semantic');const r=await call('mnemuron_search_memories',{query:'network',...bindings});assert.equal(r.status,503);assert.equal(r.data.error_code,'SEMANTIC_UNAVAILABLE');
      relay.offline=false;assert.equal((await tool('mnemuron_search_memories',{query:'network',...bindings})).retrieval.degraded,false);
    });
    await check('isolated_app_reopen',async()=>{
      const snapshot=app.store.vectorIndex.snapshot();await restart('hybrid');assert.deepEqual(app.store.vectorIndex.snapshot(),snapshot);
      const r=await tool('mnemuron_search_memories',{query:'8.4.1',...bindings});assert.equal(r.retrieval.degraded,false);assert.equal(r.results[0].memory_id,memories.router.memory_id);
      const before=embeddingCalls;assert.equal((await app.store.vectorIndex.sync(generation)).processed,0);assert.equal(embeddingCalls,before);
    });
    await check('safe_logs_and_no_handoff',async()=>{
      const logged=JSON.stringify([...logs,...web.gatewayLogs,...web.logs]);for(const secret of [...credentials,...Object.values(bodies)])assert.ok(!logged.includes(secret));
      for(const table of ['tasks','events','checkpoints','resumes','resume_delivery_receipts'])assert.equal(app.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,0);
      assert.equal((await request('/v1/status')).data.production_ready,false);
      return {raw_body_or_credential_in_logs:0,handoff_rows:0,synthetic_embedding_http_calls:embeddingCalls,synthetic_embedding_items:embeddingItems,qdrant_forwarded_requests:forwarded};
    });
    result.status='passed';
  }catch(error){result.error_code=safeError(error);}
  finally{
    for(const name of cases)if(!result.cases.some(c=>c.name===name))result.cases.push({name,status:'not_run'});
    const errors=[];for(const cleanup of cleanups.reverse())try{await cleanup();}catch{errors.push('PROCESS_CLEANUP_FAILED');}
    for(const name of result.collections)try{
      if(!collectionPattern.test(name))fail('OWNED_COLLECTION_REQUIRED');
      await backend.call('/collections/'+name,undefined,'DELETE');
      assert.equal((await backend.call('/collections/'+name+'/exists',undefined,'GET')).exists,false);
    }catch{errors.push('COLLECTION_CLEANUP_FAILED');}
    for(const filename of [proxyKeyFile,modelKeyFile])try{unlinkSync(filename);}catch(error){if(error.code!=='ENOENT')errors.push('SECRET_CLEANUP_FAILED');}
    if(beforeCollections)try{assert.deepEqual((await backend.call('/collections',undefined,'GET')).collections.map(c=>c.name).sort(),beforeCollections);}catch{errors.push('COLLECTION_BASELINE_CHANGED');}
    result.cleanup={isolated_processes_closed:errors.every(e=>e!=='PROCESS_CLEANUP_FAILED'),owned_collections_removed:errors.every(e=>!e.startsWith('COLLECTION')),unrelated_collection_names_unchanged:errors.every(e=>e!=='COLLECTION_BASELINE_CHANGED'),temporary_keys_removed:errors.every(e=>e!=='SECRET_CLEANUP_FAILED'),errors};
    if(errors.length)result.status='failed';write(run,'result.json',result);
  }
  return {...result,run};
}
