import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {memoryFixture} from './helpers/core-memory-fixture.mjs';
import {consoleRead} from '../lib/console-read.mjs';
import {CONSOLE_WRITE_SCOPES,CONSOLE_READ_SCOPES} from '../../shared/console-contract.mjs';
const consoleAuth=auth=>({...auth,agent_id:'mnemuron-console',scopes:[...CONSOLE_WRITE_SCOPES]});

test('search feedback uses a private owner fingerprint, exact returned revision and idempotent non-ranking votes',async t=>{
 const f=await memoryFixture(t),{store}=f,auth=consoleAuth(f.a.auth);
 const own=store.saveMemory(f.a.auth,{scope:'user',content:'Synthetic private keyword graphfixture.'}).memory;
 const response=await consoleRead(store,auth,'memories',{query:'graphfixture',mode:'lexical'});
 assert.equal(response.results[0].memory_id,own.memory_id);assert.equal(response.results[0].revision,1);
 const context=response.feedback_context,decoded=Buffer.from(context.token.split('.')[0],'base64url').toString();
 assert.doesNotMatch(decoded,/graphfixture|Synthetic private/);assert.equal(context.stores_query_text,false);
 const payload={search_token:context.token,memory_id:own.memory_id,revision:1,feedback:'relevant'},operation=randomUUID();
 const act=(p,id=randomUUID())=>store.consoleService.execute(auth,{action:'search.feedback',operation_id:id,payload:p});
 const saved=await act(payload,operation);assert.equal(saved.status,'saved');assert.equal(saved.ranking_changed,false);
 assert.equal((await act(payload,operation)).replayed,true);
 await act({...payload,feedback:'irrelevant'});
 const read=store.consoleService.searchFeedback.read(auth,{});assert.equal(read.total,1);assert.equal(read.items[0].feedback,'irrelevant');
 assert.equal(read.metric_basis,'explicit_human_feedback_not_benchmark_accuracy');assert.equal(read.groups[0].effective_mode,'lexical');
 assert.doesNotMatch(JSON.stringify(store.db.prepare('SELECT * FROM console_search_feedback').all()),/graphfixture|Synthetic private/);
 assert.doesNotMatch(JSON.stringify(store.db.prepare('SELECT * FROM console_operations').all()),/graphfixture|Synthetic private/);
 assert.equal(store.consoleService.memory(auth,own.memory_id).row.content,'Synthetic private keyword graphfixture.');
});

test('feedback enforces account, displayed-result, lifecycle and current revision at write time',async t=>{
 const f=await memoryFixture(t),{store}=f,auth=consoleAuth(f.a.auth),other=consoleAuth(f.other.auth);
 const own=store.saveMemory(f.a.auth,{scope:'project',project_id:f.alpha.project_id,content:'Synthetic feedbackneedle topology.'}).memory;
 const foreign=store.saveMemory(f.other.auth,{scope:'user',content:'Synthetic feedbackneedle foreign.'}).memory;
 const response=await consoleRead(store,auth,'memories',{query:'feedbackneedle',mode:'lexical'}),payload={search_token:response.feedback_context.token,memory_id:own.memory_id,revision:1,feedback:'outdated'};
 const act=(a,p)=>store.consoleService.execute(a,{action:'search.feedback',operation_id:randomUUID(),payload:p});
 await assert.rejects(act(other,payload),e=>e.errorCode==='INVALID_CONSOLE_INPUT');
 await assert.rejects(act(auth,{...payload,memory_id:foreign.memory_id}),e=>e.errorCode==='MEMORY_NOT_FOUND');
 await assert.rejects(act({...auth,scopes:[...CONSOLE_READ_SCOPES]},payload));
 await assert.rejects(act(auth,{...payload,feedback:'missing'}),e=>e.errorCode==='SEARCH_FEEDBACK_RESULT_MISMATCH');
 const late=store.saveMemory(f.a.auth,{scope:'user',content:'Synthetic record not in search.'}).memory;
 await assert.rejects(act(auth,{...payload,memory_id:late.memory_id}),e=>e.errorCode==='SEARCH_FEEDBACK_RESULT_MISMATCH');
 await act(auth,payload);
 store.retractMemory(f.a.auth,own.memory_id,{reason:'Synthetic changed revision.'});
 await assert.rejects(act(auth,payload),e=>e.errorCode==='MEMORY_VERSION_CHANGED');
 assert.equal(store.consoleService.searchFeedback.read(auth,{}).items[0].revision_current,0);
 store.db.prepare("INSERT OR REPLACE INTO project_lifecycle VALUES (?,?,'deleted',NULL,1,?)").run(auth.user_id,f.alpha.project_id,new Date().toISOString());
 assert.equal(store.consoleService.searchFeedback.read(auth,{}).total,0,'deleted-project feedback is hidden before counts/paging');
 await assert.rejects(act(auth,payload),e=>e.errorCode==='PROJECT_DELETED');
});

