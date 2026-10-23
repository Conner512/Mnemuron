// Console project/task editing and Console-only archive (CP-01..CP-12): owner-bound, bounded, revision-checked
// and merging onto the full stored record. Disposable synthetic fixtures only; actions go through the real
// Console action path (state.sync transaction, idempotency, audit).
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {memoryFixture} from './helpers/core-memory-fixture.mjs';
import {consoleRead} from '../lib/console-read.mjs';
import {HandoffPolicy} from '../lib/handoff-policy.mjs';
import {CONSOLE_WRITE_SCOPES,CONSOLE_BASIC_SCOPES} from '../../shared/console-contract.mjs';

const RESPONSE_LIMIT=256*1024;
const long=(n,seed)=>`${seed}-`.padEnd(n,'x');

async function setup(t){
  const f=await memoryFixture(t);
  const consoleAuth=(user,scopes=CONSOLE_WRITE_SCOPES)=>{const c=f.store.issueCredential({userId:user,deviceId:'synthetic-console',agentId:'mnemuron-console',agentInstanceId:randomUUID(),scopes});return f.store.authenticate(c.api_key);};
  const A=consoleAuth(f.a.auth.user_id),B=consoleAuth(f.other.auth.user_id);
  const run=(auth,action,payload,operation=randomUUID())=>f.store.consoleService.execute(auth,{action,operation_id:operation,payload});
  const read=(auth,view,params={})=>consoleRead(f.store,auth,view,Object.fromEntries(Object.entries(params).map(([k,v])=>[k,String(v)])));
  const row=(table,key,value)=>({...f.store.db.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).get(value)});
  const listed=async(auth,projectId)=>{for(const archived of ['false','true']){let offset=0;for(;;){const page=await read(auth,'projects',{offset,limit:50,archived});const hit=page.projects.find(p=>p.project_id===projectId);if(hit)return hit;if(page.next_offset===null)break;offset=page.next_offset;}}};
  // A task with structured items the Console never edits (objects in arrays, workstreams with extra keys, conflicts).
  f.store.upsertTask(f.a.auth,{task_id:'task-console-rich',project_id:f.alpha.project_id,project_name:f.alpha.project_name,title:'Synthetic rich task',goal:'Synthetic goal',
    aliases:['rich-alias-one'],progress:['text progress',{text:'structured progress',source_event_id:'synthetic-event-1'}],decisions:[{text:'structured decision',confidence:0.7}],
    blockers:['synthetic blocker'],next_steps:['synthetic next'],resources:[{category:'doc',text:'synthetic resource'}],
    workstreams:[{workstream_id:'ws-rich-one',name:'Rich one',status:'active',source:{agent_id:'synthetic-agent',session_id:'synthetic-session'}}],
    conflicts:[{claim:'synthetic recorded claim',evidence:['synthetic-checkpoint']}]});
  return {...f,A,B,consoleAuth,run,read,row,listed};
}
const retainedTaskFields=task=>Object.fromEntries(['progress','decisions','blockers','next_steps','resources','workstreams','conflicts'].map(k=>[k,task[`${k}_json`]]));

test('CP-01: the project list is owner-bound, paged, bounded and carries revision, counts and archive state',async t=>{
  const f=await setup(t);
  const page=await f.read(f.A,'projects',{limit:50});
  assert.ok(page.projects.some(p=>p.project_id===f.alpha.project_id));
  assert.equal(page.projects.some(p=>p.project_id===f.foreign.project_id),false,'another owner\'s project never listed');
  const alpha=page.projects.find(p=>p.project_id===f.alpha.project_id);
  for(const key of ['revision','counts','task_count','archived','alias_preview','created_at','updated_at'])assert.ok(key in alpha,key);
  assert.equal(alpha.task_count,f.store.db.prepare('SELECT COUNT(*) n FROM tasks WHERE user_id=? AND project_id=?').get(f.a.auth.user_id,f.alpha.project_id).n);
  // 50 projects, each with a full 50 x 2048 alias list, still list within the transport bound.
  for(let i=0;i<50;i++)f.store.upsertProject(f.a.auth,{project_id:`project-bulk-${i}`,name:long(200,`Bulk ${i}`),aliases:Array.from({length:50},(_,k)=>long(2048,`a${i}-${k}`))});
  const full=await f.read(f.A,'projects',{limit:50});
  assert.ok(Buffer.byteLength(JSON.stringify(full))<RESPONSE_LIMIT,'list response stays under 256 KiB');
  assert.equal(full.projects.length,50);assert.notEqual(full.next_offset,null);
  const bulk=full.projects.find(p=>p.project_id.startsWith('project-bulk-'));
  assert.equal(bulk.counts.aliases,50);assert.equal(bulk.alias_preview.length,5);assert.equal(bulk.alias_preview_complete,false);
  assert.ok(bulk.alias_preview.every(a=>[...a.text].length<=120&&a.complete===false));
  await assert.rejects(f.read(f.A,'projects',{limit:51}),{statusCode:400});
});

