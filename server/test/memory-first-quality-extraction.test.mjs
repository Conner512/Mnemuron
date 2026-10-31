import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MnemuronStore} from '../lib/store.mjs';
import {conversationStatements,labeledStatements} from '../lib/memory/rules.mjs';

const user='synthetic-extraction-owner',policy={enabled:true,user_ids:[user],after:'2026-01-01T00:00:00.000Z'};
function source(content){return {user_id:user,event_type:'user_message',content:JSON.stringify(content),captured_at:new Date().toISOString(),received_at:new Date().toISOString()};}
function setup(t){
  const root=mkdtempSync(path.join(os.tmpdir(),'mnemuron-extraction-quality-'));
  const store=new MnemuronStore(path.join(root,'synthetic.sqlite3'),{memoryConfig:{config_version:'mnemuron-memory-first-v1',deployment_mode:'test',development:{synthetic_data:true},
    modules:{memory:{enabled:true},handoff:{enabled:false,existing_inflight_policy:'drain_before_disable'}},memory:{capture_extraction:{enabled:true,conversation:policy}}}});
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const auth=store.authenticate(store.issueCredential({userId:user,deviceId:'synthetic-device',agentId:'synthetic',agentInstanceId:'synthetic-instance',scopes:['capture:write','memory:read']}).api_key);
  return {store,auth,append:(id,content)=>store.appendEvents(auth,{event:{event_id:id,event_type:'user_message',session_id:'synthetic-session',captured_at:new Date().toISOString(),content}})};
}

test('automatic capture preserves complete Chinese versions, decimal quantities and IPs, so different versions never deduplicate to a partial prefix',t=>{
  const f=setup(t),contents=['我的路由器版本是 17.9.8。','我的路由器版本是 17.12.3。','存储设备已经扩容到 1.5 TB。','服务已经部署在 192.0.2.10。'];
  for(const [index,content] of contents.entries())assert.equal(f.append('synthetic-numeric-'+index,content).structured_memories.created,1);
  const rows=f.store.db.prepare('SELECT content,content_fingerprint FROM memories ORDER BY rowid').all();
  assert.deepEqual(rows.map(row=>row.content),contents);assert.equal(new Set(rows.map(row=>row.content_fingerprint)).size,contents.length);
  assert.equal(f.append('synthetic-numeric-0',contents[0]).structured_memories.created,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memories').get().n,contents.length);
  for(const content of contents){const [result]=conversationStatements([source(content)],policy,user);assert.equal(result.content,content);assert.equal(content.slice(result.start,result.end),content);}
});

test('conversation sentence boundaries retain dotted names while preserving exact original source offsets',()=>{
  const content='The version is 17.9.8. I live in a synthetic town.\n服务已经部署在 deploy.synthetic.test。';
  const results=conversationStatements([source(content)],policy,user);
  assert.deepEqual(results.map(result=>result.content),['The version is 17.9.8.','I live in a synthetic town.','服务已经部署在 deploy.synthetic.test。']);
  for(const result of results)assert.equal(content.slice(result.start,result.end),result.content);
});

test('labeled extraction excludes tilde and long backtick fences, including shorter or mismatched markers inside them',t=>{
  const f=setup(t),inside='事实：代码中的合成示例不能变成长期事实。';
  const blocks=['~~~markdown\n'+inside+'\n~~~','````markdown\n```text\n'+inside+'\n```\n````',
    '~~~~text\n~~~\n'+inside+'\n~~~~','~~~text\n```\n'+inside+'\n~~~'];
  for(const [index,block] of blocks.entries()){
    assert.deepEqual(labeledStatements([source(block)]),[]);assert.equal(f.append('synthetic-code-'+index,block).structured_memories.created,0);
    const body='事实：前面的真实合成陈述。\n'+block+'\n事实：后面的真实合成陈述。',found=labeledStatements([source(body)]);
    assert.deepEqual(found.map(result=>result.content),['前面的真实合成陈述。','后面的真实合成陈述。']);
    for(const result of found)assert.equal(body.slice(result.start,result.end),result.content);
  }
  assert.deepEqual(labeledStatements([source('~~~~\n~~~\n'+inside)]),[],'an unclosed outer fence remains excluded');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memories').get().n,0);
});
