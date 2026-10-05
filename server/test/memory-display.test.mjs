import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {splitLeadingPath,memoryPresentation,isNamespaceTag} from '../../shared/memory-display.mjs';
import {libraryView,memoryDetailView,memoryRows} from '../../web/console/visuals.mjs';
import {memoryFixture} from './helpers/core-memory-fixture.mjs';
import {CONSOLE_WRITE_SCOPES} from '../../shared/console-contract.mjs';

test('DISPLAY-01: a clear leading path is split verbatim; everything else stays whole',()=>{
  const cases=[
    ['/Users/example/app/src/billing.ts: Invoices run nightly.',{path:'/Users/example/app/src/billing.ts',body:'Invoices run nightly.'}],
    ['~/repo/docs/0007-queue.md — Decision: one queue per tenant.',{path:'~/repo/docs/0007-queue.md',body:'Decision: one queue per tenant.'}],
    ['C:\\Users\\example\\notes\\router.txt: Guest Wi-Fi is isolated.',{path:'C:\\Users\\example\\notes\\router.txt',body:'Guest Wi-Fi is isolated.'}],
    ['[services/oauth/src/console.mjs] Codes only.',{path:'services/oauth/src/console.mjs',body:'Codes only.'}],
    ['`docs/guide.md`: backticked',{path:'docs/guide.md',body:'backticked'}],
    ['packages/ui/src/Row.tsx\nPath line, then the body.',{path:'packages/ui/src/Row.tsx',body:'Path line, then the body.'}],
    ['src/store.mjs:42: line-numbered',{path:'src/store.mjs:42',body:'line-numbered'}],
  ];
  for(const [input,expected] of cases){const parts=splitLeadingPath(input);assert.deepEqual(parts,expected,input);
    assert.ok(input.includes(parts.path)&&input.includes(parts.body),'both parts are verbatim slices of the stored text');}
  for(const input of ['A plain memory.','https://example.com/a/b: a URL','and/or: prose','/single: one segment','/Users/example/file.md:','中文 /home/example/y 在中间：不拆分','notes/todo: two segments, no extension','',null,
    // Namespace tags are not files: no extension, no root, so they are never shown as a path.
    'AgentMemory/observation/Mnemuron: 用户偏好简洁回答','AgentMemory/observation/Mnemuron\nbody on the next line'])
    assert.equal(splitLeadingPath(input),null,String(input));
});

test('DISPLAY-02: a short title from a meaningful topic or the content; namespace topics become a separate tag',()=>{
  const cases=[
    [{content:'用户喜欢在周末徒步，通常选择郊外的山路。也喜欢拍照。',topic:'AgentMemory/observation/Mnemuron'},{title:'用户喜欢在周末徒步，通常选择郊外的山路',title_source:'content',tag:'AgentMemory/observation/Mnemuron'}],
    [{content:'Deploy runs nightly at 02:00 UTC. Rollback uses the previous tag.',topic:'observation'},{title:'Deploy runs nightly at 02:00 UTC',title_source:'content',tag:'observation'}],
    [{content:'正文内容很长',topic:'周末安排'},{title:'周末安排',title_source:'topic'}],
    [{content:'x',topic:'Travel plans'},{title:'Travel plans',title_source:'topic'}],
    [{content:'正文',topic:'Mnemuron'},{title:'正文',title_source:'content',tag:'Mnemuron'}],
    [{content:'AgentMemory/observation/Mnemuron: 这是正文。后续',topic:null},{title:'这是正文',title_source:'content'}],
    [{content:'/Users/example/app/src/billing.ts: Invoices run nightly.'},{title:'Invoices run nightly',title_source:'content'}],
    [{content:'## Heading line\nbody'},{title:'Heading line',title_source:'content'}],
    [{content:'and/or: prose here'},{title:'and/or: prose here',title_source:'content'}],
    [{content:'',topic:null,memory_id:'mem-1'},{title:'mem-1',title_source:'id'}],
    [{content:'   ',topic:'   ',memory_id:'mem-2'},{title:'mem-2',title_source:'id'}],
  ];
  for(const [input,expected] of cases)assert.deepEqual(memoryPresentation(input),expected,JSON.stringify(input));
  // Bounded length: CJK titles at most 28 graphemes, Latin at most 56 and broken at a word.
  const cjk=memoryPresentation({content:'这是一段非常长的中文记忆内容，没有任何句号所以会一直延续下去直到超过长度限制为止并且继续写'}).title;
  assert.ok([...cjk].length<=28&&cjk.endsWith('…'),cjk);
  const latin=memoryPresentation({content:'The billing service retries failed invoices three times with exponential backoff before alerting'}).title;
  assert.equal(latin,'The billing service retries failed invoices three…');
  const emoji=memoryPresentation({content:'😀'.repeat(40)}).title;assert.ok([...emoji].length<=56);
  // An over-long or path-like topic is never a title.
  assert.equal(memoryPresentation({content:'Body',topic:'这是一个超过四十个字符的主题'.repeat(4)}).title_source,'content');
  for(const tag of ['AgentMemory/observation/Mnemuron','observation','Mnemuron','a.b:c','x\\y'])assert.equal(isNamespaceTag(tag),true,tag);
  for(const title of ['周末安排','Travel plans','AgentMemory 观察'])assert.equal(isNamespaceTag(title),false,title);
});

