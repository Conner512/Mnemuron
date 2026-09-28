import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {loadAuthConfig} from './config.mjs';
import {AuthStore} from './sqlite-adapter.mjs';
import {IdentityRepository} from './identity-repository.mjs';
import {prepareIdentityBindings,applyIdentityBindings,identityMapSnapshot} from './provisioning.mjs';
import {prepareCloudBinding,cloudWorkCurrent,finishCloudBinding,applyCloudBinding} from './cloud-provisioning.mjs';
import {prepareConnectionBinding,connectionWorkCurrent,finishConnectionBinding,applyConnectionBinding} from './connection-provisioning.mjs';
import {revokeCoreIdentity} from './identity-maintenance.mjs';
import {MnemuronStore} from '../../../server/lib/store.mjs';
import {loadMemoryRuntimeFile} from '../../../server/lib/memory-runtime.mjs';
import {CONSOLE_READ_SCOPES,CONSOLE_BASIC_SCOPES,exactScopes} from '../../../shared/console-contract.mjs';
import {readPrivate,writePrivate,requireConfig,CORE_SCOPES,MEMORY_WRITE_CORE_SCOPES,validateCloudPolicy} from '../../../shared/oauth-common.mjs';
import {storageDoctor} from '../../../server/lib/storage-policy.mjs';

