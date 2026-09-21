#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {AuthStore} from '../src/sqlite-adapter.mjs';
import {IdentityRepository} from '../src/identity-repository.mjs';
import {IdentityMaintenance} from '../src/identity-maintenance.mjs';
import {RecoveryService} from '../src/recovery.mjs';
import {loadAuthConfig} from '../src/config.mjs';
import {MnemuronStore} from '../../../server/lib/store.mjs';
import {CONSOLE_READ_SCOPES,CONSOLE_WRITE_SCOPES,exactScopes} from '../../../shared/console-contract.mjs';
import {storageDoctor} from '../../../server/lib/storage-policy.mjs';
import {readPrivate,writePrivate,randomSecret,requireConfig} from '../../../shared/oauth-common.mjs';
export async function main(argv){
  if(!argv.length||argv.includes('--help')){console.log(`Mnemuron local console operator (no secrets in arguments).
core-key --output /private/new-console-key --confirm
enable-console --config /private/auth.json --core-database /private/core.sqlite3 --account-id ID --confirm
grant-operator | revoke-operator --config /private/auth.json --account-id ID --confirm
provision-once --config /private/auth.json --confirm
recovery-begin --config /private/auth.json --proof-file /private/proofs.json --output /private/new-session.json --confirm
recovery-complete --config /private/auth.json --session-file /private/session.json --proof-file /private/new-factor.json --confirm
The recovery commands enforce the same explicit proof policy as web recovery.
No command downloads memories, enables MCP writes, or restores shared databases.`);return;}
  const [command,...rest]=argv,args=new Map();
  for(let i=0;i<rest.length;i++){const k=rest[i];requireConfig(/^--[a-z-]+$/.test(k)&&!args.has(k),'unique CLI flag');args.set(k,['--confirm','--isolated-fixture'].includes(k)?true:rest[++i]);}
  const allowed={
    'core-key':['--output'], 'enable-console':['--config','--core-database','--account-id'],
    'grant-operator':['--config','--account-id'],'revoke-operator':['--config','--account-id'],'provision-once':['--config'],
    'recovery-begin':['--config','--proof-file','--output'],'recovery-complete':['--config','--session-file','--proof-file']
  }[command];requireConfig(!!allowed&&args.has('--confirm'),'explicit command confirmation');
  requireConfig([...args].every(([k,v])=>[...allowed,'--confirm','--isolated-fixture'].includes(k)&&(v===true||typeof v==='string'&&!v.startsWith('--')))&&allowed.every(k=>args.has(k)),'complete command arguments');
  if(command==='core-key'){const output=args.get('--output');storageDoctor({console_key:output});writePrivate(output,randomSecret());console.log(JSON.stringify({status:'created',secret:'written_to_private_file'}));return;}
  const config=loadAuthConfig(args.get('--config'),{isolated:args.has('--isolated-fixture')});requireConfig(config.identity_mode==='multi_account_v1','multi-account mode');
  storageDoctor({auth_database:config.database_file,identity_key:config.identity.encryption_key_file});
  const store=new AuthStore(config.database_file,{identity:true}),ids=new IdentityRepository(store,{keyFile:config.identity.encryption_key_file,issuer:config.issuer,batchLimit:config.identity.invitation_batch_limit,sessionTtl:config.identity.console_session_ttl_seconds});
  try{let result;
    if(command==='enable-console'){
      const a=ids.byId(args.get('--account-id'));requireConfig(a&&ids.eligible(a.subject),'active exact account');
      const file=args.get('--core-database');storageDoctor({core_database:file});requireConfig(fs.existsSync(file),'existing Core database');
      const core=new MnemuronStore(file);try{
        const binding=ids.bindings(a.subject).find(b=>b.purpose==='console'),auth=core.authenticate(readPrivate(binding.credential_file));
        requireConfig(auth.user_id===a.user_id&&auth.credential_id===binding.credential_id&&auth.agent_id==='mnemuron-console'&&auth.agent_instance_id===binding.agent_instance_id,'exact Core binding');
        requireConfig(exactScopes(auth.scopes,CONSOLE_READ_SCOPES)||exactScopes(auth.scopes,CONSOLE_WRITE_SCOPES),'expected Core scopes');
        core.memoryTransaction(()=>{core.db.prepare('UPDATE credentials SET scopes_json=? WHERE user_id=? AND credential_id=? AND revoked_at IS NULL').run(JSON.stringify(CONSOLE_WRITE_SCOPES),a.user_id,binding.credential_id);core.audit({auth,action:'console.capability.enable',targetType:'credential',targetId:binding.credential_id});});
        result={status:'enabled',account_id:a.account_id,chatgpt_scopes_unchanged:true};
      }finally{core.close();}
    }else if(command==='grant-operator'||command==='revoke-operator'){
      const account=args.get('--account-id'),a=ids.byId(account);requireConfig(a&&ids.eligible(a.subject),'active exact account');
      ids.store.transaction(()=>{ids.console.role(account,command==='grant-operator');ids.audit(account,`operator.${command}`);});result={status:'updated',account_id:account,operator:ids.console.operator(account)};
    }else{
      const maintenance=new IdentityMaintenance(ids,config);
      if(command==='provision-once'){requireConfig(maintenance.enabled(),'configured local maintenance');result=await maintenance.run();}
      else {
        requireConfig(maintenance.enabled(),'configured local maintenance');const recovery=new RecoveryService(ids,{policy:config.identity.recovery_policy});
        storageDoctor({proof:args.get('--proof-file'),session:args.get('--session-file'),output:args.get('--output')});
        const proof=readPrivate(args.get('--proof-file'),{json:true});
        if(command==='recovery-begin'){
          requireConfig(!fs.existsSync(args.get('--output')),'exclusive recovery output');const session=await recovery.begin(proof);
          writePrivate(args.get('--output'),{...session,...(session.action==='totp'?{enrollment:recovery.enrollment(session.token)}:{})});
          result={status:'proof_verified',session:'written_to_private_file',restricted:true};
        }else{
          const session=readPrivate(args.get('--session-file'),{json:true});result=await recovery.complete(session.token,proof,{revokeCore:p=>maintenance.revoke(p)});await maintenance.run();
        }
      }
    }
    console.log(JSON.stringify(result));
  }finally{store.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main(process.argv.slice(2)).catch(error=>{console.error(JSON.stringify({status:'failed',error_code:error.code||error.errorCode||'OPERATOR_COMMAND_FAILED'}));process.exitCode=1;});