test('DISPLAY-03: list and detail markup show a title, a labelled original tag and provenance; never a path for a tag',()=>{
  const t=key=>`[${key}]`;
  const row={memory_id:'m-1',content:'用户喜欢在周末徒步。',memory_type:'goal',status:'active',created_at:'2026-01-01T00:00:00.000Z',category:'personal',
    topic:'AgentMemory/observation/Mnemuron',imported:true,original_created_at:'2025-01-01T00:00:00.000Z',...memoryPresentation({content:'用户喜欢在周末徒步。',topic:'AgentMemory/observation/Mnemuron'})};
  const topicRow={memory_id:'m-2',content:'正文',memory_type:'fact',status:'active',created_at:'2026-01-01T00:00:00.000Z',topic:'周末安排',...memoryPresentation({content:'正文',topic:'周末安排'})};
  const html=libraryView(t,{data:{results:[row,topicRow]},status:'active'});
  assert.match(html,/<span class="memory-title" data-title-source="content">用户喜欢在周末徒步<\/span>/);
  assert.match(html,/class="type-chip" data-type="goal">\[goal\]/,'memory_type stays its own chip');
  assert.match(html,/class="category-pill" data-category="personal"/,'classification stays its own column');
  assert.match(html,/class="topic-chip tag-chip" data-facet="topic" data-value="AgentMemory\/observation\/Mnemuron"[^>]*><span class="chip-label">\[originalTag\]<\/span>AgentMemory\/observation\/Mnemuron<\/button>/);
  assert.doesNotMatch(html,/class="memory-path"/,'a namespace tag is never shown as a file path');
  assert.equal((html.match(/周末安排/g)||[]).length,1,'a topic used as the title is not repeated as a chip');
  assert.match(html,/\[importedOrigin\]/);
  // Older servers without titles keep the previous body-only layout.
  assert.doesNotMatch(libraryView(t,{data:{results:[{memory_id:'m-3',content:'Legacy row',status:'active'}]}}),/memory-title/);
  assert.match(memoryRows([row],t),/memory-title/);
  // A one-sentence memory is not printed twice; a longer body stays as the preview line.
  const single={memory_id:'m-6',content:'Synthetic imported note 1.',status:'active',...memoryPresentation({content:'Synthetic imported note 1.'})};
  assert.doesNotMatch(libraryView(t,{data:{results:[single]}}),/class="memory-text"/);
  const longer={memory_id:'m-7',content:'第一句是标题。第二句补充细节。',status:'active',...memoryPresentation({content:'第一句是标题。第二句补充细节。'})};
  assert.match(libraryView(t,{data:{results:[longer]}}),/<span class="memory-title" data-title-source="content">第一句是标题<\/span><span class="memory-text">第一句是标题。第二句补充细节。<\/span>/);
  const detail=memoryDetailView(t,{revision:3,content_offset:0,content_length:10,content_complete:true,memory:{memory_id:'m-1',content:'用户喜欢在周末徒步。',memory_type:'goal',status:'active'}},
    {meta:{memory_id:'m-1',category:'personal',sensitivity:'sensitive',tag:'AgentMemory/observation/Mnemuron',origin:{kind:'imported',original_created_at:'2025-01-01T00:00:00.000Z'}},labels:{personal:'个人'}});
  for(const key of ['memoryType','category','status','revisions','originFacet','originalTag','sensitivity'])assert.match(detail,new RegExp(`<dt><span data-i18n="${key}">`),key);
  assert.match(detail,/<code class="tag-value">AgentMemory\/observation\/Mnemuron<\/code>/);
  assert.match(detail,/>个人</);assert.match(detail,/\[importedOrigin\]/);
  assert.doesNotMatch(detail,/webVisibility|ChatGPT/);
  // Without metadata the detail still renders the body and the lifecycle facts.
  const bare=memoryDetailView(t,{revision:1,content_offset:0,content_length:4,content_complete:true,memory:{memory_id:'m-4',content:'Body',status:'retracted'}},{});
  assert.match(bare,/data-status="retracted"/);assert.match(bare,/Body/);
  // Stored text is escaped, never markup.
  const hostile=libraryView(t,{data:{results:[{memory_id:'m-5',content:'<img src=x onerror=alert(1)>',status:'active',...memoryPresentation({content:'<img src=x onerror=alert(1)>'})}]}});
  assert.doesNotMatch(hostile,/<img/);
});