test('missing feedback may be unbound or explicitly identify owned expected memory, never claims recall',async t=>{
 const f=await memoryFixture(t),{store}=f,auth=consoleAuth(f.a.auth);
 const expected=store.saveMemory(f.a.auth,{scope:'user',content:'Synthetic expected memory.'}).memory;
 const search=await consoleRead(store,auth,'memories',{query:'unfindable synthetic term',mode:'lexical'}),token=search.feedback_context.token;
 assert.equal(search.results.length,0);
 const act=payload=>store.consoleService.execute(auth,{action:'search.feedback',operation_id:randomUUID(),payload:{search_token:token,feedback:'missing',...payload}});
 const unspecified=await act({});assert.equal(unspecified.memory_id,undefined);
 await act({memory_id:expected.memory_id,revision:1});
 const view=await consoleRead(store,auth,'search-feedback',{query_fingerprint:search.feedback_context.query_fingerprint});
 assert.equal(view.total,2);assert.ok(view.items.every(row=>row.feedback==='missing'&&row.rank===null&&row.result_count===0));
 assert.equal(store.consoleService.searchFeedback.read(consoleAuth(f.other.auth),{}).total,0);
 const fresh=await consoleRead(store,auth,'memories',{query:'unfindable synthetic term',mode:'lexical'});
 assert.equal(fresh.feedback_context.query_fingerprint,search.feedback_context.query_fingerprint);
 const other=await consoleRead(store,consoleAuth(f.other.auth),'memories',{query:'unfindable synthetic term',mode:'lexical'});
 assert.notEqual(other.feedback_context.query_fingerprint,search.feedback_context.query_fingerprint);
});

test('expired/tampered/malformed feedback fails closed, and filtering/paging is explicit',async t=>{
 const f=await memoryFixture(t),{store}=f,auth=consoleAuth(f.a.auth),feedback=store.consoleService.searchFeedback;
 const old=feedback.context(auth,{query:'Synthetic old ticket'},{results:[],offset:0,retrieval:{effective_mode:'lexical'}},0);
 assert.throws(()=>feedback.apply(auth,{search_token:old.feedback_context.token,feedback:'missing'}),e=>e.errorCode==='SEARCH_FEEDBACK_EXPIRED');
 assert.throws(()=>feedback.apply(auth,{search_token:old.feedback_context.token+'bad',feedback:'missing'}),e=>e.errorCode==='INVALID_CONSOLE_INPUT');
 assert.throws(()=>feedback.read(auth,{query_fingerprint:'raw query'}),e=>e.errorCode==='INVALID_CONSOLE_INPUT');
 assert.throws(()=>feedback.read(auth,{limit:'100'}),e=>e.errorCode==='INVALID_CONSOLE_INPUT');
 assert.equal((await consoleRead(store,auth,'memories',{})).feedback_context,undefined,'browse creates no query context');
 for(let i=0;i<3;i++){const context=feedback.context(auth,{query:`Synthetic query ${i}`},{results:[],retrieval:{requested_mode:'semantic',effective_mode:'lexical',degraded:true}});feedback.apply(auth,{search_token:context.feedback_context.token,feedback:'missing'});}
 const page=feedback.read(auth,{limit:'2'});assert.equal(page.total,3);assert.equal(page.next_offset,2);assert.equal(page.items.length,2);assert.equal(page.groups[0].requested_mode,'semantic');
 assert.equal(page.groups[0].effective_mode,'lexical');assert.ok(page.items.every(row=>row.degraded===1));
 assert.equal(feedback.read(auth,{offset:'2',limit:'2'}).next_offset,null);
});

test('a source change between display read and context signing cannot relabel an old body with a newer revision',async t=>{
 const f=await memoryFixture(t),{store}=f,auth=consoleAuth(f.a.auth);
 const memory=store.saveMemory(auth,{scope:'user',content:'Synthetic displayrace evidence.'}).memory;
 const displayed=await consoleRead(store,auth,'memories',{query:'displayrace',mode:'lexical'});
 store.retractMemory(auth,memory.memory_id,{reason:'Synthetic independent source change.'});
 const context=store.consoleService.searchFeedback.context(auth,{query:'displayrace'},displayed);
 assert.equal(context.results[0].revision,1,'the snapshot revision travels with its displayed body');
 const signed=JSON.parse(Buffer.from(context.feedback_context.token.split('.')[0],'base64url').toString());assert.equal(signed.results[0].revision,1);
 assert.throws(()=>store.consoleService.searchFeedback.apply(auth,{search_token:context.feedback_context.token,memory_id:memory.memory_id,revision:1,feedback:'relevant'}),e=>e.errorCode==='MEMORY_VERSION_CHANGED');
});
