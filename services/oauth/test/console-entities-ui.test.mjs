import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {text,catalog} from '../../../web/console/catalog.mjs';
import {anchorCurrent,entityCurrent,entitySourceView,entitySummaryView,proposalView,entitiesPendingView,entityMemoryView} from '../../../web/console/entities.mjs';
import {libraryView} from '../../../web/console/visuals.mjs';
import {ConsoleCore} from '../src/console-core.mjs';
const t=k=>text(k,'en');
const source={current:true,memory_id:'memory-a',revision:2,current_revision:2,status:'active',content:'Current source proof',source_kind:'synthetic',created_at:'2026-10-01T00:00:00Z',context:{kind:'session',project_id:null,session_id:'session-a'}};
const entity={entity_id:'entity-a',name:'Ali',kind:'server',state:'current',confirmable:true,expected_version:'version-a',anchor:source};
const proposal={proposal_id:'proposal-a',state:'pending',relation:'same_entity',source:entity,target:{...entity,entity_id:'entity-b',anchor:{...source,memory_id:'memory-b',context:{kind:'project',project_id:'project-b',project_name:'Production'}}},confirmable:true,expected_version:'version-a'};
const caps={allowed_actions:['entity.create','entity.link','entity.resolve']};
test('Entity source text requires the exact active revision; stale/inactive text and links never render',()=>{
 assert.equal(anchorCurrent(source),true);assert.equal(entityCurrent(entity),true);
 for(const a of [{...source,current:false},{...source,current_revision:3},{...source,status:'retracted'},{...source,current_revision:null},{...source,revision:'2'}]){
  const html=entitySourceView(t,a);assert.equal(anchorCurrent(a),false);assert.doesNotMatch(html,/Current source proof|data-memory=/);
 }
 assert.match(entitySourceView(t,source),/Current source proof/);
});
test('Equal-name entities show context, source kind, date and revision; identifiers stay secondary',()=>{
 const html=proposalView(t,proposal,caps);assert.equal((html.match(/class="entity-name">Ali/g)||[]).length,2);
 assert.match(html,/Production/);assert.match(html,/session-a/);assert.match(html,/synthetic/);assert.match(html,/2 \/ 2/);assert.match(html,/Internal references \(secondary\)/);
 assert.match(html,/No associated project/);assert.doesNotMatch(html,/User scope/);
 assert.match(entitySourceView(t,{...source,context:{kind:'user'}}),/User scope/);
});
test('Stale and resolved proposals disable confirmation and rejection, and relationship copy does not promise search expansion',()=>{
 for(const p of [{...proposal,confirmable:false},{...proposal,state:'accepted'}]){
  const html=proposalView(t,p,caps);assert.match(html,/data-entity-resolve="accept"[^>]* disabled/);assert.match(html,/data-entity-resolve="reject"[^>]* disabled/);
 }
 assert.match(proposalView(t,{...proposal,relation:'related'},caps),/does not expand search/);
 assert.doesNotMatch(proposalView(t,proposal,{}),/data-entity-resolve/);
});
test('Entity user text is escaped throughout names, sources, context and confirmation targets',()=>{
 const html=entitySummaryView(t,{...entity,name:'<img onerror=alert(1)>',anchor:{...source,content:'<script>x</script>',context:{project_name:'<unsafe>'}}});
 assert.doesNotMatch(html,/<img|<script|<unsafe>/);assert.match(html,/&lt;img/);assert.match(html,/&lt;script/);
});
test('MEM-08 pending card has bounded paging, source distinctions and failure/empty states',()=>{
 const html=entitiesPendingView(t,{proposals:[proposal],proposal_total:11,offset:10,limit:10,next_offset:20,truncated:true},caps);
 assert.match(html,/data-feature="MEM-08"/);assert.match(html,/data-entity-pending-page="0"/);assert.match(html,/data-entity-pending-page="20"/);assert.match(html,/Production/);assert.match(html,/Results are incomplete/);
 assert.match(entitiesPendingView(t,null,caps),/data-i18n="unavailable"/);assert.match(entitiesPendingView(t,{proposals:[]},caps),/No pending associations/);
});
test('Memory panel respects independent create/link capabilities and active lifecycle',()=>{
 assert.match(entityMemoryView(t,{entities:[]},{allowed_actions:['entity.link']},{status:'active',current:true}),/data-entity-link-existing/);
 assert.doesNotMatch(entityMemoryView(t,{entities:[]},{allowed_actions:['entity.link']},{status:'active',current:true}),/data-entity-create/);
 assert.doesNotMatch(entityMemoryView(t,{entities:[]},caps,{status:'retracted'}),/data-entity-create|data-entity-link-existing/);
});
test('Original-query ranking explains exact, terms and aliases without merging ambiguity and truncation notices',()=>{
 const results=['raw_query','original_terms','alias'].map((match_kind,i)=>({memory_id:String(i),content:'Synthetic result',status:'active',ranking:{match_kind,alias:{matched_name:'ali-vps'}}}));
 const html=libraryView(t,{query:'ali-vps',data:{results,truncated:true,retrieval:{window_limited:true,candidate_limit:20,aliases:{ambiguous:true,truncated:true}}}});
 for(const key of ['entityMatchExact','entityMatchTerms','entityMatchAlias','boundedSearchNote','entitySearchAmbiguous','entitySearchTruncated'])assert.match(html,new RegExp(`data-i18n="${key}"`));
 assert.match(html,/ali-vps/);
});
test('Every entity translation exists in both languages and browser/controller assets have guarded navigation',()=>{
 for(const locale of ['zh-CN','en'])for(const key of Object.keys(catalog.en).filter(k=>k.startsWith('entity')||k.startsWith('featMEM08')))assert.ok(Object.hasOwn(catalog[locale],key),locale+'.'+key);
 const app=fs.readFileSync(new URL('../../../web/console/app.mjs',import.meta.url),'utf8');
 assert.match(app,/pendingSeq!==entityPendingSequence/);assert.match(app,/entities\?\.clearMemory\(\)/);assert.match(app,/entities\?\.clear\(\)/);assert.match(app,/sequence===detailSequence&&pane.open/);
 const controller=fs.readFileSync(new URL('../../../web/console/entities.mjs',import.meta.url),'utf8');
 assert.match(controller,/seq===sequence&&isActive\(\)&&dialog.open/);assert.match(controller,/seq===memorySequence&&isActive\(\)&&region.isConnected&&guard\(\)/);
 assert.match(controller,/role="status" tabindex="-1" data-entity-focus/);
});

