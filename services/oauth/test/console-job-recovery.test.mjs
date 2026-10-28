import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,organizer,taxonomy} from '../../../server/test/helpers/memory-models.mjs';
import {consoleRead} from '../../../server/lib/console-read.mjs';
import {CONSOLE_WRITE_SCOPES} from '../../../shared/console-contract.mjs';

globalThis.document={body:{dataset:{}},documentElement:{dataset:{},lang:'zh-CN'},querySelectorAll:()=>[],addEventListener:()=>{}};
const {actionPage,batchJobsView,mountActions}=await import('../../../web/console/actions.mjs');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

// Only DOM plumbing is synthetic. Reads, capabilities, retry/cancel and operation receipts use the real Core.
function page(t,options){
  const prior={document:globalThis.document,FormData:globalThis.FormData};
  const listeners={},dialogs=[];
  const node=()=>({
    dataset:{},attributes:{},innerHTML:'',textContent:'',isConnected:true,children:[],nodes:{},listeners:{},
    addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);},
    setAttribute(name,value){this.attributes[name]=String(value);},removeAttribute(name){delete this.attributes[name];},
    append(...children){this.children.push(...children);},prepend(...children){this.children.unshift(...children);},
    replaceChildren(...children){this.innerHTML='';this.children=children;},
    querySelectorAll(){return [];},querySelector(selector){return this.nodes[selector]??=node();},
    showModal(){this.open=true;},close(){this.open=false;},focus(){},reset(){},
  });
  globalThis.document={
    body:{dataset:{},append:d=>dialogs.push(d)},documentElement:{dataset:{},lang:'zh-CN'},activeElement:null,
    querySelectorAll:()=>[],getElementById:()=>null,createElement:node,
    addEventListener:(name,fn)=>(listeners[name]??=[]).push(fn),
  };
  globalThis.FormData=class extends Map{constructor(form){super(Object.entries(form.values||{}));}};
  t.after(()=>Object.assign(globalThis,prior));
  let active=true;
  const actions=mountActions({...options,isActive:()=>active});
  const click=target=>{for(const listener of listeners.click||[])listener({target});};
  const box=batch_id=>Object.assign(node(),{dataset:{batchJobs:batch_id}});
  // Construct controls from the rendered markup so the test must use an action the actual view offers.
  function control(html,attribute,value,box){
    const tag=[...html.matchAll(/<button\b[^>]*>/g)].map(match=>match[0]).find(tag=>tag.includes(`${attribute}="${value}"`));
    assert.ok(tag,`rendered ${attribute}="${value}" control`);
    const button=node();
    for(const [,key,val] of tag.matchAll(/data-([a-z-]+)="([^"]*)"/g))button.dataset[key.replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=val;
    button.closest=selector=>selector===`[${attribute}]`?button:selector==='[data-batch-jobs]'?box:null;
    return button;
  }
  function navigate(box,offset){const button=node();button.dataset.batchPage=String(offset);button.closest=selector=>selector==='[data-batch-page]'?button:selector==='[data-batch-jobs]'?box:null;click(button);}
  async function submit(){const modal=dialogs.at(-1),form=node();form.values={};for(const listener of modal.listeners.submit||[])await listener({preventDefault(){},target:form});}
  return {actions,box,click,control,navigate,submit,dialog:()=>dialogs.at(-1),deactivate:()=>{active=false;}};
}

