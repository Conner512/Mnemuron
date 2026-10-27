import test from 'node:test';
import assert from 'node:assert/strict';
import {identityFixture,pendingAccount} from './helpers/identity-fixture.mjs';
import {ConnectionRegistry} from '../src/connections.mjs';
import {seconds} from '../../../shared/oauth-common.mjs';

globalThis.document={body:{dataset:{}},documentElement:{dataset:{}},querySelectorAll:()=>[],addEventListener:()=>{}};
const {agentsView,mountAgents,connectionRows,selectAgent}=await import('../../../web/console/agents.mjs');
const {mountConnections}=await import('../../../web/console/connections.mjs');
const {actionPage}=await import('../../../web/console/actions.mjs');

// Drive the real page event handlers without a browser or network. Only DOM plumbing is stubbed;
// payload validation, owner/session checks, token rotation and quota accounting use temporary SQLite.
function page(t){
 const prior={document:globalThis.document,window:globalThis.window,FormData:globalThis.FormData};
 const listeners={},dialogs=[];
 const node=()=>({innerHTML:'',listeners:{},children:{},values:{},dataset:{},hidden:false,
  addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);},setAttribute(){},focus(){},replaceChildren(){},querySelectorAll:()=>[],
  querySelector(selector){return this.children[selector]??=node();},
  showModal(){this.open=true;},close(){this.open=false;}});
 const root=node();
 globalThis.document={body:{dataset:{},append:d=>dialogs.push(d)},documentElement:{dataset:{}},querySelectorAll:()=>[],querySelector:selector=>selector==='[data-agents-root]'?root:null,
  createElement:node,addEventListener:(name,fn)=>(listeners[name]??=[]).push(fn)};
 globalThis.window={addEventListener(){}};
 globalThis.FormData=class extends Map{constructor(form){super(Object.entries(form.values||{}));}};
 t.after(()=>Object.assign(globalThis,prior));
 const fire=async(name,event)=>{for(const fn of listeners[name]||[])await fn(event);};
 return {dialogs,root,async click(dataset){const button={dataset,hasAttribute(name){return this.dataset[name.replace(/^data-/, '').replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]!==undefined;},
   closest(selector){return selector==='button'||selector.startsWith('[data-')&&this.hasAttribute(selector.slice(1,-1))?this:null;}};await fire('click',{target:button});},
  async submit(form,values={}){form.values=values;for(const fn of form.listeners.submit||[])await fn({preventDefault(){},target:form});},
  async filter(values){await fire('submit',{preventDefault(){},target:{id:'connection-filters',values,getAttribute:()=>null}});}};
}
async function fixture(t,{max=100}={}){
 const f=identityFixture(t),owner=await pendingAccount(f,'Synthetic_Agents'),ids=f.identities,id=owner.account.account_id;
 ids.db.prepare("UPDATE identity_accounts SET status='active',binding_ready=1,recovery_ack=1 WHERE account_id=?").run(id);
 const login=ids.newSession('console',{accountId:id}),session=ids.session(login.token,'console');
 const config={issuer:ids.issuer,resource:'http://127.0.0.1:49002/mcp',isolated:true,identity:{connection_management:{enabled:true,max_connections:max,pat_default_ttl_seconds:2592000,pat_max_ttl_seconds:7776000,secret_receipt_ttl_seconds:300,rotation_overlap_seconds:0}},cloud_memory:{enabled:true}};
 const registry=new ConnectionRegistry(ids,config);ids.connections=registry;
 return {...f,ids,id,session,registry};
}
const caps={allowed_actions:['oauth.revoke','connections.rotate','connections.revoke','devices.register']};
const create=(f,label)=>f.registry.operatorChange(f.id,'connections.create',{kind:'generic_mcp',label,profile:'readonly'});
const bind=(f,id)=>f.ids.db.prepare("UPDATE identity_connections SET binding_json='{}',binding_version=version,binding_account_version=? WHERE connection_id=?").run(f.ids.byId(f.id).security_version,id);

