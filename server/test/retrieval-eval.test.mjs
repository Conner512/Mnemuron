import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {MnemuronStore} from '../lib/store.mjs';

const tool=path.resolve(import.meta.dirname,'../bin/mnemuron-retrieval-eval.mjs');
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const leftovers=()=>fs.readdirSync(os.tmpdir()).filter(n=>n.startsWith('mnemuron-eval-')).sort();

test('retrieval eval: scores a labelled set on a private copy and never writes the source database',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mnemuron-retrieval-eval-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'source.sqlite3'),store=new MnemuronStore(source);
  const auth=store.authenticate(store.issueCredential({userId:'synthetic-owner',deviceId:'d',agentId:'test',agentInstanceId:'i',scopes:['memory:read','memory:write']}).api_key);
  const ids=['Synthetic harbor schedule for the ferry.','Synthetic router firmware upgrade plan.','Synthetic tea preference note.'].map(content=>store.saveMemory(auth,{scope:'user',content}).memory.memory_id);
  store.close();
  const cases=path.join(root,'cases.json');
  fs.writeFileSync(cases,JSON.stringify({user_id:'synthetic-owner',cases:[
    {id:'hit',query:'router firmware',gold:[ids[1].slice(0,8)]},{id:'miss',query:'completely unrelated words',gold:[ids[2]]}]}));
  const before=hash(source),credentials=leftovers();
  const report=JSON.parse(execFileSync(process.execPath,[tool,'--source',source,'--cases',cases,'--modes','lexical','--k','1,5'],{encoding:'utf8'}));
  assert.equal(report.cases,2);assert.equal(report.active_memories,3);
  assert.deepEqual(report.modes.lexical.hit_rate,{'@1':0.5,'@5':0.5});assert.equal(report.modes.lexical.mrr,0.5);
  assert.deepEqual(report.modes.lexical.misses.map(m=>m.id),['miss']);
  assert.equal(hash(source),before,'the source database is unchanged (no credential, no migration)');
  assert.deepEqual(leftovers(),credentials,'the private copy is removed');
  assert.ok(!JSON.stringify(report).includes('router'),'no query or memory text is printed');
  fs.writeFileSync(cases,JSON.stringify({user_id:'synthetic-owner',cases:[{id:'bad',query:'x',gold:['zzzz']}]}));
  assert.throws(()=>execFileSync(process.execPath,[tool,'--source',source,'--cases',cases],{stdio:'pipe'}),/matches 0 active memories/);
  assert.deepEqual(leftovers(),credentials);
});