function queue(t,count=25){
  const f=fixture(t),s=f.s;
  s.memoryConfig.memory={taxonomy};
  const credential=s.issueCredential({userId:f.auth.user_id,label:'Synthetic console',deviceId:'synthetic-console',agentId:'mnemuron-console',agentInstanceId:randomUUID(),scopes:CONSOLE_WRITE_SCOPES});
  const auth=s.authenticate(credential.api_key),model=organizer();
  model.profile=Object.freeze({...model.profile,fingerprint:'console-synthetic-recovery'});
  s.consoleService.models.provider=()=>model;
  // One frozen planning minute makes all real jobs one batch, independent of machine speed.
  s.memoryJobs.clock=()=>Date.UTC(2026,9,28,12);
  const ids=[];
  for(let i=0;i<count;i++){
    const memory=f.save(`Synthetic recoverable summary ${i}`),source=s.derivedMemory.currentSource(auth.user_id,memory.memory_id);
    ids.push(s.memoryJobs.enqueue({type:'summary',userId:auth.user_id,scope:source.scope_key,profile:model.profile.fingerprint,
      metadata:{taxonomy,category:'uncategorized',window:{period:'daily',timezone:'UTC',local_start:`2026-09-${String(i+1).padStart(2,'0')}`}},items:[source]}));
  }
  const batch=s.memoryJobs.batches(auth.user_id)[0];
  const read=(params={})=>consoleRead(s,auth,'jobs',Object.fromEntries(Object.entries(params).map(([k,v])=>[k,String(v)])));
  const mutate=(action,payload,operation_id=randomUUID())=>s.consoleService.execute(auth,{action,payload,operation_id});
  const capabilities=s.consoleService.capabilities(auth),caps={enabled:true,writable:capabilities.writable,allowed_actions:capabilities.actions};
  return {...f,s,auth,model,ids,batch,read,mutate,caps};
}

test('JOB-RECOVERY-01: the default grouped queue exposes an authorized retry and its handler requeues the failed Core job',async t=>{
  const f=queue(t,1),leased=f.s.memoryJobs.claim('synthetic-worker',{userId:f.auth.user_id,profile:f.model.profile.fingerprint});
  f.s.memoryJobs.failure(leased,{code:'REQUEST_TIMEOUT'},{max_attempts:1,base_ms:100,max_ms:1000});
  assert.equal(f.s.memoryJobs.get(leased.job_id).state,'dead_letter');
  const data=await f.read({group:'batch'}),details=await f.read({batch_id:f.batch.batch_id,limit:10});
  assert.equal(data.batches[0].failed,1);
  assert.match(actionPage('jobs',data,f.caps),/data-batch-toggle/);
  const calls=[],ui=page(t,{api:(_,params)=>f.read(params),mutate:async(...args)=>{calls.push(args);return f.mutate(...args);},getData:()=>data,getCaps:()=>f.caps,reload:async()=>{}});
  const box=ui.box(f.batch.batch_id);ui.navigate(box,0);await settle();
  const retry=ui.control(box.innerHTML,'data-console-action','jobs.retry',box);
  assert.equal(retry.dataset.id,details.jobs[0].job_id);
  ui.click(retry);await settle();await ui.submit();
  assert.equal(calls.length,1);assert.equal(calls[0][0],'jobs.retry');
  assert.deepEqual(calls[0][1],{job_id:leased.job_id});
  assert.equal(f.s.memoryJobs.get(leased.job_id).state,'pending');
  assert.equal((await f.read({batch_id:f.batch.batch_id})).jobs[0].last_error_code,null);
  ui.navigate(box,0);await settle();ui.click(ui.control(box.innerHTML,'data-console-action','jobs.cancel',box));await settle();await ui.submit();
  assert.equal(calls.length,2);assert.equal(calls[1][0],'jobs.cancel');
  assert.equal(f.s.memoryJobs.get(leased.job_id).state,'cancelled');
});

test('JOB-RECOVERY-02: batch controls respect read-only/owner capabilities and exclude retired or replaced jobs',async t=>{
  const f=queue(t,1);await f.mutate('jobs.cancel',{job_id:f.ids[0]});
  const details=await f.read({batch_id:f.batch.batch_id}),can=action=>f.caps.allowed_actions.includes(action);
  assert.match(batchJobsView(details,can),/data-console-action="jobs.retry"/);
  assert.doesNotMatch(batchJobsView(details,()=>false),/data-console-action=/);
  assert.doesNotMatch(batchJobsView(details,action=>action==='jobs.cancel'),/data-console-action="jobs.retry"/,'owner mode never gains a retry without its execution grant');
  for(const patch of [{job_type:'classification'},{retired:true},{last_error_code:'RESCHEDULED'},{state:'succeeded'},{state:'pending'},{state:'stale'}]){
    const data={...details,jobs:details.jobs.map(job=>({...job,...patch}))};
    assert.doesNotMatch(batchJobsView(data,can),/data-console-action="jobs.retry"/,JSON.stringify(patch));
  }
});