test('Agent legacy grant revoke sends the accepted payload and preserves foreign grants on failure',async t=>{
 const f=await fixture(t),ui=page(t),subject=f.ids.byId(f.id).subject;
 for(const [grant,owner] of [['own-grant',subject],['foreign-grant','synthetic-foreign']])f.store.db.prepare("INSERT INTO oauth_records(model,id,payload,expires) VALUES('Grant',?,?,?)").run(grant,JSON.stringify({accountId:owner,clientId:'synthetic-client',resources:{'http://127.0.0.1:49002/mcp':'memory:read'}}),seconds()+600);
 let payload,reloads=0;
 mountAgents({mutate:async(action,p,op)=>{payload=p;return f.ids.console.execute(f.id,f.session,action,p,op);},reload:()=>{reloads++;}});
 const form=ui.dialogs[0].querySelector('form');
 await ui.click({agentRow:'oauth.revoke',id:'foreign-grant',source:'grant'});
 assert.doesNotMatch(form.innerHTML,/name="current_password"/);
 await ui.submit(form);assert.equal(reloads,0);assert.equal(form.querySelector('.agent-error').hidden,false);
 assert.ok(f.store.find('Grant','id','foreign-grant'));
 await ui.click({agentRow:'oauth.revoke',id:'own-grant',source:'grant'});await ui.submit(form);
 assert.deepEqual(payload,{grant_id:'own-grant'});assert.equal(reloads,1);assert.equal(f.ids.console.grants(subject).length,0);
 assert.ok(f.store.find('Grant','id','foreign-grant'));
 await assert.rejects(f.ids.console.execute(f.id,f.session,'oauth.revoke',{grant_id:'foreign-grant',current_password:'synthetic'},'strict-input'),{code:'INVALID_CONSOLE_INPUT'});
});

test('Agent table follows backend pagination and filter events reset the offset',async t=>{
 const f=await fixture(t),ui=page(t);for(let i=0;i<21;i++)create(f,`Synthetic connection ${i}`);
 let html,data,controller;
 const reload=()=>{data=f.registry.list(f.id,controller.query());html=actionPage('connections',data,caps,controller.query());};
 controller=mountConnections({api:async()=>({}),mutate:async()=>({}),getCaps:()=>caps,reload,isActive:()=>true});reload();
 assert.equal(data.total,21);assert.equal(data.connections.length,20);assert.match(html,/data-connection-page="20"/);
 const firstIds=data.connections.map(c=>c.connection_id);
 await ui.click({connectionPage:'20'});assert.equal(data.connections.length,1);assert.ok(!firstIds.includes(data.connections[0].connection_id));
 assert.match(html,new RegExp(`data-id="${data.connections[0].connection_id}"`));assert.match(html,/data-connection-page="0"/);assert.doesNotMatch(html,/下一页/);
 await ui.filter({section:'active',search:'connection 20'});assert.equal(controller.query().offset,0);assert.equal(data.total,1);
 assert.match(html,/value="connection 20"/);assert.match(html,/本页 1 个/);
 await ui.click({connectionReset:''});assert.deepEqual(controller.query(),{section:'active'});assert.equal(data.total,21);
 await ui.filter({section:'history',search:''});assert.equal(data.total,0);assert.match(html,/value="history" selected/);
 // Owner and ordinary console modes retain the same selected section.
 assert.match(actionPage('connections',data,{...caps,owner_mode:true},controller.query()),/value="history" selected/);
});

test('Expired tokens remain manageable; failed proof preserves them, rotation renews, revoke frees quota',async t=>{
 const f=await fixture(t,{max:20}),ui=page(t);for(let i=0;i<20;i++)create(f,`Synthetic expired ${i}`);
 f.ids.db.prepare('UPDATE identity_connection_tokens SET expires=? WHERE account_id=?').run(seconds()-1,f.id);
 assert.equal(f.registry.list(f.id,{section:'active'}).total,0);
 assert.throws(()=>create(f,'Synthetic blocked'),{code:'CONNECTION_QUOTA'});
 let history=f.registry.list(f.id,{section:'history'}),html=agentsView(history,caps,{}, {section:'history'});
 const [renew,remove]=history.connections;
 assert.match(html,new RegExp(`data-agent-row="connections.rotate" data-id="${renew.connection_id}"`));
 assert.match(html,/过期的 MCP 令牌仍占用连接名额/);
 let reloads=0;
 mountAgents({mutate:(action,p,op)=>f.registry.execute(f.id,f.session,action,p,op),reload:()=>{reloads++;history=f.registry.list(f.id,{section:'history'});agentsView(history,caps,{}, {section:'history'});}});
 const form=ui.dialogs[0].querySelector('form');
 await ui.click({agentRow:'connections.rotate',id:renew.connection_id,source:'connection'});
 assert.match(form.innerHTML,/name="current_password"/);
 await ui.submit(form,{current_password:'Wrong synthetic password'});assert.equal(reloads,0);assert.equal(form.querySelector('.agent-error').hidden,false);
 assert.equal(f.registry.list(f.id,{section:'history'}).total,20);
 await ui.submit(form,{current_password:'Synthetic password with spaces  '});assert.equal(reloads,1);
 assert.equal(f.registry.list(f.id,{section:'active'}).total,1);assert.equal(f.registry.list(f.id,{section:'history'}).total,19);
 await ui.click({agentRow:'connections.revoke',id:remove.connection_id,source:'connection'});await ui.submit(form,{current_password:'Synthetic password with spaces  '});
 assert.equal(reloads,2);create(f,'Synthetic replacement');assert.equal(f.registry.list(f.id).total,21);
 html=agentsView(f.registry.list(f.id,{section:'history'}),caps,{}, {section:'history'});
 const revoked=html.match(new RegExp(`<tr>[^]*?<small>${remove.label}</small>[^]*?</tr>`))?.[0];
 assert.ok(revoked);assert.doesNotMatch(revoked,new RegExp(`data-id="${remove.connection_id}"`));assert.match(revoked,/已撤销/);
});

