// Synthetic loopback fixture for real browser/module/CSP acceptance. No production configuration is read.
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
import http from 'node:http';
import {generate} from 'otplib';
import {fixture} from '../fixture.mjs';
import {pendingAccount} from './identity-fixture.mjs';
import {memoryFixture} from '../../../../server/test/helpers/core-memory-fixture.mjs';
import {VectorIndex} from '../../../../server/lib/vector-stores/index.mjs';
import {MockVectorStore} from '../../../../server/test/helpers/vector-mock.mjs';
import {calendarWindow} from '../../../../server/lib/memory-jobs/windows.mjs';
import {provisionIdentities} from '../../src/provisioning.mjs';
import {prepareConnectionBinding,applyConnectionBinding,finishConnectionBinding} from '../../src/connection-provisioning.mjs';
import {randomSecret,writePrivate,seconds,secretHash} from '../../../../shared/oauth-common.mjs';
const cleanup=[],t={after:fn=>cleanup.push(fn)};
let stopped=false;
async function stop(){
 if(stopped)return;stopped=true;
 for(const fn of cleanup.reverse())await fn();
 const removed=!fs.existsSync(core.root)&&!fs.existsSync(f.directory);
 process.stderr.write(JSON.stringify({synthetic_cleanup_complete:removed,core_storage_removed:!fs.existsSync(core.root),identity_storage_removed:!fs.existsSync(f.directory)})+'\n');
 process.exit(removed?0:1);
}
const core=await memoryFixture(t);
Object.assign(core.store.runtime,{cloudMemory:true,cloudSubmittedGrant:true});
// Model-list discovery: a bodyless GET of the list route. Only the presence of an authorization header is recorded.
const listing={inferenceCalls:0,requests:[],hold:null,release:null,models:['synthetic-embed-small','synthetic-chat-large','synthetic-chat-mini','<b>markup-like</b>']};
const model=http.createServer(async(req,res)=>{let data='';for await(const chunk of req)data+=chunk;
 if(req.method==='GET'&&(req.url.endsWith('/models')||req.url.endsWith('/api/tags'))){listing.requests.push({url:req.url,authorized:!!req.headers.authorization});if(listing.hold)await listing.hold;
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(req.url.endsWith('/api/tags')?{models:listing.models.map(name=>({name}))}:{object:'list',data:listing.models.map(id=>({id}))}));return;}
 listing.inferenceCalls++;const body=JSON.parse(data);let output={ok:true};
 try{const request=JSON.parse(body.messages?.find(m=>m.role==='user')?.content||'{}'),sources=request.input?.sources;
  if(sources)output={results:sources.map(s=>request.input.operation==='entities'?{memory_id:s.memory_id,revision:s.revision,objects:[]}:request.input.operation==='classification'?{memory_id:s.memory_id,category:'technical',tags:['synthetic']}:{memory_id:s.memory_id,revision:s.revision,start:0,end:s.content.length,quote:s.content})};
 }catch{}
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(body.input?{data:body.input.map((_,index)=>({index,embedding:[1,0,0]}))}:{choices:[{message:{content:JSON.stringify(output)},finish_reason:'stop'}]}));
});
await new Promise(r=>model.listen(0,'127.0.0.1',r));cleanup.push(()=>new Promise(r=>model.close(r)));
const modelUrl='http://127.0.0.1:'+model.address().port;
const key=path.join(core.root,'console-key');writePrivate(key,randomSecret());
core.store.memoryConfig.console={key_file:key,worker_enabled:false,allowed_private_origins:[modelUrl]};
const f=await fixture(t,{start:false,mutate:c=>{c.identity_mode='multi_account_v1';c.login.registration_enabled=true;
 c.cloud_memory={enabled:true,allow_submitted_revision_grant:true};c.resource_scopes.push('memory:write');c.chatgpt_client.allowed_scopes.push('memory:write');
 c.identity={encryption_key_file:path.join(path.dirname(c.database_file),'identity-key'),invitation_batch_limit:20,console_session_ttl_seconds:3600,console_operations:true,core:{base_url:core.baseUrl},
 connection_management:{enabled:true,max_connections:20,pat_default_ttl_seconds:2592000,pat_max_ttl_seconds:7776000,secret_receipt_ttl_seconds:300,rotation_overlap_seconds:0},
 recovery_policy:{password:['recovery_code','totp'],totp:['recovery_code','password']},
 provisioning:{enabled:true,core_database:core.databasePath,credential_directory:path.join(path.dirname(c.database_file),'keys'),identity_map_file:path.join(path.dirname(c.database_file),'map.json')}};
}});
writePrivate(f.config.identity.encryption_key_file,randomSecret());await f.start();const ids=f.app.accounts,owners=[];
for(const username of ['Synthetic_Browser_A','Synthetic_Browser_B']){
 const o=await pendingAccount({identities:ids},username);o.codes=ids.takeRecoveryCodes(o.session.token);ids.acknowledgeRecovery(o.session.token);owners.push(o);
}
provisionIdentities(ids,core.store,{credentialDirectory:path.join(f.directory,'keys'),identityMapFile:path.join(f.directory,'map.json'),consoleOperations:true});
for(const [i,o] of owners.entries()){
 o.account=ids.byId(o.account.account_id);o.console=ids.newSession('console',{accountId:o.account.account_id});
 const writer=core.issue(o.account.user_id,`synthetic-browser-${i}`);
 core.store.upsertTask(writer.auth,{task_id:`synthetic-browser-task-${i}`,project_id:`synthetic-browser-project-${i}`,project_name:'Synthetic UI Project',title:'Synthetic UI Task',goal:'Synthetic canonical goal for read-only console acceptance.',status:'active',workstreams:[{workstream_id:`synthetic-browser-branch-${i}`,name:'Synthetic branch',status:'active'}]});
 for(const content of [i?'Synthetic private B sentinel':'合成记忆：蓝色纸船在测试港口。',i?'Synthetic B second memory':'Synthetic technical decision: preserve exact source revisions.'])core.store.saveMemory(writer.auth,{scope:'user',content});
}
ids.console.role(owners[0].account.account_id,true);

