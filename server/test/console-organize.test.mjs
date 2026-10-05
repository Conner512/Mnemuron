import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomBytes,randomUUID} from 'node:crypto';
import {memoryFixture,businessSnapshot} from './helpers/core-memory-fixture.mjs';
import {CONSOLE_WRITE_SCOPES,CONSOLE_BASIC_SCOPES,CONSOLE_READ_SCOPES} from '../../shared/console-contract.mjs';
import {organizer,taxonomy as syntheticTaxonomy} from './helpers/memory-models.mjs';
import {MemoryWorker} from '../lib/memory-jobs/worker.mjs';

// Synthetic accounts and memories only; disposable loopback store per test.
async function setup(t){
  const f=await memoryFixture(t);const key=f.root+'/console.key';fs.writeFileSync(key,randomBytes(32).toString('base64url'),{mode:0o600});
  f.store.memoryConfig.console={key_file:key,worker_enabled:false};
  const issue=(user,scopes=CONSOLE_WRITE_SCOPES)=>{const c=f.store.issueCredential({userId:user,label:'Synthetic console',deviceId:'synthetic-console',agentId:'mnemuron-console',agentInstanceId:randomUUID(),scopes});return {...c,auth:f.store.authenticate(c.api_key)};};
  const A=issue(f.a.auth.user_id),B=issue(f.other.auth.user_id);
  const act=(action,payload,owner=A,operation_id=randomUUID())=>f.request('POST','/v1/console/action',{action,payload,operation_id},owner);
  const get=(view,p={},owner=A)=>f.request('GET','/v1/console/'+view+'?'+new URLSearchParams(p),undefined,owner);
  const create=async(content,owner=A,extra={})=>{const r=await act('memory.create',{content,scope:'user',memory_type:'fact',sensitivity:'sensitive',...extra},owner);assert.equal(r.status,200,JSON.stringify(r.body));return r.body.memory_id;};
  const preview=async(target,p={},owner=A)=>{const r=await get('memories',{part:'preview',target,...p},owner);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  const organize=async(target,p={},owner=A,op)=>{const pv=await preview(target,p,owner);return act('memory.organize',{category:target,...p,preview_token:pv.preview_token},owner,op);};
  const categoryOf=async(memory_id,owner=A)=>(await get('memory-meta',{memory_id},owner)).body.category;
  const taxonomy=async(owner=A)=>(await get('taxonomy',{},owner)).body;
  const importRecords=async(records,owner=A)=>{for(let i=0;i<records.length;i+=20){const r=await act('storage.import',{format:'mnemuron-personal-portable-v1',records:records.slice(i,i+20),confirm_personal_scope:true},owner);assert.equal(r.status,200,JSON.stringify(r.body));}};
  return {...f,A,B,issue,act,get,create,preview,organize,categoryOf,taxonomy,importRecords};
}
const topics=['router','billing','travel','garden','reading'];
const portable=(n,prefix='synthetic-orig')=>Array.from({length:n},(_,i)=>({original_id:`${prefix}-${i}`,revision:1,content:`Synthetic imported note ${i} about ${topics[i%5]}`,memory_type:'fact',
  status:i%20===0?'retracted':'active',topic:topics[i%5],sensitivity:'sensitive',original_scope:{scope:'user'},created_at:new Date(Date.UTC(2025,0,1)+i*86400000).toISOString()}));
const annotate=(f,user,memoryId,version,category)=>f.store.db.prepare('INSERT OR REPLACE INTO memory_annotations VALUES (?,?,?,?,?,?,?,?,?)')
  .run(user,memoryId,f.store.revisions.latest(user,memoryId).revision,version,category,'[]',null,'synthetic-profile','synthetic-job');

test('ORG-01: a large import is browsable by facets, topic, origin and original date; tombstones are counted separately',async t=>{
  const f=await setup(t);await f.importRecords(portable(300));await f.create('Synthetic console-created note');
  const facets=(await f.get('memories',{part:'facets'})).body;
  assert.equal(facets.statuses.active,286);assert.equal(facets.statuses.retracted,15);
  assert.deepEqual(facets.origins,{imported:285,other:1});
  assert.equal(facets.categories.find(c=>c.category==='uncategorized').count,286);
  assert.ok(facets.categories.every(c=>Number.isSafeInteger(c.count)),'every taxonomy category is listed, empty ones with 0');
  assert.deepEqual(facets.topics.map(x=>x.topic).sort(),[...topics].sort());assert.equal(facets.topics.find(x=>x.topic==='router').count,45,'retracted imports are not counted as active');
  assert.equal(facets.import_days.reduce((n,d)=>n+d.count,0),300);
  const router=(await f.get('memories',{topic:'router',status:'active',limit:25})).body;
  assert.equal(router.results.length,25);assert.equal(router.next_offset,25);assert.ok(router.results.every(m=>m.topic==='router'&&m.imported===true));
  assert.ok(router.results.every(m=>/^2025|^2026/.test(m.original_created_at)),'original capture dates are kept beside the import time');
  const newest=(await f.get('memories',{origin:'imported',limit:4})).body.results.map(m=>Number(m.content.match(/note (\d+)/)[1]));
  assert.deepEqual(newest,[299,298,297,296],'records written in the same second keep their import order (newest first)');
  const other=(await f.get('memories',{origin:'other'})).body.results;assert.deepEqual(other.map(m=>m.content),['Synthetic console-created note']);
  const search=(await f.get('memories',{query:'imported note',topic:'garden',status:'active',limit:50})).body;
  assert.ok(search.results.length>0&&search.results.every(m=>m.topic==='garden'));assert.equal(search.retrieval.mode,'lexical');
  for(const p of [{origin:'elsewhere'},{topic:'x'.repeat(201)},{part:'anything'},{part:'facets',topic:'router'},{target:'technical'},{memory_ids:'a'}])assert.equal((await f.get('memories',p)).status,400,JSON.stringify(p));
  assert.equal((await f.get('memories',{part:'facets'},f.B)).body.origins.imported,0);
});

test('ORG-02: one flow — preview, confirm with the preview token, batch result, undo; repeats and stale previews are safe',async t=>{
  const f=await setup(t);await f.importRecords(portable(60));
  assert.equal((await f.act('category.create',{label:'travel',expected_revision:0})).body.category,'travel');
  const pv=await f.preview('travel',{topic:'travel'});
  assert.equal(pv.matched,12);assert.equal(pv.changed,12);assert.equal(pv.unchanged,0);assert.equal(pv.applicable,true);
  assert.deepEqual(pv.by_category,[{category:'uncategorized',count:12}]);assert.equal(pv.sample.length,5);
  assert.equal((await f.get('memories',{status:'active',category:'travel'})).body.results.length,0,'a preview writes nothing');
  assert.equal((await f.act('memory.organize',{category:'travel',topic:'travel'})).body.error_code,'PREVIEW_REQUIRED');
  const op=randomUUID(),applied=await f.act('memory.organize',{category:'travel',topic:'travel',preview_token:pv.preview_token},f.A,op);
  assert.equal(applied.status,200,JSON.stringify(applied.body));assert.equal(applied.body.changed,12);assert.equal(applied.body.undo_available,true);
  const replay=await f.act('memory.organize',{category:'travel',topic:'travel',preview_token:pv.preview_token},f.A,op);
  assert.equal(replay.body.replayed,true);assert.equal(replay.body.batch_id,applied.body.batch_id);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM console_organize_batches').get().n,1,'a repeated submission does not create a second batch');
  // The same token after the selection changed (another tab filed one record) is refused.
  const again=await f.preview('preferences',{topic:'reading'});const one=(await f.get('memories',{topic:'reading',status:'active',limit:1})).body.results[0].memory_id;
  assert.equal((await f.organize('decisions',{memory_ids:one})).status,200);
  const stale=await f.act('memory.organize',{category:'preferences',topic:'reading',preview_token:again.preview_token});
  assert.equal(stale.status,409);assert.equal(stale.body.error_code,'PREVIEW_CHANGED');
  assert.equal(stale.body.error_code&&(await f.get('memories',{status:'active',category:'preferences'})).body.results.length,0,'a refused apply writes nothing');
  const travel=(await f.get('memories',{status:'active',category:'travel',limit:50})).body.results;assert.equal(travel.length,12);
  const batches=(await f.get('memories',{part:'facets'})).body.recent_batches;assert.equal(batches[0].kind,'selection');assert.equal(batches[1].batch_id,applied.body.batch_id);assert.equal(batches[1].undoable,true);
  const undone=await f.act('memory.organize_undo',{batch_id:applied.body.batch_id});
  assert.equal(undone.status,200);assert.equal(undone.body.restored,12);assert.equal(undone.body.skipped_count,0);
  assert.equal((await f.get('memories',{status:'active',category:'travel'})).body.results.length,0);
  assert.equal((await f.act('memory.organize_undo',{batch_id:applied.body.batch_id})).body.error_code,'BATCH_ALREADY_UNDONE');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM memory_category_overrides WHERE category='travel'").get().n,0,'undo restores the derived state exactly');
  // Explicit selection limits and the filter-wide limit.
  assert.equal((await f.get('memories',{part:'preview',target:'travel',memory_ids:Array.from({length:101},(_,i)=>`m-${i}`).join(',')})).status,400);
  assert.equal((await f.get('memories',{part:'preview',target:'travel'})).body.error_code,'INVALID_SELECTION','an empty filter must say "all" explicitly');
  assert.equal((await f.get('memories',{part:'preview',target:'not-a-category',topic:'travel'})).status,400);
});

test('ORG-03: organizing beyond the safe limit or a truncated search is refused instead of partially applied',async t=>{
  const f=await setup(t);
  f.store.db.exec('BEGIN');for(let i=0;i<2005;i++)f.store.saveMemory(f.A.auth,{scope:'user',content:`Synthetic bulk window marker ${i}`,topic:'bulk'});f.store.db.exec('COMMIT');
  const pv=await f.preview('technical',{topic:'bulk'});assert.equal(pv.over_limit,true);assert.equal(pv.applicable,false);assert.equal(pv.matched,2000);
  assert.equal(pv.total,2005,'the preview reports the exact number of matches, not the capped count');assert.equal(pv.limit,2000);
  assert.equal((await f.preview('technical',{topic:'bulk',query:'window marker 1'})).total>0,true);
  assert.equal((await f.act('memory.organize',{category:'technical',topic:'bulk',preview_token:pv.preview_token})).body.error_code,'SELECTION_TOO_LARGE');
  const q=await f.preview('technical',{query:'bulk window marker'});assert.equal(q.truncated,true);assert.equal(q.applicable,false);
  assert.equal((await f.act('memory.organize',{category:'technical',query:'bulk window marker',preview_token:q.preview_token})).body.error_code,'SELECTION_TRUNCATED');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memory_category_overrides').get().n,0);
});

test('ORG-04: categories have editable names, stable IDs, and edits keep model classifications visible',async t=>{
  const f=await setup(t),m=await f.create('Synthetic model-classified note'),n=await f.create('Synthetic manual note');
  let tax=await f.taxonomy();annotate(f,f.A.auth.user_id,m,tax.version,'projects');
  assert.equal(await f.categoryOf(m),'projects');
  const created=await f.act('category.create',{label:'旅行 计划',expected_revision:tax.revision});
  assert.equal(created.status,200,JSON.stringify(created.body));assert.match(created.body.category,/^c-[a-f0-9]{10}$/);assert.equal(created.body.label,'旅行 计划');
  assert.equal(await f.categoryOf(m),'projects','adding a category no longer hides model classifications');
  const ascii=await f.act('category.create',{label:'Home Network',expected_revision:created.body.revision});assert.equal(ascii.body.category,'home-network');
  assert.equal((await f.act('category.create',{label:'home network',expected_revision:ascii.body.revision})).body.error_code,'CATEGORY_EXISTS');
  assert.equal((await f.act('category.create',{label:'  ',expected_revision:ascii.body.revision})).body.error_code,'INVALID_CATEGORY_LABEL');
  assert.equal((await f.act('category.create',{label:'<b>x</b>',expected_revision:ascii.body.revision})).body.error_code,'INVALID_CATEGORY_LABEL');
  tax=await f.taxonomy();assert.deepEqual(tax.labels,{[created.body.category]:'旅行 计划','home-network':'Home Network'});
  const caps=(await f.get('capabilities')).body;assert.equal(caps.category_labels['home-network'],'Home Network');assert.ok(caps.taxonomy.categories.includes('home-network'));
  // Rename is presentation only.
  await f.organize('home-network',{memory_ids:n});
  const renamed=await f.act('category.rename',{category:'home-network',label:'Network & Wi-Fi',expected_revision:tax.revision});
  assert.equal(renamed.status,200,JSON.stringify(renamed.body));const after=await f.taxonomy();
  assert.equal(after.version,tax.version);assert.equal(after.labels['home-network'],'Network & Wi-Fi');assert.equal(await f.categoryOf(n),'home-network');
  assert.equal((await f.act('category.rename',{category:'uncategorized',label:'Inbox',expected_revision:after.revision})).body.error_code,'INVALID_CATEGORY');
  // Legacy textarea saves carry model classifications forward too.
  const legacy=await f.act('taxonomy.save',{expected_revision:after.revision,categories:[...after.categories,'synthetic']});assert.equal(legacy.status,200,JSON.stringify(legacy.body));
  assert.equal(await f.categoryOf(m),'projects');assert.equal((await f.taxonomy()).labels['home-network'],'Network & Wi-Fi');
  assert.ok(f.store.db.prepare('SELECT COUNT(*) n FROM memory_annotations WHERE memory_id=?').get(m).n>=4,'old annotation rows are preserved, never rewritten');
  assert.equal((await f.taxonomy(f.B)).labels['home-network'],undefined,'names are per account');
  // Removing a category that only model classifications use never leaves them pointing at it.
  const current=await f.taxonomy(),without=current.categories.filter(c=>c!=='projects');
  assert.equal((await f.act('taxonomy.save',{expected_revision:current.revision,categories:without})).status,200);
  assert.equal(await f.categoryOf(m),'uncategorized');assert.ok((await f.get('memories',{part:'facets'})).body.categories.every(c=>c.category!=='projects'));
});

test('ORG-05: delete-with-move (merge) moves members and model classifications, and undo restores the category',async t=>{
  const f=await setup(t),a=await f.create('Synthetic travel A'),b=await f.create('Synthetic travel B'),c=await f.create('Synthetic model travel');
  let tax=await f.taxonomy();const trip=(await f.act('category.create',{label:'Trips',expected_revision:tax.revision})).body;
  await f.organize(trip.category,{memory_ids:`${a},${b}`});tax=await f.taxonomy();annotate(f,f.A.auth.user_id,c,tax.version,trip.category);
  assert.equal(await f.categoryOf(c),trip.category);
  assert.equal((await f.act('category.delete',{category:trip.category,move_to:trip.category,expected_revision:tax.revision})).body.error_code,'INVALID_CATEGORY');
  assert.equal((await f.act('category.delete',{category:'uncategorized',move_to:'personal',expected_revision:tax.revision})).body.error_code,'INVALID_CATEGORY');
  const merged=await f.act('category.delete',{category:trip.category,move_to:'personal',expected_revision:tax.revision});
  assert.equal(merged.status,200,JSON.stringify(merged.body));assert.equal(merged.body.moved,2);
  for(const id of [a,b,c])assert.equal(await f.categoryOf(id),'personal');
  assert.ok(!(await f.taxonomy()).categories.includes(trip.category));
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memories WHERE user_id=?').get(f.A.auth.user_id).n,3,'merging never deletes memories');
  const undone=await f.act('memory.organize_undo',{batch_id:merged.body.batch_id});
  assert.equal(undone.status,200,JSON.stringify(undone.body));assert.equal(undone.body.restored_category,trip.category);assert.equal(undone.body.restored,2);
  const restored=await f.taxonomy();assert.ok(restored.categories.includes(trip.category));assert.equal(restored.labels[trip.category],'Trips');
  for(const id of [a,b,c])assert.equal(await f.categoryOf(id),trip.category,'members and model classifications come back');
});

test('ORG-06: concurrent rename/merge and undo conflicts are reported, never silently overwritten',async t=>{
  const f=await setup(t),a=await f.create('Synthetic conflict A'),b=await f.create('Synthetic conflict B');
  let tax=await f.taxonomy();
  // Two tabs read the same revision; the second write is refused.
  const first=await f.act('category.rename',{category:'technical',label:'Engineering',expected_revision:tax.revision});assert.equal(first.status,200);
  const second=await f.act('category.delete',{category:'technical',move_to:'projects',expected_revision:tax.revision});
  assert.equal(second.status,409);assert.equal(second.body.error_code,'SETTINGS_VERSION_CHANGED');assert.ok((await f.taxonomy()).categories.includes('technical'));
  // Parallel organizes from two tabs with the same preview: one applies, the other is stale.
  const pv=await f.preview('technical',{memory_ids:`${a},${b}`});
  const [x,y]=await Promise.all([f.act('memory.organize',{category:'technical',memory_ids:`${a},${b}`,preview_token:pv.preview_token}),f.act('memory.organize',{category:'technical',memory_ids:`${a},${b}`,preview_token:pv.preview_token})]);
  assert.deepEqual([x.status,y.status].sort(),[200,409]);assert.equal([x,y].find(r=>r.status===409).body.error_code,'PREVIEW_CHANGED');
  const batch1=[x,y].find(r=>r.status===200).body.batch_id;
  // A later change to one memory: undo restores the other and reports the changed one.
  const metaB=(await f.get('memory-meta',{memory_id:b})).body;await f.act('memory.classify',{memory_id:b,revision:metaB.revision,category:'decisions'});
  const partial=await f.act('memory.organize_undo',{batch_id:batch1});
  assert.equal(partial.body.restored,1);assert.deepEqual(partial.body.skipped,[{memory_id:b,reason:'CHANGED_SINCE'}]);
  assert.equal(await f.categoryOf(a),'uncategorized');assert.equal(await f.categoryOf(b),'decisions');
  // Merge, then undo the earlier move: nothing restorable → conflict, and the earlier batch stays undoable.
  tax=await f.taxonomy();const moved=await f.organize('projects',{memory_ids:a});
  const merge=await f.act('category.delete',{category:'projects',move_to:'personal',expected_revision:tax.revision});assert.equal(merge.body.moved,1);
  const conflict=await f.act('memory.organize_undo',{batch_id:moved.body.batch_id});assert.equal(conflict.status,409);assert.equal(conflict.body.error_code,'UNDO_CONFLICT');
  assert.ok(!(await f.taxonomy()).categories.includes('projects'),'a refused undo changes nothing');
  assert.equal((await f.act('memory.organize_undo',{batch_id:merge.body.batch_id})).status,200);
  const later=await f.act('memory.organize_undo',{batch_id:moved.body.batch_id});assert.equal(later.status,200,JSON.stringify(later.body));assert.equal(later.body.restored,1);
  assert.equal(await f.categoryOf(a),'uncategorized');
});

test('ORG-07: two owners stay isolated across facets, previews, organize, undo and categories',async t=>{
  const f=await setup(t),mine=await f.create('Synthetic owner A note'),theirs=await f.create('Synthetic owner B note',f.B);
  const pv=await f.preview('technical',{memory_ids:`${mine},${theirs}`});assert.equal(pv.matched,1);assert.equal(pv.missing,1);
  const applied=await f.act('memory.organize',{category:'technical',memory_ids:`${mine},${theirs}`,preview_token:pv.preview_token});assert.equal(applied.body.changed,1);
  assert.equal(await f.categoryOf(theirs,f.B),'uncategorized');
  const all=await f.preview('technical',{all:'true'},f.B);assert.equal(all.matched,1);assert.equal(all.sample[0].memory_id,theirs);
  assert.equal((await f.act('memory.organize_undo',{batch_id:applied.body.batch_id},f.B)).status,404);
  assert.equal((await f.get('memories',{part:'facets'},f.B)).body.recent_batches.length,0);
  const tax=await f.taxonomy(),created=await f.act('category.create',{label:'A only',expected_revision:tax.revision});
  assert.ok(!(await f.taxonomy(f.B)).categories.includes(created.body.category));
  assert.equal((await f.get('memories',{part:'preview',target:created.body.category,all:'true'},f.B)).status,400);
  assert.equal((await f.act('category.delete',{category:created.body.category,move_to:'personal',expected_revision:1},f.B)).body.error_code,'INVALID_CATEGORY');
  // Read-only console credentials cannot organize; basic memory credentials can (same gate as memory.classify).
  const reader=f.issue(f.A.auth.user_id,CONSOLE_READ_SCOPES),basic=f.issue(f.A.auth.user_id,CONSOLE_BASIC_SCOPES);
  const fresh=await f.preview('personal',{memory_ids:mine});
  assert.equal((await f.act('memory.organize',{category:'personal',memory_ids:mine,preview_token:fresh.preview_token},reader)).status,403);
  assert.equal((await f.act('category.create',{label:'Nope',expected_revision:2},reader)).status,403);
  assert.equal((await f.act('memory.organize',{category:'personal',memory_ids:mine,preview_token:fresh.preview_token},basic)).status,200);
});

test('ORG-08: keep_private, secret records, original fields and writes are preserved; nothing is physically deleted',async t=>{
  const f=await setup(t);
  await f.act('privacy.defaults',{expected_revision:0,sensitivity:'secret',cloud_readable:false});
  const secret=await f.create('Synthetic secret note',f.A,{sensitivity:'secret'});
  await f.act('privacy.defaults',{expected_revision:1,sensitivity:'sensitive',cloud_readable:false});
  const privateId=await f.create('Synthetic keep-private note');
  f.store.webVisibility.keepPrivate(f.A.auth.user_id,privateId,f.store.revisions.latest(f.A.auth.user_id,privateId));
  await f.act('memory.web_policy',{read_all:true,expected_revision:0});
  const web={...f.A.auth,agent_id:'chatgpt-web'};assert.equal(f.store.webVisibility.visible(web,privateId),false);
  const snapshot=()=>({...businessSnapshot(f.store),revisions:f.store.db.prepare('SELECT * FROM memory_revisions ORDER BY rowid').all(),
    privacy:f.store.db.prepare('SELECT * FROM memory_privacy ORDER BY rowid').all(),denials:f.store.db.prepare('SELECT * FROM memory_web_denials ORDER BY rowid').all(),
    grants:f.store.db.prepare("SELECT name FROM sqlite_master WHERE name='memory_web_grants'").get()?f.store.db.prepare('SELECT * FROM memory_web_grants ORDER BY rowid').all():null});
  const before=snapshot();
  const pv=await f.preview('personal',{memory_ids:`${secret},${privateId}`});assert.equal(pv.changed,2,'secret records can be categorized locally');
  const applied=await f.act('memory.organize',{category:'personal',memory_ids:`${secret},${privateId}`,preview_token:pv.preview_token});assert.equal(applied.status,200);
  let tax=await f.taxonomy();const merged=await f.act('category.delete',{category:'personal',move_to:'decisions',expected_revision:tax.revision});assert.equal(merged.body.moved,2);
  await f.act('memory.organize_undo',{batch_id:merged.body.batch_id});await f.act('memory.organize_undo',{batch_id:applied.body.batch_id});
  const after=snapshot();
  assert.deepEqual(after,before,'memories, revisions, events, tasks, privacy and web denials are untouched by organizing');
  assert.equal(f.store.webVisibility.visible(web,privateId),false,'keep_private still rejects web reads');
  assert.equal(f.store.derivedMemory.currentSource(f.A.auth.user_id,secret),null,'secret records stay excluded from model input');
  // Correction keeps the manual category on the replacement and keeps the private denial.
  const meta=(await f.get('memory-meta',{memory_id:privateId})).body;await f.act('memory.classify',{memory_id:privateId,revision:meta.revision,category:'technical'});
  const corrected=await f.act('memory.correct',{memory_id:privateId,revision:meta.revision,content:'Synthetic keep-private note, corrected',memory_type:'fact'});
  assert.equal(await f.categoryOf(corrected.body.memory_id),'technical');assert.equal(f.store.webVisibility.visible(web,corrected.body.memory_id),false);
  assert.equal(f.store.db.prepare('PRAGMA user_version').get().user_version,7,'no schema version change');
});

test('ORG-09: existing classify and batch classify share the write path and are undoable',async t=>{
  const f=await setup(t),a=await f.create('Synthetic legacy A'),b=await f.create('Synthetic legacy B');
  const single=await f.act('memory.classify',{memory_id:a,revision:1,category:'technical'});
  assert.equal(single.status,200);assert.equal(single.body.status,'classified');assert.equal(single.body.locked,true);assert.ok(single.body.batch_id);
  const batch=await f.act('memory.batch_classify',{items:[{memory_id:a,revision:1},{memory_id:b,revision:1}],category:'projects'});
  assert.deepEqual(batch.body.results.map(r=>r.ok),[true,true]);assert.equal(batch.body.changed,2);
  assert.equal((await f.act('memory.organize_undo',{batch_id:batch.body.batch_id})).body.restored,2);
  assert.equal(await f.categoryOf(a),'technical','undo returns to the previous manual category');assert.equal(await f.categoryOf(b),'uncategorized');
  await f.act('memory.retract',{memory_id:b,revision:1});
  assert.equal((await f.act('memory.classify',{memory_id:b,revision:2,category:'technical'})).body.error_code,'INVALID_CATEGORY_TARGET');
  // Undo after a correction reports the memory as changed instead of silently editing the old version.
  const c=await f.create('Synthetic corrected later'),moved=await f.organize('decisions',{memory_ids:c});
  const fixed=await f.act('memory.correct',{memory_id:c,revision:1,content:'Synthetic corrected later, fixed',memory_type:'fact'});
  const undone=await f.act('memory.organize_undo',{batch_id:moved.body.batch_id});
  assert.equal(undone.status,409);assert.equal(undone.body.error_code,'UNDO_CONFLICT');assert.equal(await f.categoryOf(fixed.body.memory_id),'decisions');
});

test('ORG-10: a job fenced by a category change is rescheduled under the current categories; classifications are kept',async t=>{
  const f=await setup(t);f.store.memoryConfig.memory={taxonomy:syntheticTaxonomy};
  const model=organizer();model.profile=Object.freeze({...model.profile,fingerprint:'console-synthetic-profile'});f.store.consoleService.models.provider=()=>model;
  const drain=()=>new MemoryWorker(f.store,f.store.memoryJobs,model,{workerId:'synthetic-console',userId:f.A.auth.user_id,profileFilter:model.profile.fingerprint}).drain({maxJobs:10});
  const schedule=()=>f.act('jobs.schedule',{type:'classification',timezone:'UTC',periods:['daily'],include_open:true});
  const jobs=async()=>(await f.get('jobs')).body.jobs,ids=[await f.create('Synthetic job note one'),await f.create('Synthetic job note two')];
  assert.equal((await schedule()).status,200);await drain();
  for(const id of ids)assert.equal(await f.categoryOf(id),'engineering');
  const manual=await f.organize('preferences',{memory_ids:ids[1]});assert.equal(manual.status,200);
  for(const [label,edit] of [['create',rev=>f.act('category.create',{label:'Synthetic Later',expected_revision:rev})],['delete',rev=>f.act('category.delete',{category:'synthetic-later',move_to:'uncategorized',expected_revision:rev})]]){
    ids.push(await f.create(`Synthetic job note before ${label}`));
    const queued=(await schedule()).body.jobs[0];assert.equal(f.store.memoryJobs.get(queued).state,'pending');
    assert.equal((await edit((await f.taxonomy()).revision)).status,200);
    const fenced=f.store.memoryJobs.get(queued);assert.equal(fenced.state,'blocked_config');assert.equal(fenced.last_error_code,'STALE_TAXONOMY');
    const listed=(await jobs()).find(j=>j.job_id===queued);assert.equal(listed.stale_taxonomy,true,'the jobs view marks the outdated plan');
    assert.equal(await f.categoryOf(ids[0]),'engineering');assert.equal(await f.categoryOf(ids[1]),'preferences');
    assert.equal((await f.act('jobs.retry',{job_id:queued},f.B)).status,404,'another owner cannot reschedule');
    const retried=await f.act('jobs.retry',{job_id:queued});
    assert.equal(retried.status,200,JSON.stringify(retried.body));assert.equal(retried.body.status,'rescheduled');assert.equal(retried.body.superseded,1);assert.equal(retried.body.jobs.length,1);
    const old=f.store.memoryJobs.get(queued);assert.equal(old.state,'cancelled');assert.equal(old.last_error_code,'RESCHEDULED');
    assert.equal((await f.act('jobs.retry',{job_id:queued})).body.error_code,'JOB_NOT_RETRYABLE','a replaced job cannot be retried again');
    assert.equal((await f.get('attention')).body.counts.failed_jobs,0);
    const replacement=f.store.memoryJobs.get(retried.body.jobs[0]);assert.equal(replacement.metadata.taxonomy.version,(await f.taxonomy()).version);
    await drain();assert.equal(f.store.memoryJobs.get(retried.body.jobs[0]).state,'succeeded');
    assert.equal(await f.categoryOf(ids.at(-1)),'engineering','the rescheduled job classifies the new memory');
    assert.equal(await f.categoryOf(ids[0]),'engineering');assert.equal(await f.categoryOf(ids[1]),'preferences','manual categories still win');
  }
  assert.equal(f.store.db.prepare('PRAGMA user_version').get().user_version,7);
});