test('Codex plugin explicitly requests task continuity; memory-only and other agents retain narrow grants',async t=>{
 const ui=page(t),calls=[];agentsView({capabilities:{write_enabled:true}},caps);
 mountAgents({mutate:async(action,p)=>{calls.push({action,p});return {api_key:'synthetic-key',credential:{agent_instance_id:'synthetic-instance'}};},reload:()=>{}});
 const form=ui.dialogs[0].querySelector('form'),values={label:'Synthetic device',device:'synthetic-local',current_password:'Synthetic password'};
 await ui.click({agentGenerate:'codex:plugin'});assert.match(form.innerHTML,/value="continuity" selected/);
 await ui.submit(form,{...values,access:'continuity'});
 assert.deepEqual(calls.at(-1),{action:'devices.register',p:{label:values.label,agent_id:'codex',device_id:values.device,access:'read_write',task_continuity:true,current_password:values.current_password}});
 for(const access of ['read','write']){await ui.click({agentGenerate:'codex:plugin'});await ui.submit(form,{...values,access});assert.equal(calls.at(-1).p.task_continuity,undefined);assert.equal(calls.at(-1).p.access,access==='write'?'read_write':'read');}
 await ui.click({agentGenerate:'openclaw:adapter'});assert.doesNotMatch(form.innerHTML,/value="continuity"/);await ui.submit(form,{...values,access:'write'});
 assert.equal(calls.at(-1).p.agent_id,'openclaw');assert.equal(calls.at(-1).p.task_continuity,undefined);
});

test('Agent create, rotate and revoke recover a committed response with the same operation and credential',async t=>{
 const f=await fixture(t),ui=page(t),attempts=[],lost=new Set();let reloads=0;
 const reload=()=>{reloads++;agentsView(f.registry.list(f.id),caps);};agentsView(f.registry.list(f.id),caps);
 mountAgents({mutate:async(action,p,op)=>{
  const result=await f.registry.execute(f.id,f.session,action,p,op);attempts.push({action,op,result});
  if(!lost.has(op)){lost.add(op);throw new Error('Synthetic response lost after commit');}return result;
 },reload});
 const form=ui.dialogs[0].querySelector('form'),values={label:'Synthetic retry',access:'write',current_password:'Synthetic password with spaces  '};
 await ui.click({agentGenerate:'cursor:mcp'});await ui.submit(form,values);
 assert.equal(f.registry.list(f.id).total,1);assert.equal(reloads,0);assert.equal(form.querySelector('.agent-error').hidden,false);
 // Proof is not part of the committed request. Recovery succeeds even after the user edits it.
 await ui.submit(form,{...values,current_password:'A different synthetic proof'});
 const created=attempts[0].result,id=created.connection.connection_id;
 assert.equal(f.registry.list(f.id).total,1);assert.equal(reloads,1);assert.equal(attempts[1].result.secret,created.secret);
 bind(f,id);assert.equal(f.registry.verifyPat(created.secret,f.registry.config.resource+'/generic').active,true);
 await ui.click({agentRow:'connections.rotate',id,source:'connection'});await ui.submit(form,values);
 assert.equal(f.registry.row(f.id,id).version,2);assert.equal(f.registry.verifyPat(created.secret,f.registry.config.resource+'/generic').active,false);
 await ui.submit(form,{current_password:'A different synthetic proof'});
 assert.equal(f.registry.row(f.id,id).version,2);assert.equal(attempts[3].result.secret,attempts[2].result.secret);
 assert.equal(f.ids.db.prepare('SELECT COUNT(*) n FROM identity_connection_tokens WHERE connection_id=?').get(id).n,2);
 assert.ok(form.innerHTML.includes(attempts[3].result.secret),'the recovered rotated credential is shown');
 bind(f,id);assert.equal(f.registry.verifyPat(attempts[3].result.secret,f.registry.config.resource+'/generic').active,true);
 await ui.click({agentRow:'connections.revoke',id,source:'connection'});await ui.submit(form,values);
 assert.equal(f.registry.row(f.id,id).state,'revoked');await ui.submit(form,{current_password:'A different synthetic proof'});
 assert.equal(f.registry.row(f.id,id).version,3);assert.equal(reloads,3);
 assert.equal(f.ids.db.prepare('SELECT COUNT(*) n FROM identity_connection_activity WHERE connection_id=?').get(id).n,3,'each action commits only once');
 for(let i=0;i<attempts.length;i+=2){assert.equal(attempts[i].op,attempts[i+1].op);assert.equal(attempts[i+1].result.replayed,true);}
 assert.equal(new Set(attempts.map(a=>a.op)).size,3,'each explicit action has a separate operation');
});

