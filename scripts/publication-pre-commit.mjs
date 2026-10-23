import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {checkPublication} from './check-publication.mjs';
import {checkSecrets} from './check-secrets.mjs';

export function precommitCheck({publication=checkPublication,secrets=checkSecrets} = {}) {
  const findings=publication(['--staged']),scanner=secrets(['--staged']);
  return {status:findings.status==='passed' && scanner.status==='passed'?'passed':'failed',
    publication:{status:findings.status,findings:findings.findings.length,rules:[...new Set(findings.findings.map(f=>f.rule))]},
    scanner,matched_content_logged:false};
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const result=precommitCheck();console.log(JSON.stringify(result,null,2));process.exitCode=result.status==='passed'?0:1;
}