// Synthetic projects for the projects/tasks page: exactly 26 active projects (one past a 25-row page), a
// long-named project with many aliases and 15 tasks (one carrying structured fields the Console keeps), a
// project memory for context, and a project/task whose name, title and goal contain newlines.
function seedProjects(o,i){
 const user=o.account.user_id,store=core.store,writer=core.issue(user,`synthetic-projects-${i}-${Date.now()}`);
 const main=`synthetic-ui-main-${i}`,mainName='Atlas 合成项目：一个名称很长的项目，用于检查窄屏换行 Synthetic project with a deliberately long name for wrapping checks';
 store.upsertProject(writer.auth,{project_id:main,name:mainName,aliases:Array.from({length:12},(_,k)=>k===3?`long-alias-${'x'.repeat(180)}`:`合成别名 ${k}`),
  git_remotes:['https://example.invalid/synthetic/repo.git'],repo_fingerprints:['synthetic-fingerprint-1'],path_hints:['/synthetic/workspace/project']});
 // Task 00 carries the structured fields and is written last, so it is the newest: first in the context
 // window (the Core returns the 10 most recently updated) and on the first task page. Its 20 blockers are
 // an ordinary array the Core caps in previews (4 shown of 20).
 for(const k of [...Array.from({length:14},(_,n)=>n+1),0])store.upsertTask(writer.auth,{task_id:`synthetic-ui-task-${i}-${String(k).padStart(2,'0')}`,project_id:main,project_name:mainName,title:`合成任务 ${k} Synthetic task ${k}`,
  goal:`Synthetic goal ${k}`,status:'active',...(k===0?{progress:['text progress',{text:'structured progress',source_event_id:'synthetic-event'}],decisions:[{text:'structured decision'}],
  blockers:Array.from({length:20},(_,n)=>n?`synthetic blocker ${n}`:'synthetic blocker'),next_steps:['synthetic next step'],resources:[{category:'doc',text:'synthetic resource'}],
  workstreams:[{workstream_id:`synthetic-ui-ws-${i}`,name:'Synthetic workstream',status:'active',description:'Synthetic workstream description'}],conflicts:[{claim:'synthetic recorded claim'}]}:{})});
 store.saveMemory(writer.auth,{scope:'project',project_id:main,content:'合成项目记忆：用于上下文预览。Synthetic project memory for the context preview.'});
 const newline=`synthetic-ui-newline-${i}`,newlineName='Line one\nLine two';
 store.upsertProject(writer.auth,{project_id:newline,name:newlineName,aliases:['newline-alias']});
 store.upsertTask(writer.auth,{task_id:`synthetic-ui-newline-task-${i}`,project_id:newline,project_name:newlineName,title:'Title line one\r\nTitle line two',goal:'\nGoal after a leading newline',status:'active',aliases:['task-alias']});
 const existing=store.listProjects(user).length;
 for(let k=0;existing+k<26;k++)store.upsertProject(writer.auth,{project_id:`synthetic-ui-bulk-${i}-${String(k).padStart(2,'0')}`,name:`Synthetic bulk project ${String(k).padStart(2,'0')}`});
 return {main,newline,newline_task:`synthetic-ui-newline-task-${i}`,rich_task:`synthetic-ui-task-${i}-00`,active:store.listProjects(user).length};
}

