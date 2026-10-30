import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {evaluateSearchWorkbench} from '../lib/memory-evaluation/search-workbench.mjs';
export async function searchWorkbenchCli(args){
 if(args.length!==2||args[0]!=='--output'||!args[1]||args[1].startsWith('--'))throw new Error('INVALID_ARGUMENTS');
 return evaluateSearchWorkbench({output:args[1]});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{const result=await searchWorkbenchCli(process.argv.slice(2));console.log(JSON.stringify({run:result.run,status:result.status,network_calls:result.network_calls,model_quality:result.model_quality}));process.exitCode=result.status==='passed'?0:1;}
 catch{console.error(JSON.stringify({status:'blocked',error_code:'SEARCH_WORKBENCH_PREFLIGHT_FAILED'}));process.exitCode=1;}
}
