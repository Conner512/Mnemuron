import test from 'node:test';
import assert from 'node:assert/strict';

// Pure rendering harness. Actual browser/login acceptance is a separate suite.
globalThis.document={body:{dataset:{}},documentElement:{dataset:{}},querySelectorAll:()=>[],addEventListener:()=>{}};
const {actionPage}=await import('../../../web/console/actions.mjs');
const caps={enabled:false,writable:false,operator:true,account_id:'synthetic-a',management:{invitations:true,accounts:true,roles:false}};
test('MGMT-UI-01: independent management renders while general writes remain hidden',()=>{
 assert.match(actionPage('invitations',{batch_limit:100,invitations:[]},caps),/data-console-action="invitations.issue"/);
 assert.doesNotMatch(actionPage('models',{},caps),/data-console-action=/);
 assert.match(actionPage('accounts',{}, {...caps,operator:false}),/operatorRequired/);
 assert.match(actionPage('accounts',{}, {...caps,management:{}}),/managementDisabled/);
});
test('MGMT-UI-02: role changes and self-disable are absent, metadata is escaped',()=>{
 const rows=[{account_id:'synthetic-a',username:'Current',status:'active',role:'operator',mfa_verified:1,binding_ready:1},
   {account_id:'synthetic-b',username:'<script>secret</script>',status:'active',role:'member',mfa_verified:1,binding_ready:1}];
 const html=actionPage('accounts',{accounts:rows,maintenance_enabled:true},caps);
 assert.doesNotMatch(html,/data-console-action="accounts.role"|<script>/);
 assert.match(html,/rolesServerOnly/);assert.match(html,/currentAccount/);assert.match(html,/mfaStatus/);
 assert.equal([...html.matchAll(/data-console-action="accounts.disable"/g)].length,1);
 assert.match(html,/data-id="synthetic-b"/);
});
test('MGMT-UI-03: expired/used invitation rows cannot offer a misleading revoke action',()=>{
 const html=actionPage('invitations',{batch_limit:100,invitations:[{invitation_id:'expired',batch_id:'batch',state:'issued',effective_state:'expired',expires:1},
   {invitation_id:'live',batch_id:'batch2',state:'issued',effective_state:'issued',expires:1e10}]},caps);
 assert.equal([...html.matchAll(/data-console-action="invitations.revoke"/g)].length,1);
 assert.match(html,/data-id="live"/);assert.doesNotMatch(html,/data-id="expired"/);
});
