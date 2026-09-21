#!/usr/bin/env node
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {AuthStore} from '../src/sqlite-adapter.mjs';
import {IdentityRepository} from '../src/identity-repository.mjs';
import {provisionIdentities} from '../src/provisioning.mjs';
import {loadAuthConfig} from '../src/config.mjs';
import {acquireAuthorizationLease} from '../src/process-lease.mjs';
import {MnemuronStore} from '../../../server/lib/store.mjs';
import {storageDoctor,realDestination} from '../../../server/lib/storage-policy.mjs';
import {readPrivate,writePrivate,requireConfig,BoundaryError} from '../../../shared/oauth-common.mjs';

export async function main(argv) {
  if(!argv.length||argv.includes('--help')) {
    console.log(`Local account operator; no public admin route, no secrets in arguments.
node services/oauth/bin/identity.mjs COMMAND --config /private/auth.json [options]
invite-issue --count INTEGER --ttl-minutes INTEGER --issuer LABEL --output /private/new-file
invite-list
invite-revoke --batch-id ID --confirm
migrate-owner --legacy-file /private/owner.json --mapping-file /private/map.json --confirm
provision --core-database /private/core.sqlite3 --credential-directory /private/keys --identity-map /private/map.json --confirm
recovery-inspect --account-id ID
recovery-reset --account-id ID --confirm  (blocked until a recovery proof policy is approved)
status
Requires identity_mode=multi_account_v1. No production defaults for batch/session policy.
Stop legacy processes before migrate-owner. provision is a retryable local worker.
Recovery proof policy is pending; no weaker operator reset is enabled.`);return;
  }
  const [command,...rest]=argv,args=new Map();
  requireConfig(['invite-issue','invite-list','invite-revoke','migrate-owner','provision','status','recovery-inspect','recovery-reset'].includes(command),'known identity command');
  for(let i=0;i<rest.length;i++) {
    const name=rest[i];requireConfig(name.startsWith('--')&&!args.has(name),'unique CLI option');
    args.set(name,['--confirm','--isolated-fixture'].includes(name)?true:rest[++i]);
  }
  const options={
    'invite-issue':['--count','--ttl-minutes','--issuer','--output'],
    'invite-list':[],'invite-revoke':['--batch-id','--confirm'],
    'migrate-owner':['--legacy-file','--mapping-file','--confirm'],
    provision:['--core-database','--credential-directory','--identity-map','--confirm'],
    status:[],'recovery-inspect':['--account-id'],'recovery-reset':['--account-id','--confirm']
  }[command];
  requireConfig([...args].every(([key,value])=>['--config','--isolated-fixture',...options].includes(key)
    &&(value===true||typeof value==='string'&&!value.startsWith('--'))),'known complete command options');
  const config=loadAuthConfig(args.get('--config'),{isolated:args.has('--isolated-fixture')});
  requireConfig(config.identity_mode==='multi_account_v1','explicit multi-account mode');
  storageDoctor({database:config.database_file,key:config.identity.encryption_key_file});
  const release=command==='migrate-owner'?acquireAuthorizationLease(config.database_file):()=>{};
  let store;
  try {
    store=new AuthStore(config.database_file,{identity:true});
    const ids=new IdentityRepository(store,{issuer:config.issuer,keyFile:config.identity.encryption_key_file,batchLimit:config.identity.invitation_batch_limit,sessionTtl:config.identity.console_session_ttl_seconds});
    let result;
    if(command==='invite-issue') {
      const supplied=args.get('--output');requireConfig(typeof supplied==='string','private output required');
      const output=realDestination(supplied);storageDoctor({invitation_output:output});requireConfig(!fs.existsSync(output),'exclusive new output');
      const integer=name=>{const value=args.get(name);requireConfig(typeof value==='string'&&/^[1-9][0-9]*$/.test(value),'integer CLI parameter');return Number(value);};
      result=ids.issueInvitations({count:integer('--count'),ttlMinutes:integer('--ttl-minutes'),issuer:args.get('--issuer')});
      try{writePrivate(output,result);}catch(error){ids.revokeBatch(result.batch_id);throw error;}
      result={batch_id:result.batch_id,count:result.codes.length,expires:result.expires,plaintext:'written_once_to_private_file'};
    } else if(command==='invite-list')result=ids.listInvitations();
    else if(command==='invite-revoke'){requireConfig(args.has('--confirm'),'explicit confirmation');result={revoked:ids.revokeBatch(args.get('--batch-id'))};}
    else if(command==='migrate-owner') {
      requireConfig(args.has('--confirm'),'explicit confirmation');
      const map=readPrivate(args.get('--mapping-file'),{json:true});requireConfig(map.mappings?.length===1,'exact legacy binding');
      result=ids.importLegacy(readPrivate(args.get('--legacy-file'),{json:true}),map.mappings[0]);
    } else if(command==='provision') {
      requireConfig(args.has('--confirm'),'explicit confirmation');
      const file=args.get('--core-database');requireConfig(fs.existsSync(file),'existing Core database');
      const core=new MnemuronStore(file);
      try{result=provisionIdentities(ids,core,{credentialDirectory:args.get('--credential-directory'),identityMapFile:args.get('--identity-map')});}finally{core.close();}
    } else if(command==='recovery-inspect'||command==='recovery-reset') {
      const target=ids.byId(args.get('--account-id'));requireConfig(!!target,'exact recovery account required');
      if(command==='recovery-reset') {
        requireConfig(args.has('--confirm'),'explicit recovery intent');
        ids.audit(target.account_id,'recovery.operator_request','blocked_policy');throw new BoundaryError(403,'BLOCKED_POLICY');
      }
      result={account_id:target.account_id,status:target.status,security_version:target.security_version,mfa_verified:!!target.mfa_verified,policy:'blocked_policy',
        operations:store.db.prepare("SELECT operation_id,state,last_error FROM identity_operations WHERE account_id=? AND kind LIKE 'recovery:%'").all(target.account_id)};
    } else if(command==='status') result={accounts:store.db.prepare('SELECT status,COUNT(*) count FROM identity_accounts GROUP BY status').all(),production_ready:false};
    else throw new Error('Unknown local identity command');
    console.log(JSON.stringify(result));
  } finally {store?.close();release();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(()=>{console.error('Identity operation refused or incomplete. Reconcile the durable operation; no secrets are printed.');process.exitCode=1;});
