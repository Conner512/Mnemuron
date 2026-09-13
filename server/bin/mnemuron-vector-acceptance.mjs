#!/usr/bin/env node
import {readFileSync,statSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {storageDoctor} from '../lib/storage-policy.mjs';
import {evaluateVector} from '../lib/memory-evaluation/vector.mjs';
import {ModelError,fail} from '../lib/model-providers/contracts.mjs';

export async function vectorAcceptanceCli(args){
  const options={};for(let n=0;n<args.length;n+=2){const key=args[n];
    if(!['--output','--config','--allow-network'].includes(key) || Object.hasOwn(options,key) || !args[n+1] || args[n+1].startsWith('--'))fail('INVALID_ARGUMENTS');options[key]=args[n+1];}
  if(options['--allow-network']!=='true')fail('NETWORK_NOT_ALLOWED');
  if(!options['--config'] || !options['--output'])fail('INVALID_ARGUMENTS');
  storageDoctor({config_file:options['--config'],evidence_dir:options['--output']});const info=statSync(options['--config']);
  if(!info.isFile() || info.mode & 0o077 || info.size>32768)fail('PRIVATE_CONFIG_REQUIRED');
  const config=JSON.parse(readFileSync(options['--config'],'utf8'));
  return evaluateVector({output:options['--output'],config,allowNetwork:true,onProgress:row=>console.log(JSON.stringify(row))});
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{const result=await vectorAcceptanceCli(process.argv.slice(2));console.log(JSON.stringify({run:result.run,status:result.status,model_network_calls:0}));process.exitCode=result.status==='passed'?0:result.status==='partial'?2:1;}
  catch(error){console.error(JSON.stringify({status:'blocked',error_code:error instanceof ModelError?error.code:'VECTOR_ACCEPTANCE_PREFLIGHT_FAILED'}));process.exitCode=1;}
}
