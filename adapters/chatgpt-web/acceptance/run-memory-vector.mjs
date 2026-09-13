import {readFileSync,statSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {storageDoctor} from '../../../server/lib/storage-policy.mjs';
import {fail} from '../../../server/lib/model-providers/contracts.mjs';
import {evaluateApplication} from './memory-vector.mjs';

export async function applicationAcceptanceCli(args){
  const options={};for(let n=0;n<args.length;n+=2){const key=args[n];
    if(!['--output','--config','--allow-network'].includes(key) || Object.hasOwn(options,key) || !args[n+1] || args[n+1].startsWith('--'))fail('INVALID_ARGUMENTS');options[key]=args[n+1];}
  if(options['--allow-network']!=='true')fail('NETWORK_NOT_ALLOWED');
  if(!options['--config'] || !options['--output'])fail('INVALID_ARGUMENTS');
  storageDoctor({config_file:options['--config'],evidence_dir:options['--output']});const info=statSync(options['--config']);
  if(!info.isFile() || info.mode & 0o077 || info.size>32768)fail('PRIVATE_CONFIG_REQUIRED');
  const config=JSON.parse(readFileSync(options['--config'],'utf8'));
  return evaluateApplication({output:options['--output'],config,allowNetwork:true,onProgress:row=>console.log(JSON.stringify(row))});
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{const result=await applicationAcceptanceCli(process.argv.slice(2));console.log(JSON.stringify({run:result.run,status:result.status,real_model_calls:0}));process.exitCode=result.status==='passed'?0:1;}
  catch(error){console.error(JSON.stringify({status:'blocked',error_code:/^[A-Z][A-Z0-9_]{1,60}$/.test(error?.code || '')?error.code:'APPLICATION_ACCEPTANCE_PREFLIGHT_FAILED'}));process.exitCode=1;}
}
