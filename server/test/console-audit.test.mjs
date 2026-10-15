import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryFixture} from './helpers/core-memory-fixture.mjs';
import {consoleRead} from '../lib/console-read.mjs';
import {auditPage} from '../lib/console/audit.mjs';
import {auditQuery,auditKind,AUDIT_QUERY_REFS} from '../../shared/console-queries.mjs';
import {CONSOLE_READ_SCOPES} from '../../shared/console-contract.mjs';

const page=(f,q={})=>auditPage(f.store,f.a.auth.user_id,auditQuery(q));
const memory=(f,owner=f.a,scope={scope:'user'},content='Visible title. PRIVATE BODY SHOULD NOT LEAVE AUDIT')=>f.store.saveMemory(owner.auth,{...scope,content}).memory;

test('Audit projection: recorded actor, current owned titles and no foreign/deleted content or private metadata',async t=>{
 const f=await memoryFixture(t),own=memory(f),foreign=memory(f,f.other),deleted=memory(f,f.a,{scope:'project',project_id:f.alpha.project_id},'Deleted private title.'),missing='synthetic-missing-memory';
 f.store.db.prepare("INSERT INTO project_lifecycle VALUES (?,?,'deleted',NULL,1,?)").run(f.a.auth.user_id,f.alpha.project_id,new Date().toISOString());
 f.store.audit({auth:f.a.auth,action:'memory.query',metadata:{result_refs_kind:'lexical_subquery',result_refs:[own.memory_id,foreign.memory_id,deleted.memory_id,missing],result_count:4,query:'PRIVATE QUERY',key_hash:'PRIVATE HASH',content:'PRIVATE BODY'}});
 const d=page(f,{action:'memory.query'}),row=d.entries[0];
 assert.equal(row.credential_id,f.a.auth.credential_id);assert.equal(row.kind,'read');assert.deepEqual(row.query.result_refs,[own.memory_id,foreign.memory_id,deleted.memory_id,missing]);
 assert.deepEqual(Object.keys(d.memories),[own.memory_id]);assert.equal(d.memories[own.memory_id].title,'Visible title');
 assert.equal(d.credentials[row.credential_id].agent_instance_id,f.a.auth.agent_instance_id);
 assert.doesNotMatch(JSON.stringify(d),/PRIVATE|Deleted private|key_hash|metadata_json|scopes_json|api_key|content"/);
 assert.equal(page(f,{action:'memory.create'}).entries.some(e=>e.target_id===foreign.memory_id),false);
 // The recorded foreign reference can survive, but never its credentials, title or link.
 f.store.audit({auth:{...f.a.auth,credential_id:f.other.auth.credential_id},action:'memory.read',targetType:'memory',targetId:foreign.memory_id});
 const foreignActor=page(f,{action:'memory.read'});assert.deepEqual(Object.keys(foreignActor.credentials),[]);assert.deepEqual(Object.keys(foreignActor.memories),[]);
 const reader=f.store.issueCredential({userId:f.a.auth.user_id,label:'Synthetic console',deviceId:'synthetic',agentId:'mnemuron-console',agentInstanceId:'console-audit',scopes:CONSOLE_READ_SCOPES});
 const response=await consoleRead(f.store,f.store.authenticate(reader.api_key),'audit',{});assert.equal(response.source,'core');
 await assert.rejects(consoleRead(f.store,f.store.authenticate(reader.api_key),'audit',{source:'identity'}),/Unknown console query/);
});

test('Audit provenance: unknown old rows are distinct from empty results; refs, metadata and stable IDs are bounded',async t=>{
 const f=await memoryFixture(t),ids=Array.from({length:25},(_,n)=>`synthetic-ref-${n}`);
 for(const metadata of [null,{result_count:4},{result_refs:ids},{result_refs_kind:'lexical_subquery',result_refs:[]},{result_refs_kind:'lexical_subquery',result_refs:ids}])f.store.audit({auth:f.a.auth,action:'memory.query',metadata});
 f.store.audit({auth:{user_id:f.a.auth.user_id},action:'memory.read'});
 const rows=page(f,{action:'memory.query'}).entries;
 assert.equal(rows.filter(r=>r.query.result_refs===null).length,3);assert.equal(rows.filter(r=>r.query.result_refs?.length===0).length,1);
 const bounded=rows.find(r=>r.query.result_refs?.length===AUDIT_QUERY_REFS);assert.equal(bounded.query.result_refs_truncated,true);assert.equal(bounded.query.result_refs_kind,'lexical_subquery');
 assert.equal(page(f,{action:'memory.read'}).entries[0].credential_id,null);
 const long='a'.repeat(128),issued=f.store.issueCredential({userId:f.a.auth.user_id,label:'Synthetic label',deviceId:long,agentId:long,agentInstanceId:long,scopes:['memory:read']});
 const d=page(f,{action:'credential.issue'});assert.equal(d.credentials[issued.credential.credential_id].agent_instance_id,long);
});

test('Audit instrumentation: real reads and lexical subqueries record IDs, never query text or bodies',async t=>{
 const f=await memoryFixture(t),m=memory(f,f.a,{scope:'user'},'Synthetic searchable title. PRIVATE SECRET BODY.');
 f.store.queryMemories(f.a.auth,{query:'Synthetic',limit:50});f.store.memoryDetail(f.a.auth,m.memory_id,{content_limit:10});
 const d=page(f,{action:'memory.query'});assert.deepEqual(d.entries[0].query.result_refs,[m.memory_id]);assert.equal(d.entries[0].query.result_count,1);
 const read=page(f,{action:'memory.read'}).entries[0];assert.equal(read.target_id,m.memory_id);assert.equal(read.kind,'read');
 const raw=f.store.db.prepare("SELECT metadata_json FROM audit_events WHERE action='memory.query' AND user_id=?").get(f.a.auth.user_id).metadata_json;
 assert.doesNotMatch(raw,/Synthetic|PRIVATE|query_text|content/);
});

test('Audit paging, inclusive UTC dates and exact filters remain within the owner stream',async t=>{
 const f=await memoryFixture(t);f.store.db.prepare('DELETE FROM audit_events WHERE user_id=?').run(f.a.auth.user_id);
 for(let n=0;n<5;n++){f.store.audit({auth:f.a.auth,action:n===4?'memory.create':'memory.read',outcome:n===3?'failure':'success'});}
 f.store.db.prepare('UPDATE audit_events SET created_at=? WHERE user_id=?').run('2026-10-08T01:00:00.000Z',f.a.auth.user_id);
 const p1=page(f,{limit:2}),p2=page(f,{limit:2,offset:2}),p3=page(f,{limit:2,offset:4});
 assert.equal(p1.next_offset,2);assert.equal(p2.next_offset,4);assert.equal(p3.next_offset,null);assert.equal(new Set([...p1.entries,...p2.entries,...p3.entries].map(e=>e.audit_id)).size,5);
 const filtered=page(f,{action:'memory.read',outcome:'success',from:'2026-10-08T01:00:00Z',to:'2026-10-08T01:00:00.000Z'});assert.equal(filtered.entries.length,3);
 for(const q of [{source:'merged'},{limit:101},{offset:-1},{action:'memory%'},{from:'2026-02-30T00:00:00Z'},{from:'2026-10-09T00:00:00Z',to:'2026-10-08T00:00:00Z'},{user_id:'other'}])assert.throws(()=>auditQuery(q));
 assert.equal(auditKind('console.unknown.future'),'other');assert.equal(auditKind('memory.create_preview'),'other');assert.equal(auditKind('console.jobs.reschedule'),'write');assert.equal(auditKind('console.models.test'),'other');assert.equal(auditKind('console.memory.create'),'write');assert.equal(auditKind('console.read.memories'),'read');
});


test('Audit title lookup bound preserves recorded references and signals that names are incomplete',async t=>{
 const f=await memoryFixture(t);
 for(let n=0;n<26;n++)f.store.audit({auth:f.a.auth,action:'memory.query',metadata:{result_refs_kind:'lexical_subquery',result_refs:Array.from({length:20},(_,i)=>`synthetic-memory-${n}-${i}`)}});
 const d=page(f,{action:'memory.query',limit:100});assert.equal(d.memory_titles_truncated,true);assert.equal(d.entries.flatMap(e=>e.query.result_refs).length,520);assert.deepEqual(Object.keys(d.memories),[]);
});
