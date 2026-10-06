import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
globalThis.document={body:{dataset:{}},documentElement:{dataset:{}},querySelectorAll:()=>[],addEventListener:()=>{}};
const {connectionsView}=await import('../../../web/console/connections.mjs');
test('C-06: summary uses current authorization counts, not created credentials; footer Back is a peer action',async()=>{
 const {connectionInventory,connectionFormActions}=await import('../../../web/console/connections.mjs');
 const data={connections:[{connection_id:'pending',label:'Synthetic pending',kind:'chatgpt_oauth',profile:'memory_readwrite',configuration_state:'ready',health:'never_used',active_grant_count:0}],counts:{active:1,memory_readwrite:1,pending:0},authorization_counts:{usable:0,readonly:0,memory_readwrite:0,pending:1,verified:0},total:1};
 assert.deepEqual(connectionInventory(data).counts,{active:0,readonly:0,readwrite:0,pending:1});
 const html=connectionsView(data,{});assert.match(html,/connAuthorizedCount/);assert.match(html,/connAwaitingAuthorization/);assert.match(html,/connCountsNote/);
 const historical=connectionsView({...data,connections:[{...data.connections[0],health:'verified'}]},{});
 assert.match(historical,/connHistoricalSuccess/);assert.doesNotMatch(historical,/connHealth_verified/);
 const actions=connectionFormActions('continue','type');assert.match(actions,/<div class="actions connection-form-actions"><button type="button".*data-connection-back="type"/);
 assert.ok(actions.indexOf('data-connection-back')<actions.indexOf('type="submit"'));assert.match(actions,/data-connection-close/);
 assert.doesNotMatch(connectionFormActions(),/data-connection-back/);
});
test('C-01: one logical row, account counts, history/system folds, no IDs or credential secrets in main row',()=>{
 const html=connectionsView({connections:[{connection_id:'synthetic-id',label:'<script>alert(1)</script>',kind:'generic_mcp',profile:'readonly',configuration_state:'ready',health:'never_used'}],counts:{active:1,readonly:1,memory_readwrite:0,pending:0},total:1,offset:0,limit:20,next_offset:null,core_connections:[{label:'Synthetic system',credential_id:'do-not-use-as-main-row',agent_id:'chatgpt-web'}]}, {allowed_actions:['connections.create'],connection_management:{enabled:true}},{});
 assert.match(html,/data-connection-new/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/data-connection-detail="synthetic-id"/);assert.match(html,/connSystem/);assert.match(html,/never_used/);
 const actions=fs.readFileSync(new URL('../../../web/console/actions.mjs',import.meta.url),'utf8');assert.match(actions,/connectionsView/);assert.doesNotMatch(actions,/card\('chatgptGrants'/);
});
test('C-05: setup uses server OAuth scopes and endpoints, never guesses missing parameters or current authorization',async()=>{
 const {pluginValues,chatgptPluginForm,pluginStatus}=await import('../../../web/console/connections.mjs');
 const c={kind:'chatgpt_oauth',label:'Synthetic setup',profile:'readonly',client_id:'synthetic-client',redirect_uri:'https://chatgpt.com/connector_platform_oauth_redirect',configuration_state:'ready',health:'verified'};
 const guide={url:'https://memory.example.test/mcp',scopes:['memory:read'],oauth_scopes:['openid','offline_access','memory:read'],issuer:'https://memory.example.test',authorization_url:'https://memory.example.test/authorize',token_url:'https://memory.example.test/token',resource:'https://memory.example.test/mcp',discovery_url:'https://memory.example.test/.well-known/openid-configuration',token_endpoint_auth_method:'client_secret_post'};
 const values=pluginValues(c,guide);assert.equal(values.scopes,'openid offline_access memory:read');assert.equal(values.issuer,guide.issuer);assert.equal(pluginValues(c).token_auth,undefined);
 const html=chatgptPluginForm(c,guide);for(const name of ['authorization_url','token_url','issuer','resource','discovery_url'])assert.match(html,new RegExp(`data-connection-copy="${name}"`));
 assert.match(html,/connPluginRegistration/);assert.match(html,/connPluginManual/);
 const scopeField=html.match(/<code>([^<]*)<\/code><button[^>]*data-connection-copy="scopes"/)[1];
 assert.equal(scopeField,values.scopes);assert.doesNotMatch(scopeField,/memory:write|project:read/);
 assert.match(html,/基础授权范围/,'instructions explain where to paste the per-connection scopes');
 assert.ok(html.indexOf('data-connection-copy="discovery_url"')<html.indexOf('<details'),'connection-specific discovery is not hidden in advanced details');
 assert.doesNotMatch(html,/data-i18n="connWriteConsentCheck"/);
 assert.equal(pluginStatus({...c,active_grant_count:0}),'connStatus_ready');
 assert.equal(pluginStatus({...c,health:'degraded',active_grant_count:1}),'connStatus_degraded');
 assert.equal(pluginStatus({...c,configuration_state:'draft'}),'connStatus_callback');
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
 const caps={allowed_actions:['oauth.revoke','devices.revoke'],read_policy:{active_records_uniform:false,legacy_read_all:true},connection_management:{enabled:true}};
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
 const readonly=connectionsView(data,{allowed_actions:[],read_policy:{active_records_uniform:false,legacy_read_all:false}},{});
 assert.doesNotMatch(readonly,/data-console-action/);assert.match(readonly,/data-i18n="connReadGranted"/);
 // The operator's active-uniform policy is shown as such, whatever the legacy account setting.
 assert.match(connectionsView(data,{allowed_actions:[],read_policy:{active_records_uniform:true,legacy_read_all:false}},{}),/data-i18n="connReadActiveUniform"/);
 const none=connectionInventory({connections:[],counts:{},core_connections:[]},{});
 assert.deepEqual([none.chatgpt.configured,none.counts.active],[false,0]);assert.doesNotMatch(connectionsView({connections:[],counts:{}},{},{}),/connection-chatgpt/);
 assert.match(card,/data-i18n="connWriteOff"/);
 const pending={...data,system_chatgpt:{...data.system_chatgpt,write_enabled:true}};
 assert.match(connectionsView(pending,caps,{}),/data-i18n="connWritePending"/);
 const written={...pending,legacy_connections:[{grants:[...data.legacy_connections[0].grants,{grant_id:'grant-3',client_id:'system-client',created:1759216000,expires:1791000000,scopes:['memory:read','memory:write']}]}]};
 const writeInv=connectionInventory(written,caps);
 assert.equal(writeInv.chatgpt.write,true);assert.deepEqual(writeInv.counts,{active:3,readonly:1,readwrite:2,pending:0});
 const writeCard=connectionsView(written,caps,{}).match(/<section class="card connection-chatgpt">[\s\S]*?<\/section>/)[0];
 assert.match(writeCard,/data-i18n="connReadWrite"/);assert.match(writeCard,/data-i18n="connWriteGranted"/);
});
test('C-04: the ChatGPT plugin form lists every field to copy, shows the secret only when just issued, and escapes values',async()=>{
 const {chatgptPluginForm,pluginValues,pluginStatus,CHATGPT_CALLBACK}=await import('../../../web/console/connections.mjs');
 const c={connection_id:'conn-1',kind:'chatgpt_oauth',label:'My <b>ChatGPT</b>',description:'',profile:'memory_readwrite',client_id:'mnmc_synthetic',redirect_uri:CHATGPT_CALLBACK,configuration_state:'ready',health:'never_used',provisioning:false};
 const guide={url:'https://memory.example.test/mcp',scopes:['openid','offline_access','memory:read','memory:write'],token_endpoint_auth_method:'client_secret_post'};
 const values=pluginValues(c,guide);
 assert.equal(values.scopes,'openid offline_access memory:read memory:write');assert.equal(values.callback,CHATGPT_CALLBACK);assert.equal(values.token_auth,'client_secret_post');assert.ok(values.description);
 const detail=chatgptPluginForm(c,guide);
 for(const field of ['label','description','url','client_id','token_auth','scopes','callback'])assert.match(detail,new RegExp(`data-connection-copy="${field}"`),field);
 assert.match(detail,/data-connection-icon/);assert.match(detail,/data-i18n="connSecretHidden"/);assert.doesNotMatch(detail,/id="connection-secret"/);
 assert.match(detail,/data-i18n="connWriteConsentCheck"/);assert.match(detail,/data-i18n="connBaseScopes"/);
 assert.match(detail,/My &lt;b&gt;ChatGPT&lt;\/b&gt;/);assert.doesNotMatch(detail,/<b>ChatGPT/);
 const issued=chatgptPluginForm(c,guide,{withSecret:true});
 assert.match(issued,/<input type="password" readonly autocomplete="off" id="connection-secret"/);assert.match(issued,/data-i18n-aria-label="connClientSecret"/);assert.match(issued,/data-connection-copy-secret/);
 assert.equal(pluginStatus(c),'connStatus_ready');assert.equal(pluginStatus({...c,provisioning:true}),'connStatus_provisioning');
 assert.equal(pluginStatus({...c,redirect_uri:null}),'connStatus_callback');assert.equal(pluginStatus({...c,health:'authorized'}),'connStatus_authorized');
 assert.equal(pluginStatus({...c,health:'verified'}),'connStatus_verified');assert.equal(pluginStatus({...c,configuration_state:'revoked'}),'connState_revoked');
 const card=connectionsView({connections:[],counts:{},legacy_connections:[{grants:[{grant_id:'g',client_id:'system',created:1,expires:2,scopes:[]}]}],system_chatgpt:{configured:true}},{allowed_actions:['connections.create']},{});
 assert.match(card,/data-connection-new data-connection-start="chatgpt_oauth"/);
});
test('C-07: an existing ChatGPT authorization stays visible and intact; adding a connection is a separate explicit action',async()=>{
 const {connectionInventory}=await import('../../../web/console/connections.mjs');
 const data={connections:[],counts:{},total:0,system_chatgpt:{configured:true,last_token_at:1759214539},
  legacy_connections:[{grants:[{grant_id:'synthetic-grant',client_id:'synthetic-system-client',created:1757490455,expires:1791000000,scopes:['openid','memory:read']}]}]};
 const caps={allowed_actions:['oauth.revoke','connections.create'],connection_management:{enabled:true}};
 const before=JSON.stringify(data);const html=connectionsView(data,caps,{});
 assert.equal(JSON.stringify(data),before,'rendering never mutates the inventory');
 assert.equal(connectionInventory(data,caps).counts.active,1);
 const card=html.match(/<section class="card connection-chatgpt">[\s\S]*?<\/section>/)[0];
 assert.match(card,/data-state="enabled"[^>]*><span data-i18n="connAuthorized"/);
 assert.match(card,/<dl class="connection-facts">/);assert.match(card,/data-i18n="readOnly"/);assert.match(card,/data-i18n="connWriteOff"/);
 assert.match(card,/<dt><span data-i18n="connGrantsLabel">[^<]*<\/span><\/dt><dd>1<\/dd>/);
 // The only state-changing control is the explicit per-grant revoke, inside the folded grant list, with its consequence stated.
 assert.equal((card.match(/data-console-action=/g)||[]).length,1);
 const grants=card.match(/<details class="connection-grants">[\s\S]*?<\/details>/)[0];
 assert.match(grants,/data-console-action="oauth.revoke" data-id="synthetic-grant"/);assert.match(grants,/data-i18n="connRevokeGrantNote"/);
 // Creating a new ChatGPT connection is a labelled button in the card footer, not an inline quiet link.
 assert.match(card,/<div class="connection-card-actions">[\s\S]*<button type="button" data-connection-new data-connection-start="chatgpt_oauth">[\s\S]*data-i18n="connNewChatGPT"/);
 assert.doesNotMatch(card,/class="quiet" data-connection-new/);
 assert.ok(html.indexOf('data-connection-new')<html.indexOf('connection-chatgpt'),'the general Add button stays first on the page');
 const viewer=connectionsView(data,{allowed_actions:[]},{}).match(/<section class="card connection-chatgpt">[\s\S]*?<\/section>/)[0];
 assert.doesNotMatch(viewer,/data-connection-new|data-console-action|connRevokeGrantNote/);assert.match(viewer,/data-i18n="connAuthorized"/);
});
test('C-08: list rows show a toned state; wizard steps are named; destructive confirmations are explicit',async()=>{
 const {connectionSteps,connectionFormActions}=await import('../../../web/console/connections.mjs');
 const row=c=>connectionsView({connections:[{connection_id:'x',label:'Synthetic',kind:'chatgpt_oauth',profile:'readonly',health:'never_used',...c}],counts:{},total:1},{},{}).match(/<td><span class="state-dot" data-state="([^"]+)"><span data-i18n="([^"]+)"/).slice(1);
 assert.deepEqual(row({configuration_state:'ready',active_grant_count:0}),['review_required','connAwaitingAuthorization']);
 assert.deepEqual(row({configuration_state:'ready',active_grant_count:1}),['ready','connState_ready']);
 assert.deepEqual(row({configuration_state:'draft'}),['review_required','connState_draft']);
 assert.deepEqual(row({configuration_state:'disabled'}),['disabled','connState_disabled']);
 assert.deepEqual(row({configuration_state:'revoked'}),['revoked','connState_revoked']);
 assert.deepEqual(row({configuration_state:'ready',active_grant_count:1,expired:true}),['expired','connExpired']);
 const steps=connectionSteps(3);
 assert.equal((steps.match(/<li/g)||[]).length,4);assert.equal((steps.match(/data-done/g)||[]).length,2);
 assert.match(steps,/<li aria-current="step"><span class="connection-step-number" aria-hidden="true">3<\/span><span data-i18n="connStepVerify"/);
 assert.match(steps,/data-i18n-aria-label="connStepsLabel"/);
 const danger=connectionFormActions('connConfirm_revoke','detail',{danger:true});
 assert.match(danger,/data-connection-back="detail"/);assert.match(danger,/<button type="submit" class="primary danger"><span data-i18n="connConfirm_revoke"/);
 assert.doesNotMatch(connectionFormActions('confirm','detail'),/danger/);
 const filters=connectionsView({connections:[],counts:{},total:0},{},{});
 assert.match(filters,/<form id="connection-filters"[\s\S]*<button type="submit"><span data-i18n="connApplyFilters"/);
});
test('C-09: the detail view separates routine actions from disable/revoke, and the wizard has Cancel at every step',()=>{
 const source=fs.readFileSync(new URL('../../../web/console/connections.mjs',import.meta.url),'utf8');
 assert.match(source,/\['update','rotate',\.\.\.\(c\.configuration_state==='disabled'\?\['enable'\]:\[\]\)\]/);
 assert.match(source,/<section class="connection-danger">[\s\S]*?\[\.\.\.\(c\.configuration_state==='disabled'\?\[\]:\['disable'\]\),'revoke'\]/);
 assert.match(source,/function selectType\(\)[^\n]*data-connection-close/);
 assert.match(source,/back==='detail'/);
});
test('C-10: the existing connection is named as a plugin connection in both locales, never as browser-only ChatGPT web',async()=>{
 const {catalog}=await import('../../../web/console/catalog.mjs');
 const keys=['connChatGPTWeb','connChatGPTWebNote','connChatGPT','connChatGPTNote','connChatGPTAddHint','connNewChatGPT','connPersonalNote','connManagedNote','agent_chatgpt_web','featCON01','featCON01Note'];
 for(const locale of ['zh-CN','en'])for(const key of keys)assert.doesNotMatch(catalog[locale][key],/网页版|ChatGPT Web\b|ChatGPT on the web|ChatGPT web/,`${locale} ${key}`);
 assert.equal(catalog['zh-CN'].connChatGPTWeb,'插件连接');assert.equal(catalog.en.connChatGPTWeb,'Plugin connection');
 assert.match(catalog['zh-CN'].connChatGPTWebNote,/不限于浏览器/);assert.match(catalog.en.connChatGPTWebNote,/not limited to a browser/);
 // The setup flow remains honestly ChatGPT-specific: it names ChatGPT and its "New plugin" form, not arbitrary clients.
 assert.equal(catalog['zh-CN'].connChatGPT,'ChatGPT 插件');assert.equal(catalog.en.connChatGPT,'ChatGPT plugin');
 for(const locale of ['zh-CN','en']){assert.match(catalog[locale].connChatGPTNote,/ChatGPT/);assert.match(catalog[locale].connChatGPTWebNote,/ChatGPT/);assert.match(catalog[locale].connPluginTitle,/ChatGPT/);}
 // Internal identifiers stay as they are: the card class, kind value and agent id are unchanged.
 const html=connectionsView({connections:[],counts:{},legacy_connections:[{grants:[{grant_id:'g',client_id:'synthetic',created:1,expires:2,scopes:['memory:read']}]}],system_chatgpt:{configured:true}},{allowed_actions:['connections.create']},{});
 assert.match(html,/<section class="card connection-chatgpt">/);assert.match(html,/data-connection-start="chatgpt_oauth"/);assert.match(html,/data-i18n="connChatGPTWeb"/);
});