test('CP-02: full list values are readable in bounded pages without truncation, owner-bound',async t=>{
  const f=await setup(t);
  const aliases=Array.from({length:50},(_,k)=>long(2048,`full-${k}-汉字`));
  f.store.upsertProject(f.a.auth,{project_id:'project-full-values',name:'Full values',aliases});
  let offset=0;const seen=[];
  for(let pages=0;offset!==null;pages++){
    assert.ok(pages<20);const page=await f.read(f.A,'metadata-values',{kind:'project',id:'project-full-values',field:'aliases',offset,limit:10});
    assert.ok(Buffer.byteLength(JSON.stringify(page))<RESPONSE_LIMIT);assert.equal(page.total,50);
    seen.push(...page.items.map(i=>i.value));offset=page.next_offset;
  }
  assert.deepEqual(seen,aliases,'every value read back exactly');
  await assert.rejects(f.read(f.B,'metadata-values',{kind:'project',id:'project-full-values',field:'aliases'}),{errorCode:'PROJECT_NOT_FOUND'});
  await assert.rejects(f.read(f.A,'metadata-values',{kind:'task',id:'task-console-rich',field:'progress'}),{statusCode:400},'retained task fields are not exposed for editing');
  await assert.rejects(f.read(f.A,'metadata-values',{kind:'project',id:'project-full-values',field:'name'}),{statusCode:400});
});

test('CP-03: renaming a project keeps every other stored field, moves the revision and rewrites no task',async t=>{
  const f=await setup(t);
  f.store.upsertProject(f.a.auth,{project_id:f.alpha.project_id,name:'Alpha',aliases:['a1','a2'],git_remotes:['ssh://example.invalid/a.git'],repo_fingerprints:['fp-a'],path_hints:[long(2048,'/deep')]});
  const before=f.row('projects','project_id',f.alpha.project_id),tasksBefore=f.store.db.prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY task_id').all(f.alpha.project_id);
  const listed=await f.listed(f.A,f.alpha.project_id);
  const saved=await f.run(f.A,'projects.update',{project_id:f.alpha.project_id,expected_revision:listed.revision,name:'  Alpha renamed  '});
  assert.equal(saved.status,'saved');assert.equal(saved.tasks_rewritten,0);assert.notEqual(saved.revision,listed.revision);
  const after=f.row('projects','project_id',f.alpha.project_id);
  assert.equal(after.name,'Alpha renamed');
  for(const k of ['aliases_json','git_remotes_json','repo_fingerprints_json','path_hints_json','created_at','user_id'])assert.equal(after[k],before[k],k);
  assert.ok(after.updated_at>before.updated_at);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY task_id').all(f.alpha.project_id),tasksBefore,'tasks keep their canonical snapshot');
  const audit=f.store.db.prepare("SELECT metadata_json FROM audit_events WHERE action='project.update' AND target_id=? ORDER BY created_at DESC LIMIT 1").get(f.alpha.project_id);
  assert.deepEqual(JSON.parse(audit.metadata_json).fields,['name']);
});

