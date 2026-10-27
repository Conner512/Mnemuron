import test from 'node:test';
import assert from 'node:assert/strict';
import {identityFixture,pendingAccount} from './helpers/identity-fixture.mjs';
import {ConnectionRegistry} from '../src/connections.mjs';
import {seconds} from '../../../shared/oauth-common.mjs';

globalThis.document={body:{dataset:{}},documentElement:{dataset:{}},querySelectorAll:()=>[],addEventListener:()=>{}};
const {agentsView,mountAgents}=await import('../../../web/console/agents.mjs');
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
 globalThis.document={body:{dataset:{},append:d=>dialogs.push(d)},documentElement:{dataset:{}},querySelectorAll:()=>[],querySelector:()=>null,
  createElement:node,addEventListener:(name,fn)=>(listeners[name]??=[]).push(fn)};
 globalThis.window={addEventListener(){}};
 globalThis.FormData=class extends Map{constructor(form){super(Object.entries(form.values||{}));}};
 t.after(()=>Object.assign(globalThis,prior));
 const fire=async(name,event)=>{for(const fn of listeners[name]||[])await fn(event);};
 return {dialogs,async click(dataset){const button={dataset,hasAttribute(name){return this.dataset[name.replace(/^data-/, '').replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]!==undefined;},
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
