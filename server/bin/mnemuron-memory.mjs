#!/usr/bin/env node
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {MnemuronStore} from '../lib/store.mjs';
import {loadMemoryRuntimeFile} from '../lib/memory-runtime.mjs';
import {MemoryWorker,scheduleLibrary} from '../lib/memory-jobs/worker.mjs';
import {createMemoryBackup,verifyMemoryBackup,restoreIsolatedBackup} from '../lib/memory/backup.mjs';
import {readMemoryStatus,requireMemoryDatabase} from '../lib/memory/maintenance.mjs';
import {storageDoctor,SOURCE_ROOT} from '../lib/storage-policy.mjs';
import {fail,ModelError} from '../lib/model-providers/contracts.mjs';
import {Organizer,Embedder} from '../lib/model-providers/providers.mjs';

export async function memoryCommand(args){
  const [command,...flags]=args,options={};
  for(let n=0;n<flags.length;n+=2){const key=flags[n];if(!/^--(config|user|type|generation|destination|backup|memory-id|pin-id|event-id|task-id|project-id|workstream-id|session-id|value|max-jobs|allow-network|offset|after|highwater|limit|profile|job-id)$/.test(key) || options[key]!==undefined || flags[n+1]===undefined || flags[n+1].startsWith('--'))fail('INVALID_ARGUMENTS');options[key]=flags[n+1];}
  if(!options['--config'] || !path.isAbsolute(options['--config']))fail('PRIVATE_CONFIG_REQUIRED');
  const config=loadMemoryRuntimeFile(options['--config']);
  const commands=['status','provider-validate','organize','worker-once','worker-loop','category-set','sensitivity-set','summaries','index-rebuild','index-sync','index-activate','index-reconcile','sources','source-read','pin','unpin','privacy-dry-run','backup','backup-verify','restore-isolated','migration-dry-run','jobs-resume-profile','jobs-cancel'];
  if(!commands.includes(command))fail('INVALID_COMMAND');
  if(command==='migration-dry-run')return {dry_run:true,source_paths:storageDoctor({database:config.storage?.sqlite_path},{sourceRoots:[SOURCE_ROOT]}),destination_paths:options['--destination']?storageDoctor({database:options['--destination']},{sourceRoots:[SOURCE_ROOT]}):null,copied:false,service_started:false};
  if(command==='backup-verify')return verifyMemoryBackup(options['--backup']);
  if(command==='restore-isolated')return restoreIsolatedBackup(options['--backup'],options['--destination']);
  if(command==='provider-validate'){
    if(options['--allow-network']!=='true')return {config_valid:true,network_called:false,real_model_validation:'blocked_requires_explicit_allow_network',synthetic_inputs_only:true};
    const checks=[];
    for(const kind of ['organizer','embedder']){
      const p=config.providers?.[kind];if(!p?.enabled){checks.push({component:kind,status:'not_configured'});continue;}
      try{
        if(kind==='organizer'){
          const result=await new Organizer(p).generateStructured({synthetic:true,instruction:'Return ok true.'},{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false},{sensitivity:'public'});
          if(result.data.ok!==true)fail('PROBE_OUTPUT_MISMATCH');
          checks.push({component:kind,status:'passed',synthetic_input:true,endpoint_called:true,usage:result.usage});
        }else{
          const model=new Embedder(p),document=await model.embed(['Synthetic protocol validation only.'],'document',{sensitivity:'public'});
          const query=await model.embed(['Find the synthetic protocol example.'],'query',{sensitivity:'public'});
          checks.push({component:kind,status:'passed',synthetic_input:true,endpoint_called:true,dimensions:document.dimensions,query_dimensions:query.dimensions,usage:{document:document.usage,query:query.usage}});
        }
      }catch(error){checks.push({component:kind,status:'failed',error_code:error instanceof ModelError?error.code:'PROVIDER_PROBE_FAILED'});}
    }
    return {status:checks.every(c=>c.status==='passed')?'passed':checks.some(c=>c.status==='failed')?'failed':'blocked',checks,synthetic_inputs_only:true,database_opened:false,quality_acceptance:'not_evaluated'};
  }
  const database=config.storage?.sqlite_path;
  if(command==='status')return readMemoryStatus(database,{vectorEnabled:config.vector_store?.enabled===true});
  requireMemoryDatabase(database);
  if(command==='backup'){
    const db=new DatabaseSync(database,{readOnly:true});
    try{return await createMemoryBackup({db},options['--destination']);}finally{db.close();}
  }
  const store=new MnemuronStore(database,{memoryConfig:config,memoryConfigPath:options['--config']});
  // Local file access is the administrative boundary. No public/OAuth token grants these scopes.
  const auth={user_id:options['--user'],scopes:['memory:read','memory:sources:read','memory:retention','memory:organize'],credential_id:null,agent_instance_id:'local-maintenance'};
  try{
    if(command.startsWith('index-')){
      if(!store.vectorIndex)fail('VECTOR_DISABLED');
      if(command==='index-rebuild')return {generation:store.vectorIndex.begin(store.embedder.profile.fingerprint),activated:false};
      const id=options['--generation'];if(!id)fail('GENERATION_REQUIRED');
      if(command==='index-sync')return await store.vectorIndex.sync(id);
      if(command==='index-activate')return store.vectorIndex.activate(id);
      return await store.vectorIndex.reconcile(id);
    }
    if(!auth.user_id)fail('EXPLICIT_OWNER_REQUIRED');
    if(command==='jobs-resume-profile'){if(!options['--profile'])fail('PROFILE_REQUIRED');store.memoryJobs.resumeProfile(options['--profile']);return {resumed:true};}
    if(command==='jobs-cancel'){const job=store.memoryJobs.get(options['--job-id']);if(job?.user_id!==auth.user_id)fail('JOB_NOT_FOUND');store.memoryJobs.cancel(job.job_id);return {cancelled:true};}
    if(command==='privacy-dry-run')return store.memorySources.privacyImpact(auth,[options['--memory-id']]);
    if(command==='pin')return store.memorySources.pin(auth,{event_ids:[options['--event-id']],pin_id:options['--pin-id']});
    if(command==='unpin')return store.memorySources.unpin(auth,options['--pin-id']);
    const pagination=Object.fromEntries(['offset','limit','after','highwater'].filter(k=>options['--'+k]!==undefined).map(k=>[k,Number(options['--'+k])]));
    if(command==='sources')return store.memorySources.manifest(auth,{task_id:options['--task-id'],workstream_id:options['--workstream-id'],session_id:options['--session-id'],...pagination});
    if(command==='source-read')return store.memorySources.content(auth,options['--event-id'],pagination);
    if(command==='sensitivity-set')return store.memorySources.setSensitivity(auth,options['--memory-id'],options['--value']);
    const taxonomy=config.memory?.taxonomy;
    if(command==='category-set')return store.derivedMemory.setCategory(auth,options['--memory-id'],options['--value'],taxonomy);
    if(command==='summaries')return store.memorySummaries(auth,{scope:options['--type'] || 'user',project_id:options['--project-id'],task_id:options['--task-id'],workstream_id:options['--workstream-id'],session_id:options['--session-id'],...pagination});
    if(!config.jobs?.enabled || !store.runtime.memory)fail('WORKER_DISABLED');
    store.derivedMemory.taxonomy(taxonomy);
    const worker=new MemoryWorker(store,store.memoryJobs,store.organizer,{workerId:'local-'+process.pid,userId:auth.user_id});
    const schedule=type=>scheduleLibrary(store,store.memoryJobs,{userId:auth.user_id,organizer:store.organizer,taxonomy,type,periods:config.jobs.periods,timezone:config.jobs.timezone});
    if(command==='organize')return schedule(options['--type'] || 'classification');
    if(command==='worker-once')return await worker.drain({maxJobs:Number(options['--max-jobs'] || 100)});
    let stopping=false;const stop=()=>{stopping=true;};process.once('SIGINT',stop);process.once('SIGTERM',stop);
    try{while(!stopping){schedule('classification');await worker.drain();schedule('summary');await worker.drain();
      if(store.vectorIndex?.state().active)await store.vectorIndex.sync(store.vectorIndex.snapshot().generation);
      await new Promise(resolve=>setTimeout(resolve,config.jobs.poll_ms || 60000));}}
    finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
    return {stopped:true};
  }finally{store.close();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{const result=await memoryCommand(process.argv.slice(2));console.log(JSON.stringify(result,null,2));if(['failed','blocked'].includes(result.status))process.exitCode=1;}
  catch(error){console.error(JSON.stringify({status:'failed',error_code:error.code || error.errorCode || 'MAINTENANCE_FAILED'}));process.exitCode=1;}
}
