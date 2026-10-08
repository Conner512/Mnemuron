import {CONSOLE_ACTIONS} from './console-contract.mjs';
// Shared validation keeps identity audit and Core audit pagination/filter semantics identical.
export function auditQuery(params){
  if(Object.keys(params).some(k=>!['offset','limit','action','outcome','from','to','source'].includes(k)))throw new Error('Invalid audit query');
  if(params.source!==undefined&&!AUDIT_SOURCES.includes(params.source))throw new Error('Invalid audit source');
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
const AUDIT_CREDENTIAL=/^(?:credential\.|agent_instance\.|devices\.|connections\.|oauth\.)/;
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