// Same-category synthetic summaries that differ only by scope, period, time zone or revision, so the
// list must tell them apart. Published through the real derived store over real synthetic memories:
// the detail read revalidates every dependency exactly as it does for model-produced summaries.
function seedSummaries(o,i){
 const user=o.account.user_id,store=core.store,writer=core.issue(user,`synthetic-summaries-${i}-${Date.now()}`);
 const at=Date.UTC(2026,9,1,18,30),version=store.consoleService.taxonomy(user).version;
 const task={project_id:`synthetic-browser-project-${i}`,task_id:`synthetic-browser-task-${i}`,workstream_id:`synthetic-browser-branch-${i}`};
 // A second project holding a task and workstream with the same names: only the project tells them apart.
 const twin={project_id:`synthetic-browser-project-${i}-twin`,task_id:`synthetic-browser-task-${i}-twin`,workstream_id:`synthetic-browser-branch-${i}-twin`};
 store.upsertTask(writer.auth,{task_id:twin.task_id,project_id:twin.project_id,project_name:'Synthetic UI Project Twin',title:'Synthetic UI Task',goal:'Synthetic same-title task in another project.',
  status:'active',workstreams:[{workstream_id:twin.workstream_id,name:'Synthetic branch',status:'active'}]});
 const specs=[
  {key:'user-shanghai',scope:{scope:'user'},period:'daily',timezone:'Asia/Shanghai',revisions:2},
  {key:'user-utc',scope:{scope:'user'},period:'daily',timezone:'UTC'},
  {key:'user-week',scope:{scope:'user'},period:'weekly',timezone:'UTC'},
  {key:'project',scope:{scope:'project',project_id:task.project_id},period:'daily',timezone:'Asia/Shanghai'},
  {key:'task',scope:{scope:'task',task_id:task.task_id},period:'daily',timezone:'Asia/Shanghai'},
  {key:'workstream',scope:{scope:'workstream',task_id:task.task_id,workstream_id:task.workstream_id},period:'daily',timezone:'UTC'},
  {key:'workstream-twin',scope:{scope:'workstream',task_id:twin.task_id,workstream_id:twin.workstream_id},period:'daily',timezone:'UTC'},
  {key:'session',scope:{scope:'session',session_id:`synthetic-browser-session-${i}-${'long-identifier-'.repeat(6)}end`},period:'weekly',timezone:'America/Los_Angeles'},
 ];
 const contents=key=>[`合成摘要来源（${key}）：这是一段较长的中文测试文本，用来检查窄屏上的摘要正文是否保持可读的行宽，而不是被压缩成一列一个字。`,
  `Synthetic source (${key}) with an unbroken identifier ${'0123456789abcdef'.repeat(4)} and a long path /synthetic/${'nested-directory/'.repeat(6)}file.txt`];
 const ids=[];
 for(const spec of specs){
  const memories=contents(spec.key).map(content=>store.saveMemory(writer.auth,{...spec.scope,content}).memory);
  for(const m of memories)store.db.prepare('INSERT OR REPLACE INTO memory_category_overrides VALUES (?,?,?,1)').run(user,m.memory_id,'technical');
  const items=memories.map(m=>store.derivedMemory.currentSource(user,m.memory_id));
  if(items.some(item=>!item))throw new Error('Synthetic summary source unavailable');
  const claims=items.map(item=>({memory_id:item.memory_id,revision:item.revision,start:0,end:[...item.content].length,quote:item.content}));
  for(let revision=1;revision<=(spec.revisions||1);revision++){
   const job={job_id:`synthetic-summary-${i}-${spec.key}-${revision}`,group_key:`synthetic-summary-${i}-${spec.key}`,user_id:user,scope_key:items[0].scope_key,profile:'synthetic-layout',
    metadata:{category:'technical',window:calendarWindow(at,{timezone:spec.timezone,period:spec.period}),taxonomy:{version}}};
   ids.push(store.memoryTransaction(()=>store.derivedMemory.publishSummary(job,items.map(({user_id,memory_id,revision,state_hash,scope_key})=>({user_id,memory_id,revision,state_hash,scope_key})),claims,at+revision*1000)));
  }
 }
 return {summaries:ids.length};
}
const Adapter=f.app.store.adapter();for(const o of owners)await new (Adapter)('Grant').upsert('synthetic-browser-'+o.account.account_id,{accountId:o.account.subject,clientId:f.config.chatgpt_client.client_id},3600);
console.log(JSON.stringify({fixture:true,url:f.config.issuer,model_url:modelUrl,cookie:'mnm_fixture_console',
 oauth:{client_id:f.config.chatgpt_client.client_id,redirect_uri:f.config.chatgpt_client.redirect_uris[0],resource:f.config.resource},accounts:owners.map(o=>({account_id:o.account.account_id,username:o.account.username,token:o.console.token})),password:'Synthetic password with spaces  '}));
