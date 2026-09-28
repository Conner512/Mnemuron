import test from 'node:test';
import assert from 'node:assert/strict';
import {text,catalog} from '../../../web/console/catalog.mjs';
import {scanPublicationFile} from '../../../scripts/check-publication.mjs';
globalThis.document={body:{dataset:{}},documentElement:{dataset:{}},querySelectorAll:()=>[],addEventListener:()=>{}};
const {connectionPage,connectionGuide}=await import('../../../web/console/actions.mjs');
const caps={allowed_actions:['cloud_connections.create','cloud_connections.rotate','cloud_connections.revoke'],resource:'https://memory.example.com/mcp'};
test('CLOUD-UI-01 connection groups are collapsed and keep source metadata escaped',()=>{
 const html=connectionPage({cloud:{items:[{connection_id:'safe-id',label:'<script>untrusted</script>',kind:'mcp',permission:'readonly',status:'active',expires:123}],total:1},core_connections:[{agent_id:'chatgpt-web',label:'internal gateway',credential_id:'synthetic-internal'},{agent_id:'test',label:'old test',credential_id:'synthetic-history',revoked_at:'2000-01-01'}]},caps);
 assert.match(html,/data-connection-wizard/);assert.match(html,/data-connection-status="history"/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|connection-secondary[^>]*\bopen\b/);
 assert.match(html,/systemConnections/);assert.match(html,/legacyConnectionHistory/);assert.match(html,/connectionState_active/);
});
test('CLOUD-UI-02 guides distinguish credentials and do not treat agents as implemented',()=>{
 const mcp=connectionGuide('mcp',caps.resource),oauth=connectionGuide('chatgpt',caps.resource),agents=connectionGuide('agents',caps.resource);
 assert.match(mcp,/&lt;YOUR_MCP_ACCESS_TOKEN&gt;/);assert.match(mcp,/Bearer/);assert.match(oauth,/PKCE S256/);
 assert.match(agents,/OpenClaw/);assert.match(agents,/comingSoon/);assert.doesNotMatch(agents,/data-console-action/);
 for(const locale of ['zh-CN','en'])for(const key of ['scopeMemoryWrite','cloudOAuthConsent','cloudSecretNote','chatgptStep1','chatgptStep4','cloudScopeNote'])assert.notEqual(text(key,locale),key);
});
test('CLOUD-UI-03 disabled issuance still provides guides without a credential-mint action',()=>{
 const html=connectionPage({}, {allowed_actions:[]});assert.match(html,/cloudDisabledNote/);assert.doesNotMatch(html,/data-console-action/);
});
test('CLOUD-UI-04 publication rules detect the new generic MCP token format',()=>{
 const sample=['mnmc_', 'A'.repeat(43)].join('');assert.ok(scanPublicationFile('sample.txt',sample).some(x=>x.rule==='project-or-model-key'));
});
