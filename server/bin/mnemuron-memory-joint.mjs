#!/usr/bin/env node
import {readFileSync,statSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {storageDoctor} from '../lib/storage-policy.mjs';
import {ModelError,fail} from '../lib/model-providers/contracts.mjs';
import {evaluateJoint} from '../lib/memory-evaluation/joint.mjs';

export async function jointCli(args){
  const options={};for(let n=0;n<args.length;n+=2){const key=args[n];
    if(!['--config','--output','--allow-network'].includes(key) || Object.hasOwn(options,key) || !args[n+1] || args[n+1].startsWith('--'))fail('INVALID_ARGUMENTS');options[key]=args[n+1];}
  if(options['--allow-network']!=='true')fail('NETWORK_NOT_ALLOWED');
  if(!options['--config'] || !options['--output'])fail('INVALID_ARGUMENTS');
  storageDoctor({config_file:options['--config'],evidence_dir:options['--output']});const info=statSync(options['--config']);
  if(!info.isFile() || info.mode & 0o077 || info.size>65536)fail('PRIVATE_CONFIG_REQUIRED');
  const config=JSON.parse(readFileSync(options['--config'],'utf8'));
  return evaluateJoint({output:options['--output'],config,allowNetwork:true,onProgress:item=>console.log(JSON.stringify(item))});
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{const result=await jointCli(process.argv.slice(2));console.log(JSON.stringify({run:result.run,status:result.status,qualification:result.qualification,calls:result.calls}));process.exitCode=result.status==='passed'?0:1;}
  catch(error){console.error(JSON.stringify({status:'blocked',error_code:error instanceof ModelError?error.code:'JOINT_PREFLIGHT_FAILED'}));process.exitCode=1;}
}
