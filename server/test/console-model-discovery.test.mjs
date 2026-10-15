// Console model-list discovery (MD-01..MD-08). Synthetic loopback endpoints and injected DNS only: no real provider,
// no real key. Discovery never saves settings, records verification, spends model budget, runs inference or queues work.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {memoryFixture} from './helpers/core-memory-fixture.mjs';
import {CONSOLE_WRITE_SCOPES,CONSOLE_BASIC_SCOPES,CONSOLE_READ_SCOPES} from '../../shared/console-contract.mjs';
import {DISCOVERY,modelIds} from '../lib/console/models.mjs';

const SAVED='synthetic-saved-key-SENTINEL-7f3a',TYPED='synthetic-typed-key-SENTINEL-91c2';
const until=async(condition,label,pending=null)=>{for(let i=0;i<400;i++){if(condition())return;
  if(pending){const settled=await Promise.race([pending.then(()=>'resolved',e=>e),new Promise(r=>setTimeout(()=>r(null),5))]);if(settled)throw new Error(`${label}: settled early (${settled.errorCode||settled.code||settled})`);}
  else await new Promise(r=>setTimeout(r,5));}throw new Error(`${label}: timed out`);};
const code=expected=>error=>{assert.equal(error.errorCode||error.code,expected,`${error.errorCode||error.code} (${error.message})`);return true;};

// A loopback "provider": records every request; the reply is chosen per test.
async function provider(t){
  const calls=[];let reply=(req)=>({status:200,body:{object:'list',data:[{id:'synthetic-b'},{id:'synthetic-a'},{id:'synthetic-a'}]}});let hold=null;
  const server=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;
    calls.push({method:req.method,url:req.url,authorization:req.headers.authorization??null,body:raw});
    if(hold)await hold;
    const r=reply(req);res.writeHead(r.status,{'content-type':'application/json',...(r.headers||{})});res.end(typeof r.body==='string'?r.body:JSON.stringify(r.body));});
  let connections=0;server.on('connection',()=>{connections++;});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections?.();server.close(r);}));
  return {calls,connections:()=>connections,port:server.address().port,origin:`http://127.0.0.1:${server.address().port}`,set:fn=>{reply=fn;},
    hold(){let release;hold=new Promise(r=>{release=r;});return ()=>{hold=null;release();};}};
}
async function setup(t){
  const f=await memoryFixture(t),key=f.root+'/discovery.key';fs.writeFileSync(key,randomBytes(32).toString('base64url'),{mode:0o600});
  const p=await provider(t),other=await provider(t);
  const named=`http://models.synthetic.test:${p.port}`;
  f.store.memoryConfig.console={key_file:key,worker_enabled:false,allowed_private_origins:[p.origin,other.origin,named]};
  const issue=(user,scopes=CONSOLE_WRITE_SCOPES)=>{const c=f.store.issueCredential({userId:user,deviceId:'synthetic-discovery',agentId:'mnemuron-console',agentInstanceId:randomUUID(),scopes});return {...c,auth:f.store.authenticate(c.api_key)};};
  const a=issue(f.a.auth.user_id),b=issue(f.other.auth.user_id),service=f.store.consoleService,models=service.models;
  const act=(action,payload,owner=a)=>service.execute(owner.auth,{action,payload,operation_id:randomUUID()});
  const discover=(payload={},owner=a)=>act('models.discover',{kind:'organizer',expected_revision:0,protocol:'openai_compatible',base_url:p.origin,key_source:'none',consent:true,...payload},owner);
  const config={enabled:true,protocol:'openai_compatible',base_url:p.origin,model:'synthetic-model',profile_revision:'1',daily_requests:100,output_tokens:4096,batch_size:5,sensitivities:['public','internal','sensitive'],egress_approved:true,query_approved:true};
  const save=(overrides={},revision=0,extra={},owner=a)=>act('models.save',{kind:'organizer',expected_revision:revision,config:{...config,...overrides},...extra},owner);
  const tables=['console_models','console_model_tests','memory_jobs','memory_model_budget','memory_owner_model_usage','console_operations'];
  const state=()=>JSON.stringify(tables.map(name=>f.store.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()));
  const audits=()=>f.store.db.prepare("SELECT outcome,metadata_json FROM audit_events WHERE action='console.models.discover' ORDER BY rowid").all();
  return {...f,p,other,named,a,b,issue,service,models,act,discover,save,state,audits};
}

