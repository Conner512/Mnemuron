import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
globalThis.document={body:{dataset:{}},documentElement:{dataset:{}},querySelectorAll:()=>[],addEventListener:()=>{}};
const {connectionsView}=await import('../../../web/console/connections.mjs');
test('C-01: one logical row, account counts, history/system folds, no IDs or credential secrets in main row',()=>{
 const html=connectionsView({connections:[{connection_id:'synthetic-id',label:'<script>alert(1)</script>',kind:'generic_mcp',profile:'readonly',configuration_state:'ready',health:'never_used'}],counts:{active:1,readonly:1,memory_readwrite:0,pending:0},total:1,offset:0,limit:20,next_offset:null,core_connections:[{label:'Synthetic system',credential_id:'do-not-use-as-main-row',agent_id:'chatgpt-web'}]}, {allowed_actions:['connections.create'],connection_management:{enabled:true}},{});
 assert.match(html,/data-connection-new/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/data-connection-detail="synthetic-id"/);assert.match(html,/connSystem/);assert.match(html,/never_used/);
 const actions=fs.readFileSync(new URL('../../../web/console/actions.mjs',import.meta.url),'utf8');assert.match(actions,/connectionsView/);assert.doesNotMatch(actions,/card\('chatgptGrants'/);
});
test('C-02: disabled policies never expose an enabled create action; no fake connection health',()=>{
 const html=connectionsView({connections:[],counts:{total:0},total:0},{allowed_actions:[],connection_management:{enabled:false}},{});
 assert.doesNotMatch(html,/data-connection-new/);assert.match(html,/connPolicy/);assert.doesNotMatch(html,/demo|已连接|Connected/);
});
test('C-03: ChatGPT web and agent devices are counted and listed; managed and revoked keys only in history',async()=>{
 const {connectionInventory}=await import('../../../web/console/connections.mjs');
 const key=(agent_id,instance,extra={})=>({credential_id:`cred-${instance}`,agent_id,agent_instance_id:instance,label:`Synthetic ${agent_id}`,device_id:'synthetic-device',created_at:'2026-09-01T00:00:00Z',last_used_at:'2026-09-30T02:00:00Z',scopes:['memory:read','capture:write'],state:'active',managed:false,console_revocable:true,...extra});
 const data={connections:[],counts:{active:0,readonly:0,memory_readwrite:0,pending:0},total:0,
  legacy_connections:[{grants:[{grant_id:'grant-1',client_id:'system-client',created:1757490455,expires:1791000000,scopes:['openid','memory:read','project:read']},{grant_id:'grant-2',client_id:'system-client',created:1759211470,expires:1791000000,scopes:['memory:read']}]}],
  system_chatgpt:{configured:true,last_token_at:1759214539},
  core_connections:[key('openclaw','inst-openclaw'),key('hermes','inst-hermes',{scopes:['memory:read']}),
   key('chatgpt-web','inst-gateway',{managed:true,console_revocable:false,last_used_at:'2026-09-30T06:42:01Z',scopes:['memory:read']}),
   key('mnemuron','inst-admin',{managed:true,console_revocable:false,scopes:['admin:devices']}),
   key('mnemuron-loadgen','inst-old',{state:'revoked',revoked_at:'2026-09-02T07:10:00Z',console_revocable:false})]};
 const caps={allowed_actions:['oauth.revoke','devices.revoke'],web_policy:{read_all:true},connection_management:{enabled:true}};
 const inv=connectionInventory(data,caps);
 assert.deepEqual(inv.counts,{active:3,readonly:2,readwrite:1,pending:0});
 assert.deepEqual(inv.devices.map(c=>c.agent_id),['openclaw','hermes']);
 assert.deepEqual(inv.managed.map(c=>c.agent_id),['chatgpt-web','mnemuron']);assert.deepEqual(inv.history.map(c=>c.agent_id),['mnemuron-loadgen']);
 assert.equal(inv.chatgpt.authorized,true);assert.equal(inv.chatgpt.first,1757490455000);assert.equal(inv.chatgpt.last,Date.parse('2026-09-30T06:42:01Z'));
 const html=connectionsView(data,caps,{});
 const card=html.match(/<section class="card connection-chatgpt">[\s\S]*?<\/section>/)[0];
 assert.match(card,/data-state="enabled"/);assert.match(card,/data-i18n="connReadAll"/);assert.match(card,/href="\/app\/privacy"/);
 assert.equal((card.match(/data-console-action="oauth.revoke"/g)||[]).length,2);assert.match(card,/<code>project:read<\/code>/);assert.doesNotMatch(card,/<code>openid<\/code>/);
 const devices=html.match(/<section class="card connection-devices">[\s\S]*?<\/section>/)[0];
 assert.match(devices,/data-console-action="devices.revoke" data-id="inst-openclaw"/);assert.match(devices,/data-inspect="core_connections" data-id="cred-inst-hermes"/);
 assert.doesNotMatch(devices,/inst-gateway|inst-admin|inst-old/);
 const system=html.match(/<details class="card connection-system">[\s\S]*<\/details>/)[0];
 assert.match(system,/data-i18n="agent_chatgpt_web"/);assert.match(system,/data-i18n="connState_revoked"/);assert.doesNotMatch(system,/data-console-action/);
 assert.doesNotMatch(html,/已连接|Connected/);
 const readonly=connectionsView(data,{allowed_actions:[],web_policy:{read_all:false}},{});
 assert.doesNotMatch(readonly,/data-console-action/);assert.match(readonly,/data-i18n="connReadGranted"/);
 const none=connectionInventory({connections:[],counts:{},core_connections:[]},{});
 assert.deepEqual([none.chatgpt.configured,none.counts.active],[false,0]);assert.doesNotMatch(connectionsView({connections:[],counts:{}},{},{}),/connection-chatgpt/);
});
