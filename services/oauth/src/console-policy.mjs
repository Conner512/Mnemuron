import {CLOUD_ACTIONS,connectionPolicy} from '../../../shared/cloud-contract.mjs';
import {CONSOLE_ACTIONS} from '../../../shared/console-contract.mjs';
const basicActions={
  memory:['memory.create','memory.correct','memory.retract','memory.classify','memory.sensitivity','memory.visibility'],
  security:['security.password','security.totp.begin','security.totp.complete','security.session.revoke','security.sessions.revoke_others'],
  oauth:['oauth.revoke'],
};
const identityActions=[...basicActions.security,...basicActions.oauth,'security.recovery_codes','invitations.issue','invitations.revoke','invitations.revoke_batch','accounts.enable','accounts.disable','accounts.role'];
// An explicit management policy overrides the older all-operations switch.
// Roles stay independently gated; browser policy never grants operator status.
export function consoleManagement(config) {
  const configured=config.identity.console_management;
  const legacy=config.identity.console_operations===true;
  return Object.fromEntries(['invitations','accounts','roles'].map(key=>
    [key,configured===undefined?legacy:configured[key]===true]));
}

export function consoleActionAllowed(config,action) {
  if(CLOUD_ACTIONS.includes(action))return connectionPolicy(config).enabled===true;
  const management=consoleManagement(config);
  if(action==='accounts.role')return management.accounts&&management.roles;
  if(action.startsWith('accounts.'))return management.accounts&&['accounts.enable','accounts.disable'].includes(action);
  if(action.startsWith('invitations.'))return management.invitations&&['invitations.issue','invitations.revoke','invitations.revoke_batch'].includes(action);
  const basic=config.identity.console_basic_operations;
  const group=Object.keys(basicActions).find(key=>basicActions[key].includes(action));
  if(group&&basic!==undefined)return basic[group]===true;
  return config.identity.console_operations===true&&[...CONSOLE_ACTIONS,...identityActions,'storage.export'].includes(action);
}

export function consoleAllowedActions(config,core,operator){
  return [...CONSOLE_ACTIONS,...identityActions,...CLOUD_ACTIONS,'storage.export'].filter(action=>{
    if(!consoleActionAllowed(config,action))return false;
    if(CLOUD_ACTIONS.includes(action))return true;
    if(/^(invitations|accounts)\./.test(action))return operator;
    if(/^(security|oauth)\./.test(action))return true;
    return core.writable===true&&(action==='storage.export'||core.actions?.includes(action));
  });
}
