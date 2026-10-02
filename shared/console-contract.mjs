// Console writes are opt-in. They do not change the ChatGPT MCP read-only grant.
export const CONSOLE_READ_SCOPES = Object.freeze(['memory:read','resume:read','console:read']);
export const CONSOLE_BASIC_SCOPES = Object.freeze([...CONSOLE_READ_SCOPES,'memory:write','memory:organize']);
export const CONSOLE_WRITE_SCOPES = Object.freeze([...CONSOLE_READ_SCOPES,'memory:write','memory:organize','console:write']);
export const exactScopes = (actual,expected) => Array.isArray(actual) && actual.length===expected.length && new Set(actual).size===actual.length && expected.every(s=>actual.includes(s));
export const consoleWritable = auth => auth?.agent_id==='mnemuron-console' && exactScopes(auth.scopes,CONSOLE_WRITE_SCOPES);
export const consoleMemoryWritable = auth => consoleWritable(auth)||(auth?.agent_id==='mnemuron-console'&&exactScopes(auth.scopes,CONSOLE_BASIC_SCOPES));
export const CONSOLE_MEMORY_ACTIONS = Object.freeze(['memory.create','memory.correct','memory.retract','memory.classify','memory.sensitivity','memory.visibility','memory.web_policy']);
// Basic console credentials may also revoke their own agents' keys; the BFF requires fresh factors first.
export const CONSOLE_SELF_SERVICE_ACTIONS = Object.freeze(['devices.revoke']);
export const consoleActionWritable = (auth,action) => consoleWritable(auth)||(consoleMemoryWritable(auth)&&(CONSOLE_MEMORY_ACTIONS.includes(action)||CONSOLE_SELF_SERVICE_ACTIONS.includes(action)));
export const CONSOLE_ACTIONS = Object.freeze(['memory.create','memory.correct','memory.retract','memory.classify','memory.sensitivity','memory.visibility','memory.web_policy',
  'jobs.schedule','jobs.cancel','jobs.retry','models.save','models.test','models.disable','vector.schedule',
  'connections.create','connections.rotate','connections.revoke','storage.import','devices.revoke',
  'memory.batch_classify','memory.batch_retract','taxonomy.save','privacy.defaults','retention.save','retention.prune','devices.register','devices.rotate']);
export const CONSOLE_FEATURE_VIEWS = Object.freeze(['attention','capture-status','model-usage','taxonomy','privacy-defaults','retention','task-branches','project-context','task-checkpoints','task-reconciliation','system-health','system-version','backups','memory-versions']);