const filename=fileURLToPath(import.meta.url);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,200}$/.test(value);
export function validateWorkerConfig(c,{isolated=false,phase}={}){
  requireConfig(c?.config_version==='isolated-identity-worker-v1','isolated worker version');
  requireConfig(Object.keys(c).every(k=>['config_version','auth','core','web','console_access','cloud_memory','connection_management'].includes(k)),'worker fields');
  if(c.connection_management!==undefined)requireConfig(typeof c.connection_management==='boolean','connection worker policy');
  validateCloudPolicy(c);
  requireConfig(c.console_access===undefined||['read_only','basic_memory'].includes(c.console_access),'bounded console access');
  const fields={auth:['config_file','credential_directory'],core:['database_file'],web:['credential_directory','identity_map_file']};
  for(const phase of ['auth','core','web']){
    const p=c[phase];requireConfig(p&&Number.isInteger(p.uid)&&p.uid>=0&&Number.isInteger(p.gid)&&p.gid>=0,'service uid/gid');
    requireConfig(Object.keys(p).every(k=>['uid','gid',...fields[phase],...(phase==='core'?['memory_config_file']:[])].includes(k)),'service fields');
    for(const k of fields[phase])requireConfig(typeof p[k]==='string'&&path.isAbsolute(p[k])&&path.normalize(p[k])===p[k],'fixed private paths');
    if(p.memory_config_file!==undefined)requireConfig(typeof p.memory_config_file==='string'&&path.isAbsolute(p.memory_config_file),'memory configuration path');
  }
  requireConfig(isolated||[c.auth.uid,c.core.uid,c.web.uid].every(v=>v>0)&&new Set([c.auth.uid,c.core.uid,c.web.uid]).size===3,'distinct unprivileged service identities');
  const paths={auth:{worker_auth:c.auth.config_file,worker_console_keys:c.auth.credential_directory},
    core:{worker_core:c.core.database_file,worker_memory_config:c.core.memory_config_file},
    web:{worker_web_keys:c.web.credential_directory,worker_map:c.web.identity_map_file}};
  requireConfig(phase===undefined||Object.hasOwn(paths,phase),'storage phase');
  // The coordinator validates every destination. A dropped-privilege child must
  // not traverse another service's private directory to repeat that check.
  storageDoctor(phase?paths[phase]:Object.assign({},...Object.values(paths)));
  return c;
}
function validWork(work,c){
  const a=work?.account;requireConfig(a&&id(a.account_id)&&id(a.user_id)&&id(a.subject)&&Number.isInteger(a.security_version)&&a.security_version>0&&id(work.operation_id),'account operation');
  if(work.kind==='connection'){
    const b=work.binding;requireConfig(c.connection_management===true&&b&&b.purpose==='connection'&&id(b.credential_id)&&b.user_id===a.user_id&&/^mnm_[A-Za-z0-9_-]{43}$/.test(b.api_key)&&/^[a-f0-9]{64}$/.test(b.connection_id),'fixed connection binding');
    requireConfig(['readonly','memory_readwrite'].includes(b.profile)&&id(b.client_id)&&Number.isSafeInteger(b.connection_version)&&b.connection_version>0&&b.agent_id==='chatgpt-web'&&b.agent_instance_id===`connection-${b.connection_id}`&&b.account_id===a.account_id&&b.security_version===a.security_version,'connection identity');
    requireConfig(exactScopes(b.scopes,b.profile==='memory_readwrite'?MEMORY_WRITE_CORE_SCOPES:CORE_SCOPES)&&typeof b.allow_submitted_revision_grant==='boolean'&&(b.profile!=='memory_readwrite'||c.cloud_memory?.enabled===true)&&(!b.allow_submitted_revision_grant||b.profile==='memory_readwrite'&&c.cloud_memory?.allow_submitted_revision_grant===true),'connection least privilege');
    requireConfig(b.credential_file===path.join(c.web.credential_directory,`${a.account_id}-connection-${b.connection_id}-v${b.connection_version}-s${a.security_version}.key`),'connection fixed destination');return;
  }
  if(work.kind==='cloud'){
    const b=work.binding;requireConfig(c.cloud_memory?.enabled===true&&b&&b.purpose==='cloud'&&id(b.credential_id)&&b.user_id===a.user_id
      &&/^mnm_[A-Za-z0-9_-]{43}$/.test(b.api_key)&&/^[a-f0-9]{64}$/.test(b.connection_id),'fixed cloud binding');
    requireConfig(b.agent_id==='chatgpt-web'&&b.agent_instance_id===`cloud-${a.account_id}`&&b.account_id===a.account_id&&b.security_version===a.security_version
      &&exactScopes(b.scopes,MEMORY_WRITE_CORE_SCOPES)&&typeof b.allow_submitted_revision_grant==='boolean'
      &&(!b.allow_submitted_revision_grant||c.cloud_memory.allow_submitted_revision_grant===true),'bounded cloud authority');
    requireConfig(b.credential_file===path.join(c.web.credential_directory,`${a.account_id}-cloud-${b.connection_id}-v${a.security_version}.key`),'fixed cloud credential destination');return;
  }
  requireConfig(Array.isArray(work.bindings)&&work.bindings.length===2&&new Set(work.bindings.map(b=>b.purpose)).size===2,'two purpose bindings');
  for(const b of work.bindings){
    requireConfig(['web','console'].includes(b.purpose)&&id(b.credential_id)&&b.user_id===a.user_id&&/^mnm_[A-Za-z0-9_-]{43}$/.test(b.api_key),'fixed credential');
    requireConfig(b.agent_id===(b.purpose==='web'?'chatgpt-web':'mnemuron-console')&&b.agent_instance_id===`${b.purpose}-${a.account_id}`,'credential identity');
    const expected=b.purpose==='web'?[CORE_SCOPES]:[CONSOLE_READ_SCOPES,...(c.console_access==='basic_memory'?[CONSOLE_BASIC_SCOPES]:[])];
    requireConfig(expected.some(scopes=>exactScopes(b.scopes,scopes)),'bounded worker scopes');
    const directory=c[b.purpose==='web'?'web':'auth'].credential_directory;
    requireConfig(b.credential_file===path.join(directory,`${a.account_id}-${b.purpose}-v${a.security_version}.key`),'fixed credential destination');
  }
}
function publish(file,value){if(fs.existsSync(file)){requireConfig(readPrivate(file)===value,'credential file collision');}else writePrivate(file,value);}

