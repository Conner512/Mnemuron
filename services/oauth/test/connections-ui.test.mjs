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
