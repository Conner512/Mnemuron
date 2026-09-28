import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MnemuronStore} from '../lib/store.mjs';
import {memoryRuntime} from '../lib/memory-runtime.mjs';
import {labeledStatements} from '../lib/memory/rules.mjs';

const cutoff='2026-01-01T00:00:00.000Z';
const config={config_version:'mnemuron-memory-first-v1',modules:{memory:{enabled:true},handoff:{enabled:false,existing_inflight_policy:'drain_before_disable'}},
  memory:{capture_extraction:{enabled:true,conversation:{enabled:true,user_ids:['synthetic-owner'],after:cutoff}}}};
function fixture(t,cfg=config){const root=mkdtempSync(path.join(os.tmpdir(),'mnemuron-conversation-'));
  const store=new MnemuronStore(root+'/test.sqlite3',{memoryConfig:cfg});t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const authFor=id=>store.authenticate(store.issueCredential({userId:id,deviceId:id,agentId:'test',agentInstanceId:id,scopes:['capture:write','memory:read']}).api_key);
  return {store,auth:authFor('synthetic-owner'),other:authFor('other-owner')};}
const append=(f,id,content,extra={},auth=f.auth)=>f.store.appendEvents(auth,{event:{event_id:id,event_type:'user_message',session_id:'synthetic-session',captured_at:new Date().toISOString(),content,...extra}});
test('Markdown labels preserve exact source spans rather than dropping ordinary formatting',()=>{
  for(const body of ['**事实**：合成船抵达模拟码头。','- **事实：** 合成船抵达模拟码头。','事实：合成船抵达模拟码头。']){
    const [c]=labeledStatements([{event_type:'user_message',content:JSON.stringify(body)}]);assert.ok(c);assert.equal(c.content,'合成船抵达模拟码头。');
    assert.equal(body.slice(c.start,c.end),c.content);
  }
});
test('new direct user statements create versioned, deduplicated source-bound memory without models or handoff',t=>{
  const f=fixture(t),content='合成测试船今天下午抵达模拟码头。';
  assert.equal(append(f,'first',content).structured_memories.created,1);
  assert.equal(append(f,'first',content).structured_memories.created,0);
  assert.equal(append(f,'second',content).structured_memories.created,0);
  const row=f.store.db.prepare('SELECT * FROM memories').get();assert.equal(row.content,content);assert.equal(row.user_id,f.auth.user_id);
  assert.equal(row.generation_method,'conservative-user-statements-v1');assert.equal(row.confidence_label,'medium');
  const detail=f.store.memoryDetail(f.auth,row.memory_id);assert.equal(detail.source_manifest.evidence_kind,'observed_user_statement');
  assert.equal(detail.source_manifest.sources.length,2);assert.equal(detail.source_manifest.sources[0].extraction_version,'conservative-user-statements-v1');
  assert.equal(detail.source_manifest.sources[0].span_available,true);
  assert.throws(()=>f.store.memoryDetail(f.other,row.memory_id),e=>e.errorCode==='MEMORY_NOT_FOUND');
  const web=f.store.authenticate(f.store.issueCredential({userId:f.auth.user_id,deviceId:'synthetic-web',agentId:'chatgpt-web',agentInstanceId:'synthetic-web',scopes:['memory:read']}).api_key);
  assert.throws(()=>f.store.memoryDetail(web,row.memory_id),e=>e.errorCode==='MEMORY_NOT_FOUND');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM resumes').get().n,0);
  assert.equal(f.store.status(f.auth).production_ready,false);
});
test('activation is owner-scoped, forward-only, opt-in, and never promotes assistant suggestions',t=>{
  const f=fixture(t),body='合成测试船今天下午抵达模拟码头。';
  for(const [id,extra,auth] of [['old',{captured_at:'2025-12-31T23:59:00.000Z'},f.auth],['other',{},f.other],
    ['assistant',{event_type:'assistant_message'},f.auth],['tool',{event_type:'tool_result'},f.auth]])assert.equal(append(f,id,body,extra,auth).structured_memories.created,0);
  assert.equal(f.store.memoryService.derive(f.auth,[{event_type:'user_message',content:JSON.stringify(body),captured_at:new Date().toISOString()}],{checkpoint_id:'historical'}).created,0);
  const disabled=fixture(t,{...config,memory:{capture_extraction:{enabled:true}}});assert.equal(append(disabled,'disabled',body).structured_memories.created,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memories').get().n,0);
});
test('questions, requests, confirmations, quoted/code content and credential-like text are not facts',t=>{
  const f=fixture(t);
  const rejected=['同意授权，帮我修复','继续','好了','合成船今天抵达模拟码头了吗？','请把合成船抵达模拟码头写成测试',
    '> 合成测试船今天下午抵达模拟码头。','```\n合成测试船今天下午抵达模拟码头。\n```','"合成测试船今天下午抵达模拟码头。"',
    '我的 API key 是 synthetic-not-a-real-key','测试船已经抵达，token=synthetic-token','请检查问题；合成测试船今天下午抵达模拟码头。',
    '合成船可能今天下午抵达模拟码头。','假设合成船已经抵达模拟码头。'];
  for(const [i,body] of rejected.entries())assert.equal(append(f,`reject-${i}`,body).structured_memories.created,0,body);
});
test('invalid conversation activation fails closed',()=>{
  for(const conversation of [{enabled:true},{enabled:true,user_ids:[],after:cutoff},{enabled:true,user_ids:['x'],after:'yesterday'},
    {enabled:'yes',user_ids:['x'],after:cutoff},{enabled:true,user_ids:['x'],after:cutoff,max_chars:100000}]){
    assert.throws(()=>memoryRuntime({...config,memory:{capture_extraction:{enabled:true,conversation}}}),e=>e.errorCode==='INVALID_MEMORY_CONFIG');
  }
});