test('MD-01: an unsaved form lists models with one GET and no inference body; nothing is saved, verified, queued or budgeted',async t=>{
  const f=await setup(t),before=f.state();
  const r=await f.discover({key_source:'typed',api_key:TYPED});
  assert.deepEqual([r.status,r.models,r.total,r.truncated,r.dropped,r.settings_saved,r.capability_verified],['listed',['synthetic-a','synthetic-b'],2,false,0,false,false]);
  assert.deepEqual(f.p.calls,[{method:'GET',url:'/models',authorization:`Bearer ${TYPED}`,body:''}],'one bodyless GET of the list route');
  assert.equal(f.state(),before,'no settings, verification, jobs, budget or operation receipt');
  assert.ok(!JSON.stringify(r).includes(TYPED));
  assert.deepEqual(f.audits().map(a=>[a.outcome,JSON.parse(a.metadata_json)]),[['success',{kind:'organizer',count:2,truncated:false}]]);
  assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM audit_events').all()).includes(TYPED),'the typed key is never audited');
  // Ollama lists its local models under /api/tags at the configured root.
  f.p.set(()=>({status:200,body:{models:[{name:'llama-synthetic:8b'},{model:'qwen-synthetic'}]}}));
  const o=await f.discover({protocol:'ollama'});
  assert.deepEqual(o.models,['llama-synthetic:8b','qwen-synthetic']);assert.deepEqual(f.p.calls.at(-1),{method:'GET',url:'/api/tags',authorization:null,body:''});
  // A gateway base path is kept, never doubled or stripped.
  f.p.set(()=>({status:200,body:{data:[{id:'gateway-model'}]}}));
  assert.deepEqual((await f.discover({base_url:`${f.p.origin}/v1/`})).models,['gateway-model']);assert.equal(f.p.calls.at(-1).url,'/v1/models');
});

test('MD-02: a saved key is used only for its owner and kind, at the saved origin and revision; consent and input are strict',async t=>{
  const f=await setup(t);await f.save({},0,{api_key:SAVED});
  const r=await f.discover({key_source:'saved',expected_revision:1});
  assert.equal(f.p.calls.at(-1).authorization,`Bearer ${SAVED}`);assert.ok(!JSON.stringify(r).includes(SAVED));
  const calls=f.p.calls.length+f.other.calls.length;
  // Never to another origin, another kind or another owner; pending removal is sent as key_source none by the form.
  await assert.rejects(f.discover({key_source:'saved',expected_revision:1,base_url:f.other.origin}),code('MODEL_KEY_UNAVAILABLE'));
  await assert.rejects(f.discover({key_source:'saved',expected_revision:0,kind:'embedder'}),code('MODEL_KEY_UNAVAILABLE'));
  await assert.rejects(f.discover({key_source:'saved'},f.b),code('MODEL_KEY_UNAVAILABLE'));
  await assert.rejects(f.discover({key_source:'saved',expected_revision:0}),code('MODEL_VERSION_CHANGED'));
  await assert.rejects(f.discover({key_source:'saved',expected_revision:1,consent:false}),code('MODEL_DISCOVERY_CONSENT_REQUIRED'));
  await assert.rejects(f.discover({key_source:'saved',expected_revision:1,api_key:TYPED}),code('INVALID_CONSOLE_INPUT'));
  await assert.rejects(f.discover({key_source:'typed',expected_revision:1}),code('INVALID_CONSOLE_INPUT'));
  await assert.rejects(f.discover({key_source:'saved',expected_revision:1,model:'x'}),code('INVALID_CONSOLE_INPUT'),'unknown fields are refused');
  await assert.rejects(f.discover({key_source:'saved',expected_revision:1,protocol:'anthropic'}),code('INVALID_CONSOLE_INPUT'));
  assert.equal(f.p.calls.length+f.other.calls.length,calls,'no refused request reached any endpoint');
  // Without a key no authorization header is sent, even when one is saved.
  await f.discover({expected_revision:1});assert.equal(f.p.calls.at(-1).authorization,null);
  // Other saved keys at the same origin: each owner and kind gets exactly its own key.
  const EMBED='synthetic-embedder-key-SENTINEL',OTHER='synthetic-owner-b-key-SENTINEL';
  await f.act('models.save',{kind:'embedder',expected_revision:0,api_key:EMBED,config:{enabled:true,protocol:'openai_compatible',base_url:f.p.origin,model:'synthetic-embed',profile_revision:'1',daily_requests:100,output_tokens:4096,batch_size:5,dimensions:3,sensitivities:['public'],egress_approved:true,query_approved:false}});
  await f.save({},0,{api_key:OTHER},f.b);
  const sent=async(payload,owner)=>{await f.discover(payload,owner);return f.p.calls.at(-1).authorization;};
  assert.equal(await sent({key_source:'saved',expected_revision:1}),`Bearer ${SAVED}`);
  assert.equal(await sent({key_source:'saved',expected_revision:1,kind:'embedder'}),`Bearer ${EMBED}`);
  assert.equal(await sent({key_source:'saved',expected_revision:1},f.b),`Bearer ${OTHER}`);
});