test('Editing an Agent request starts a new operation, while a duplicate in-flight submit sends nothing',async t=>{
 const f=await fixture(t),ui=page(t),operations=[];let release,first=true;
 agentsView(f.registry.list(f.id),caps);
 mountAgents({mutate:async(action,p,op)=>{operations.push(op);if(first){first=false;await new Promise(resolve=>{release=resolve;});throw new Error('Synthetic request not delivered');}return f.registry.execute(f.id,f.session,action,p,op);},reload:()=>{}});
 const form=ui.dialogs[0].querySelector('form'),values={label:'Synthetic draft',access:'read',current_password:'Synthetic password with spaces  '};
 await ui.click({agentGenerate:'cursor:mcp'});const pending=ui.submit(form,values);await ui.submit(form,values);
 assert.equal(operations.length,1);release();await pending;
 await ui.submit(form,{...values,label:'Synthetic corrected request'});
 assert.equal(operations.length,2);assert.notEqual(operations[0],operations[1]);
 assert.equal(f.registry.list(f.id).total,1);assert.equal(f.registry.list(f.id).connections[0].label,'Synthetic corrected request');
});

test('A failed inventory refresh cannot hide generated, rotated or enabled credentials or repeat the mutation',async t=>{
 const f=await fixture(t),ui=page(t),results=[];selectAgent('cursor','mcp');agentsView(f.registry.list(f.id),caps);
 mountAgents({mutate:async(action,p,op)=>{const result=await f.registry.execute(f.id,f.session,action,p,op);results.push(result);return result;},reload:async()=>{throw new Error('Synthetic inventory unavailable');}});
 const form=ui.dialogs[0].querySelector('form'),proof={current_password:'Synthetic password with spaces  '};
 await ui.click({agentGenerate:'cursor:mcp'});await ui.submit(form,{...proof,label:'Synthetic refresh loss',access:'read'});
 const id=results[0].connection.connection_id;
 assert.equal(f.registry.list(f.id).total,1);assert.ok(ui.root.outerHTML.includes(results[0].secret),'generated credential is rendered before refreshing inventory');
 assert.match(ui.root.outerHTML,/data-i18n="agentsRefreshUnavailable"/);
 await ui.submit(form,proof);assert.equal(results.length,1,'a completed hidden form is no longer submittable');
 for(const action of ['connections.rotate','connections.enable']){
  if(action==='connections.enable')f.registry.operatorChange(f.id,'connections.disable',{connection_id:id});
  await ui.click({agentRow:action,id,source:'connection'});await ui.submit(form,proof);
  assert.equal(ui.dialogs[0].open,true);assert.ok(form.innerHTML.includes(results.at(-1).secret),'the new credential remains visible after reload fails');
  assert.equal(form.querySelector('[data-agent-refresh-error]').hidden,false);
  const count=results.length;await ui.submit(form,proof);assert.equal(results.length,count,'saving the displayed credential cannot submit the old action');
  bind(f,id);assert.equal(f.registry.verifyPat(results.at(-1).secret,f.registry.config.resource+'/generic').active,true);
 }
 assert.equal(f.registry.list(f.id).total,1);assert.equal(f.registry.row(f.id,id).version,4);
});

