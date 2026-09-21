// Console writes are opt-in. They do not change the ChatGPT MCP read-only grant.
export const CONSOLE_READ_SCOPES = Object.freeze(['memory:read','resume:read','console:read']);
export const CONSOLE_WRITE_SCOPES = Object.freeze([...CONSOLE_READ_SCOPES,'memory:write','memory:organize','console:write']);
export const exactScopes = (actual,expected) => Array.isArray(actual) && actual.length===expected.length && new Set(actual).size===actual.length && expected.every(s=>actual.includes(s));
export const consoleWritable = auth => auth?.agent_id==='mnemuron-console' && exactScopes(auth.scopes,CONSOLE_WRITE_SCOPES);
export const CONSOLE_ACTIONS = Object.freeze(['memory.create','memory.correct','memory.retract','memory.classify','memory.sensitivity','memory.visibility',
  'jobs.schedule','jobs.cancel','jobs.retry','models.save','models.test','models.disable','vector.schedule',
  'connections.create','connections.rotate','connections.revoke','storage.import']);