// Each child is launched under the existing service uid/gid. Secrets travel over
// private pipes only, never argv, logs, a socket or a public HTTP administrative API.
export function workerPhase(phase,input,{isolated=false}={}){
  const c=validateWorkerConfig(input.config,{isolated,phase});requireConfig(['auth','core','web'].includes(phase)&&process.getuid()===c[phase].uid,'phase identity');
  const action=input.action;
  if(input.work)validWork(input.work,c);
  if(phase==='auth'){
    const config=loadAuthConfig(c.auth.config_file,{isolated});
    requireConfig(config.identity_mode==='multi_account_v1'&&config.identity.provisioning?.enabled===true&&config.identity.provisioning.mode==='external_worker','external maintenance enabled');
    requireConfig(config.identity.console_operations!==true,'isolated worker excludes general writes');
    requireConfig(c.console_access!=='basic_memory'||config.identity.console_basic_operations?.memory===true,'matching basic policy');
    const store=new AuthStore(config.database_file,{identity:true}),ids=new IdentityRepository(store,{keyFile:config.identity.encryption_key_file,issuer:config.issuer,batchLimit:config.identity.invitation_batch_limit,sessionTtl:config.identity.console_session_ttl_seconds});
    ids.connections.config=config;
    try{
      if(action==='plan'){
        const revocations=ids.db.prepare("SELECT o.operation_id,a.account_id,a.user_id,a.security_version FROM identity_operations o JOIN identity_accounts a ON a.account_id=o.account_id WHERE o.kind LIKE 'console-disable:%' AND o.state='revocation_pending' AND a.status='disabled' ORDER BY o.created LIMIT 20").all();
        const rows=ids.db.prepare("SELECT o.* FROM identity_operations o JOIN identity_accounts a ON a.account_id=o.account_id WHERE o.kind LIKE 'provision:%' AND o.state NOT IN ('completed','superseded') AND a.recovery_ack=1 ORDER BY o.created LIMIT 20").all();
        const works=rows.map(op=>prepareIdentityBindings(ids,op,{credentialDirectories:{console:c.auth.credential_directory,web:c.web.credential_directory},consoleBasicOperations:c.console_access==='basic_memory'})).filter(Boolean);
        const cloudWorks=c.cloud_memory?.enabled===true&&config.cloud_memory?.enabled===true?ids.db.prepare("SELECT * FROM identity_operations WHERE kind LIKE 'cloud-write:%' AND state NOT IN ('completed','superseded') ORDER BY created LIMIT 20").all()
          .map(op=>prepareCloudBinding(ids,config,op,c.web.credential_directory)).filter(Boolean):[];
        const connectionWorks=c.connection_management&&ids.connections.enabled()?ids.db.prepare("SELECT * FROM identity_operations WHERE kind LIKE 'connection-bind:%' AND state NOT IN ('completed','superseded') ORDER BY created,operation_id LIMIT 20").all().map(op=>prepareConnectionBinding(ids,op,c.web.credential_directory)).filter(Boolean):[];
        const connectionRevocations=ids.db.prepare('SELECT k.credential_id,a.user_id,k.account_id FROM identity_connection_credentials k JOIN identity_accounts a ON a.account_id=k.account_id WHERE k.revoked=1 ORDER BY k.credential_id LIMIT 100').all();
        for(const work of [...works,...cloudWorks,...connectionWorks])validWork(work,c);return {revocations,works,cloudWorks,connectionWorks,connectionRevocations};
      }
      if(action==='ack-revocation'){
        const r=input.revocation;requireConfig(r&&id(r.operation_id)&&id(r.account_id),'revocation operation');
        const a=ids.byId(r.account_id);requireConfig(a?.status==='disabled'&&a.security_version===r.security_version,'current revocation');
        ids.db.prepare("UPDATE identity_operations SET state='completed',last_error=NULL WHERE operation_id=? AND account_id=? AND kind LIKE 'console-disable:%' AND state='revocation_pending'").run(r.operation_id,r.account_id);return {completed:true};
      }
      if(action==='map')return identityMapSnapshot(ids);
      if(action==='connection-current')return {current:connectionWorkCurrent(ids,input.work)};
      if(action==='finish-connection'){finishConnectionBinding(ids,input.work);return {completed:true};}
      if(action==='ack-connection-revocation'){
        const r=input.revocation;requireConfig(r&&id(r.credential_id)&&id(r.account_id),'connection revocation');ids.db.prepare('UPDATE identity_connection_credentials SET revoked=2 WHERE account_id=? AND credential_id=? AND revoked=1').run(r.account_id,r.credential_id);return {completed:true};
      }
      if(action==='cloud-current')return {current:cloudWorkCurrent(ids,config,input.work)};
      if(action==='finish-cloud'){finishCloudBinding(ids,config,input.work);return {completed:true};}
      if(action==='still-current'){
        const a=ids.byId(input.work.account.account_id);
        return {current:!!a&&a.security_version===input.work.account.security_version&&['active','provisioning'].includes(a.status)&&!!a.mfa_verified&&!!a.recovery_ack};
      }
      if(action==='publish-console'||action==='finish'){
        const work=input.work,a=ids.byId(work.account.account_id),op=ids.db.prepare('SELECT * FROM identity_operations WHERE operation_id=? AND account_id=?').get(work.operation_id,work.account.account_id);
        requireConfig(a&&a.security_version===work.account.security_version&&['active','provisioning'].includes(a.status)&&a.mfa_verified&&a.recovery_ack,'current provisionable account');
        requireConfig(op&&op.kind===`provision:${a.security_version}`&&JSON.stringify(ids.unseal(op.payload_cipher,a.account_id,'provision'))===JSON.stringify(work.bindings),'durable prepared identity');
        const b=work.bindings.find(b=>b.purpose==='console');publish(b.credential_file,b.api_key);
        if(action==='finish')ids.finishProvision(a.account_id,work.bindings,work.operation_id);
        return {completed:true};
      }
      throw new Error('UNSUPPORTED_WORKER_ACTION');
    }finally{store.close();}
  }
  if(phase==='core'){
    requireConfig(['apply','apply-cloud','apply-connection','revoke-connection','revoke','discard'].includes(action),'core maintenance action');
    const memoryConfig=c.core.memory_config_file?loadMemoryRuntimeFile(c.core.memory_config_file):undefined;
    requireConfig(fs.existsSync(c.core.database_file),'existing Core database');
    const core=new MnemuronStore(c.core.database_file,{memoryConfig,memoryConfigPath:c.core.memory_config_file});
    try{
      if(action==='apply')applyIdentityBindings(core,input.work.account,input.work.bindings);
      if(action==='apply-cloud'){requireConfig(input.work.kind==='cloud','cloud work');applyCloudBinding(core,input.work);}
      if(action==='apply-connection'){requireConfig(input.work.kind==='connection','connection work');applyConnectionBinding(core,input.work);}
      if(action==='revoke-connection'){const r=input.revocation;requireConfig(r&&id(r.credential_id)&&id(r.user_id),'exact connection credential');core.db.prepare('UPDATE credentials SET revoked_at=COALESCE(revoked_at,?) WHERE credential_id=? AND user_id=?').run(new Date().toISOString(),r.credential_id,r.user_id);}
      if(action==='revoke'){requireConfig(id(input.revocation?.user_id),'revocation owner');revokeCoreIdentity(core,input.revocation.user_id);}
      if(action==='discard')for(const b of ['cloud','connection'].includes(input.work.kind)?[input.work.binding]:input.work.bindings)core.db.prepare('UPDATE credentials SET revoked_at=COALESCE(revoked_at,?) WHERE credential_id=? AND user_id=?').run(new Date().toISOString(),b.credential_id,b.user_id);
      return {completed:true};
    }finally{core.close();}
  }
  if(action==='publish-keys'){
    const b=input.work.bindings.find(b=>b.purpose==='web');publish(b.credential_file,b.api_key);return {completed:true};
  }
  if(action==='publish-cloud'){requireConfig(input.work.kind==='cloud','cloud work');publish(input.work.binding.credential_file,input.work.binding.api_key);return {completed:true};}
  if(action==='publish-connection'){requireConfig(input.work.kind==='connection','connection work');publish(input.work.binding.credential_file,input.work.binding.api_key);return {completed:true};}
  if(action==='publish-map'){
    const map=input.map;requireConfig(map?.schema_version==='multi-account-identity-v1'&&map.unknown_subject_policy==='deny'&&Array.isArray(map.mappings),'derived identity map');
    for(const m of map.mappings){requireConfig(id(m.account_id)&&id(m.subject)&&id(m.mnemuron_user_id),'map identity');requireConfig(typeof m.credential_file==='string'&&path.dirname(m.credential_file)===c.web.credential_directory,'web map credential directory');readPrivate(m.credential_file);
      for(const b of [...(m.cloud_write?[m.cloud_write]:[]),...(m.connections||[])]){requireConfig(path.dirname(b.credential_file)===c.web.credential_directory,'connection credential directory');readPrivate(b.credential_file);}}
    if(!fs.existsSync(c.web.identity_map_file)||JSON.stringify(readPrivate(c.web.identity_map_file,{json:true}))!==JSON.stringify(map))writePrivate(c.web.identity_map_file,map,{replace:fs.existsSync(c.web.identity_map_file)});
    return {completed:true};
  }
  throw new Error('UNSUPPORTED_WORKER_ACTION');
}

