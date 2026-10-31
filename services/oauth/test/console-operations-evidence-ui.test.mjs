import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.document={body:{dataset:{}},documentElement:{dataset:{},lang:'zh-CN'},querySelectorAll:()=>[],addEventListener:()=>{}};
const {actionPage}=await import('../../../web/console/actions.mjs');
const {backupStatusView}=await import('../../../web/console/visuals.mjs');
const {text}=await import('../../../web/console/catalog.mjs');
const usage={days:14,totals:{attempts:2,succeeded:1,failed:1,pending:0,input_tokens:100,input_unknown:1,output_tokens:20,output_unknown:1,invalid_usage:0,unestimated_attempts:1},groups:[],estimates:[{currency:'USD',amount:0.00028,attempts:1}],recent_limit:50,
  recent:[{started_at:Date.now(),kind:'organizer',model:'<script>synthetic</script>',purpose:'summary',outcome:'failed',error_code:'NETWORK_ERROR',input_tokens:null,output_tokens:null,cached_input_tokens:null,duration_ms:3,estimate_status:'unknown_usage',pricing:{currency:'USD',version:'<synthetic-price>'},estimated_amount:null}]};
test('usage UI separates reserved calls, unknown tokens, per-currency estimates and immutable price versions without markup injection',()=>{
  const html=actionPage('models',{models:[],processing:{},features:{'model-usage':{history:[],searches_7d:0,observed_usage:usage}}},{owner_mode:true,allowed_actions:[]});
  assert.match(html,/usage-evidence/);assert.match(html,/不等于已成功发送或被供应商计费/);assert.match(html,/data-i18n="usageUnknown"/);assert.match(html,/data-i18n="usageEstimate_unknown_usage"/);
  assert.match(html,/USD 0\.00028/);assert.match(html,/&lt;synthetic-price&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;synthetic/);assert.doesNotMatch(html,/data-console-action/);
});
test('backup UI is operator-only, read-only and explains missing, stale, failed and earlier restore evidence in both languages',()=>{
  const data={status:'failed',backup:{status:'created',observed_at:Date.now(),size_bytes:100,artifact_sha256:'a'.repeat(64)},verification:{status:'failed',error_code:'BACKUP_HASH_MISMATCH'},restore:{status:'stale',artifact_sha256:'b'.repeat(64),matches_latest_backup:false}};
  for(const locale of ['zh-CN','en']){const html=backupStatusView(k=>text(k,locale),data);for(const key of ['backupState_failed','backupState_created','backupState_stale','backupRestoreEarlier'])assert.match(html,new RegExp(`data-i18n="${key}"`));assert.doesNotMatch(html,/data-console-action|<a\b[^>]*download/);}
  assert.match(backupStatusView(k=>text(k,'en'),null),/could not be read/);
  assert.match(actionPage('storage',{features:{backups:data}},{operator:true,allowed_actions:[]}),/data-backup-evidence/);
  assert.doesNotMatch(actionPage('storage',{features:{backups:data}},{operator:false,allowed_actions:[]}),/data-backup-evidence/);
});