test('Agent permissions and totals follow actual scoped grants, including expiry, revocation and account versions',async t=>{
 const f=await fixture(t);page(t);f.store.identity=f.ids;
 const oauth=(label)=>f.registry.operatorChange(f.id,'connections.create',{kind:'chatgpt_oauth',label,profile:'memory_readwrite',redirect_uri:'https://chatgpt.com/connector_platform_oauth_redirect'});
 const c=oauth('Synthetic actual permissions').connection,other=oauth('Synthetic other client').connection;bind(f,c.connection_id);
 const Grant=f.store.adapter(),grants=new Grant('Grant'),owner=f.ids.byId(f.id),resource=f.registry.config.resource;
 const payload={accountId:owner.subject,clientId:c.client_id,resources:{[resource]:'memory:read memory:write'}};
 await grants.upsert('read-grant',{...payload,resources:{[resource]:'memory:read'}},600);
 for(const [id,changes,ttl] of [
  ['foreign-owner',{accountId:'synthetic-other-subject',securityVersion:owner.security_version},600],
  ['other-client',{clientId:other.client_id},600],
  ['wrong-resource',{resources:{'https://other.example.test/mcp':'memory:read memory:write'}},600],
  ['old-security',{securityVersion:owner.security_version-1},600],
  ['expired-grant',{},0],
 ])await grants.upsert(id,{...payload,...changes},ttl);
 await grants.upsert('revoked-grant',payload,600);await grants.destroy('revoked-grant');
 // Durable revocation remains authoritative even if an old row is restored independently.
 f.ids.db.prepare("INSERT INTO oauth_records(model,id,payload,expires,grant_id) VALUES('Grant',?,?,?,?)").run('revoked-grant',JSON.stringify({...payload,securityVersion:owner.security_version}),seconds()+600,'revoked-grant');
 const data=()=>f.registry.list(f.id,{search:c.label}),current=()=>data().connections[0];
 assert.deepEqual(current().authorized_scopes,['memory:read']);assert.equal(current().active_grant_count,1);
 assert.deepEqual(data().authorization_counts,{usable:1,readonly:1,memory_readwrite:0,pending:1,verified:0});
 const row=connectionRows(data())[0];assert.equal(row.access_key,'readOnly');assert.equal(row.configured_access,'connReadWrite');
 const html=agentsView(data(),caps);assert.match(html,/data-access="ro"><span data-i18n="readOnly"/);
 assert.match(html,/data-i18n="connConfiguredAccess"[^]*?data-i18n="connReadWrite"/);
 assert.match(html,/data-i18n="connReadWrite">[^<]*<\/span><strong>0<\/strong>/,'the account summary also reports no write authorization');
 await grants.upsert('write-grant',payload,600);
 assert.deepEqual(current().authorized_scopes,['memory:read','memory:write']);assert.equal(data().authorization_counts.memory_readwrite,1);
 assert.equal(connectionRows(data())[0].access_key,'connReadWrite');
 await grants.destroy('write-grant');assert.deepEqual(current().authorized_scopes,['memory:read']);
 f.ids.db.prepare("UPDATE oauth_records SET expires=? WHERE id='read-grant'").run(seconds()-1);
 assert.deepEqual(current().authorized_scopes,[]);assert.equal(current().active_grant_count,0);assert.equal(data().authorization_counts.usable,0);
 await grants.upsert('current-before-security-change',payload,600);
 f.ids.db.prepare('UPDATE identity_accounts SET security_version=security_version+1 WHERE account_id=?').run(f.id);bind(f,c.connection_id);
 assert.equal(await grants.find('current-before-security-change'),undefined);
 assert.deepEqual(current().authorized_scopes,[]);assert.equal(current().active_grant_count,0);assert.equal(data().authorization_counts.usable,0);
});

