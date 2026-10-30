// Real Python Hermes hooks against the isolated HTTP Core. Synthetic credentials never leave loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {memoryFixture} from './helpers/core-memory-fixture.mjs';
import {CONSOLE_WRITE_SCOPES} from '../../shared/console-contract.mjs';

const ROOT=path.resolve(import.meta.dirname,'../..');
const PYTHON=`import json,sys
from adapters.hermes import PluginRuntime
from adapters.hermes.client import scope_tokens
data=json.load(sys.stdin)
class Context:
    def get_config(self,key,default=None): return data['config'].get(key,default)
runtime=PluginRuntime(Context())
result=getattr(runtime,data['hook'])(**data['payload'])
scope=runtime.task_scopes().resolve(scope_tokens(session_id=data['payload'].get('session_id')))
print(json.dumps({'result':result,'scope':scope,'pending':runtime.pending().counts()}))
`;
function hook(config,name,payload){return new Promise((resolve,reject)=>{
  const env={...process.env};for(const key of Object.keys(env))if(/proxy/i.test(key))delete env[key];
  const child=spawn('python3',['-c',PYTHON],{cwd:ROOT,env,stdio:['pipe','pipe','pipe']});let out='',err='';
  child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);child.once('error',reject);
  child.once('close',code=>{if(code!==0)return reject(new Error(`Synthetic Hermes process failed: ${err}`));try{resolve({...JSON.parse(out),stderr:err});}catch(error){reject(error);}});
  child.stdin.end(JSON.stringify({config,hook:name,payload}));
});}
async function fixture(t){
  const f=await memoryFixture(t),store=f.store,agent=store.issueCredential({userId:f.a.auth.user_id,deviceId:'synthetic-hermes-device',agentId:'hermes',agentInstanceId:'synthetic-hermes-instance',scopes:['capture:write','resume:read','resume:confirm']}),
    owner=store.issueCredential({userId:f.a.auth.user_id,deviceId:'synthetic-console-device',agentId:'mnemuron-console',agentInstanceId:'synthetic-console-instance',scopes:CONSOLE_WRITE_SCOPES});
  const key=path.join(f.root,'hermes-key');writeFileSync(key,agent.api_key,{mode:0o600});
  const config={server_url:f.baseUrl,allow_insecure_http:true,request_timeout_seconds:1,api_key_file:key,outbox_dir:path.join(f.root,'hermes-outbox'),pending_resume_dir:path.join(f.root,'hermes-pending'),
    task_scope_dir:path.join(f.root,'hermes-scopes'),injection_event_outbox_dir:path.join(f.root,'hermes-injections'),device_id:'synthetic-hermes-device',agent_id:'hermes',agent_instance_id:'synthetic-hermes-instance',
    project_id:f.alpha.project_id,task_id:f.alpha.task_id,workstream_id:f.alpha.workstreams[0].workstream_id};
  const act=async(action,payload)=>{const r=await f.request('POST','/v1/console/action',{action,payload,operation_id:randomUUID()},owner);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  const read=async(view,p={})=>{const r=await f.request('GET',`/v1/console/${view}?${new URLSearchParams(p)}`,undefined,owner);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  await hook(config,'on_session_start',{session_id:'synthetic-hermes-session',platform:'synthetic'});
  const target=(await read('resume-targets')).targets.find(r=>r.session_id==='hermes:synthetic-hermes-session');assert.ok(target,'real Hermes capture is the destination proof');
  store.upsertTask(f.a.auth,{...f.beta,goal:'Synthetic Console source for real Hermes'});
  const preview=await act('resume.preview',{task_id:f.beta.task_id,target_event_id:target.target_event_id});
  await act('resume.confirm',{resume_id:preview.resume_id,preview_version:preview.preview_version,confirmed:true});
  return {...f,config,target,preview,read,act};
}

test('Console → real Hermes hook → one injected context → actual session completion ACK',async t=>{
  const f=await fixture(t),params={session_id:'synthetic-hermes-session',turn_id:'synthetic-real-turn',user_message:'Continue the reviewed task'};
  assert.equal((await f.read('resume-status',{resume_id:f.preview.resume_id})).status,'queued');
  const wrong=await hook(f.config,'pre_llm_call',{...params,session_id:'wrong-session'});assert.equal(wrong.result,null);assert.equal(wrong.scope,null);
  const delivered=await hook(f.config,'pre_llm_call',params);assert.match(delivered.result.context,/Synthetic Console source for real Hermes/);
  assert.equal(delivered.scope.task_id,f.beta.task_id);assert.equal(delivered.scope.workstream_id,f.target.workstream_id);
  const status=await f.read('resume-status',{resume_id:f.preview.resume_id});assert.equal(status.status,'delivered');assert.equal(status.delivery.completed,false);
  const repeated=await hook(f.config,'pre_llm_call',params);assert.equal(repeated.result,null);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM resume_injection_events WHERE resume_id=?').get(f.preview.resume_id).n,1);
  await hook(f.config,'on_session_end',{session_id:params.session_id,turn_id:params.turn_id,completed:true});
  const complete=await f.read('resume-status',{resume_id:f.preview.resume_id});assert.equal(complete.status,'completed');assert.equal(complete.delivery.completed,true);
  const rows=f.store.db.prepare('SELECT phase,session_id,turn_id,workstream_id FROM resume_injection_events WHERE resume_id=? ORDER BY rowid').all(f.preview.resume_id);
  assert.deepEqual(rows.map(r=>r.phase),['injected','acknowledged']);assert.ok(rows.every(r=>r.session_id===f.target.session_id&&r.workstream_id===f.target.workstream_id));
  assert.equal(rows[1].turn_id,'hermes-turn:synthetic-real-turn');
});

for(const statusCode of [503,403]) test(`Hermes keeps a Console packet retryable after HTTP ${statusCode} from the real central injection gate; no premature task binding`,async t=>{
  const f=await fixture(t),params={session_id:'synthetic-hermes-session',turn_id:'synthetic-retry-turn',user_message:'Continue after a temporary outage'};
  const original=f.store.recordInjectionEvent;f.store.recordInjectionEvent=()=>{throw Object.assign(new Error('Synthetic unavailable receipt gate'),{statusCode});};
  let failed;try{failed=await hook(f.config,'pre_llm_call',params);}finally{f.store.recordInjectionEvent=original;}
  assert.equal(failed.result,null);assert.equal(failed.scope,null);assert.equal(failed.pending.pending,1);assert.match(failed.stderr,/injection deferred/);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM resume_injection_events').get().n,0);
  const retried=await hook(f.config,'pre_llm_call',params);assert.match(retried.result.context,/Synthetic Console source for real Hermes/);assert.equal(retried.scope.task_id,f.beta.task_id);
  const status=await f.read('resume-status',{resume_id:f.preview.resume_id});assert.equal(status.status,'delivered');assert.equal(status.delivery.completed,false);
});

test('Hermes clears a permanently stale local Console authorization and can consume the next reviewed packet',async t=>{
  const f=await fixture(t),params={session_id:'synthetic-hermes-session',turn_id:'synthetic-stale-turn',user_message:'Continue the reviewed work'};
  const original=f.store.recordInjectionEvent;f.store.recordInjectionEvent=()=>{throw Object.assign(new Error('Synthetic unavailable receipt gate'),{statusCode:503});};
  try{assert.equal((await hook(f.config,'pre_llm_call',params)).result,null);}finally{f.store.recordInjectionEvent=original;}
  f.store.upsertTask(f.a.auth,{...f.beta,goal:'New source requiring a fresh reviewed authorization'});
  const stale=await hook(f.config,'pre_llm_call',params);assert.equal(stale.result,null);assert.equal(stale.pending.pending,0);assert.equal(stale.scope,null);
  assert.match(stale.stderr,/authorization is no longer usable/);
  const p=await f.act('resume.preview',{task_id:f.beta.task_id,target_event_id:f.target.target_event_id});
  await f.act('resume.confirm',{resume_id:p.resume_id,preview_version:p.preview_version,confirmed:true});
  const fresh=await hook(f.config,'pre_llm_call',{...params,turn_id:'synthetic-fresh-turn'});assert.match(fresh.result.context,/New source requiring a fresh reviewed authorization/);
  assert.equal(fresh.scope.resume_id,p.resume_id);assert.equal((await f.read('resume-status',{resume_id:f.preview.resume_id})).content_withheld,true);
});