test('MD-03: a configuration change while DNS or the reply is pending makes the result stale; no request starts after a change during DNS',async t=>{
  const f=await setup(t);await f.save({base_url:f.named},0,{api_key:SAVED});
  let releaseDns;const dns=new Promise(r=>{releaseDns=r;});
  f.models.lookup=async()=>{await dns;return [{address:'127.0.0.1',family:4}];};
  const during=f.discover({key_source:'saved',expected_revision:1,base_url:f.named});
  await new Promise(r=>setImmediate(r));
  await f.save({base_url:f.named,daily_requests:99},1);releaseDns();
  await assert.rejects(during,code('MODEL_VERSION_CHANGED'));
  assert.equal(f.p.calls.length,0,'the key was never sent after the change during DNS');
  // A change while the reply is held: the list is not returned.
  f.models.lookup=async()=>[{address:'127.0.0.1',family:4}];
  const release=f.p.hold(),pending=f.discover({key_source:'saved',expected_revision:2,base_url:f.named});
  await until(()=>f.p.calls.length>0,'held reply',pending);
  await f.save({base_url:f.named,daily_requests:98},2);release();
  await assert.rejects(pending,code('MODEL_VERSION_CHANGED'));
  assert.deepEqual(f.audits().map(a=>JSON.parse(a.metadata_json).error_code),['MODEL_VERSION_CHANGED','MODEL_VERSION_CHANGED']);
});

test('MD-04: one deadline covers DNS and HTTP; a late lookup never starts a request',async t=>{
  const f=await setup(t);f.models.discoveryDeadlineMs=60;
  f.models.lookup=()=>new Promise(r=>setTimeout(()=>r([{address:'127.0.0.1',family:4}]),150));
  await assert.rejects(f.discover({base_url:f.named}),code('REQUEST_TIMEOUT'));
  await new Promise(r=>setTimeout(r,200));
  assert.equal(f.p.connections(),0,'the lookup finished after the deadline and opened no connection');
  // A lookup that never settles: the deadline still answers, and the slot is freed for the next attempt.
  f.models.lookup=()=>new Promise(()=>{});
  await assert.rejects(f.discover({base_url:f.named}),code('REQUEST_TIMEOUT'));
  await assert.rejects(f.discover({base_url:f.named}),code('REQUEST_TIMEOUT'),'not MODEL_DISCOVERY_PENDING: the slot was released');
  // A lookup that completes after the deadline has passed (controlled clock, so the DNS timer cannot fire first) is
  // still refused before any request starts.
  const real=f.models.clock;let calls=0;f.models.clock=()=>calls++===0?0:1e12;
  f.models.lookup=async()=>[{address:'127.0.0.1',family:4}];
  await assert.rejects(f.discover({base_url:f.named}),code('REQUEST_TIMEOUT'));
  await new Promise(r=>setTimeout(r,50));
  assert.equal(f.p.connections(),0,'no connection was opened');f.models.clock=real;
  // A slow reply is cut off with the remaining time.
  const release=f.p.hold();t.after(release);
  const started=Date.now();await assert.rejects(f.discover(),code('REQUEST_TIMEOUT'));
  assert.ok(Date.now()-started<1000);
});