test('DISPLAY-04: console list rows and memory-meta carry display fields; stored content and topic are unchanged',async t=>{
  const f=await memoryFixture(t);
  const issue=user=>{const c=f.store.issueCredential({userId:user,label:'Synthetic console',deviceId:'synthetic',agentId:'mnemuron-console',agentInstanceId:randomUUID(),scopes:CONSOLE_WRITE_SCOPES});return {...c,auth:f.store.authenticate(c.api_key)};};
  const owner=issue(f.a.auth.user_id),other=issue(f.other.auth.user_id);
  const act=(action,payload,o=owner)=>f.request('POST','/v1/console/action',{action,payload,operation_id:randomUUID()},o);
  const get=(view,params={},o=owner)=>f.request('GET','/v1/console/'+view+'?'+new URLSearchParams(params),undefined,o);
  const content='AgentMemory/observation/Mnemuron: 用户偏好简洁的回答。其余说明。';
  const created=(await act('memory.create',{scope:'user',content,topic:'AgentMemory/observation/Mnemuron',memory_type:'decision'})).body.memory_id;
  const titled=(await act('memory.create',{scope:'user',content:'Body text',topic:'旅行计划'})).body.memory_id;
  const before=f.store.db.prepare('SELECT * FROM memories ORDER BY rowid').all();
  const list=(await get('memories',{status:'active'})).body.results;
  const row=list.find(r=>r.memory_id===created);
  assert.deepEqual([row.title,row.title_source,row.tag,row.memory_type,row.topic],['用户偏好简洁的回答','content','AgentMemory/observation/Mnemuron','decision','AgentMemory/observation/Mnemuron']);
  assert.equal(row.path,undefined,'the namespace prefix is not a path');
  assert.deepEqual([list.find(r=>r.memory_id===titled).title,list.find(r=>r.memory_id===titled).title_source],['旅行计划','topic']);
  const meta=(await get('memory-meta',{memory_id:created})).body;
  assert.deepEqual([meta.title,meta.tag,meta.origin],['用户偏好简洁的回答','AgentMemory/observation/Mnemuron',{kind:'console'}]);
  assert.equal((await get('memory-meta',{memory_id:created},other)).status,404,'other accounts cannot read it');
  // The topic facet and filter still work with the original stored topic.
  assert.equal((await get('memories',{status:'active',topic:'AgentMemory/observation/Mnemuron'})).body.results.length,1);
  assert.ok((await get('overview')).body.recent.some(r=>r.memory_id===created&&r.title==='用户偏好简洁的回答'));
  assert.deepEqual(f.store.db.prepare('SELECT * FROM memories ORDER BY rowid').all(),before,'reads never rewrite memories');
  // Imported records report their original date as provenance.
  const exported={format:'mnemuron-personal-portable-v1',confirm_personal_scope:true,records:[{original_id:'orig-1',revision:1,content:'导入的记忆正文。',memory_type:'fact',status:'active',topic:'observation',sensitivity:'sensitive',original_scope:'user',created_at:'2025-02-03T04:05:06.000Z'}]};
  const imported=(await act('storage.import',exported)).body.memory_ids[0];
  const importedMeta=(await get('memory-meta',{memory_id:imported})).body;
  assert.deepEqual([importedMeta.origin,importedMeta.tag,importedMeta.title],[{kind:'imported',original_created_at:'2025-02-03T04:05:06.000Z'},'observation','导入的记忆正文']);
});