test('JOB-RECOVERY-03: the latest batch navigation wins when real Core pages finish out of order',async t=>{
  const f=queue(t),pages=await Promise.all([0,10,20].map(offset=>f.read({batch_id:f.batch.batch_id,offset,limit:10}))),pending=[];
  const ui=page(t,{api:(_,params)=>{const task=deferred();pending.push({params,...task});return task.promise;},mutate:f.mutate,getData:()=>({}),getCaps:()=>f.caps,reload:async()=>{}}),box=ui.box(f.batch.batch_id);
  ui.navigate(box,10);pending[0].resolve(pages[1]);await settle();
  ui.click(ui.control(box.innerHTML,'data-batch-page','0',box));
  ui.click(ui.control(box.innerHTML,'data-batch-page','20',box));
  assert.deepEqual(pending.map(x=>x.params.offset),[10,0,20]);
  pending[2].resolve(pages[2]);await settle();assert.match(box.innerHTML,/第 3 \/ 3 页/);
  pending[1].resolve(pages[0]);await settle();assert.match(box.innerHTML,/第 3 \/ 3 页/,'late page one must not replace the newer page three');
});

test('JOB-RECOVERY-04: a failed batch page preserves visible results and retries only the failed read',async t=>{
  const f=queue(t),first=await f.read({batch_id:f.batch.batch_id,offset:0,limit:10}),reads=[];
  const ui=page(t,{api:async(_,params)=>{reads.push(params);if(reads.length===2)throw new Error('unavailable');return f.read(params);},mutate:()=>assert.fail('pagination must never mutate'),getData:()=>({}),getCaps:()=>f.caps,reload:async()=>{}}),box=ui.box(f.batch.batch_id);
  ui.navigate(box,0);await settle();
  ui.click(ui.control(box.innerHTML,'data-batch-page','10',box));await settle();
  assert.match(box.innerHTML,new RegExp(first.jobs[0].job_id),'the previous page stays available after a transient read failure');
  ui.click(ui.control(box.innerHTML,'data-batch-retry','10',box));await settle();
  assert.deepEqual(reads.slice(1).map(x=>({batch_id:x.batch_id,offset:x.offset,limit:x.limit})),[{batch_id:f.batch.batch_id,offset:10,limit:10},{batch_id:f.batch.batch_id,offset:10,limit:10}]);
  assert.match(box.innerHTML,/第 2 \/ 3 页/);assert.doesNotMatch(box.innerHTML,/data-batch-retry/);
});

test('JOB-RECOVERY-05: stale failures and replies after clear cannot replace a newer or inactive batch',async t=>{
  const f=queue(t),last=await f.read({batch_id:f.batch.batch_id,offset:20,limit:10}),pending=[];
  const ui=page(t,{api:()=>{const task=deferred();pending.push(task);return task.promise;},mutate:f.mutate,getData:()=>({}),getCaps:()=>f.caps,reload:async()=>{}}),box=ui.box(f.batch.batch_id);
  ui.navigate(box,0);ui.navigate(box,20);pending[1].resolve(last);await settle();
  const current=box.innerHTML;pending[0].reject(new Error('unavailable'));await settle();assert.equal(box.innerHTML,current);
  ui.navigate(box,10);ui.actions.clear();pending[2].resolve({...last,offset:10});await settle();assert.equal(box.innerHTML,current);
  ui.navigate(box,0);ui.deactivate();pending[3].reject(new Error('unavailable'));await settle();assert.equal(box.innerHTML,current);
});