const lines=readline.createInterface({input:process.stdin});
lines.on('line',async line=>{
 try{const req=JSON.parse(line);if(req.command==='stop')return stop();const o=owners[req.owner||0];let reply;
  if(req.command==='otp'){
   // Isolated test fixtures reset their proof window between independent UI cases.
   // This stdin helper is not a service endpoint and never exists in production.
   if(req.fresh){ids.db.prepare('DELETE FROM oauth_mfa_steps WHERE subject=?').run(o.account.subject);ids.db.prepare('DELETE FROM oauth_rate_limits WHERE key=?').run(secretHash(`console:reauth:${o.account.account_id}`));}
   reply={otp:await generate({secret:o.setup.secret,epoch:seconds()+(req.offset||0)})};
  }
  if(req.command==='provision-connections'){
   for(const op of ids.db.prepare("SELECT * FROM identity_operations WHERE kind LIKE 'connection-bind:%' AND state NOT IN ('completed','superseded')").all()){
    const work=prepareConnectionBinding(ids,op,path.join(f.directory,'keys'));if(!work)continue;applyConnectionBinding(core.store,work);writePrivate(work.binding.credential_file,work.binding.api_key);finishConnectionBinding(ids,work);
   }reply={done:true};
  }
  if(req.command==='model-list-hold'){listing.hold=new Promise(r=>{listing.release=r;});reply={held:true};}
  if(req.command==='model-list-release'){listing.release?.();listing.hold=null;reply={released:true};}
  if(req.command==='model-list-requests')reply={requests:listing.requests};
  if(req.command==='owner-mode'){
   const {OwnerControls,migrateOwner}=await import('../../../../server/lib/console/owner.mjs');const s=core.store,user=o.account.user_id;
   f.app.config.identity.owner_account_id=o.account.account_id;s.memoryConfig.console.owner_user_id=user;s.memoryConfig.cloud_memory={enabled:true};
   s.memoryTransaction(()=>migrateOwner(s.db,user,{memory:true,connections:true,cloud_write:true}));s.consoleService.owner=new OwnerControls(s.consoleService);
   const c={enabled:true,protocol:'openai_compatible',base_url:modelUrl,model:'synthetic-owner-model',profile_revision:'1',daily_requests:10,output_tokens:4096,batch_size:2,sensitivities:['public','internal','sensitive'],egress_approved:true,query_approved:true};
   s.db.prepare('INSERT INTO console_models(user_id,kind,revision,config_json,secret_cipher,updated_at) VALUES(?,?,1,?,NULL,?)').run(user,'organizer',JSON.stringify(c),Date.now());reply={done:true};
  }
  if(req.command==='owner-state')reply={...core.store.consoleService.owner.view(o.account.user_id),inference_calls:listing.inferenceCalls};
  if(req.command==='owner-tick'){await core.store.consoleService.tick();reply={done:true,inference_calls:listing.inferenceCalls};}
  if(req.command==='model-config')reply={models:core.store.db.prepare('SELECT kind,revision,config_json,secret_cipher IS NOT NULL AS has_key FROM console_models WHERE user_id=? ORDER BY kind').all(o.account.user_id).map(r=>({...r,config:JSON.parse(r.config_json),config_json:undefined}))};
  if(req.command==='seed-lifecycle'){const writer=core.issue(o.account.user_id,'synthetic-lifecycle-'+Date.now()),store=core.store;
   const projects=[['synthetic-life-del','Synthetic Lifecycle Delete 合成删除项目'],['synthetic-life-src','Synthetic Lifecycle Source 合成源项目'],['synthetic-life-tgt','Synthetic Lifecycle Target 合成目标项目'],['synthetic-life-keep','Synthetic Lifecycle Keep 合成保留项目']];
   for(const [id,name] of projects)store.upsertProject(writer.auth,{project_id:id,name});
   for(const [id,name] of projects.slice(0,3))store.upsertTask(writer.auth,{task_id:`${id}-task`,project_id:id,project_name:name,title:'Shared lifecycle task 同名任务',goal:'Synthetic lifecycle goal',status:'active'});
   store.saveMemory(writer.auth,{scope:'project',project_id:'synthetic-life-del',content:'Synthetic lifecycle memory 合成生命周期记忆'});
   reply={projects:Object.fromEntries(projects)};}
  if(req.command==='lifecycle-state')reply={states:Object.fromEntries((req.project_ids||[]).map(id=>[id,core.store.lifecycle.projectState(o.account.user_id,id)])),
   canonical:Object.fromEntries((req.project_ids||[]).map(id=>[id,core.store.lifecycle.resolve(o.account.user_id,id).canonical_project_id]))};
  if(req.command==='unrelated-write'){const writer=core.issue(o.account.user_id,'synthetic-unrelated-'+Date.now());core.store.saveMemory(writer.auth,{scope:'project',project_id:'synthetic-life-keep',content:'Synthetic unrelated write '+Date.now()});reply={done:true};}
  if(req.command==='tick'){
   const requested=req.job_ids||[];if(!Array.isArray(requested)||requested.length>100||requested.some(id=>core.store.memoryJobs.get(id)?.user_id!==o.account.user_id))throw new Error('Invalid synthetic target jobs');
   core.store.memoryConfig.console.worker_enabled=true;
   try{for(let n=0;n<100;n++){await core.store.consoleService.tick();const states=requested.map(id=>({job_id:id,state:core.store.memoryJobs.get(id)?.state}));
     if(!states.length||states.every(j=>j.state==='succeeded')){reply={done:true,jobs:states};break;}
     if(states.some(j=>!['pending','leased','retry_wait'].includes(j.state)))throw new Error('Synthetic target job failed: '+JSON.stringify(states));
   }if(!reply)throw new Error('Synthetic target job did not settle');}finally{core.store.memoryConfig.console.worker_enabled=false;}
  }
  if(req.command==='enable-synthetic-processing'){
   core.store.memoryConfig.console.worker_enabled=true;core.store.memoryConfig.vector_store={enabled:true};
   const backend=new MockVectorStore();core.store.consoleService.vector=user=>{const e=core.store.consoleService.models.provider(user,'embedder');return new VectorIndex(core.store,backend,new Map([[e.profile.fingerprint,e]]),{ownerId:user});};
   reply={done:true,synthetic_vector_backend:true};
  }
  // First run against a synthetic operator-pre-created collection (never created by Mnemuron; no Qdrant).
  if(req.command==='enable-first-run-vector'){
   core.store.memoryConfig.console.worker_enabled=true;core.store.memoryConfig.vector_store={enabled:true,collection_prefix:'synthetic'};delete core.store.consoleService.vector;
   const backend=new MockVectorStore();backend.precreated=['synthetic_first_v1'];backend.collections.set('synthetic_first_v1',{config:{dimensions:3,distance:'Cosine'},points:new Map()});
   core.store.consoleService.vectorBackend=()=>backend;reply={done:true,precreated:backend.precreated};
  }
  // UI-state fixtures only; actual OAuth/MCP acceptance lives in the gateway SDK suite.
  if(req.command==='connection-evidence'){
   const r=ids.db.prepare('SELECT * FROM identity_connections WHERE account_id=? AND label=?').get(o.account.account_id,req.label);if(!r)throw new Error('Synthetic connection missing');
   if(req.state==='authorized'){await new (Adapter)('Grant').upsert('synthetic-guide-'+r.connection_id,{accountId:o.account.subject,clientId:r.client_id,resources:{[f.config.resource]:'memory:read'}},3600);ids.connections.markAuthorized(r.client_id,o.account.subject);}
   else if(req.state==='verified')ids.connections.markTool({connection_id:r.connection_id,account_id:r.account_id,connection_version:r.version});
   else if(req.state==='revoked')ids.store.revoke({subject:o.account.subject,clientId:r.client_id});
   reply={done:true};
  }
  // Read-only integrity evidence for organize acceptance: schema version and row counts, never content.
  if(req.command==='integrity'){const db=core.store.db,n=(sql,...a)=>db.prepare(sql).get(...a).n;
   reply={user_version:db.prepare('PRAGMA user_version').get().user_version,users:owners.map(x=>({memories:n('SELECT COUNT(*) n FROM memories WHERE user_id=?',x.account.user_id),
    active:n("SELECT COUNT(*) n FROM memories WHERE user_id=? AND status='active'",x.account.user_id),revisions:n('SELECT COUNT(*) n FROM memory_revisions WHERE user_id=?',x.account.user_id),
    overrides:n('SELECT COUNT(*) n FROM memory_category_overrides WHERE user_id=?',x.account.user_id),denials:n('SELECT COUNT(*) n FROM memory_web_denials WHERE user_id=?',x.account.user_id),
    // Original memory fields (content, type, lifecycle, topic, scope, dates) must never change by organizing.
    fields_sha256:createHash('sha256').update(JSON.stringify(db.prepare('SELECT memory_id,content,memory_type,status,topic,scope,source,created_at,updated_at FROM memories WHERE user_id=? ORDER BY memory_id').all(x.account.user_id))).digest('hex')}))};
  }
  if(req.command==='keep-private'){const writer=core.issue(o.account.user_id,'synthetic-private-'+Date.now());const m=core.store.saveMemory(writer.auth,{scope:'user',content:'Synthetic keep-private memory for organize acceptance',topic:'privacy-check'}).memory;
   core.store.webVisibility.keepPrivate(o.account.user_id,m.memory_id,core.store.revisions.latest(o.account.user_id,m.memory_id));reply={memory_id:m.memory_id};}
  if(req.command==='web-visible'){reply={visible:core.store.webVisibility.visible({user_id:o.account.user_id,agent_id:'chatgpt-web',scopes:['memory:read']},req.memory_id),denied:core.store.webVisibility.denied(o.account.user_id,req.memory_id)};}
  // Synthetic bulk memories for limit acceptance (owner-scoped, one transaction).
  if(req.command==='bulk'){const writer=core.issue(o.account.user_id,'synthetic-bulk-'+Date.now());core.store.db.exec('BEGIN');
   try{for(let i=0;i<req.count;i++)core.store.saveMemory(writer.auth,{scope:'user',content:`Synthetic bulk limit note ${i}`,topic:req.topic});core.store.db.exec('COMMIT');}catch(e){core.store.db.exec('ROLLBACK');throw e;}reply={created:req.count};}
  if(req.command==='invitation')reply=ids.issueInvitations({count:1,ttlMinutes:10,issuer:'synthetic-browser-operator'});
  if(req.command==='codes')reply={codes:o.codes};
  if(req.command==='cookies'){o.console=ids.newSession('console',{accountId:o.account.account_id});reply={token:o.console.token};}
  if(req.command==='basic-memory-only'){f.app.config.identity.console_operations=false;f.app.config.identity.console_basic_operations={memory:true,security:true,oauth:true};reply={done:true};}
  if(req.command==='seed-audit'){
   const writer=core.issue(o.account.user_id,'synthetic-audit-'+Date.now()),foreign=owners.find(owner=>owner!==o);
   const own=core.store.saveMemory(writer.auth,{scope:'user',topic:'部署前备份与回滚准备',content:'部署前备份与回滚准备。PRIVATE AUDIT BODY MUST NOT APPEAR IN LIST OR EXPORT.'}).memory;
   const foreignId=core.store.db.prepare('SELECT memory_id FROM memories WHERE user_id=? LIMIT 1').get(foreign.account.user_id).memory_id;
   for(let n=0;n<38;n++)core.store.audit({auth:writer.auth,action:'memory.read',targetType:'memory',targetId:n===37?foreignId:own.memory_id});
   core.store.audit({auth:writer.auth,action:'memory.query',metadata:{result_refs_kind:'lexical_subquery',result_refs:[own.memory_id,foreignId],result_refs_truncated:true,result_count:2}});
   core.store.audit({auth:{user_id:o.account.user_id},action:'memory.query'});
   for(let n=0;n<36;n++){ids.audit(o.account.account_id,'account.login');ids.audit(o.account.account_id,'connection.tool_succeeded');core.store.audit({auth:writer.auth,action:'console.models.test'});}
   ids.audit(o.account.account_id,'synthetic.audit.unknown');
   reply={memory_id:own.memory_id,foreign_memory_id:foreignId,credential_id:writer.auth.credential_id,agent_instance_id:writer.auth.agent_instance_id};
  }
  if(req.command==='seed-entities')reply=(await import('./entity-browser-seed.mjs')).seedEntityBrowser(core,o);
  if(req.command==='seed-entity-pending')reply=(await import('./entity-browser-seed.mjs')).seedEntityBrowserPending(core,o);
  if(req.command==='seed-summaries')reply=seedSummaries(o,owners.indexOf(o));
  if(req.command==='seed-projects')reply=seedProjects(o,owners.indexOf(o));
  if(req.command==='seed-responsive')reply=await (await import('./responsive-browser-seed.mjs')).seedResponsive(core,ids,o,modelUrl);
  // Read-only evidence of the stored synthetic rows (exactness checks); never content of another owner.
  if(req.command==='project-state'){const r=core.store.db.prepare('SELECT name,aliases_json,git_remotes_json,repo_fingerprints_json,path_hints_json,updated_at FROM projects WHERE user_id=? AND project_id=?').get(o.account.user_id,req.project_id);reply={row:r?{...r}:null};}
  if(req.command==='task-state'){const r=core.store.db.prepare('SELECT title,goal,status,aliases_json,blockers_json,progress_json,workstreams_json,conflicts_json,project_name,canonical_version FROM tasks WHERE user_id=? AND task_id=?').get(o.account.user_id,req.task_id);reply={row:r?{...r}:null};}
  // A real agent canonical write (as an MCP/admin client would make) between a Console read and its save.
  if(req.command==='touch-task'){const writer=core.issue(o.account.user_id,'synthetic-touch-'+Date.now());const task=core.store.taskFromRow(core.store.db.prepare('SELECT * FROM tasks WHERE user_id=? AND task_id=?').get(o.account.user_id,req.task_id));
   reply={result:core.store.upsertTask(writer.auth,{...task,blockers:[...task.blockers,'blocker added by a synthetic agent']}).status};}
  if(req.command==='revoke-console-sessions'){ids.db.prepare("DELETE FROM identity_sessions WHERE account_id=? AND purpose='console'").run(o.account.account_id);reply={done:true};}
  console.log(JSON.stringify({request:req.command,...reply}));
 }catch(error){console.log(JSON.stringify({fixture_error:error.code||error.errorCode||'FAILED'}));}
});
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,stop);
