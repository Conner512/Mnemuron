import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync,chmodSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {evaluateSearchWorkbench} from '../lib/memory-evaluation/search-workbench.mjs';
import {searchWorkbenchCli} from '../bin/mnemuron-search-workbench-quality.mjs';
test('search workbench extends frozen quality metrics with reproducible offline graph and feedback gates',async t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'synthetic-search-quality-test-'));chmodSync(root,0o700);t.after(()=>rmSync(root,{recursive:true,force:true}));
 const result=await evaluateSearchWorkbench({output:root});assert.equal(result.status,'passed',JSON.stringify(result));assert.equal(result.network_calls,0);assert.equal(result.model_quality,'not_run');
 assert.equal(result.components.exact.count,8);assert.equal(result.components.exact.top1,1);assert.equal(result.components.exact.scope_leaks,0);assert.equal(result.components.graph.paged_unique_records,13);
 const json=JSON.parse(readFileSync(path.join(result.run,'results.json'),'utf8'));assert.deepEqual(json.hard_gates,result.hard_gates);
 assert.match(readFileSync(path.join(result.run,'results.md'),'utf8'),/Top-1: 1; MRR: 1/);
 const before=readdirSync(root);await assert.rejects(searchWorkbenchCli(['--output',root,'--allow-network','true']));assert.deepEqual(readdirSync(root),before);
});
