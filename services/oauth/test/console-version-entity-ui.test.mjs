import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.document??={body:{dataset:{}},documentElement:{dataset:{}},querySelectorAll:()=>[],addEventListener:()=>{}};
import {text} from '../../../web/console/catalog.mjs';
const {versionChainView,kindGroup}=await import('../../../web/console/visuals.mjs');
const {mapAnchors,anchorPanel,mapWindow}=await import('../../../web/console/actions.mjs');
const t=k=>text(k,'zh-CN');

test('Version chain: newest first, numbered from the oldest, each correction can show its change',()=>{
  const chain=[{memory_id:'m3',status:'active',created_at:'2026-10-16T03:57:00Z',revision:1,reason:'<b>补充按钮</b>'},{memory_id:'m2',status:'superseded',created_at:'2026-10-15T03:00:00Z',revision:2,reason:null},{memory_id:'m1',status:'superseded',created_at:'2026-10-14T03:00:00Z',revision:1,reason:null}];
  const html=versionChainView(t,chain,{current:'m2'});
  assert.deepEqual([...html.matchAll(/<p class="version-head">[^<]*<span data-i18n="versionNumber">第<\/span> (\d+)/g)].map(m=>m[1]),['3','2','1']);
  assert.deepEqual([...html.matchAll(/data-version-change="(\d)" data-before="([^"]+)" data-before-revision="(\d+)" data-after="([^"]+)" data-after-revision="(\d+)"/g)].map(m=>m.slice(1)),[['0','m2','2','m3','1'],['1','m1','1','m2','2']]);
  assert.deepEqual([...html.matchAll(/<button type="button" class="quiet" data-memory="([^"]+)">/g)].map(m=>m[1]),['m3','m1'],'every other record opens; the open one does not');
  assert.match(html,/class="version-step is-current"/);assert.match(html,/&lt;b&gt;补充按钮&lt;\/b&gt;/);
  assert.match(versionChainView(t,[]),/读不到版本记录/);
  assert.match(versionChainView(t,chain,{truncated:true}),/只列出最近 10 个版本/);
});

test('Memory map connection points: shared keywords first; otherwise shared topics plus type hubs; otherwise hubs only',()=>{
  // Shared keywords come first (entities were replaced by keywords): a keyword used by two memories is a connection point,
  // case-insensitive, and each memory links to every one of its keywords plus loosely to its type hub.
  const keyed=mapAnchors({memories:[{id:'a',kind:'fact',concepts:['PVE','Mnemuron']},{id:'b',kind:'bug',concepts:['pve']},{id:'c',kind:'fact',concepts:['solo'],topic:'x'}],entities:[],links:[]});
  assert.equal(keyed.mode,'concepts');assert.deepEqual(keyed.anchors.map(a=>[a.kind,a.label,a.count]),[['concept','PVE',2],['hub','事实',2],['hub','问题',1]]);
  assert.deepEqual(keyed.links,[[[0,1],[1,.3]],[[0,1],[2,.3]],[[1,1]]],'a memory without a shared keyword hangs on its type hub');
  const memories=[{id:'a',kind:'fact',topic:'Agent/observation/Mnemuron'},{id:'b',kind:'preference',topic:'Agent/observation/Mnemuron'},
    {id:'c',kind:'architecture',topic:'Agent/history/Mnemuron'},{id:'d',kind:'architecture',topic:'Agent/history/Mnemuron'},{id:'e',kind:'fact',topic:'solo'},{id:'f',kind:'fact',topic:null}];
  const t=mapAnchors({memories,entities:[],links:[]});
  assert.equal(t.mode,'topics');
  assert.deepEqual(t.anchors.map(a=>[a.kind,a.label,a.count]),[['topic','history/Mnemuron',2],['topic','observation/Mnemuron',2],['hub','事实',3],['hub','偏好',1],['hub','架构',2]],'largest first, ties by name; a shared last segment keeps one more level; single-use topics are not anchors');
  assert.deepEqual(t.links[0],[[1,1],[2,.3]],'a memory links to its topic and loosely to its kind hub');
  assert.deepEqual(t.links[4],[[2,1]],'a memory without a shared topic links to its hub only');
  const plain=mapAnchors({memories:[{id:'a',kind:'fact',topic:null},{id:'b',kind:'workflow',topic:'once'}],entities:[],links:[]});
  assert.equal(plain.mode,'kinds');assert.deepEqual(plain.anchors.map(a=>a.label),['事实','工作流程']);
});

test('Map info panel: a topic links to its library filter, a hub lists its topics, names are escaped',()=>{
  const memories=[{id:'a',kind:'fact',topic:'A/<b>x</b>'},{id:'b',kind:'preference',topic:'A/<b>x</b>'},{id:'c',kind:'fact',topic:'B/y'},{id:'d',kind:'fact',topic:'B/y'}];
  const graph={memories,entities:[],links:[]},plan=mapAnchors(graph);
  const topic=anchorPanel(graph,plan,plan.anchors.findIndex(a=>a.title==='A/<b>x</b>'));
  assert.match(topic,/A\/&lt;b&gt;x&lt;\/b&gt;/);assert.doesNotMatch(topic,/<b>x<\/b>/);
  assert.match(topic,/图上 2 条记忆/);assert.match(topic,/href="\/app\/memories\?topic=A%2F%3Cb%3Ex%3C%2Fb%3E"/);assert.doesNotMatch(topic,/常一起出现/);
  const hub=anchorPanel(graph,plan,plan.anchors.findIndex(a=>a.kind==='hub'&&a.group==='fact'));
  assert.match(hub,/图上 3 条记忆/);assert.match(hub,/这个类型里的主题/);assert.match(hub,/href="\/app\/memories\?kind=fact"/);
  assert.equal(anchorPanel(graph,plan,99),'');
});

test('Map info panel: a keyword links to its library filter and lists the keywords it appears with',()=>{
  const graph={memories:[{id:'a',kind:'fact',concepts:['PVE','<b>Gemini</b>']},{id:'b',kind:'bug',concepts:['pve','<b>Gemini</b>']},{id:'c',kind:'fact',concepts:['PVE']}],entities:[],links:[]},plan=mapAnchors(graph);
  const html=anchorPanel(graph,plan,plan.anchors.findIndex(a=>a.label==='PVE'));
  assert.match(html,/关键词<\/span>/);assert.match(html,/图上 3 条记忆/);assert.match(html,/href="\/app\/memories\?concept=PVE"/);
  assert.match(html,/常一起出现[\s\S]*&lt;b&gt;Gemini&lt;\/b&gt;/);assert.doesNotMatch(html,/<b>Gemini<\/b>/);
});

test('Map window and aggregation: recent days by activity, hidden types, and keywords-only beyond 150 memories',()=>{
  const today=new Date('2026-10-21T12:00:00Z'),graph={memories:[{id:'new',kind:'fact',day:'2026-10-20'},{id:'edge',kind:'bug',day:'2026-09-22'},{id:'old',kind:'fact',day:'2026-08-01'},{id:'legacy',kind:'fact'}],entities:[],links:[]};
  assert.deepEqual(mapWindow(graph,{days:30,today}).memories.map(m=>m.id),['new','edge','legacy'],'30 days include day 30; a memory without a day stays');
  assert.deepEqual(mapWindow(graph,{days:0,today}).memories.length,4,'0 is all');
  assert.deepEqual(mapWindow(graph,{days:0,hidden:new Set(['fact']),today}).memories.map(m=>m.id),['edge']);
  const many={memories:Array.from({length:160},(_,i)=>({id:'m'+i,kind:'fact',concepts:i%2?['PVE','Mnemuron']:['PVE']})),entities:[],links:[]};
  const plan=mapAnchors(many);
  assert.equal(plan.aggregate,true);assert.deepEqual(plan.anchors.map(a=>[a.label,a.count]),[['PVE',160],['Mnemuron',80]],'only keywords, no type hubs');
  assert.deepEqual(plan.edges,[[0,1,80]],'keywords linked by how many memories they share');
  assert.equal(mapAnchors({...many,memories:many.memories.slice(0,150)}).aggregate,undefined,'150 or fewer memories are drawn one by one');
  assert.equal(mapAnchors(many,{max:1}).anchors.length,1,'the canvas size caps the connection points');
});