test('CP-04: list values change by explicit add/remove within the existing limits',async t=>{
  const f=await setup(t);
  f.store.upsertProject(f.a.auth,{project_id:'project-lists',name:'Lists',aliases:Array.from({length:49},(_,k)=>`alias-${k}`)});
  let revision=(await f.listed(f.A,'project-lists')).revision;
  const update=async payload=>{const r=await f.run(f.A,'projects.update',{project_id:'project-lists',expected_revision:revision,...payload});revision=r.revision;return r;};
  await update({add:{aliases:['alias-new','alias-0'],git_remotes:['https://user:secret@example.invalid/repo.git?token=x'],path_hints:[long(4096,'/hint')]},remove:{aliases:['alias-1']}});
  const r=f.row('projects','project_id','project-lists'),aliases=JSON.parse(r.aliases_json);
  assert.equal(aliases.length,49);assert.ok(aliases.includes('alias-new'));assert.ok(!aliases.includes('alias-1'));
  assert.deepEqual(JSON.parse(r.git_remotes_json),['https://example.invalid/repo.git'],'remote credentials and query are stripped');
  assert.equal([...JSON.parse(r.path_hints_json)[0]].length,4096);
  await assert.rejects(update({remove:{aliases:['never-stored']}}),{errorCode:'FIELD_VALUE_NOT_FOUND'});
  await update({add:{aliases:['alias-fifty']}});
  await assert.rejects(update({add:{aliases:['alias-fifty-one']}}),{errorCode:'FIELD_FULL'});
  await assert.rejects(update({add:{path_hints:[long(4097,'/too-long')]}}),{errorCode:'INVALID_CONSOLE_INPUT'});
  await assert.rejects(update({add:{aliases:[long(2049,'too-long')]}}),{errorCode:'INVALID_CONSOLE_INPUT'});
  await assert.rejects(update({add:{unknown_field:['x']}}),{errorCode:'INVALID_CONSOLE_INPUT'});
  await assert.rejects(update({name:''}),{errorCode:'INVALID_CONSOLE_INPUT'});
  assert.equal(JSON.parse(f.row('projects','project_id','project-lists').aliases_json).length,50,'refused changes wrote nothing');
});

test('CP-05: a stale project revision is refused and an identical edit is unchanged',async t=>{
  const f=await setup(t);
  const listed=await f.listed(f.A,f.alpha.project_id),before=f.row('projects','project_id',f.alpha.project_id);
  // A concurrent writer (an agent upsert) changes a value the Console never loaded.
  f.store.upsertProject(f.a.auth,{project_id:f.alpha.project_id,repo_fingerprints:['fp-from-agent']});
  const changed=f.row('projects','project_id',f.alpha.project_id);
  await assert.rejects(f.run(f.A,'projects.update',{project_id:f.alpha.project_id,expected_revision:listed.revision,name:'Console rename'}),{errorCode:'PROJECT_VERSION_CHANGED'});
  assert.deepEqual(f.row('projects','project_id',f.alpha.project_id),changed);
  const fresh=await f.listed(f.A,f.alpha.project_id);
  const same=await f.run(f.A,'projects.update',{project_id:f.alpha.project_id,expected_revision:fresh.revision,name:changed.name,add:{repo_fingerprints:['fp-from-agent']}});
  assert.equal(same.status,'unchanged');assert.equal(same.revision,fresh.revision);
  assert.deepEqual(f.row('projects','project_id',f.alpha.project_id),changed);assert.notDeepEqual(changed,before);
});

test('CP-06: cross-owner identifiers are refused generically and leave foreign rows untouched',async t=>{
  const f=await setup(t);
  const foreignProject=f.row('projects','project_id',f.foreign.project_id),foreignTask=f.row('tasks','task_id',f.foreign.task_id);
  await assert.rejects(f.run(f.B,'projects.update',{project_id:f.alpha.project_id,expected_revision:'0'.repeat(32),name:'Hijack'}),{errorCode:'PROJECT_NOT_FOUND'});
  await assert.rejects(f.run(f.A,'projects.update',{project_id:f.foreign.project_id,expected_revision:'0'.repeat(32),name:'Hijack'}),{errorCode:'PROJECT_NOT_FOUND'});
  await assert.rejects(f.run(f.A,'projects.archive',{project_id:f.foreign.project_id}),{errorCode:'PROJECT_NOT_FOUND'});
  await assert.rejects(f.run(f.A,'tasks.update',{task_id:f.foreign.task_id,expected_canonical_version:1,title:'Hijack'}),{errorCode:'TASK_NOT_FOUND'});
  await assert.rejects(f.read(f.A,'task-detail',{task_id:f.foreign.task_id}),{errorCode:'TASK_NOT_FOUND'});
  assert.deepEqual(f.row('projects','project_id',f.foreign.project_id),foreignProject);assert.deepEqual(f.row('tasks','task_id',f.foreign.task_id),foreignTask);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM console_project_state').get().n,0);
});

