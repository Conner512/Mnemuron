import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.document??={body:{dataset:{}},documentElement:{dataset:{},lang:'zh-CN'},querySelectorAll:()=>[],addEventListener(){},removeEventListener(){}};
const {mapAnchors,overviewStatus}=await import('../../../web/console/actions.mjs');
const {memoryMap,anchorPanel}=await import('../../../web/console/memory-map.mjs');
const memories=(count,traits)=>Array.from({length:count},(_,i)=>({id:`synthetic-map-${i}`,kind:'fact',day:'2026-10-30',...traits(i)}));

test('MAP-01: aggregation keeps every returned memory reachable, including untagged and rare keywords',()=>{
 const input=memories(151,i=>({concepts:i<2?['shared']:i%2?[`unique-${i}`]:[]}));
 for(const max of [1,8,30]){
  const plan=mapAnchors({memories:input},{max});
  assert.equal(plan.aggregate,true);
  assert.equal(plan.links.filter(links=>links.length).length,input.length,'aggregation must not drop memories outside the popular anchors');
  assert.equal(plan.anchors.filter(anchor=>anchor.kind==='unmapped').reduce((sum,anchor)=>sum+anchor.count,0),149);
 }
 const topicPlan=mapAnchors({memories:memories(151,i=>({topic:i<2?'shared/topic':`unique/${i}`}))});
 assert.equal(topicPlan.links.filter(links=>links.length).length,151,'rare topics also retain an accessible group');
});

test('MAP-02: filtered graph counts and bounded-result notice are present in the normal 30-day view',()=>{
 const graph={memories:memories(2,()=>({concepts:['shared']})),entities:[],links:[],scope:{days:30,kinds:['fact'],query:'shared',time_basis:'latest_activity',as_of:'2026-10-30T00:00:00Z'},filtered_total:1001,returned:2,truncated:true,truncation_reason:'response_budget',active_total:1500,active_with_concepts:1200,kind_counts:{fact:1001}};
 const html=overviewStatus({features:{attention:{counts:{},graph}}});
 assert.match(html,/data-map-coverage/,'coverage is outside the optional canvas hint');
 assert.match(html,/1,001/);
 assert.match(html,/data-map-node-key/,'native node buttons provide keyboard access without pointer hit-testing');
 assert.match(html,/data-map-query/);
});

