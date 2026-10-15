#!/usr/bin/env node
import {mkdtempSync,writeFileSync,statSync,chmodSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import {MnemuronStore} from '../lib/store.mjs';
import {MemoryWorker,scheduleLibrary} from '../lib/memory-jobs/worker.mjs';
import {MemoryJobs} from '../lib/memory-jobs/store.mjs';
import {Organizer} from '../lib/model-providers/providers.mjs';
import {storageDoctor,SOURCE_ROOT} from '../lib/storage-policy.mjs';

const limits={save_p95_ms:100,search_p95_ms:250,worker_ms:180000,peak_rss_bytes:1536*1024*1024,db_total_bytes:2*1024*1024*1024};
const p95=values=>values.toSorted((a,b)=>a-b)[Math.floor((values.length-1)*0.95)] || 0;
export async function benchmark({output,sizes=[10000,100000]}={}){
  storageDoctor({evidence_dir:output},{sourceRoots:[SOURCE_ROOT]});if(!path.isAbsolute(output) || !statSync(output).isDirectory())throw new Error('Private existing output directory required.');
  const run=mkdtempSync(path.join(output,'synthetic-performance-'));chmodSync(run,0o700);
  const specification={synthetic_only:true,started_at:new Date().toISOString(),sizes,thresholds:limits,environment:{node:process.version,platform:process.platform,arch:process.arch,cpus:os.cpus().length,total_memory_bytes:os.totalmem()},
    dataset:'Distinct synthetic engineering statements; every saved memory remains atomic. No network.',worker:'Mock classification; no real model latency or quality claim.'};
  writeFileSync(run+'/preflight.json',JSON.stringify(specification,null,2),{flag:'wx',mode:0o600});
  const results=[];
  for(const size of sizes){
    const database=run+'/'+size+'.sqlite3',s=new MnemuronStore(database),credential=s.issueCredential({label:'Synthetic benchmark',userId:'benchmark-owner',deviceId:'benchmark-device',agentId:'synthetic',agentInstanceId:'synthetic-benchmark',scopes:['memory:read','memory:write']}),auth=s.authenticate(credential.api_key);
    const save=content=>s.saveMemory(auth,{scope:'user',content});let peak=process.memoryUsage().rss;const buildStart=performance.now();
    try{
      for(let base=0;base<size;base+=100){s.memoryTransaction(()=>{for(let n=base;n<Math.min(base+100,size);n++)save(`Synthetic component SN-${String(n).padStart(8,'0')} uses release 1.2.${n%100}; do not enable unsafe mode.`);});peak=Math.max(peak,process.memoryUsage().rss);await new Promise(setImmediate);}
      const buildMs=performance.now()-buildStart,saveTimes=[],searchTimes=[];
      for(let n=0;n<30;n++){let time=performance.now();save('Synthetic acceptance probe '+n);saveTimes.push(performance.now()-time);time=performance.now();s.queryMemories(auth,{query:'SN-'+String(n*97%size).padStart(8,'0'),limit:5});searchTimes.push(performance.now()-time);}
      const model=new Organizer({enabled:true,provider_id:'synthetic-benchmark',protocol:'mock',model:'synthetic-classifier',profile_revision:'fixture-v1',auth:{none:true},
        timeouts:{request_ms:1000},limits:{input_bytes:1000000,input_tokens:1000000,output_bytes:1000000,output_tokens:10000,batch_size:128,concurrency:1,daily_requests:100000},
        retry:{max_attempts:1,base_ms:100,max_ms:1000,repair_once:false},capabilities:{native_schema:true},egress:{approved:true,origins:[],addresses:[],allow_private:false,sensitivities:['sensitive'],query_approved:false}},
        {synthetic:true,mock:async input=>{await new Promise(setImmediate);peak=Math.max(peak,process.memoryUsage().rss);return {results:input.sources.map(source=>({memory_id:source.memory_id,category:'engineering',tags:[]}))};}});
      const jobs=new MemoryJobs(s,{batchSize:128}),start=performance.now(),schedule=scheduleLibrary(s,jobs,{userId:auth.user_id,organizer:model,taxonomy:{version:'synthetic-v1',categories:['uncategorized','engineering']}}),worker=new MemoryWorker(s,jobs,model);
      const loop=monitorEventLoopDelay({resolution:10});loop.enable();const running=worker.drain();const concurrentSearch=[],concurrentSave=[];
      for(let n=0;n<30;n++){await new Promise(setImmediate);let time=performance.now();s.queryMemories(auth,{query:'SN-'+String(n*193%size).padStart(8,'0'),limit:5});concurrentSearch.push(performance.now()-time);time=performance.now();save('Concurrent synthetic acceptance '+n);concurrentSave.push(performance.now()-time);}
      const done=await running;loop.disable();const workerMs=performance.now()-start;
      const bytes=s.db.prepare('PRAGMA page_count').get().page_count*s.db.prepare('PRAGMA page_size').get().page_size;
      const result={size,build_ms:buildMs,save_p95_ms:p95(saveTimes),search_p95_ms:p95(searchTimes),worker_save_p95_ms:p95(concurrentSave),worker_search_p95_ms:p95(concurrentSearch),
        worker_ms:workerMs,worker_jobs:done,worker_snapshot_total:schedule.scanned,annotations:s.db.prepare('SELECT COUNT(*) AS n FROM memory_annotations').get().n,peak_rss_bytes:Math.max(peak,process.memoryUsage().rss),
        db_total_bytes:bytes,fts_index_bytes:s.db.prepare("SELECT COALESCE(SUM(pgsize),0) AS n FROM dbstat WHERE name LIKE 'memory_search_%'").get().n,event_loop_p95_ms:loop.percentile(95)/1e6,
        max_search_result_budget_bytes:128*1024};
      result.passed=result.save_p95_ms<=limits.save_p95_ms && result.worker_save_p95_ms<=limits.save_p95_ms && result.search_p95_ms<=limits.search_p95_ms && result.worker_search_p95_ms<=limits.search_p95_ms && workerMs<=limits.worker_ms && result.peak_rss_bytes<=limits.peak_rss_bytes && bytes<=limits.db_total_bytes && done.every(j=>j.state==='succeeded');
      results.push(result);writeFileSync(run+'/results.json',JSON.stringify({specification,results},null,2),{mode:0o600});console.log(JSON.stringify({synthetic_size:size,passed:result.passed,worker_ms:workerMs}));
    }finally{s.close();}
  }
  return {run,results,passed:results.every(r=>r.passed)};
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const args=process.argv.slice(2);if(args.length!==2 || args[0]!=='--output')throw new Error('Use --output PRIVATE_EXISTING_DIRECTORY');
  const result=await benchmark({output:args[1]});console.log(JSON.stringify({run:result.run,passed:result.passed}));process.exitCode=result.passed?0:1;}