test('Public PAT permissions require a live token for the current owner, token version and binding',async t=>{
 const f=await fixture(t),r=f.registry.operatorChange(f.id,'connections.create',{kind:'generic_mcp',label:'Synthetic PAT permissions',profile:'memory_readwrite'}),id=r.connection.connection_id;
 const scopes=()=>f.registry.detail(f.id,id).connection.authorized_scopes;bind(f,id);
 assert.deepEqual(scopes(),['memory:read','memory:write']);assert.equal(f.registry.list(f.id).authorization_counts.memory_readwrite,1);
 const original=f.ids.db.prepare('SELECT * FROM identity_connection_tokens WHERE connection_id=?').get(id);
 for(const [field,value] of [['expires',seconds()-1],['revoked',seconds()],['security_version',original.security_version-1],['version',original.version+1],['account_id','synthetic-foreign-account']]){
  f.ids.db.prepare(`UPDATE identity_connection_tokens SET ${field}=? WHERE token_id=?`).run(value,original.token_id);
  assert.deepEqual(scopes(),[],field);assert.equal(f.registry.verifyPat(r.secret,f.registry.config.resource+'/generic').active,false,field);
  assert.equal(f.registry.list(f.id).authorization_counts.usable,0,field);
  f.ids.db.prepare(`UPDATE identity_connection_tokens SET ${field}=? WHERE token_id=?`).run(original[field],original.token_id);
 }
 for(const field of ['binding_version','binding_account_version']){
  f.ids.db.prepare(`UPDATE identity_connections SET ${field}=-1 WHERE connection_id=?`).run(id);
  assert.deepEqual(scopes(),[],field);assert.equal(f.registry.list(f.id).authorization_counts.usable,0,field);bind(f,id);
 }
 assert.deepEqual(scopes(),['memory:read','memory:write']);
});

test('ChatGPT generation uses the real full guide and existing connections can reopen it without another create',async t=>{
 const f=await fixture(t),ui=page(t);let html,guideUnavailable=false,mutations=0;
 const api=async(name,q)=>{assert.equal(name,'connections');if(guideUnavailable)throw new Error('Synthetic guide response loss');return f.registry.detail(f.id,q.connection_id);};
 const reload=()=>{html=agentsView(f.registry.list(f.id),caps);};selectAgent('chatgpt','connector');reload();
 mountAgents({api,mutate:(action,p,op)=>{mutations++;return f.registry.execute(f.id,f.session,action,p,op);},reload});
 const controller=mountConnections({api,mutate:()=>{throw new Error('A guide read must not mutate');},getCaps:()=>({...caps,connection_management:{enabled:true,write_enabled:true}}),reload,isActive:()=>true});t.after(()=>controller.clear());
 const form=ui.dialogs[0].querySelector('form'),body=ui.dialogs[1].querySelector('.connection-content');
 for(const access of ['write','read']){
  await ui.click({agentGenerate:'chatgpt:connector'});await ui.submit(form,{label:`Synthetic ${access} guide`,access,current_password:'Synthetic password with spaces  '});
  const c=f.registry.list(f.id,{search:`Synthetic ${access} guide`}).connections[0],guide=f.registry.detail(f.id,c.connection_id).guide;
  const setup=html.slice(html.indexOf('<ol class="agent-steps">'));
  assert.ok(setup.includes(guide.oauth_scopes.join(' ')));assert.ok(setup.includes(guide.discovery_url));assert.ok(guide.discovery_url.endsWith('?client_id='+encodeURIComponent(c.client_id)));
  assert.match(setup,new RegExp(`data-connection-detail="${c.connection_id}"`));
  if(access==='read')assert.doesNotMatch(guide.oauth_scopes.join(' '),/memory:write/);
  await ui.click({connectionDetail:c.connection_id});assert.ok(body.innerHTML.includes(guide.oauth_scopes.join(' ')));assert.ok(body.innerHTML.includes(guide.discovery_url));
  assert.match(body.innerHTML,/data-connection-action="update"/);assert.match(body.innerHTML,/data-i18n="connCurrentAccess"/);controller.clear();
 }
 guideUnavailable=true;await ui.click({agentGenerate:'chatgpt:connector'});await ui.submit(form,{label:'Synthetic retry guide',access:'write',current_password:'Synthetic password with spaces  '});
 assert.equal(mutations,3);assert.equal(f.registry.list(f.id).total,3);assert.match(html,/data-i18n="agentsGuideUnavailable"/);
 const c=f.registry.list(f.id,{search:'Synthetic retry guide'}).connections[0];guideUnavailable=false;
 await ui.click({connectionDetail:c.connection_id});assert.match(body.innerHTML,/openid offline_access memory:read memory:write/);assert.equal(mutations,3,'guide recovery never creates another credential');
});
