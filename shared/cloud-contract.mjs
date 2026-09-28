// An opt-in remote memory surface, not a console/admin or local lifecycle capability.
export const CLOUD_WRITE_SCOPE = 'memory:write';
export const CLOUD_CORE_SCOPES = Object.freeze(['memory:read','resume:read','memory:write']);
export const CLOUD_ACTIONS = Object.freeze(['cloud_connections.create','cloud_connections.rotate','cloud_connections.revoke']);
export function connectionScopes(permission, oauth = false) {
  return [...(oauth ? ['openid','offline_access'] : []),'memory:read','project:read',...(permission === 'readwrite' ? [CLOUD_WRITE_SCOPE] : [])];
}
export function connectionPolicy(config) {
  return config.cloud_connections || {enabled:false,allow_write:false,max_active:20,max_ttl_days:90};
}
export function validateConnectionPolicy(config, requireConfig) {
  const input=config.cloud_connections;
  if(input===undefined)return;
  requireConfig(input && typeof input==='object' && !Array.isArray(input),'cloud connections policy');
  requireConfig(Object.keys(input).every(k=>['enabled','allow_write','max_active','max_ttl_days'].includes(k)),'cloud connections fields');
  requireConfig(typeof input.enabled==='boolean' && typeof input.allow_write==='boolean','cloud connections explicit switches');
  requireConfig(!input.allow_write || input.enabled,'cloud writes require connections');
  requireConfig(!input.enabled || config.identity_mode==='multi_account_v1','cloud connections require isolated accounts');
  input.max_active??=20;input.max_ttl_days??=90;
  requireConfig(Number.isSafeInteger(input.max_active)&&input.max_active>=1&&input.max_active<=100,'connection quota');
  requireConfig(Number.isSafeInteger(input.max_ttl_days)&&input.max_ttl_days>=1&&input.max_ttl_days<=365,'connection lifetime');
}