test('CP-07: Console archive and restore are idempotent hiding only; tasks, memories and agent reads are kept',async t=>{
  const f=await setup(t);
  f.store.saveMemory(f.a.auth,{scope:'project',project_id:f.alpha.project_id,content:'Synthetic project memory kept across Console archive'});
  const counts=()=>['tasks','memories'].map(table=>f.store.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`).get(f.a.auth.user_id).n);
  const before=counts(),projectRow=f.row('projects','project_id',f.alpha.project_id);
  const archived=await f.run(f.A,'projects.archive',{project_id:f.alpha.project_id});
  assert.deepEqual({status:archived.status,archived:archived.archived,deleted:archived.deleted,console_only:archived.console_only,agent_access_changed:archived.agent_access_changed},
    {status:'archived',archived:true,deleted:false,console_only:true,agent_access_changed:false});
  assert.equal((await f.run(f.A,'projects.archive',{project_id:f.alpha.project_id})).status,'unchanged');
  // A real separate view: the active view no longer contains the project, the archive view only it.
  const active=await f.read(f.A,'projects',{limit:50}),archivedView=await f.read(f.A,'projects',{limit:50,archived:'true'});
  assert.equal(active.view,'active');assert.equal(active.projects.some(p=>p.project_id===f.alpha.project_id),false);assert.ok(active.projects.every(p=>!p.archived));
  assert.equal(archivedView.view,'archived');assert.deepEqual(archivedView.projects.map(p=>[p.project_id,p.archived]),[[f.alpha.project_id,true]]);
  assert.equal(active.archived_count,1);assert.equal(archivedView.active_count,active.active_count);
  assert.equal(active.active_count+active.archived_count,f.store.db.prepare('SELECT COUNT(*) n FROM projects WHERE user_id=?').get(f.a.auth.user_id).n);
  await assert.rejects(f.read(f.A,'projects',{archived:'all'}),{statusCode:400});
  assert.deepEqual(counts(),before);assert.deepEqual(f.row('projects','project_id',f.alpha.project_id),projectRow);
  assert.ok(f.store.listProjects(f.a.auth.user_id).some(p=>p.project_id===f.alpha.project_id),'agents still see the project');
  // Console archive state is Console-only and stays available while new handoff operations are disabled.
  new HandoffPolicy(f.store.db,{legacy:false,handoff:false});
  assert.equal((await f.run(f.A,'projects.restore',{project_id:f.alpha.project_id})).status,'restored');
  assert.equal((await f.run(f.A,'projects.restore',{project_id:f.alpha.project_id})).status,'unchanged');
  const listed=await f.listed(f.A,f.alpha.project_id);assert.equal(listed.archived,false);
  await assert.rejects(f.run(f.A,'projects.update',{project_id:f.alpha.project_id,expected_revision:listed.revision,name:'Blocked'}),{errorCode:'HANDOFF_DISABLED'});
  await assert.rejects(f.run(f.A,'tasks.update',{task_id:'task-console-rich',expected_canonical_version:1,title:'Blocked'}),{errorCode:'HANDOFF_DISABLED'});
  // Insertion order: both rows can share one millisecond timestamp.
  const audits=f.store.db.prepare("SELECT action FROM audit_events WHERE target_id=? AND action LIKE 'project.console_%' ORDER BY rowid").all(f.alpha.project_id).map(r=>r.action);
  assert.deepEqual(audits,['project.console_archive','project.console_restore']);
});

test('CP-08: a task edit merges onto the full canonical task through the normal revision path',async t=>{
  const f=await setup(t);
  const before=f.row('tasks','task_id','task-console-rich'),parent=f.row('projects','project_id',f.alpha.project_id);
  const proposal=randomUUID();
  f.store.db.prepare(`INSERT INTO task_reconciliation_proposals VALUES (?,?,?,?,1,?,NULL,'[]','[]','[]','[]','[]','{}',?,'awaiting_confirmation',?,NULL,NULL)`)
    .run(proposal,f.a.auth.user_id,'task-console-rich',f.alpha.project_id,before.canonical_version,'synthetic-fingerprint',new Date().toISOString());
  const result=await f.run(f.A,'tasks.update',{task_id:'task-console-rich',expected_canonical_version:before.canonical_version,title:'Renamed rich task',status:'paused',
    add:{aliases:['rich-alias-two']},remove:{aliases:['rich-alias-one']}});
  assert.equal(result.status,'saved');assert.equal(result.canonical_version,before.canonical_version+1);
  const after=f.row('tasks','task_id','task-console-rich');
  assert.equal(after.title,'Renamed rich task');assert.equal(after.status,'paused');assert.equal(after.goal,before.goal);
  assert.deepEqual(JSON.parse(after.aliases_json),['rich-alias-two']);
  assert.deepEqual(retainedTaskFields(after),retainedTaskFields(before),'structured fields kept exactly');
  assert.equal(after.project_id,before.project_id);assert.equal(after.project_name,before.project_name);
  assert.deepEqual(f.row('projects','project_id',f.alpha.project_id),parent,'parent project not renamed or touched');
  const revision=f.store.db.prepare('SELECT decision,canonical_version_before,canonical_version_after,operations_json FROM task_canonical_revisions WHERE task_id=? ORDER BY canonical_version_after DESC LIMIT 1').get('task-console-rich');
  assert.deepEqual({decision:revision.decision,from:revision.canonical_version_before,to:revision.canonical_version_after},{decision:'console_edit',from:before.canonical_version,to:before.canonical_version+1});
  assert.deepEqual(JSON.parse(revision.operations_json)[0].fields.sort(),['aliases','status','title']);
  assert.equal(f.row('task_reconciliation_proposals','proposal_id',proposal).status,'stale','awaiting proposal is staled, never confirmed');
  const detail=await f.read(f.A,'task-detail',{task_id:'task-console-rich'});
  assert.deepEqual(detail.retained,{progress:2,decisions:1,blockers:1,next_steps:1,resources:1,workstreams:1,conflicts:1});
});

test('CP-09: stale, unchanged and over-long task edits are handled without writes',async t=>{
  const f=await setup(t);
  const before=f.row('tasks','task_id','task-console-rich'),revisions=()=>f.store.db.prepare('SELECT COUNT(*) n FROM task_canonical_revisions WHERE task_id=?').get('task-console-rich').n;
  await assert.rejects(f.run(f.A,'tasks.update',{task_id:'task-console-rich',expected_canonical_version:before.canonical_version+1,title:'Stale'}),{errorCode:'TASK_VERSION_CHANGED'});
  // A real writer (an agent's canonical upsert) lands between the Console read and its save.
  const seen=await f.read(f.A,'task-detail',{task_id:'task-console-rich'});
  f.store.upsertTask(f.a.auth,{...f.store.taskFromRow(before),blockers:['blocker added by an agent']});
  const agentRow=f.row('tasks','task_id','task-console-rich');assert.equal(agentRow.canonical_version,seen.canonical_version+1);
  await assert.rejects(f.run(f.A,'tasks.update',{task_id:'task-console-rich',expected_canonical_version:seen.canonical_version,goal:'Console goal over a stale view'}),{errorCode:'TASK_VERSION_CHANGED'});
  assert.deepEqual(f.row('tasks','task_id','task-console-rich'),agentRow,'the agent write is kept and nothing else is written');
  // After reloading, a goal edit succeeds through the normal canonical path and keeps the agent's blocker.
  const goal=await f.run(f.A,'tasks.update',{task_id:'task-console-rich',expected_canonical_version:agentRow.canonical_version,goal:'Console goal after reload'});
  assert.equal(goal.status,'saved');assert.equal(goal.canonical_version,agentRow.canonical_version+1);
  const edited=f.row('tasks','task_id','task-console-rich');assert.equal(edited.goal,'Console goal after reload');assert.equal(edited.blockers_json,agentRow.blockers_json);
  assert.deepEqual(JSON.parse(f.store.db.prepare('SELECT operations_json FROM task_canonical_revisions WHERE task_id=? ORDER BY canonical_version_after DESC LIMIT 1').get('task-console-rich').operations_json)[0].fields,['goal']);
  Object.assign(before,edited);const count=revisions();
  const same=await f.run(f.A,'tasks.update',{task_id:'task-console-rich',expected_canonical_version:before.canonical_version,title:before.title,status:before.status});
  assert.equal(same.status,'unchanged');assert.equal(revisions(),count);assert.deepEqual(f.row('tasks','task_id','task-console-rich'),before);
  await assert.rejects(f.run(f.A,'tasks.update',{task_id:'task-console-rich',expected_canonical_version:before.canonical_version,status:'deleted'}),{errorCode:'INVALID_CONSOLE_INPUT'});
  await assert.rejects(f.run(f.A,'tasks.update',{task_id:'task-console-rich',expected_canonical_version:before.canonical_version,progress:[]}),{errorCode:'INVALID_CONSOLE_INPUT'},'retained fields cannot be sent');
  // A stored goal longer than the Console edit bound is shown as not editable and kept; other fields still edit.
  f.store.upsertTask(f.a.auth,{...f.store.taskFromRow(f.row('tasks','task_id','task-console-rich')),goal:long(9000,'long goal')});
  const longRow=f.row('tasks','task_id','task-console-rich');
  const detail=await f.read(f.A,'task-detail',{task_id:'task-console-rich'});assert.equal(detail.goal_complete,false);assert.equal([...detail.goal].length,8000);
  await assert.rejects(f.run(f.A,'tasks.update',{task_id:'task-console-rich',expected_canonical_version:longRow.canonical_version,goal:'Short goal'}),{errorCode:'FIELD_TOO_LONG_TO_EDIT'});
  const titled=await f.run(f.A,'tasks.update',{task_id:'task-console-rich',expected_canonical_version:longRow.canonical_version,title:'Title still editable'});
  assert.equal(titled.status,'saved');assert.equal(f.row('tasks','task_id','task-console-rich').goal,longRow.goal,'long goal kept exactly');
});

test('CP-10: only full Console write credentials may edit; replays are idempotent per operation',async t=>{
  const f=await setup(t);
  const basic=f.consoleAuth(f.a.auth.user_id,CONSOLE_BASIC_SCOPES),listed=await f.listed(f.A,f.alpha.project_id);
  await assert.rejects(f.run(basic,'projects.update',{project_id:f.alpha.project_id,expected_revision:listed.revision,name:'Basic'}),{statusCode:403});
  await assert.rejects(f.run(basic,'projects.archive',{project_id:f.alpha.project_id}),{statusCode:403});
  assert.equal(f.store.consoleService.capabilities(basic).actions.includes('tasks.update'),false);
  assert.ok(f.store.consoleService.capabilities(f.A).actions.includes('tasks.update'));
  const operation=randomUUID(),payload={project_id:f.alpha.project_id,expected_revision:listed.revision,name:'Replay-safe rename'};
  const first=await f.run(f.A,'projects.update',payload,operation),again=await f.run(f.A,'projects.update',payload,operation);
  assert.equal(first.replayed,false);assert.equal(again.replayed,true);assert.equal(again.revision,first.revision);
  await assert.rejects(f.run(f.A,'projects.update',{...payload,name:'Different payload'},operation),{errorCode:'IDEMPOTENCY_CONFLICT'});
  // A non-Console credential (even with admin:tasks) has no Console routes.
  await assert.rejects(f.read(f.a.auth,'projects'),{statusCode:403});
});

test('CP-11: task detail is bounded and names the current parent project while keeping the stored snapshot',async t=>{
  const f=await setup(t);
  const listed=await f.listed(f.A,f.alpha.project_id);
  await f.run(f.A,'projects.update',{project_id:f.alpha.project_id,expected_revision:listed.revision,name:'Alpha current name'});
  const detail=await f.read(f.A,'task-detail',{task_id:'task-console-rich'});
  assert.equal(detail.project_name,'Alpha current name');assert.equal(detail.project_name_snapshot,f.alpha.project_name);
  assert.ok(Buffer.byteLength(JSON.stringify(detail))<RESPONSE_LIMIT);
  for(const key of ['progress','workstreams','conflicts'])assert.equal(key in detail,false,`${key} values are not returned`);
  // A large stored legacy record (an admin task upsert accepts these) stays readable within the transport bound.
  const huge=long(300000,'legacy project name'),hugeStatus=long(300000,'legacy-status');
  f.store.upsertTask(f.a.auth,{task_id:'task-huge-legacy',project_id:'project-huge-legacy',project_name:huge,title:'Huge legacy task',goal:'Synthetic',status:hugeStatus});
  const stored=f.row('tasks','task_id','task-huge-legacy'),storedProject=f.row('projects','project_id','project-huge-legacy');
  const big=await f.read(f.A,'task-detail',{task_id:'task-huge-legacy'});
  assert.ok(Buffer.byteLength(JSON.stringify(big))<RESPONSE_LIMIT,'detail of a huge legacy record stays under 256 KiB');
  assert.deepEqual([big.project_name_complete,big.project_name_snapshot_complete,big.status_complete,big.status_editable],[false,false,false,false]);
  assert.equal([...big.project_name].length,200);
  const page=await f.read(f.A,'projects',{limit:50}),row=page.projects.find(p=>p.project_id==='project-huge-legacy');
  assert.ok(Buffer.byteLength(JSON.stringify(page))<RESPONSE_LIMIT);assert.equal(row.name_complete,false);assert.equal([...row.name].length,200);
  assert.deepEqual(f.row('tasks','task_id','task-huge-legacy'),stored);assert.deepEqual(f.row('projects','project_id','project-huge-legacy'),storedProject,'reads never change stored values');
  // Other fields of such a record still edit, and the oversized status is kept as stored.
  const titled=await f.run(f.A,'tasks.update',{task_id:'task-huge-legacy',expected_canonical_version:stored.canonical_version,title:'Huge legacy task renamed'});
  assert.equal(titled.status,'saved');assert.equal(f.row('tasks','task_id','task-huge-legacy').status,hugeStatus);
});

test('CP-13: a task upsert carrying a stale project name never reverts a project rename',async t=>{
  const f=await setup(t);
  const listed=await f.listed(f.A,f.alpha.project_id);
  await f.run(f.A,'projects.update',{project_id:f.alpha.project_id,expected_revision:listed.revision,name:'Renamed in Console'});
  const renamed=f.row('projects','project_id',f.alpha.project_id);
  // An agent writes its task back with the snapshot it holds (the old project name).
  const task=f.store.taskFromRow(f.row('tasks','task_id',f.alpha.task_id));assert.equal(task.project_name,f.alpha.project_name);
  const saved=f.store.upsertTask(f.a.auth,{...task,blockers:['agent change']});
  assert.equal(saved.status,'saved');
  assert.deepEqual(f.row('projects','project_id',f.alpha.project_id),renamed,'the project keeps its Console name and every other field');
  assert.equal(f.row('tasks','task_id',f.alpha.task_id).project_name,f.alpha.project_name,'the task keeps its own snapshot');
  // The same through HTTP POST /v1/tasks.
  const http=await f.request('POST','/v1/tasks',{...task,goal:'agent goal change'},f.a);
  assert.equal(http.status,200);assert.equal(f.row('projects','project_id',f.alpha.project_id).name,'Renamed in Console');
  // Controls: explicit renames still work; a task upsert still creates a new project with its name.
  f.store.upsertProject(f.a.auth,{project_id:f.alpha.project_id,name:'Renamed by POST /v1/projects'});
  assert.equal(f.row('projects','project_id',f.alpha.project_id).name,'Renamed by POST /v1/projects');
  f.store.upsertTask(f.a.auth,{task_id:'task-new-project',project_id:'project-created-by-task',project_name:'Created by task upsert',title:'New',goal:'Synthetic'});
  assert.equal(f.row('projects','project_id','project-created-by-task').name,'Created by task upsert');
  assert.equal(f.row('projects','project_id','project-created-by-task').user_id,f.a.auth.user_id);
  // Owner checks are unchanged: a foreign project ID is still refused and stays untouched.
  const foreign=f.row('projects','project_id',f.foreign.project_id);
  assert.throws(()=>f.store.upsertTask(f.a.auth,{task_id:'task-foreign-claim',project_id:f.foreign.project_id,project_name:'Claim',title:'x',goal:'x'}),{errorCode:'IDENTIFIER_UNAVAILABLE'});
  assert.throws(()=>f.store.ensureProject(f.a.auth,f.foreign.project_id,'Claim'),{errorCode:'IDENTIFIER_UNAVAILABLE'});
  assert.deepEqual(f.row('projects','project_id',f.foreign.project_id),foreign);
  assert.equal(f.store.db.isTransaction,false);
});

test('CP-12: Console edits and reads never cross the Phase 1 global identifier boundary',async t=>{
  const f=await setup(t);
  // The foreign owner's IDs remain unavailable to an owner's admin upsert after Console activity.
  await f.run(f.A,'projects.archive',{project_id:f.alpha.project_id});
  assert.throws(()=>f.store.upsertProject(f.a.auth,{project_id:f.foreign.project_id,name:'Claim'}),{errorCode:'IDENTIFIER_UNAVAILABLE'});
  assert.throws(()=>f.store.upsertTask(f.a.auth,{task_id:f.foreign.task_id,project_id:f.alpha.project_id,project_name:'x',title:'x',goal:'x'}),{errorCode:'IDENTIFIER_UNAVAILABLE'});
  assert.equal(f.store.db.isTransaction,false);
});