test('BFF Core client explicitly allows the owner-scoped entity view and preserves its query',async()=>{
 const core=Object.create(ConsoleCore.prototype),paths=[];core.identity=async()=>({});core.request=async route=>{paths.push(route);return {read_only:true,entities:[]};};
 assert.deepEqual(await core.view('entities',{status:'pending',limit:10}),{read_only:true,entities:[]});
 assert.deepEqual(paths,['/v1/console/entities?status=pending&limit=10']);
 await assert.rejects(core.view('entity-secrets',{}),e=>e.code==='NOT_FOUND'||e.errorCode==='NOT_FOUND');
});

test('Lifecycle impact previews display additive entity totals and both locales explain bridge retirement',()=>{
 const actions=fs.readFileSync(new URL('../../../web/console/actions.mjs',import.meta.url),'utf8');
 for(const [key,field] of [['impactEntities','entities'],['impactEntityProposals','entity_proposals'],['impactPendingEntities','pending_entity_proposals']]){
  assert.ok(actions.includes(`['${key}',tt.${field}]`));for(const locale of ['zh-CN','en'])assert.ok(Object.hasOwn(catalog[locale],key));
 }
 assert.match(text('entityRetiredAliasesNote','en'),/both objects/);assert.match(text('entityRetiredAliasesNote','zh-CN'),/两个对象/);
});