test('MD-05: provider replies map to fixed codes without bodies; IDs are bounded, deduplicated and safe to offer',async t=>{
  const f=await setup(t),secretBody={error:'upstream-private-error-body SENTINEL'};
  for(const [status,expected] of [[401,'AUTH_FAILED'],[403,'AUTH_FAILED'],[404,'HTTP_REJECTED'],[429,'RATE_LIMITED'],[500,'REMOTE_UNAVAILABLE'],[503,'REMOTE_UNAVAILABLE']]){
    f.p.set(()=>({status,body:secretBody}));
    await assert.rejects(f.discover(),error=>{code(expected)(error);assert.ok(!String(error.message).includes('SENTINEL'));return true;},String(status));
  }
  f.p.set(()=>({status:200,body:'not json'}));await assert.rejects(f.discover(),code('INVALID_JSON'));
  f.p.set(()=>({status:200,body:{models:['wrong shape']}}));await assert.rejects(f.discover(),code('MODEL_LIST_INVALID'));
  f.p.set(()=>({status:200,body:{data:[{id:'x'.repeat(DISCOVERY.max_bytes)}]}}));await assert.rejects(f.discover(),code('OUTPUT_TOO_LARGE'));
  // A redirect is refused and its target receives nothing.
  f.p.set(()=>({status:302,headers:{location:`${f.other.origin}/models`},body:{}}));
  await assert.rejects(f.discover({key_source:'typed',api_key:TYPED}),code('REDIRECT_DENIED'));assert.equal(f.other.calls.length,0);
  // Unusable IDs are dropped and counted; markup-like text stays an ordinary ID (rendered as text).
  const ids=['ok-1','ok-1',' padded','x'.repeat(161),'tab\there','','<b>markup-like</b>',42,null,'x'.repeat(160),'bidi\u202Espoof','zero\u200Bwidth','line\u2028sep'];
  f.p.set(()=>({status:200,body:{data:ids.map(id=>({id}))}}));
  const r=await f.discover();
  assert.deepEqual(r.models,['<b>markup-like</b>','ok-1','x'.repeat(160)]);assert.equal(r.dropped,9);
  f.p.set(()=>({status:200,body:{data:Array.from({length:DISCOVERY.max_models+25},(_,i)=>({id:`m-${String(i).padStart(4,'0')}`}))}}));
  const many=await f.discover();assert.deepEqual([many.count,many.total,many.truncated,many.models.length],[DISCOVERY.max_models,DISCOVERY.max_models+25,true,DISCOVERY.max_models]);
  assert.deepEqual(modelIds('openai_compatible',{data:[]}),{models:[],count:0,total:0,truncated:false,dropped:0});
});