test('MAP-03: pipeline keyword coverage uses account totals, not the filtered graph sample',()=>{
 const graph={memories:memories(2,()=>({concepts:['shared']})),active_total:1500,active_with_concepts:1200};
 const activity={sources:{chatgpt:0,agents:0,console:0,import:0,other:0},uses:{chatgpt:{search:0,read:0},agents:{search:0,read:0},console:{search:0,read:0}},redacted:0};
 const html=overviewStatus({features:{attention:{counts:{},activity_7d:activity,graph}}});
 assert.match(html,/pipe-label">关键词<\/span><strong>1,200\/1,500<\/strong>/);
});

// Only the drawing surface is synthetic. The real layout, hit testing, pointer handlers,
// stable-key selection and ResizeObserver callback execute together.
function canvasFixture(t){
 const prior=Object.fromEntries(['matchMedia','getComputedStyle','ResizeObserver','devicePixelRatio','localStorage'].map(key=>[key,globalThis[key]]));
 const handlers=new Map(),observers=[];let width=1600,height=500,labels=[],lastArc;
 globalThis.matchMedia=()=>({matches:true});globalThis.devicePixelRatio=1;globalThis.localStorage={getItem:()=>null,setItem(){}};
 globalThis.getComputedStyle=()=>({getPropertyValue:key=>key==='--map-style'?'outline':'#123456'});
 globalThis.ResizeObserver=class{constructor(callback){this.callback=callback;this.disconnected=false;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}};
 const context=new Proxy({clearRect(){labels=[];},arc(x,y,r){lastArc={x,y,r};},fillText(text){labels.push({text,...lastArc});},measureText(){return {width:30};},createRadialGradient(){return {addColorStop(){}};}},{get:(object,key)=>object[key]||(()=>{})});
 const canvas={isConnected:true,dataset:{},getBoundingClientRect:()=>({width,height,left:0,top:0}),getContext:()=>context,
  addEventListener:(key,fn)=>handlers.set(key,fn),removeEventListener:key=>handlers.delete(key),setPointerCapture(){}};
 t.after(()=>Object.assign(globalThis,prior));
 return {canvas,handlers,observers,labels:()=>labels,resize(w,h){width=w;height=h;for(const observer of observers)observer.callback();},click(node){handlers.get('pointerdown')({button:0,clientX:node.x,clientY:node.y,pointerId:1});handlers.get('pointerup')({clientX:node.x,clientY:node.y});}};
}

test('MAP-04: shrinking the viewport clears a removed selected node and rejects stale node keys without crashing',t=>{
 const dom=canvasFixture(t),graph={memories:memories(192,i=>({concepts:[`word-${String(i%24).padStart(2,'0')}`,`word-${String((i+1)%24).padStart(2,'0')}`]}))};
 let selection;const map=memoryMap(dom.canvas,graph,{onSelect:key=>selection=key,panelWidth:316});t.after(()=>map.dispose());
 assert.equal(map.plan.anchors.filter(anchor=>anchor.kind==='concept').length,22);assert.equal(map.plan.anchors.at(-1).kind,'unmapped');
 const chosen=dom.labels()[12];dom.click(chosen);assert.equal(selection,'concept:word-12');assert.equal(map.selectedKey,selection);
 dom.resize(800,360);assert.equal(map.plan.anchors.filter(anchor=>anchor.kind==='concept').length,8);assert.equal(map.selectedKey,null,'a removed concept cannot keep another node selected by its former index');
 assert.doesNotThrow(()=>map.selectKey('concept:word-11'));assert.equal(selection,null);
 map.selectKey('concept:word-00');dom.resize(1000,440);assert.equal(map.selectedKey,'concept:word-00','a surviving concept keeps its semantic identity across layout changes');
 map.dispose();assert.equal(dom.handlers.size,0);assert.equal(dom.observers[0].disconnected,true);
});

test('MAP-05: every aggregate remainder can open its actual memory IDs through bounded detail pages',()=>{
 const graph={memories:memories(151,i=>({concepts:i<2?['shared']:[]}))},plan=mapAnchors(graph),index=plan.anchors.findIndex(anchor=>anchor.kind==='unmapped');
 const all=new Set();for(let offset=0;offset<149;offset+=10){const html=anchorPanel(graph,plan,index,{offset});const ids=[...html.matchAll(/data-map-memory="([^"]+)"/g)].map(match=>match[1]);assert.ok(ids.length<=10);for(const id of ids)all.add(id);}
 assert.equal(all.size,149);assert.ok(all.has('synthetic-map-2')&&all.has('synthetic-map-150'));
 assert.match(anchorPanel(graph,plan,index),/不限制为图中的时间窗口/,'the library navigation does not claim to preserve an unsupported date filter');
});

test('MAP-06: Unicode-equivalent keywords share one stable anchor and count each memory once',()=>{
 const graph={memories:[{id:'synthetic-a',kind:'fact',concepts:['ＰＶＥ','PVE','Équipe','Data  Store']},{id:'synthetic-b',kind:'fact',concepts:['pve','E\u0301quipe','data store']}]},plan=mapAnchors(graph);
 assert.deepEqual(plan.anchors.filter(anchor=>anchor.kind==='concept').map(anchor=>[anchor.key,anchor.count]).sort(),[['concept:data store',2],['concept:pve',2],['concept:équipe',2]]);
 assert.equal(plan.anchors.find(anchor=>anchor.key==='concept:pve').label,'ＰＶＥ','the original display spelling is retained');
});
