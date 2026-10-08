// Console view of an account's Core credentials. The console never revokes platform-managed keys
// (its own console key, the ChatGPT web gateway key) or any key with admin scopes; operators do.
export const MANAGED_AGENT_IDS = Object.freeze(['mnemuron-console', 'chatgpt-web']);

export function credentialView(row, now = Date.now()) {
  let scopes = [];
  try { const parsed = JSON.parse(row.scopes_json || '[]'); if (Array.isArray(parsed)) scopes = parsed.map(String); } catch {}
  const state = row.revoked_at ? 'revoked' : row.expires_at && Date.parse(row.expires_at) <= now ? 'expired' : 'active';
  const managed = MANAGED_AGENT_IDS.includes(row.agent_id) || scopes.some(scope => scope.startsWith('admin:'));
  return {...row, scopes, state, managed, console_revocable: state === 'active' && !managed};
}