export function runIsolatedMaintenance(input,{isolated=false,afterPhase=()=>{}}={}){
  const config=validateWorkerConfig(input,{isolated});requireConfig(isolated||process.getuid()===0,'local privileged coordinator');
  const call=(phase,action,data={})=>{
    const target=config[phase],r=spawnSync(process.execPath,[filename,'--phase',phase,...(isolated?['--isolated-fixture']:[])],{
      uid:target.uid,gid:target.gid,input:JSON.stringify({config,action,...data}),encoding:'utf8',timeout:20000,maxBuffer:2*1024*1024,
      env:{NODE_ENV:'production',NODE_NO_WARNINGS:'1'}});
    // Never include child output: it may contain prepared credentials.
    if(r.status!==0)throw new Error(`IDENTITY_WORKER_${phase.toUpperCase()}_FAILED`);
    const result=JSON.parse(r.stdout);afterPhase(`${phase}.${action}`);return result;
  };
  const plan=call('auth','plan');let revoked=0,completed=0,cloud_completed=0,connection_completed=0;
  for(const revocation of plan.revocations){call('core','revoke',{revocation});call('auth','ack-revocation',{revocation});revoked++;}
  for(const revocation of plan.connectionRevocations){call('core','revoke-connection',{revocation});call('auth','ack-connection-revocation',{revocation});}
  for(const work of plan.works){
    call('core','apply',{work});
    try{call('auth','publish-console',{work});call('web','publish-keys',{work});call('auth','finish',{work});completed++;}
    catch(error){
      // Publication failures remain retryable with the durable credential IDs.
      // Account revocation concurrently makes any unpublished keys unusable.
      if(!call('auth','still-current',{work}).current)call('core','discard',{work});
      throw error;
    }
  }
  for(const work of plan.cloudWorks){
    call('core','apply-cloud',{work});
    try{
      requireConfig(call('auth','cloud-current',{work}).current,'current cloud account');
      call('web','publish-cloud',{work});call('auth','finish-cloud',{work});cloud_completed++;
    }catch(error){if(!call('auth','cloud-current',{work}).current)call('core','discard',{work});throw error;}
  }
  for(const work of plan.connectionWorks){
    call('core','apply-connection',{work});
    try{requireConfig(call('auth','connection-current',{work}).current,'current connection');call('web','publish-connection',{work});call('auth','finish-connection',{work});connection_completed++;}
    catch(error){if(!call('auth','connection-current',{work}).current)call('core','discard',{work});throw error;}
  }
  call('web','publish-map',{map:call('auth','map')});return {completed,revoked,cloud_completed,connection_completed,production_ready:false};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const args=process.argv.slice(2);requireConfig(args[0]==='--phase'&&['auth','core','web'].includes(args[1])&&(args.length===2||args.length===3&&args[2]==='--isolated-fixture'),'private phase arguments');
    let data='';for await(const chunk of process.stdin){data+=chunk;requireConfig(Buffer.byteLength(data)<=2*1024*1024,'bounded private pipe');}
    process.stdout.write(JSON.stringify(workerPhase(args[1],JSON.parse(data),{isolated:args.includes('--isolated-fixture')})));
  }catch{process.stderr.write('IDENTITY_WORKER_PHASE_FAILED\n');process.exitCode=1;}
}
