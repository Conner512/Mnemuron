import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import {cloudFixture} from './cloud-fixture.mjs';
const value=r=>{assert.notEqual(r.isError,true,JSON.stringify(r));return r.structuredContent;};
const error=r=>{assert.equal(r.isError,true,JSON.stringify(r));return r.structuredContent.error.code;};

test('CLOUD-01 real MCP save/read/correction/retraction are durable, versioned and idempotent',async t=>{
 const x=await cloudFixture(t),c=await x.connect(),token=c.access_token;
 const init=await x.f.mcp('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'synthetic-cloud',version:'1'}},token);assert.equal(init.status,200,JSON.stringify(init.data));
 const tools=await x.f.mcp('tools/list',{},token);assert.ok(tools.data.result.tools.find(t=>t.name==='mnemuron_remember').annotations.readOnlyHint===false);
 const p={scope:'user',content:'Synthetic blue-network preference',allow_future_read:true,operation_id:randomUUID()};
 const saved=value(await x.call(token,'mnemuron_remember',p));assert.equal(saved.status,'saved');assert.equal(saved.web_readable,true);
 const count=()=>x.core.store.db.prepare('SELECT COUNT(*) n FROM memories WHERE user_id=?').get(x.a.record.user_id).n;
 assert.equal(count(),1);assert.equal(value(await x.call(token,'mnemuron_remember',p)).memory_id,saved.memory_id);assert.equal(count(),1);
 assert.equal(error(await x.call(token,'mnemuron_remember',{...p,content:'conflicting payload'})),'IDEMPOTENCY_CONFLICT');
 const read=value(await x.call(token,'mnemuron_get_memory',{memory_id:saved.memory_id}));assert.equal(read.memory.content,p.content);assert.equal(read.revision,saved.revision);
 const search=value(await x.call(token,'mnemuron_search_memories',{query:'blue-network'}));assert.equal(search.results[0].memory_id,saved.memory_id);
 const correction={memory_id:saved.memory_id,revision:saved.revision,content:'Synthetic green-network preference',allow_future_read:true,operation_id:randomUUID()};
 assert.equal(error(await x.call(token,'mnemuron_supersede_memory',{...correction,revision:100})),'MEMORY_VERSION_CHANGED');
 const corrected=value(await x.call(token,'mnemuron_supersede_memory',correction));assert.notEqual(corrected.memory_id,saved.memory_id);assert.equal(corrected.web_readable,true);
 assert.equal(x.core.store.db.prepare('SELECT status FROM memories WHERE memory_id=?').get(saved.memory_id).status,'superseded');
 const retracted=value(await x.call(token,'mnemuron_retract_memory',{memory_id:corrected.memory_id,revision:corrected.revision,operation_id:randomUUID()}));assert.equal(retracted.physically_deleted,false);assert.equal(retracted.web_readable,false);
 const replay=value(await x.call(token,'mnemuron_supersede_memory',correction));assert.equal(replay.current_status,'retracted');assert.equal(replay.web_readable,false);assert.equal(count(),2);
});

test('CLOUD-02 account isolation, hidden records, explicit future reads and strict schemas',async t=>{
 const x=await cloudFixture(t),a=await x.connect(),b=await x.connect({owner:x.b});
 const saved=value(await x.call(a.access_token,'mnemuron_remember',{scope:'user',content:'Synthetic hidden entry',allow_future_read:false,operation_id:randomUUID()}));assert.equal(saved.web_readable,false);
 for(const token of [a.access_token,b.access_token]){
  assert.equal(error(await x.call(token,'mnemuron_get_memory',{memory_id:saved.memory_id})),'MEMORY_NOT_FOUND');
  assert.equal(error(await x.call(token,'mnemuron_supersede_memory',{memory_id:saved.memory_id,revision:saved.revision,content:'cannot elevate',allow_future_read:true,operation_id:randomUUID()})),'MEMORY_NOT_FOUND');
 }
 const p={scope:'user',content:'Synthetic explicit future access',allow_future_read:true,operation_id:randomUUID()},visible=value(await x.call(a.access_token,'mnemuron_remember',p));
 assert.equal(error(await x.call(b.access_token,'mnemuron_get_memory',{memory_id:visible.memory_id})),'MEMORY_NOT_FOUND');
 const rejected=await x.f.mcp('tools/call',{name:'mnemuron_remember',arguments:{...p,user_id:x.b.record.user_id}},a.access_token);assert.ok(rejected.data.error||rejected.data.result?.isError);
 const rows=x.core.store.db.prepare('SELECT user_id,content FROM memories').all();assert.ok(rows.every(r=>r.user_id===x.a.record.user_id));
 const privateConsole=await x.get('memories');assert.equal(privateConsole.body.results.length,2);
});

test('CLOUD-03 readonly managed and legacy grants never gain writes when another connection upgrades Core',async t=>{
 const x=await cloudFixture(t),ro=await x.connect({permission:'readonly'}),rw=await x.connect();
 const list=await x.f.mcp('tools/list',{},ro.access_token);assert.ok(!list.data.result.tools.some(t=>t.name==='mnemuron_remember'));
 const r=await x.f.mcp('tools/call',{name:'mnemuron_remember',arguments:{}},ro.access_token);assert.ok(r.status!==200||r.data.error||r.data.result?.isError);
 assert.equal(value(await x.call(rw.access_token,'mnemuron_auth_status')).tool_profile,'readwrite');
 assert.equal(value(await x.call(ro.access_token,'mnemuron_auth_status')).tool_profile,'readonly');
 assert.equal((await x.f.introspect('mnmc_not_valid')).data.active,false);
 x.f.gateway.config.cloud_connections.allow_write=false;
 assert.equal((await x.f.mcp('tools/list',{},rw.access_token)).status,403);
});

test('CLOUD-04 dynamic OAuth client completes password/MFA/consent/PKCE and performs memory writes',async t=>{
 const x=await cloudFixture(t),c=await x.connect({kind:'chatgpt'}),auth=await x.authorize(c);assert.ok(auth.callback,JSON.stringify(auth));
 const bad=await x.exchange(c,auth,{client_secret:randomUUID()});assert.notEqual(bad.status,200);
 const tokens=await x.exchange(c,auth);assert.equal(tokens.status,200,JSON.stringify(tokens.data));
 const introspection=await x.f.introspect(tokens.data.access_token);assert.equal(introspection.data.active,true);assert.equal(introspection.data.mnemuron_connection_id,c.connection_id);assert.ok(introspection.data.scope.includes('memory:write'));
 const saved=value(await x.call(tokens.data.access_token,'mnemuron_remember',{scope:'user',content:'Synthetic OAuth written memory',allow_future_read:true,operation_id:randomUUID()}));assert.equal(saved.web_readable,true);
 const refresh=await x.f.token({grant_type:'refresh_token',refresh_token:tokens.data.refresh_token,resource:x.f.config.resource,client_id:c.client_id,client_secret:c.client_secret});assert.equal(refresh.status,200,JSON.stringify(refresh.data));
 assert.equal(value(await x.call(refresh.data.access_token,'mnemuron_get_memory',{memory_id:saved.memory_id})).memory.content,'Synthetic OAuth written memory');
 const revoke=await x.act('cloud_connections.revoke',{connection_id:c.connection_id,...await x.proof()});assert.equal(revoke.status,200);
 assert.equal((await x.f.introspect(refresh.data.access_token)).data.active,false);
});

test('CLOUD-05 per-account OAuth clients reject a different owner and scope/callback expansion',async t=>{
 const x=await cloudFixture(t),c=await x.connect({kind:'chatgpt',permission:'readonly'});
 const other=await x.authorize(c,x.b);assert.ok(other.failed||other.callback?.searchParams.has('error'));
 const scopes=await x.authorize(c,x.a,{scope:'openid memory:read memory:write'});assert.equal(scopes.callback?.searchParams.get('error'),'invalid_scope');
 const redirect=await x.authorize(c,x.a,{redirect_uri:'http://127.0.0.1:9999/other'});assert.ok(redirect.failed);
});

test('CLOUD-06 PAT rotation, expiry and account security version invalidate new checks immediately',async t=>{
 const x=await cloudFixture(t),c=await x.connect();
 const rotated=await x.act('cloud_connections.rotate',{connection_id:c.connection_id,...await x.proof()});assert.equal(rotated.status,200,JSON.stringify(rotated.body));
 assert.equal((await x.f.introspect(c.access_token)).data.active,false);assert.equal((await x.f.introspect(rotated.body.access_token)).data.active,true);
 x.t.mock.timers.setTime(Date.now()+3*86400000);assert.equal((await x.f.introspect(rotated.body.access_token)).data.active,false);
});

test('CLOUD-07 management requires actual session/CSRF/factors and never reveals saved secrets',async t=>{
 const x=await cloudFixture(t),p={kind:'mcp',label:'Test',permission:'readonly',ttl_days:1};
 assert.equal((await x.act('cloud_connections.create',{...p,current_password:'invalid',otp:'000000'})).status,403);
 assert.equal((await x.act('cloud_connections.create',{...p,...await x.proof()},x.a,randomUUID(),{account_id:x.b.record.account_id})).status,409);
 const c=await x.connect({permission:'readonly'}),listed=await x.get('connections');assert.equal(listed.body.cloud.items.length,1);
 assert.ok(!JSON.stringify(listed.body).includes(c.access_token));assert.ok(!JSON.stringify(listed.body).includes('token_hash'));
 const foreign=await x.act('cloud_connections.revoke',{connection_id:c.connection_id,...await x.proof(x.b)},x.b);assert.equal(foreign.status,404);
 assert.equal((await x.get('connections',x.b)).body.cloud.items.length,0);
});

test('CLOUD-08 invalid TTL, unknown fields, operation conflicts and connection quota fail closed',async t=>{
 const x=await cloudFixture(t),p={kind:'mcp',label:'Test',permission:'readonly',ttl_days:1,...await x.proof()},op=randomUUID();
 for(const ttl of [0,31,1.5])assert.equal((await x.act('cloud_connections.create',{...p,ttl_days:ttl})).status,400);
 assert.equal((await x.act('cloud_connections.create',{...p,role:'operator'})).status,400);
 const r=await x.act('cloud_connections.create',p,x.a,op);assert.equal(r.status,200);
 const replay=await x.act('cloud_connections.create',p,x.a,op);assert.equal(replay.body.access_token,r.body.access_token);
 assert.equal((await x.act('cloud_connections.create',{...p,label:'different'},x.a,op)).status,409);
 x.f.app.config.cloud_connections.max_active=1;assert.equal((await x.act('cloud_connections.create',{...p,...await x.proof()})).status,409);
});

test('CLOUD-09 no write binding/policy is auto-granted to a readonly console',async t=>{
 const x=await cloudFixture(t,{binding:false});
 const denied=await x.act('cloud_connections.create',{kind:'mcp',label:'No privilege',permission:'readwrite',ttl_days:1,...await x.proof()});assert.equal(denied.status,403,JSON.stringify(denied.body));
 assert.equal((await x.get('connections')).body.cloud.items.length,0);
 const ro=await x.connect({permission:'readonly'});assert.equal((await x.f.introspect(ro.access_token)).data.active,true);
});

test('CLOUD-10 SDK client can initialize and save/read across new transport sessions',async t=>{
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
 const {StreamableHTTPClientTransport}=await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
 const x=await cloudFixture(t),c=await x.connect();
 const open=async()=>{const client=new Client({name:'synthetic-sdk-memory',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(x.f.config.resource),{requestInit:{headers:{authorization:`Bearer ${c.access_token}`}}}));return client;};
 const a=await open();const saved=value(await a.callTool({name:'mnemuron_remember',arguments:{scope:'user',content:'Synthetic cross-session SDK memory',allow_future_read:true,operation_id:randomUUID()}}));await a.close();
 const b=await open();try{assert.equal(value(await b.callTool({name:'mnemuron_get_memory',arguments:{memory_id:saved.memory_id}})).memory.content,'Synthetic cross-session SDK memory');}finally{await b.close();}
});

test('CLOUD-11 restart preserves encrypted clients and tokens; account epoch invalidates both',async t=>{
 const x=await cloudFixture(t),pat=await x.connect(),oauth=await x.connect({kind:'chatgpt'});
 const encoded=JSON.stringify(x.ids.db.prepare('SELECT * FROM identity_cloud_connections').all());
 assert.ok(!encoded.includes(pat.access_token));assert.ok(!encoded.includes(oauth.client_secret));assert.ok(encoded.includes('cipher'));
 await x.f.stop();await x.f.start();
 assert.equal((await x.f.introspect(pat.access_token)).data.active,true);
 const a=await x.authorize(oauth),token=await x.exchange(oauth,a);assert.equal(token.status,200,JSON.stringify(token.data));
 x.f.app.accounts.db.prepare('UPDATE identity_accounts SET security_version=security_version+1 WHERE account_id=?').run(x.a.record.account_id);
 assert.equal((await x.f.introspect(pat.access_token)).data.active,false);assert.equal((await x.f.introspect(token.data.access_token)).data.active,false);
});

test('CLOUD-12 a failed write audit rolls back data, grants and receipt together',async t=>{
 const x=await cloudFixture(t),c=await x.connect(),audit=x.core.store.audit,p={scope:'user',content:'Synthetic atomic write',allow_future_read:true,operation_id:randomUUID()};
 x.core.store.audit=function(args){if(args.action==='memory.cloud.save')throw new Error('Synthetic audit fault');return audit.call(this,args);};
 assert.equal(error(await x.call(c.access_token,'mnemuron_remember',p)),'CORE_UNAVAILABLE');
 assert.equal(x.core.store.db.prepare('SELECT COUNT(*) n FROM memories WHERE user_id=?').get(x.a.record.user_id).n,0);
 assert.equal(x.core.store.db.prepare('SELECT COUNT(*) n FROM memory_web_grants WHERE user_id=?').get(x.a.record.user_id).n,0);
 assert.equal(x.core.store.db.prepare('SELECT COUNT(*) n FROM memory_cloud_operations WHERE user_id=?').get(x.a.record.user_id).n,0);
 x.core.store.audit=audit;
 const result=value(await x.call(c.access_token,'mnemuron_remember',p));assert.equal(result.status,'saved');
 assert.equal(x.core.store.revisions.latest(x.a.record.user_id,result.memory_id).evidence_kind,'tool_submitted');
 const coreResponse=await fetch(x.core.baseUrl+'/v1/identity',{headers:{authorization:`Bearer ${c.access_token}`}});assert.equal(coreResponse.status,401,'MCP token is not a Core credential');
});

test('CLOUD-13 old OAuth grants remain readonly and readable even after cloud issuance is disabled',async t=>{
 const x=await cloudFixture(t),c=await x.connect();
 const saved=value(await x.call(c.access_token,'mnemuron_remember',{scope:'user',content:'Synthetic readonly compatibility',allow_future_read:true,operation_id:randomUUID()}));
 const old={client_id:x.f.config.chatgpt_client.client_id,client_secret:x.f.secret,connection:{redirect_uri:x.f.config.chatgpt_client.redirect_uris[0]},scopes:x.f.config.chatgpt_client.allowed_scopes};
 const auth=await x.authorize(old),tokens=await x.exchange(old,auth);assert.equal(tokens.status,200);
 x.f.app.config.cloud_connections.enabled=false;x.f.app.config.cloud_connections.allow_write=false;
 x.f.gateway.config.cloud_connections.enabled=false;x.f.gateway.config.cloud_connections.allow_write=false;
 const list=await x.f.mcp('tools/list',{},tokens.data.access_token);assert.equal(list.status,200);assert.ok(!list.data.result.tools.some(x=>x.name==='mnemuron_remember'));
 assert.equal(value(await x.call(tokens.data.access_token,'mnemuron_get_memory',{memory_id:saved.memory_id})).memory.content,'Synthetic readonly compatibility');
 assert.equal((await x.f.introspect(c.access_token)).data.active,false);
});

test('CLOUD-14 ownership and exact limits survive list filtering and history paging',async t=>{
 const x=await cloudFixture(t),p={kind:'mcp',label:'Alpha synthetic client',permission:'readonly',ttl_days:1,...await x.proof()},op=randomUUID();
 const created=await x.act('cloud_connections.create',p,x.a,op);assert.equal(created.status,200);const id=created.body.connection_id;
 let list=await x.get('connections?status=active&kind=mcp&query=Alpha');assert.equal(list.body.cloud.total,1);assert.equal(list.body.cloud.items[0].connection_id,id);
 assert.equal((await x.get('connections?status=active&query=notfound')).body.cloud.total,0);
 assert.equal((await x.get('connections?status=active&kind=chatgpt')).body.cloud.total,0);
 assert.equal((await x.get('connections?status=active&offset=-1')).status,400);
 const r=await x.act('cloud_connections.revoke',{connection_id:id,...await x.proof()});assert.equal(r.status,200);
 assert.equal((await x.get('connections')).body.cloud.total,0);assert.equal((await x.get('connections?status=history')).body.cloud.items[0].status,'revoked');
 assert.equal((await x.get('connections?status=all',x.b)).body.cloud.total,0);
});

test('CLOUD-15 discovery keeps legacy linking readonly and requests write only through the issued URL',async t=>{
 const x=await cloudFixture(t),c=await x.connect({kind:'chatgpt'});
 assert.equal(c.connection.mcp_url,x.f.config.resource+'?access=readwrite');
 for(const [url,write] of [[x.f.config.resource,false],[c.connection.mcp_url,true]]){
  const r=await fetch(url,{method:'POST'});assert.equal(r.status,401);
  const challenge=r.headers.get('www-authenticate');assert.equal(challenge.includes('memory:write'),write);
  const metadata=await (await fetch(challenge.match(/resource_metadata="([^"]+)"/)[1])).json();
  assert.equal(metadata.resource,x.f.config.resource);assert.equal(metadata.scopes_supported.includes('memory:write'),write);
  // Use exactly the discovery challenge scopes in the authorization flow.
  const auth=await x.authorize(c,x.a,{scope:challenge.match(/scope="([^"]+)"/)[1]}),token=await x.exchange(c,auth);assert.equal(token.status,200,JSON.stringify(token.data));
  const scopes=(await x.f.introspect(token.data.access_token)).data.scope.split(' ');assert.equal(scopes.includes('memory:write'),write);
 }
});

test('CLOUD-16 production callbacks reject arbitrary origins, wildcards, query and normalized aliases',async t=>{
 const x=await cloudFixture(t);x.ids.connections.config.isolated=false;
 for(const uri of ['https://other.example/connector_platform_oauth_redirect','https://chatgpt.com/connector/oauth/*','https://chatgpt.com/connector/oauth/valid?next=bad','https://CHATGPT.com/connector_platform_oauth_redirect','https://chatgpt.com:443/connector_platform_oauth_redirect','https://chatgpt.com/a/../connector_platform_oauth_redirect','https://user@chatgpt.com/connector_platform_oauth_redirect'])assert.throws(()=>x.ids.connections.callback(uri));
 for(const uri of ['https://chatgpt.com/connector_platform_oauth_redirect','https://chatgpt.com/connector/oauth/Synthetic_123'])assert.equal(x.ids.connections.callback(uri),uri);
});
