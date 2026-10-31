import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.document??={body:{dataset:{}},documentElement:{dataset:{},lang:'zh-CN'},querySelectorAll:()=>[],addEventListener(){},removeEventListener(){}};
const {streamItems,mountActivityStream,overviewStatus}=await import('../../../web/console/actions.mjs');
const {overviewView}=await import('../../../web/console/visuals.mjs');
const {text}=await import('../../../web/console/catalog.mjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const snapshot=(...ids)=>({entries:ids.map((id,i)=>({audit_id:id,created_at:new Date(Date.UTC(2026,9,31,1,i)).toISOString(),kind:'write',action:'memory.create',target_type:'memory',target_id:'synthetic-memory',outcome:'success'})),memories:{'synthetic-memory':{title:'Synthetic activity memory'}}});

class Element extends EventTarget {
  dataset={};attributes={};isConnected=true;innerHTML='';textContent='';scrollTop=0;
  setAttribute(key,value){this.attributes[key]=value;}
  click(){this.dispatchEvent(new Event('click'));}
}
function fixture(api){
  const nodes=new Map(['list','state','updated','refresh','pause'].map(name=>[`[data-stream-${name}]`,new Element()]));
  const root={querySelector:key=>nodes.get(key)},doc=Object.assign(new EventTarget(),{hidden:false,documentElement:{lang:'en'},defaultView:Object.assign(new EventTarget(),{navigator:{onLine:true}})});
  let now=Date.UTC(2026,9,31,2),seq=0,active=true;const timers=new Map(),plays=[];
  const clock={now:()=>now,setTimeout:(fn,ms)=>{const id=++seq;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)};
  const handle=mountActivityStream({api,root,doc,clock,isActive:()=>active,onNewEvents:items=>plays.push(items)});
  return {handle,doc,timers,plays,node:name=>nodes.get(`[data-stream-${name}]`),active:value=>{active=value;},
    poll(){const [id,timer]=timers.entries().next().value||[];assert.ok(timer,'one next poll is scheduled');assert.equal(timer.ms,30000);timers.delete(id);now+=timer.ms;timer.fn();}};
}

test('ACTIVITY-01: source-backed events distinguish failures and unknown outcomes without inventing search hits',()=>{
  const data={...snapshot('synthetic-search','synthetic-failed','synthetic-unknown')};
  data.entries[0]={...data.entries[0],kind:'read',action:'memory.query',query:{result_refs:null,result_refs_kind:'not_recorded'}};
  data.entries[1]={...data.entries[1],outcome:'failure'};delete data.entries[2].outcome;
  data.memories['synthetic-memory'].title='<script>synthetic</script>\nA source title';
  const rows=streamItems(data),html=rows.map(row=>row.html).join('');
  assert.equal(rows[0].id,'synthetic-search');assert.deepEqual(rows[0].refs,[]);
  assert.doesNotMatch(html,/命中|hits|<script>/);assert.match(html,/&lt;script&gt;/);
  assert.match(rows[1].html,/data-outcome="failure"/);assert.equal(rows[1].outcome,'failure');
  assert.match(rows[2].html,/data-outcome="unknown"/);assert.match(html,/<time datetime="2026-10-31T/);assert.match(html,/<small>/);
  assert.equal(streamItems(snapshot(...Array.from({length:12},(_,i)=>`synthetic-${i}`))).length,8);
});

test('ACTIVITY-02: initial history is not animated; polling replays only newly seen successful events once',async t=>{
  let calls=0,data=snapshot('synthetic-one');const f=fixture(async(view,params)=>{assert.equal(view,'audit');assert.deepEqual(params,{group:'memory',limit:20});calls++;return data;});t.after(()=>f.handle.dispose());
  await tick();assert.equal(calls,1);assert.equal(f.node('state').dataset.state,'live');assert.equal(f.plays.length,0);
  const first=f.node('list').innerHTML;f.node('list').scrollTop=19;
  f.poll();await tick();assert.equal(f.node('list').innerHTML,first);assert.equal(f.node('list').scrollTop,19);assert.equal(f.plays.length,0);
  data=snapshot('synthetic-two','synthetic-one');f.poll();await tick();assert.deepEqual(f.plays[0].map(item=>item.id),['synthetic-two']);
  f.poll();await tick();assert.equal(f.plays.length,1,'unchanged events never loop');assert.equal(f.timers.size,1);
});

test('ACTIVITY-03: failed refresh retains the last successful content and timestamp; explicit retry recovers',async t=>{
  let fail=false;const f=fixture(async()=>{if(fail)throw Error('synthetic unavailable');return snapshot('synthetic-one');});t.after(()=>f.handle.dispose());await tick();
  const html=f.node('list').innerHTML,stamp=f.node('updated').textContent;fail=true;f.poll();await tick();
  assert.equal(f.node('state').dataset.state,'error');assert.equal(f.node('list').innerHTML,html);assert.equal(f.node('updated').textContent,stamp);assert.equal(f.timers.size,1);
  fail=false;f.node('refresh').click();await tick();assert.equal(f.node('state').dataset.state,'live');assert.notEqual(f.node('updated').textContent,stamp);
});

test('ACTIVITY-04: initial failure stays unknown, with a working retry instead of a false empty feed',async t=>{
  let fail=true;const f=fixture(async()=>{if(fail)throw Error('synthetic first load');return snapshot();});t.after(()=>f.handle.dispose());await tick();
  assert.equal(f.node('state').dataset.state,'error');assert.match(f.node('list').innerHTML,/overviewStreamInitialError/);assert.doesNotMatch(f.node('list').innerHTML,/overviewStreamEmpty/);
  fail=false;f.node('refresh').click();await tick();assert.match(f.node('list').innerHTML,/overviewStreamEmpty/);assert.equal(f.node('state').dataset.state,'live');
});

test('ACTIVITY-05: pause, visibility and offline controls stop automatic work without hiding the snapshot',async t=>{
  let calls=0;const f=fixture(async()=>{calls++;return snapshot('synthetic-one');});t.after(()=>f.handle.dispose());await tick();
  f.node('pause').click();assert.equal(f.node('state').dataset.state,'paused');assert.equal(f.timers.size,0);assert.deepEqual(f.plays.at(-1),[]);
  f.node('refresh').click();await tick();assert.equal(calls,2);assert.equal(f.node('state').dataset.state,'paused');assert.equal(f.timers.size,0);
  f.node('pause').click();await tick();assert.equal(calls,3);assert.equal(f.timers.size,1);
  const html=f.node('list').innerHTML;f.doc.hidden=true;f.doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.node('state').dataset.state,'hidden');assert.equal(f.timers.size,0);assert.equal(f.node('list').innerHTML,html);
  f.node('refresh').click();await tick();assert.equal(calls,3);
  f.doc.hidden=false;f.doc.dispatchEvent(new Event('visibilitychange'));await tick();assert.equal(calls,4);
  f.doc.defaultView.navigator.onLine=false;f.doc.defaultView.dispatchEvent(new Event('offline'));assert.equal(f.node('state').dataset.state,'offline');assert.equal(f.timers.size,0);
  f.node('refresh').click();await tick();assert.equal(calls,4);
  f.doc.defaultView.navigator.onLine=true;f.doc.defaultView.dispatchEvent(new Event('online'));await tick();assert.equal(calls,5);assert.equal(f.node('state').dataset.state,'live');
});

test('ACTIVITY-06: overlapping triggers, disposal and changed account cannot render a late reply',async()=>{
  let calls=0;const gate=deferred(),f=fixture(async()=>{calls++;return gate.promise;});
  assert.equal(calls,1);assert.equal(f.node('refresh').disabled,true);f.node('refresh').click();f.doc.dispatchEvent(new Event('visibilitychange'));assert.equal(calls,1);
  f.handle.dispose();gate.resolve(snapshot('synthetic-late'));await tick();assert.equal(f.node('list').innerHTML,'');assert.equal(f.timers.size,0);assert.equal(f.plays.length,0);
  f.node('refresh').click();assert.equal(calls,1,'listeners were removed');
  const otherGate=deferred(),other=fixture(async()=>otherGate.promise);other.active(false);otherGate.resolve(snapshot('synthetic-other-account'));await tick();
  assert.equal(other.node('list').innerHTML,'');assert.equal(other.plays.length,0);assert.equal(other.timers.size,0);other.handle.dispose();
});

test('ACTIVITY-06b: a reply arriving after the page hides or goes offline cannot update or animate',async()=>{
 for(const reason of ['hidden','offline']){
  const gate=deferred();let pending=false;const f=fixture(async()=>pending?gate.promise:snapshot('synthetic-first'));await tick();
  const html=f.node('list').innerHTML,stamp=f.node('updated').textContent;pending=true;f.node('refresh').click();
  if(reason==='hidden'){f.doc.hidden=true;f.doc.dispatchEvent(new Event('visibilitychange'));}
  else{f.doc.defaultView.navigator.onLine=false;f.doc.defaultView.dispatchEvent(new Event('offline'));}
  gate.resolve(snapshot('synthetic-late','synthetic-first'));await tick();
  assert.equal(f.node('state').dataset.state,reason);assert.equal(f.node('list').innerHTML,html);assert.equal(f.node('updated').textContent,stamp);
  assert.ok(f.plays.every(items=>items.length===0));assert.equal(f.timers.size,0);f.handle.dispose();
 }
});

test('ACTIVITY-07: secondary overview insights are visible sections without duplicate search or paused tasks',()=>{
  const html=overviewStatus({features:{}})+overviewView({},{t:text,memoryRows:()=>''});
  assert.match(html,/<section class="overview-secondary" data-overview-system aria-labelledby="overview-system-title">/);assert.match(html,/<section class="overview-secondary" data-overview-library aria-labelledby="overview-library-title">/);
  assert.doesNotMatch(html,/<details class="overview-secondary"|role="search"|data-search-input|href="\/app\/projects"/);
  assert.match(html,/href="\/app\/memories"/);
  const render=fs.readFileSync(new URL('../../../web/console/render.mjs',import.meta.url),'utf8');
  assert.match(render,/'overview-ux.css','memory-map-ux.css','summary-reader.css'/);
  assert.doesNotMatch(render,/href="\/assets\/(overview-ux|memory-map-ux|summary-reader)\.css/);
});
