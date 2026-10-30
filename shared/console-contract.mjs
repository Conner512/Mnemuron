// Console writes are opt-in. They do not change the ChatGPT MCP read-only grant.
export const CONSOLE_READ_SCOPES = Object.freeze(['memory:read','resume:read','console:read']);
export const CONSOLE_BASIC_SCOPES = Object.freeze([...CONSOLE_READ_SCOPES,'memory:write','memory:organize']);
export const CONSOLE_WRITE_SCOPES = Object.freeze([...CONSOLE_READ_SCOPES,'memory:write','memory:organize','console:write']);
export const exactScopes = (actual,expected) => Array.isArray(actual) && actual.length===expected.length && new Set(actual).size===actual.length && expected.every(s=>actual.includes(s));
export const consoleWritable = auth => auth?.agent_id==='mnemuron-console' && exactScopes(auth.scopes,CONSOLE_WRITE_SCOPES);
export const consoleMemoryWritable = auth => consoleWritable(auth)||(auth?.agent_id==='mnemuron-console'&&exactScopes(auth.scopes,CONSOLE_BASIC_SCOPES));
// Organizing entities needs memory:organize. Category writes (classify, organize, category management) were retired:
// memories are filed by their writer-chosen type.
// Entity actions were retired too: memories carry keywords instead (see memory_traits); no organize action remains.
export const CONSOLE_ORGANIZE_ACTIONS = Object.freeze([]);
export const CONSOLE_MEMORY_ACTIONS = Object.freeze(['memory.create','memory.correct','memory.retract',...CONSOLE_ORGANIZE_ACTIONS]);
// Basic console credentials may also revoke their own agents' keys; the BFF requires fresh factors first.
export const CONSOLE_SELF_SERVICE_ACTIONS = Object.freeze(['devices.revoke']);
export const consoleActionWritable = (auth,action) => consoleWritable(auth)||(consoleMemoryWritable(auth)&&(CONSOLE_MEMORY_ACTIONS.includes(action)||CONSOLE_SELF_SERVICE_ACTIONS.includes(action)));
// ChatGPT per-memory visibility (memory.visibility, memory.web_policy) was removed from the console; the
// account read policy is an operator runtime setting (memory.agent_read_policy).
// Tunnel changes and the fields the BFF forwards to Core for each.
const CONSOLE_TUNNEL_ACTIONS_LIST=['tunnel.add','tunnel.token','tunnel.reapply','tunnel.remove'];
export const CONSOLE_TUNNEL_FIELDS=Object.freeze({'tunnel.add':['name','token'],'tunnel.token':['id','token'],'tunnel.reapply':['id'],'tunnel.remove':['id']});
export const OWNER_ACTIONS=Object.freeze(['features.save','schedule.save','processing.preview','processing.start','processing.pause','processing.resume','processing.cancel','processing.delete','processing.clear']);
export const TASK_WORKFLOW_ACTIONS=Object.freeze(['projects.bootstrap_preview','projects.bootstrap_confirm','tasks.bootstrap_preview','tasks.bootstrap_confirm','tasks.reconciliation_preview','tasks.reconciliation_resolve']);
export const RESUME_WORKFLOW_ACTIONS=Object.freeze(['resume.preview','resume.confirm']);
export const TASK_WORKFLOW_VIEWS=Object.freeze(['task-workflow-preview']);
export const RESUME_WORKFLOW_VIEWS=Object.freeze(['resume-targets','resume-status','resume-history']);
export const CONSOLE_WORKFLOW_VIEWS=Object.freeze([...TASK_WORKFLOW_VIEWS,...RESUME_WORKFLOW_VIEWS]);
export const CONSOLE_REVIEW_VIEWS=Object.freeze(['review-candidates','summary-quality','memory-review']);
export const CONSOLE_REVIEW_ACTIONS=Object.freeze(['review.extract','review.candidate','review.summary','review.verify','review.resolve']);
// Candidate promotion and destructive pair decisions are explicit, freshly authenticated Console operations.
export const CONSOLE_REVIEW_FIELDS=Object.freeze({
  'review.candidate':['candidate_id','revision','decision','content','memory_type','topic','confirmed'],
  'review.resolve':['memory_id','revision','source_version','counterpart_id','counterpart_revision','counterpart_source_version','decision','confirmed'],
});
export const CONSOLE_WORKFLOW_ERRORS=Object.freeze(['LIFECYCLE_AUTHORITY_STALE','TASK_WORKFLOW_PREVIEW_TOO_LARGE','RECONCILIATION_CONFLICT',
  'RESUME_ALREADY_DELIVERED','RESUME_CONTEXT_CHANGED','RESUME_NOT_FOUND','RESUME_PREVIEW_EXPIRED','RESUME_TARGET_MISMATCH',
  'RESUME_TARGET_REQUIRED','RESUME_TARGET_UNAVAILABLE','RESUME_TASK_UNRESOLVED','RESUME_VERSION_CHANGED','RESUME_CONFIRMATION_REQUIRED']);
// Fresh factors stay at the BFF. Only the frozen preview identity and explicit decision reach Core.
export const CONSOLE_WORKFLOW_CONFIRMS=Object.freeze({
  'projects.bootstrap_confirm':['preview_id','preview_version','confirmed'],
  'tasks.bootstrap_confirm':['preview_id','preview_version','confirmed'],
  'tasks.reconciliation_resolve':['preview_id','preview_version','decision'],
  'resume.confirm':['resume_id','preview_version','confirmed'],
});
export const CONSOLE_ACTIONS = Object.freeze([...OWNER_ACTIONS,...TASK_WORKFLOW_ACTIONS,...RESUME_WORKFLOW_ACTIONS,...CONSOLE_REVIEW_ACTIONS,'memory.create','memory.correct','memory.retract',...CONSOLE_ORGANIZE_ACTIONS,
  'jobs.schedule','jobs.cancel','jobs.cancel_batch','jobs.retry','models.save','models.test','models.discover','models.disable','models.quota','hosts.set','hosts.remove','vector.schedule','vector.prepare','vector.activate','vector.deactivate',
  'connections.create','connections.rotate','connections.revoke','storage.import','devices.revoke',
  'memory.batch_retract','privacy.defaults','retention.save','retention.prune','devices.register','devices.rotate',
  // Project/task editing and Console-only archive: full Console write credentials only (no admin:tasks).
  'projects.update','projects.archive','projects.restore','tasks.update',
  // Recoverable project delete/restore and canonical merge (preview, then confirm). Full Console write credentials only;
  // the BFF requires a fresh password + OTP for every confirm. projects.restore above stays Console unarchive.
  'projects.lifecycle_preview',...['projects.lifecycle_delete','projects.lifecycle_restore','projects.merge'],
  // Cloudflare Tunnel (owner only): the BFF requires a fresh password + OTP for every change.
  ...CONSOLE_TUNNEL_ACTIONS_LIST]);
// Confirms that change project lifecycle state: the BFF re-authenticates each one and forwards only these fields.
export const CONSOLE_LIFECYCLE_CONFIRMS = Object.freeze({'projects.lifecycle_delete':['preview_id','confirm_name'],'projects.lifecycle_restore':['preview_id'],'projects.merge':['preview_id']});
export const CONSOLE_FEATURE_VIEWS = Object.freeze(['attention','capture-status','model-usage','taxonomy','privacy-defaults','retention','task-branches','project-context','task-checkpoints','task-reconciliation','system-health','system-version','backups','memory-versions','memory-processing']);