test('MD-06: the URL rules, address classes and pinned DNS still apply; consent never widens egress',async t=>{
  const f=await setup(t);let lookups=0;
  f.models.lookup=async host=>{lookups++;return host==='metadata.synthetic.test'?[{address:'127.0.0.1',family:4}]:host==='mixed.synthetic.test'?[{address:'127.0.0.1',family:4},{address:'169.254.169.254',family:4}]:[{address:'169.254.169.254',family:4}];};
  for(const url of ['http://198.51.100.7/v1','https://user:pw@example.test/v1','https://example.test/v1?x=1','https://example.test/v1#f','ftp://example.test'])
    await assert.rejects(f.discover({base_url:url}),code('MODEL_URL_DENIED'),url);
  await assert.rejects(f.discover({base_url:'not a url'}),/Invalid model URL/);
  assert.equal(lookups,0,'refused before any lookup');
  f.store.memoryConfig.console.allowed_private_origins.push(`http://link-local.synthetic.test:${f.p.port}`,`http://mixed.synthetic.test:${f.p.port}`);
  await assert.rejects(f.discover({base_url:`http://link-local.synthetic.test:${f.p.port}`}),code('ADDRESS_DENIED'));
  await assert.rejects(f.discover({base_url:`http://mixed.synthetic.test:${f.p.port}`}),code('ADDRESS_DENIED'));
  await assert.rejects(f.discover({base_url:'https://metadata.synthetic.test'}),code('EGRESS_DENIED'));
  // An approved private HTTP origin whose name resolves publicly needs TLS (private HTTP is for private addresses only).
  f.models.lookup=async()=>[{address:'198.51.100.7',family:4}];
  f.store.memoryConfig.console.allowed_private_origins.push('http://public.synthetic.test');
  await assert.rejects(f.discover({base_url:'http://public.synthetic.test'}),code('TLS_REQUIRED'));
  // The main SSRF case: an HTTPS name that resolves to a loopback or private address, with no operator approval.
  f.models.lookup=async()=>[{address:'127.0.0.1',family:4}];
  await assert.rejects(f.discover({base_url:'https://internal.synthetic.test'}),code('ADDRESS_DENIED'));
  f.models.lookup=async()=>[{address:'fd12:3456::7',family:6}];
  await assert.rejects(f.discover({base_url:'https://internal.synthetic.test'}),code('ADDRESS_DENIED'));
  assert.equal(f.p.calls.length,0,'no request reached the endpoint');
  // A saved egress denial for the origin is not overridden by the one-time consent, with any key source; another
  // origin (an unsaved draft) is not affected by it.
  await f.save({egress_approved:false},0,{api_key:SAVED});
  for(const key_source of ['saved','none'])await assert.rejects(f.discover({key_source,expected_revision:1}),code('EGRESS_DENIED'),key_source);
  await assert.rejects(f.discover({key_source:'typed',api_key:TYPED,expected_revision:1}),code('EGRESS_DENIED'));
  assert.equal(f.p.calls.length,0,'the saved key never left after a stored denial');
  assert.equal((await f.discover({expected_revision:1,base_url:f.other.origin})).status,'listed');
});

test('MD-07: one request per owner and kind at a time; other owners and kinds are independent',async t=>{
  const f=await setup(t),release=f.p.hold();
  const first=f.discover();await until(()=>f.p.calls.length>0,'first request',first);
  await assert.rejects(f.discover(),code('MODEL_DISCOVERY_PENDING'));
  const otherKind=f.discover({kind:'embedder'}),otherOwner=f.discover({},f.b);
  await until(()=>f.p.calls.length>=3,'three requests');
  release();await Promise.all([first,otherKind,otherOwner]);
  assert.equal(f.p.calls.length,3,'the refused duplicate made no outbound call');
  assert.equal((await f.discover()).status,'listed','the slot is free again');
});

test('MD-08: only full Console write credentials may discover; the action is in the shared contract',async t=>{
  const f=await setup(t);
  for(const scopes of [CONSOLE_BASIC_SCOPES,CONSOLE_READ_SCOPES]){const owner=f.issue(f.a.auth.user_id,scopes);
    await assert.rejects(f.discover({},owner),error=>/scope|console:write|Console write|authoriz/i.test(error.message)||['CONSOLE_UPGRADE_REQUIRED','FORBIDDEN','INSUFFICIENT_SCOPE'].includes(error.errorCode||error.code));}
  assert.equal(f.p.calls.length,0);
});
