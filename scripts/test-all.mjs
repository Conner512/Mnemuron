import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function runSuites(suites, {run=spawnSync,env=process.env,cwd=path.resolve(import.meta.dirname,'..')} = {}) {
  const isolated={...env};
  for (const key of Object.keys(isolated)) if (/^(MNEMURON_|CODEX_THREAD_ID$|NODE_OPTIONS$)|proxy/i.test(key)) delete isolated[key];
  const results=[];
  for (const suite of suites) {
    const result=run(suite.command,suite.args,{cwd,env:isolated,encoding:'utf8',timeout:180000,maxBuffer:32*1024*1024});
    const output=(result.stdout || '')+(result.stderr || '');
    const count=label=>Number(output.match(new RegExp(`(?:#|ℹ) ${label} (\\d+)`))?.[1] || 0);
    const pythonTests=Number(output.match(/Ran (\d+) tests?/)?.[1] || 0);
    const pythonCount=label=>Number(output.match(new RegExp(`\\b${label}=(\\d+)`))?.[1] || 0);
    const skipped=count('skipped') || pythonCount('skipped');
    const failed=count('fail') || pythonCount('failures')+pythonCount('errors');
    results.push({suite:suite.name,exit_code:result.status,signal:result.signal,error_code:result.error?.code || null,
      tests:count('tests') || pythonTests,passed:count('pass') || (pythonTests && result.status===0 ? pythonTests-skipped : 0),
      failed,skipped,cancelled:count('cancelled'),
      status:result.status===0?'passed':result.error?'blocked':'failed'});
    if (result.status!==0) process.stderr.write(output);
  }
  return {status:results.every(r=>r.status==='passed')?'passed':'failed',results};
}
export function repositorySuites(root=path.resolve(import.meta.dirname,'..')) {
  const files=(directory,filter=()=>true)=>readdirSync(path.join(root,directory)).filter(name=>name.endsWith('.test.mjs') && filter(name)).map(name=>path.join(directory,name));
  const node=(name,entries)=>({name,command:process.execPath,args:['--test','--test-reporter=tap','--test-timeout=30000',...entries]});
  return [node('core',files('server/test',name=>!name.startsWith('memory-first-'))),node('plugin',files('plugins/mnemuron/test')),
    node('openclaw',files('adapters/openclaw/test')),{name:'hermes',command:'python3',args:['-m','unittest','discover','-s','adapters/hermes/test','-p','test_*.py']},
    node('oauth',[...files('services/oauth/test'),...files('adapters/chatgpt-web/test')]),
    node('memory-unit',files('server/test',name=>/^memory-first-(storage|privacy|config)/.test(name))),
    node('memory-integration',files('server/test',name=>/^memory-first-(integration|regressions|compatibility|quality)/.test(name))),
    node('memory-model-contract',files('server/test',name=>/^memory-first-(model|probe)/.test(name))),
    node('memory-worker',files('server/test',name=>/^memory-first-jobs/.test(name))),
    node('memory-vector',files('server/test',name=>/^memory-first-vector/.test(name))),
    node('memory-schema',files('server/test',name=>/^memory-first-schema/.test(name)))];
}
if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const args=process.argv.slice(2),all=repositorySuites();
  if (args.length && (args.length!==2 || args[0]!=='--suite' || !all.some(s=>s.name===args[1]))) throw new Error('Unknown test suite.');
  const result=runSuites(args.length?all.filter(s=>s.name===args[1]):all);
  console.log(JSON.stringify(result,null,2));process.exitCode=result.status==='passed'?0:1;
}
