import {CONSOLE_ACTIONS} from './console-contract.mjs';
// Shared validation keeps identity audit and Core audit pagination/filter semantics identical.
export function auditQuery(params){
  if(Object.keys(params).some(k=>!['offset','limit','action','outcome','from','to','source','group','cursor'].includes(k)))throw new Error('Invalid audit query');
  if(params.source!==undefined&&!AUDIT_SOURCES.includes(params.source))throw new Error('Invalid audit source');
  if(params.group!==undefined&&!AUDIT_GROUPS.includes(params.group))throw new Error('Invalid audit group');
  if(params.cursor!==undefined&&(!params.group||typeof params.cursor!=='string'||params.cursor.length>160||!/^[A-Za-z0-9_-]+$/.test(params.cursor)))throw new Error('Invalid audit cursor');
  if(params.group&&params.source!==undefined)throw new Error('Group and legacy source are exclusive');
  const offset=Number(params.offset??0),limit=Number(params.limit??25);
  if(!Number.isSafeInteger(offset)||offset<0||offset>1000000||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('Invalid pagination');
  for(const key of ['action','outcome'])if(params[key]!==undefined&&!/^[a-zA-Z0-9_.:-]{1,100}$/.test(params[key]))throw new Error('Invalid audit filter');
  for(const key of ['from','to'])if(params[key]!==undefined){
    const value=params[key];
    if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==(value.includes('.')?value:value.replace('Z','.000Z')))throw new Error('Invalid audit date');
  }
  if(params.from&&params.to&&Date.parse(params.from)>Date.parse(params.to))throw new Error('Invalid audit range');
  return {...params,offset,limit};
}

// Audit streams are paged independently: Core records agent/connection activity, the identity service records
// sign-in and account-security events. A page of one is never merged with a page of the other.
export const AUDIT_SOURCES=Object.freeze(['core','identity']);
// At most this many result references are kept per memory.query audit row (lexical subquery results only).
export const AUDIT_QUERY_REFS=20;

const AUDIT_READ=new Set(['memory.query','memory.read']);
const AUDIT_CREDENTIAL=/^(?:credential\.|connection\.|agent_instance\.|devices\.|connections\.|oauth\.)/;
const AUDIT_AUTH=/^(?:account\.|accounts\.|security\.|session\.|operator\.|recovery\.|registration\.|invitations?\.|identity\.|migration\.|cloud\.binding\.)/;
const AUDIT_WRITE=/^(?:memory\.(?:create|supersede|retract|capture|derive|category\.(?:set|batch|undo)|sensitivity\.set|source\.pin|web_visibility|web_policy)|events\.append|checkpoint\.create|task\.(?:upsert|reconciliation\.(?:apply|reject)|bootstrap\.confirm)|project\.(?:upsert|update|console_archive|console_restore|lifecycle\.(?:delete|restore|merge)|bootstrap\.confirm)|resume\.confirm|retention\.(?:prune|update)|jobs\.reschedule)$/;
const CONSOLE_NOT_WRITE=/^(?:models\.(?:test|discover)|.*preview)$/;
/** Coarse event kind for display and export. Console operations (`console.<action>`) are classified by their action;
 * anything not recognized stays 'other' rather than being called a write. */
export function auditKind(action){
  const a=String(action||'');
  if(AUDIT_READ.has(a)||a.startsWith('console.read.'))return 'read';
  const console=a.startsWith('console.'),op=console?a.slice(8):a;
  if(AUDIT_CREDENTIAL.test(op))return 'credential';
  if(AUDIT_AUTH.test(op))return 'auth';
  if(AUDIT_WRITE.test(op)||(console&&CONSOLE_ACTIONS.includes(op)&&!CONSOLE_NOT_WRITE.test(op)))return 'write';
  return 'other';
}

// Product tabs are distinct from provenance streams. Unknown historical actions remain visible in
// account-scoped system activity, explicitly unclassified; no global/null-owner records are added.
export const AUDIT_GROUPS=Object.freeze(['system','memory','connections','security']);
const expand=names=>[...names,...names.map(n=>'console.'+n)];
const GROUP_ACTIONS={
 memory:expand(['memory.query','memory.read','memory.create','memory.supersede','memory.retract','memory.capture','memory.derive','memory.category.set','memory.category.batch','memory.category.undo','memory.sensitivity.set','memory.source.pin','memory.web_visibility','memory.web_policy','memory.batch_classify','memory.batch_retract','memory.update','memory.delete','memory.restore','memory.correct','memory.classify','memory.sensitivity','memory.organize','memory.organize_undo']),
 connections:expand(['credential.issue','credential.rotate','credential.reconciliation_scopes.update','credential.task_bootstrap_scopes.update','credential.project_bootstrap_scopes.update','agent_instance.register','agent_instance.revoke','devices.register','devices.rotate','devices.revoke','connections.create','connections.update','connections.disable','connections.enable','connections.revoke','connections.rotate','connection.authorized','connection.tool_failed','connection.tool_succeeded','oauth.revoke']),
 security:expand(['account.login','account.login.failed','account.disabled','account.enable_requested','accounts.disable','accounts.enable','registration.prepared','registration.expired','registration.totp_displayed','registration.mfa_verified','registration.recovery_shown','registration.recovery_ack','migration.legacy_imported','identity.provisioned','identity.credentials.revoke_all','recovery.proof_verified','recovery.credentials_prepared','recovery.completed','security.password','security.totp.begin','security.totp.complete','security.recovery_codes','security.session.revoke','security.sessions.revoke_others'])
};
GROUP_ACTIONS.memory.push('console.read.memory','console.read.memories','console.read.memory-versions','console.read.memory-meta');
const knownSystem=new Set(['events.append','checkpoint.create','project.upsert','task.upsert','retention.prune','retention.update','resume.preview','resume.cancel','resume.confirm',...CONSOLE_ACTIONS.map(n=>'console.'+n),...['overview','attention','capture-status','model-usage','taxonomy','privacy-defaults','retention','task-branches','task-checkpoints','task-reconciliation','project-context','system-health','system-version','backups','memory-versions','memories','summaries','summary','jobs','job','storage','memory','models','memory-meta','export','projects','metadata-values','task-detail','entities','operation'].map(n=>'console.read.'+n)]);
export function auditGroup(action){return Object.keys(GROUP_ACTIONS).find(g=>GROUP_ACTIONS[g].includes(action))||'system';}
export function auditUnclassified(action){return auditGroup(action)==='system'&&!knownSystem.has(action);}
export function auditGroupFilter(group){
 if(!AUDIT_GROUPS.includes(group))throw new Error('Invalid audit group');
 const values=[...new Set(group==='system'?Object.values(GROUP_ACTIONS).flat():GROUP_ACTIONS[group])];
 return {sql:`action ${group==='system'?'NOT IN':'IN'} (${values.map(()=>'?').join(',')})`,values};
}
