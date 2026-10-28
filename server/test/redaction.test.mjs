import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {redactText,redactValue,redactFields} from '../lib/redaction.mjs';
import {MnemuronStore} from '../lib/store.mjs';
import {memoryFixture} from './helpers/core-memory-fixture.mjs';

// Synthetic credentials are assembled at runtime so no credential-shaped literal is committed.
const fake={
  openai:'sk-'+'proj-'+'Q7'.repeat(14),
  anthropic:'sk-'+'ant-'+'api03-'+'Zx'.repeat(14),
  github:'gh'+'p_'+'Ab3'.repeat(12),
  aws:'AK'+'IA'+'Q2W3E4R5T6Y7U8I9',
  slack:'xo'+'xb-'+'1234-5678-'+'abcDEF'.repeat(3),
  jwt:'ey'+'J'+'hbGciOiJIUzI1'+'.ey'+'J'+'zdWIiOiIxMjM0'+'.'+'c2lnbmF0dXJlLXZhbHVl',
  password:'Hunter'+'2-'+'synthetic9',
};
const all=Object.values(fake);
const noSecret=(text,label)=>{for(const value of all)assert.ok(!String(text).includes(value),`${label} leaked ${value.slice(0,6)}…`);};

test('redaction: credential formats, private spans and named assignments are replaced; prose, IDs and placeholders are not',()=>{
  const cases=[
    [`OpenAI key 是 ${fake.openai}，记住`,'openai_key'],[`key ${fake.anthropic}`,'anthropic_key'],[`GITHUB_TOKEN=${fake.github}`,'github_token'],
    [`aws ${fake.aws} region`,'aws_access_key'],[`slack ${fake.slack}`,'slack_token'],[`cookie ${fake.jwt}`,'jwt'],
    [`Authorization: Bearer ${'abcDEF123'.repeat(3)}`,'bearer'],[`postgres://admin:${fake.password}@db:5432/app`,'url_password'],
    [`DB_PASSWORD="${fake.password}"`,'assignment'],['银行卡 <private>6222 0000 1111</private> 不要记','private'],
    [['BEGIN','END'].map(edge=>`-----${edge} OPENSSH PRIVATE`+' KEY-----').join('\nAAAA\n'),'private_key'],
  ];
  for(const [input,kind] of cases){const r=redactText(input);assert.ok(r.count>=1,input);assert.ok(r.kinds.includes(kind),`${input} → ${r.kinds}`);noSecret(r.text,input);assert.match(r.text,/\[REDACTED:/);}
  for(const input of ['max_tokens=4096 TOKEN_LIMIT=100000000','tokenizer_path=/usr/lib/model','password: 在控制台里设置','DB_PASSWORD=${DB_PASSWORD}',
    'api_key=<your-api-key>','task-abc risk-assessment-framework sk-short','credential_id=cred-12345678','合成测试船今天下午抵达模拟码头。','Version 1.2.3, synthetic.']){
    const r=redactText(input);assert.equal(r.count,0,input);assert.equal(r.text,input);
  }
  assert.equal(redactText(redactText(`k=${fake.github}`).text).count,0,'scrubbing is idempotent');
  const value=redactValue({credential_id:'cred-12345678',author:'Owner',apiKey:fake.password,max_tokens:100,nested:[{client_secret:fake.password,note:`token ${fake.github}`}]});
  assert.deepEqual(value.value,{credential_id:'cred-12345678',author:'Owner',apiKey:'[REDACTED:field]',max_tokens:100,nested:[{client_secret:'[REDACTED:field]',note:'token [REDACTED:github_token]'}]});
  assert.equal(value.count,3);
  const original={content:`a ${fake.openai}`,scope:'user'},fields=redactFields(original,['content','topic']);
  assert.equal(original.content,`a ${fake.openai}`,'input is not mutated');assert.deepEqual(fields.fields,['content']);assert.equal(fields.value.scope,'user');
});

function everything(store){
  const tables=store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'").all().map(r=>r.name);
  return tables.map(name=>JSON.stringify(store.db.prepare(`SELECT * FROM "${name}"`).all())).join('\n');
}

test('redaction: retraction reasons stay scrubbed in HTTP replies, stored history and audits; replay adds no audit',async t=>{
  const f=await memoryFixture(t),memory=f.store.saveMemory(f.a.auth,{scope:'user',content:'Synthetic record to retract.'}).memory;
  const privateText='synthetic-removal-detail',payload={reason:`Rotated ${fake.github}; <private>${privateText}</private>`};
  const result=await f.request('POST',`/v1/memories/${memory.memory_id}/retract`,payload);
  assert.equal(result.status,200);assert.equal(result.body.memory.lifecycle.reason,'Rotated [REDACTED:github_token]; [REDACTED:private]');
  assert.ok(payload.reason.includes(fake.github),'caller input remains untouched');
  const replay=f.store.retractMemory(f.a.auth,memory.memory_id,payload);assert.equal(replay.idempotent,true);
  const stored=everything(f.store);noSecret(stored,'retraction database');assert.ok(!stored.includes(privateText));
  const audit=f.store.db.prepare("SELECT target_id,metadata_json FROM audit_events WHERE action='privacy.redacted'").all();
  assert.equal(audit.length,1);assert.equal(audit[0].target_id,memory.memory_id);assert.deepEqual(JSON.parse(audit[0].metadata_json).fields,['reason']);
});

test('redaction: direct saves, supersedes, console and ChatGPT cloud writes store and audit only scrubbed text',async t=>{
  const f=await memoryFixture(t);Object.assign(f.store.runtime,{cloudMemory:true,cloudSubmittedGrant:true});
  const op=randomUUID(),payload={scope:'user',content:`部署用 ${fake.openai} 和 GITHUB_TOKEN=${fake.github}`,topic:`key ${fake.aws}`};
  const saved=f.store.saveMemory(f.a.auth,payload,{idempotencyKey:op});
  assert.equal(saved.memory.content,'部署用 [REDACTED:openai_key] 和 GITHUB_TOKEN=[REDACTED:github_token]');assert.equal(payload.content.includes(fake.openai),true,'caller payload untouched');
  const replay=f.store.saveMemory(f.a.auth,payload,{idempotencyKey:op});assert.equal(replay.idempotent,true);assert.equal(replay.memory.memory_id,saved.memory.memory_id);
  const replaced=f.store.supersedeMemory(f.a.auth,saved.memory.memory_id,{content:`新的 ${fake.slack}`,reason:`rotated ${fake.github}`});
  assert.equal(replaced.replacement_memory.content,'新的 [REDACTED:slack_token]');
  const viaHttp=await f.request('POST','/v1/memories',{scope:'user',content:`http ${fake.jwt}`});assert.equal(viaHttp.status,201,JSON.stringify(viaHttp.body));
  const cloud=f.store.issueCredential({userId:f.a.auth.user_id,deviceId:'synthetic-cloud',agentId:'chatgpt-web',agentInstanceId:randomUUID(),scopes:['memory:read','resume:read','memory:write']});
  cloud.auth=f.store.authenticate(cloud.api_key);const connection='d'.repeat(64);
  f.store.cloudMemory.bind(cloud.auth,{connection_id:connection,account_id:'account-redaction',security_version:1,allow_submitted_revision_grant:true});
  const cloudSave=await f.request('POST','/v1/cloud-memory/operations',{connection_id:connection,action:'memory.save',operation_id:randomUUID(),
    payload:{content:`cloud ${fake.anthropic}`,scope:'user',memory_type:'fact',cloud_read:'allow_submitted_revision'}},cloud);
  assert.equal(cloudSave.status,200,JSON.stringify(cloudSave.body));
  noSecret(everything(f.store),'database');
  const audits=f.store.db.prepare("SELECT target_id,metadata_json FROM audit_events WHERE action='privacy.redacted' ORDER BY rowid").all();
  assert.equal(audits.length,4,'one audit per scrubbed write, none for the idempotent replay');
  assert.deepEqual(JSON.parse(audits[0].metadata_json),{count:3,kinds:['openai_key','github_token','aws_access_key'],fields:['content','topic']});
  assert.deepEqual(JSON.parse(audits[1].metadata_json).fields,['content','reason']);assert.equal(audits[1].target_id,replaced.replacement_memory.memory_id);
});

test('redaction: captured events keep no credential in content or raw payload, and derived memories are clean',t=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'mnemuron-redaction-'));
  const config={config_version:'mnemuron-memory-first-v1',modules:{memory:{enabled:true},handoff:{enabled:false,existing_inflight_policy:'drain_before_disable'}},
    memory:{capture_extraction:{enabled:true,conversation:{enabled:true,user_ids:['synthetic-owner'],after:'2026-01-01T00:00:00.000Z'}}}};
  const store=new MnemuronStore(root+'/test.sqlite3',{memoryConfig:config});t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const auth=store.authenticate(store.issueCredential({userId:'synthetic-owner',deviceId:'d',agentId:'test',agentInstanceId:'i',scopes:['capture:write','memory:read']}).api_key);
  const event={event_id:'evt-secret',event_type:'user_message',session_id:'synthetic-session',captured_at:new Date().toISOString(),
    content:`事实：生产 API 密钥是 ${fake.openai}。`,raw_hook_payload:{tool_input:{command:`export GITHUB_TOKEN=${fake.github}`},headers:{authorization:`Bearer ${fake.jwt}`},password:fake.password}};
  const first=store.appendEvents(auth,{event});
  assert.equal(first.structured_memories.created,1);
  const again=store.appendEvents(auth,{event});assert.equal(again.structured_memories.created,0);
  noSecret(everything(store),'database');
  const memory=store.db.prepare('SELECT content FROM memories').get();assert.match(memory.content,/\[REDACTED:openai_key\]/);
  const audits=store.db.prepare("SELECT target_type,target_id,metadata_json FROM audit_events WHERE action='privacy.redacted'").all();
  assert.equal(audits.length,1,'a replayed event is not audited twice');assert.equal(audits[0].target_id,'evt-secret');
  assert.ok(JSON.parse(audits[0].metadata_json).count>=4);
});
