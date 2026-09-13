#!/usr/bin/env node
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadMemoryRuntimeFile} from '../lib/memory-runtime.mjs';
import {ModelError} from '../lib/model-providers/contracts.mjs';
import {evaluateQuality} from '../lib/memory-evaluation/quality.mjs';

export async function qualityCli(args) {
  const options={};
  for(let n=0;n<args.length;n+=2){
    const key=args[n];if(!['--output','--config','--allow-network','--edition','--with-vector'].includes(key) || Object.hasOwn(options,key) || !args[n+1] || args[n+1].startsWith('--'))throw new Error('INVALID_ARGUMENTS');
    options[key]=args[n+1];
  }
  if(!options['--output'] || options['--allow-network']!==undefined && !['true','false'].includes(options['--allow-network']) ||
    options['--edition']!==undefined && !['v1','v2','v3'].includes(options['--edition']) || options['--with-vector']!==undefined && !['true','false'].includes(options['--with-vector']))throw new Error('INVALID_ARGUMENTS');
  const allowNetwork=options['--allow-network']==='true';
  const edition=options['--edition'] || 'v1',withVector=options['--with-vector']==='true';
  if(withVector && (!allowNetwork || edition==='v1' || !options['--config']))throw new Error('INVALID_ARGUMENTS');
  // Offline checks do not even read the provider config or its credential references.
  const config=allowNetwork && options['--config']?loadMemoryRuntimeFile(options['--config']):null;
  return evaluateQuality({output:options['--output'],config,allowNetwork,edition,vectorConfig:withVector?config.vector_store:null,onProgress:item=>console.log(JSON.stringify(item))});
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{const result=await qualityCli(process.argv.slice(2));console.log(JSON.stringify({run:result.run,status:result.status,hard_correctness:result.hard_correctness,model_quality:result.model_quality,calls:result.calls}));process.exitCode=result.status==='passed'?0:result.status==='partial'?2:1;}
  catch(error){console.error(JSON.stringify({status:'blocked',error_code:error instanceof ModelError?error.code:'QUALITY_PREFLIGHT_FAILED'}));process.exitCode=1;}
}
