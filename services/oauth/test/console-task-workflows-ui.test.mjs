import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from '../../../server/test/helpers/memory-models.mjs';
import {consoleRead} from '../../../server/lib/console-read.mjs';
import {CONSOLE_WRITE_SCOPES,CONSOLE_WORKFLOW_ERRORS} from '../../../shared/console-contract.mjs';
import {mountTaskWorkflows,taskWorkflowCard,deliveryLabels} from '../../../web/console/task-workflows.mjs';
import {text} from '../../../web/console/catalog.mjs';

const settle=async()=>{for(let i=0;i<3;i++)await new Promise(resolve=>setImmediate(resolve));};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const decode=value=>String(value??'').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');

// This small DOM adapter only implements native form/control plumbing. The controller, FormData
// snapshot timing, account/sequence guards, capabilities and all successful mutations are production code.
function page(t,options){
  const prior={document:globalThis.document,window:globalThis.window,FormData:globalThis.FormData};
  let currentAccount='account-a',active=true,dialog;const listeners={},slots=[];
  const attrs=raw=>Object.fromEntries([...raw.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(([,key,value])=>[key,decode(value??'')]));
  function node(tag='div',attributes={}){
    const result={tagName:tag.toUpperCase(),attributes:{...attributes},dataset:{},isConnected:true,disabled:Object.hasOwn(attributes,'disabled'),checked:Object.hasOwn(attributes,'checked'),hidden:Object.hasOwn(attributes,'hidden'),value:attributes.value??'',name:attributes.name,type:attributes.type,textContent:'',listeners:{},children:[],
      setAttribute(k,v){this.attributes[k]=String(v);},removeAttribute(k){delete this.attributes[k];},
      addEventListener(k,fn){(this.listeners[k]??=[]).push(fn);},focus(){globalThis.document.activeElement=this;},
      matches(selector){const attribute=selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);return attribute?Object.hasOwn(this.attributes,attribute[1])&&(attribute[2]===undefined||this.attributes[attribute[1]]===attribute[2]):selector.toUpperCase()===this.tagName;},
      closest(selector){return this.matches(selector)?this:null;},
      querySelectorAll(selector){return this.children.filter(child=>selector.split(',').some(piece=>child.matches(piece.trim())));},querySelector(selector){return this.querySelectorAll(selector)[0]||null;},
      replaceChildren(){this.innerHTML='';},showModal(){this.open=true;},close(){const was=this.open;this.open=false;if(was)for(const fn of this.listeners.close||[])fn();},
    };
    for(const [key,value]of Object.entries(attributes))if(key.startsWith('data-'))result.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value;
    let html='';Object.defineProperty(result,'innerHTML',{get:()=>html,set:value=>{html=value;for(const child of result.children)child.isConnected=false;result.children=[];
      for(const match of html.matchAll(/<(input|select|textarea|button|form|p|div|h2)\b([^>]*)>/g)){
        const child=node(match[1],attrs(match[2]));
        if(['select','textarea'].includes(match[1])){const tail=html.slice(match.index+match[0].length),body=tail.slice(0,tail.indexOf(`</${match[1]}>`));
          if(match[1]==='textarea')child.value=decode(body);else{const choices=[...body.matchAll(/<option\b([^>]*)>/g)].map(m=>attrs(m[1]));child.value=(choices.find(a=>Object.hasOwn(a,'selected'))||choices[0])?.value||'';}}
        result.children.push(child);
      }
      for(const form of result.children.filter(c=>c.tagName==='FORM'))form.children=result.children.filter(c=>['INPUT','SELECT','TEXTAREA','BUTTON'].includes(c.tagName));
    }});return result;
  }
  globalThis.document={documentElement:{lang:'en'},body:{dataset:{account:currentAccount},append:d=>{dialog=d;}},activeElement:null,
    createElement:()=>{const d=node('dialog'),content=node('div',{'data-task-workflow-content':''}),title=node('h2');
      d.querySelector=selector=>selector==='h2'?title:selector==='[data-task-workflow-content]'?content:null;
      d.querySelectorAll=selector=>content.querySelectorAll(selector);d.content=content;return d;},
    addEventListener:(kind,fn)=>(listeners[kind]??=[]).push(fn),querySelectorAll:selector=>selector==='[data-task-workflow-slot]'?slots:[],querySelector:()=>null,getElementById:()=>null};
  globalThis.window={addEventListener:()=>{}};
  globalThis.FormData=class{constructor(form){this.entries=form.children.filter(c=>c.name&&!c.disabled&&(!['checkbox','radio'].includes(c.type)||c.checked)).map(c=>[c.name,c.value]);}get(key){return this.entries.find(([k])=>key===k)?.[1]??null;}getAll(key){return this.entries.filter(([k])=>key===k).map(([,v])=>v);}[Symbol.iterator](){return this.entries[Symbol.iterator]();}};
  const ui=mountTaskWorkflows({...options,getAccount:()=>currentAccount,isActive:()=>active});
  t.after(()=>{ui.clear();Object.assign(globalThis,prior);});
  const click=control=>{assert.ok(control,'the rendered action exists');for(const fn of listeners.click||[])fn({target:control});};
  function card(type){const ids={project:'TSK-05',task:'TSK-05',reconcile:'TSK-06',resume:'TSK-07'},box=node();box.innerHTML=taskWorkflowCard(k=>text(k,'en'),ids[type],{},options.getCaps());return box.querySelector(`[data-task-workflow="${type}"]`);}
  const set=(name,value)=>{const input=dialog.content.querySelector(`[name="${name}"]`);assert.ok(input,`rendered ${name}`);input.value=value;return input;};
  return {ui,dialog:()=>dialog,html:()=>dialog.content.innerHTML,error:()=>dialog.content.querySelector('[data-task-error]')?.textContent||'',set,
    async open(type){click(card(type));await settle();},async click(action){click(dialog.content.querySelector(`[data-task-workflow="${action}"]`));await settle();},
    async change(name,value){const target=set(name,value);for(const fn of dialog.listeners.change||[])fn({target});await settle();},
    async submit(decision){const form=dialog.content.querySelector('[data-task-editor]')||dialog.content.querySelector('[data-task-confirm]');assert.ok(form,'rendered form');
      const submitter=decision?dialog.content.querySelector(`[data-task-decision="${decision}"]`):undefined;for(const fn of dialog.listeners.submit||[])await fn({preventDefault(){},target:form,submitter});await settle();},
    proof(password='Synthetic password with spaces  ',otp='123456'){set('current_password',password);set('otp',otp);},
    switchAccount(value){currentAccount=value;},deactivate(){active=false;},
    async historyPage(offset){click(slots[2].querySelector(`[data-offset="${offset}"]`));await settle();},
    slots(){for(const mode of ['pending','delivery','history'])slots.push(node('div',{'data-task-workflow-slot':mode}));return slots;},
  };
}

function core(t){
  const f=fixture(t),s=f.s;s.memoryTransaction(()=>s.handoffPolicy.setEnabled(true));
  const c=s.issueCredential({userId:f.auth.user_id,label:'Synthetic workflow console',deviceId:'synthetic-console',agentId:'mnemuron-console',agentInstanceId:randomUUID(),scopes:CONSOLE_WRITE_SCOPES}),auth=s.authenticate(c.api_key);
  const capabilities=s.consoleService.capabilities(auth),caps={allowed_actions:capabilities.actions,writable:capabilities.writable};
  const api=(view,p={})=>consoleRead(s,auth,view,Object.fromEntries(Object.entries(p).map(([k,v])=>[k,String(v)])));
  const mutate=async(action,payload,operation_id)=>{const {current_password,otp,...business}=payload;try{return await s.consoleService.execute(auth,{action,payload:business,operation_id});}catch(e){throw new Error(e.errorCode||e.message);}};
  return {...f,s,auth,caps,api,mutate,count:table=>s.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n};
}
async function project(ui,name='Synthetic reviewed project'){
  await ui.open('project');ui.set('project_name',name);ui.set('task_title','Synthetic reviewed task');ui.set('task_goal','Frozen goal <script>should stay text</script>');await ui.submit();
}

test('TASK-UI-01: real frozen project preview changes no business data; confirmation uses captured factors and creates exactly once',async t=>{
  const f=core(t),calls=[],ui=page(t,{api:f.api,mutate:async(...args)=>{calls.push(args);return f.mutate(...args);},getCaps:()=>f.caps});
  await project(ui);assert.equal(f.count('tasks'),0);assert.match(ui.html(),/Frozen goal &lt;script&gt;/);assert.doesNotMatch(ui.html(),/<script>/);
  assert.match(ui.html(),/data-task-decision="confirm"/);assert.ok(ui.html().indexOf('data-task-decision="confirm"')<ui.html().indexOf('data-task-decision="cancel"'),'implicit submit confirms the reviewed intent instead of choosing Cancel');
  ui.proof();await ui.submit('confirm');assert.equal(f.count('tasks'),1);assert.equal(f.count('projects'),1);
  assert.equal(calls[1][1].current_password,'Synthetic password with spaces  ');assert.equal(calls[1][1].otp,'123456');assert.equal(calls[1][1].preview_id,(await f.api('task-workflow-preview',{preview_id:calls[1][1].preview_id})).preview_id);
  assert.deepEqual(Object.keys(calls[1][1]).sort(),['confirmed','current_password','otp','preview_id','preview_version']);assert.doesNotMatch(ui.html(),/name="(?:current_password|otp)"/);
});

test('TASK-UI-02: a lost preview reply reuses its operation and a lost confirmation reply is resolved by the same current preview',async t=>{
  const f=core(t),calls=[],loss=new Set(['projects.bootstrap_preview','projects.bootstrap_confirm']);let reloads=0;
  const ui=page(t,{api:f.api,mutate:async(...args)=>{calls.push(args);const result=await f.mutate(...args);if(loss.delete(args[0]))throw new Error('UNAVAILABLE');return result;},getCaps:()=>f.caps,reload:async()=>{reloads++;}});
  await project(ui);assert.equal(f.count('tasks'),0);assert.equal(ui.error(),text('UNAVAILABLE','en'));await ui.submit();
  assert.equal(calls[0][2],calls[1][2]);assert.equal(f.count('console_task_workflow_previews'),1);
  ui.proof();await ui.submit('confirm');assert.equal(f.count('tasks'),1);assert.equal(ui.error(),text('UNAVAILABLE','en'));
  ui.proof('new-factor','654321');await ui.submit('confirm');assert.equal(calls.length,3,'terminal current status prevents a second business mutation');assert.equal(reloads,1,'terminal recovery refreshes the real list');assert.equal(f.count('tasks'),1);assert.doesNotMatch(ui.html(),/data-task-decision="confirm"/);
});

test('TASK-UI-03: failed proof retries retain the frozen operation ID while new factors stay out of the intent hash',async t=>{
  const f=core(t),calls=[];let reject=true;
  const ui=page(t,{api:f.api,mutate:async(...args)=>{calls.push(args);if(args[0].endsWith('_confirm')&&reject){reject=false;throw new Error('MFA_INVALID');}return f.mutate(...args);},getCaps:()=>f.caps});
  await project(ui);ui.proof();await ui.submit('confirm');assert.equal(f.count('tasks'),0);assert.equal(ui.dialog().content.querySelector('[name="current_password"]').value,'');assert.equal(ui.dialog().content.querySelector('[name="otp"]').value,'');
  ui.proof('corrected-proof','654321');await ui.submit('confirm');assert.equal(calls[1][2],calls[2][2]);assert.notEqual(calls[1][1].otp,calls[2][1].otp);assert.equal(f.count('tasks'),1);
});

test('TASK-UI-04: failed expiry preflight removes old rich content and never sends factors or confirmation',async t=>{
  const f=core(t),calls=[];let unavailable=false;
  const ui=page(t,{api:async(...args)=>{if(unavailable&&args[0]==='task-workflow-preview')throw new Error('PREVIEW_EXPIRED');return f.api(...args);},mutate:async(...args)=>{calls.push(args);return f.mutate(...args);},getCaps:()=>f.caps});
  await project(ui);ui.proof();unavailable=true;await ui.submit('confirm');assert.equal(calls.length,1);assert.equal(f.count('tasks'),0);assert.doesNotMatch(ui.html(),/Frozen goal|current_password|data-task-decision/);assert.match(ui.html(),/preview expired/i);assert.match(ui.html(),/data-task-workflow="refresh-preview"/);
  unavailable=false;await ui.click('refresh-preview');assert.match(ui.html(),/Frozen goal/);assert.equal(calls.length,1,'retry only reads the retained reference');
});

test('TASK-UI-05: current preview read wins over late replies; clearing/account change discards late rich content',async t=>{
  const f=core(t),pending=[];let hold=false;
  const ui=page(t,{api:(...args)=>{if(hold&&args[0]==='task-workflow-preview'){const p=deferred();pending.push(p);return p.promise;}return f.api(...args);},mutate:f.mutate,getCaps:()=>f.caps});
  await project(ui);const reference=f.s.db.prepare('SELECT preview_id FROM console_task_workflow_previews').get(),value=await f.api('task-workflow-preview',reference);hold=true;
  await ui.click('refresh-preview');await ui.click('refresh-preview');pending[1].resolve({...value,status:'cancelled',preview:null,can_confirm:false,can_cancel:false});await settle();const latest=ui.html();pending[0].resolve(value);await settle();assert.equal(ui.html(),latest);
  await ui.click('refresh-preview');ui.switchAccount('account-b');ui.ui.clear();pending[2].resolve(value);await settle();assert.equal(ui.html(),'');assert.equal(ui.dialog().open,false);
});

test('TASK-UI-06: saved creation receipt survives reload failure and history reads use latest-page/account fences',async t=>{
  const f=core(t),pending=[];const ui=page(t,{api:(view,p)=>view==='resume-history'?(()=>{const d=deferred();pending.push(d);return d.promise;})():f.api(view,p),mutate:f.mutate,getCaps:()=>f.caps,reload:async()=>{throw new Error('UNAVAILABLE');}});
  await project(ui);ui.proof();await ui.submit('confirm');assert.equal(f.count('tasks'),1);assert.match(ui.error(),/operation receipt arrived/i);assert.match(ui.html(),/Read current state/);
  const slots=ui.slots(),one=ui.ui.afterRender(),two=ui.ui.afterRender();const result={items:[{resume_id:'current-resume',task_title:'newer history',status:'queued',delivery:{delivered:false,completed:false}}],offset:0,limit:10,total:1,next_offset:null};pending[1].resolve(result);await two;pending[0].reject(new Error('UNAVAILABLE'));await one;assert.match(slots[2].innerHTML,/newer history/);assert.doesNotMatch(slots[2].innerHTML,/UNAVAILABLE/);
  const third=ui.ui.afterRender();ui.switchAccount('account-b');ui.ui.clear();pending[2].resolve({...result,items:[{...result.items[0],task_title:'must not appear'}]});await third;assert.doesNotMatch(slots[2].innerHTML,/must not appear/);
});

test('TASK-UI-07: frozen top-level capabilities control decisions; queued or unpaired ACK never invents delivery/completion',async t=>{
  const f=core(t),ui=page(t,{api:async(...args)=>{const value=await f.api(...args);return args[0]==='task-workflow-preview'?{...value,status:'blocked',can_confirm:false,can_cancel:false,blockers:['HANDOFF_DISABLED']}:value;},mutate:f.mutate,getCaps:()=>f.caps});
  await project(ui);assert.doesNotMatch(ui.html(),/data-task-decision|current_password/);assert.match(ui.html(),/handoff module is disabled/i);
  assert.deepEqual(deliveryLabels({status:'queued'}),{delivery:'taskFlowNotDelivered',completion:'taskFlowNotCompleted'});
  assert.deepEqual(deliveryLabels({status:'acknowledged_unpaired',delivery:{completed:false}}),{delivery:'taskFlowUnpaired',completion:'taskFlowNotCompleted'});
  assert.deepEqual(deliveryLabels({status:'delivered',delivery:{delivered:true,completed:false}}),{delivery:'taskFlowDelivered',completion:'taskFlowNotCompleted'});
  assert.deepEqual(deliveryLabels({status:'completed',delivery:{delivered:true,completed:true}}),{delivery:'taskFlowDelivered',completion:'taskFlowCompleted'});
});

test('TASK-UI-08: permission-gated cards and new workflow errors are understandable in both languages',async t=>{
  for(const locale of ['zh-CN','en'])for(const id of ['TSK-05','TSK-06','TSK-07'])assert.doesNotMatch(taskWorkflowCard(k=>text(k,locale),id,{},{}),/data-task-workflow=/);
  const f=core(t),ui=page(t,{api:f.api,mutate:async()=>{throw new Error(CONSOLE_WORKFLOW_ERRORS[0]);},getCaps:()=>f.caps});
  await ui.open('project');ui.set('project_name','Synthetic');ui.set('task_title','Task');ui.set('task_goal','Goal');await ui.submit();assert.match(ui.error(),/project lifecycle changed/i);
  for(const locale of ['zh-CN','en'])for(const key of ['taskFlowErrorLifecycle','taskFlowErrorTooLarge','taskFlowErrorConflict','taskFlowErrorDelivered','taskFlowErrorContext','taskFlowErrorMissing','taskFlowErrorExpired','taskFlowErrorTarget','taskFlowErrorTask','taskFlowErrorVersion','taskFlowErrorConfirmation'])assert.notEqual(text(key,locale),key);
});

test('TASK-UI-09: invalidation between preflight and confirmation removes the obsolete rich preview',async t=>{
  const f=core(t),ui=page(t,{api:f.api,mutate:async(...args)=>{if(args[0]==='projects.bootstrap_confirm')f.s.consoleService.taskWorkflows.clock=()=>Date.now()+3600000;return f.mutate(...args);},getCaps:()=>f.caps});
  await project(ui);ui.proof();await ui.submit('confirm');assert.equal(f.count('tasks'),0);assert.doesNotMatch(ui.html(),/Frozen goal|current_password|data-task-decision/);assert.match(ui.html(),/preview expired/i);
});

test('TASK-UI-10: real task creation, duplicate candidates and no-effect reconciliation preserve their distinct contracts',async t=>{
  const f=core(t),ui=page(t,{api:f.api,mutate:f.mutate,getCaps:()=>f.caps});
  await project(ui);ui.proof();await ui.submit('confirm');await ui.click('close');const existing=f.s.db.prepare('SELECT task_id,project_id FROM tasks').get();
  const input=async()=>{await ui.open('task');ui.set('project_id',existing.project_id);ui.set('title','Synthetic distinct task');ui.set('goal','The duplicate must retain this exact proposed goal');await ui.submit();};
  await input();ui.proof();await ui.submit('confirm');assert.equal(f.count('tasks'),2);await ui.click('close');
  await input();assert.match(ui.html(),/matching task exists/);assert.match(ui.html(),/Synthetic distinct task/);assert.match(ui.html(),/duplicate must retain this exact proposed goal/);assert.match(ui.html(),/Synthetic reviewed project/);assert.doesNotMatch(ui.html(),/data-task-decision="confirm"/);await ui.click('close');
  await ui.open('reconcile');ui.set('task_id',existing.task_id);await ui.submit();assert.match(ui.html(),/No new changes/);assert.doesNotMatch(ui.html(),/State unavailable|data-task-decision/);
});

test('TASK-UI-11: failed source reads are explicit and retry the same task without creating a preview',async t=>{
  const f=core(t),calls=[];let fail=true;
  const ui=page(t,{api:async(view,p)=>{if(view==='task-branches'&&p.task_id){calls.push(p.task_id);if(fail){fail=false;throw new Error('CORE_UNAVAILABLE');}}return f.api(view,p);},mutate:f.mutate,getCaps:()=>f.caps});
  await project(ui);ui.proof();await ui.submit('confirm');await ui.click('close');const task=f.s.db.prepare('SELECT project_id,task_id FROM tasks').get(),previews=f.count('console_task_workflow_previews');
  await ui.open('resume');await ui.change('project_id',task.project_id);await ui.change('task_id',task.task_id);await ui.change('source_mode','selected');
  assert.match(ui.html(),/Source branches could not be loaded/);assert.doesNotMatch(ui.html(),/No source workstreams are available/);assert.match(ui.html(),/data-task-workflow="retry-sources"/);
  await ui.click('retry-sources');assert.deepEqual(calls,[task.task_id,task.task_id]);assert.match(ui.html(),/name="source_workstream_ids"/);assert.doesNotMatch(ui.html(),/data-task-workflow="retry-sources"/);assert.equal(f.count('console_task_workflow_previews'),previews);assert.equal(f.count('resumes'),0);
});

test('TASK-UI-12: content-bounded history pages preserve their actual previous offset',async t=>{
  const reads=[],ui=page(t,{api:async(view,p)=>{assert.equal(view,'resume-history');reads.push(p.offset);return {items:Array.from({length:p.offset===6?2:3},(_,i)=>({resume_id:`resume-${p.offset+i}`,task_title:`Historical task ${p.offset+i}`,status:'queued'})),total:8,offset:p.offset,limit:10,next_offset:p.offset===6?null:p.offset+3,truncated:p.offset!==6};},mutate:()=>assert.fail('History is read-only'),getCaps:()=>({allowed_actions:[]})});
  const slots=ui.slots();await ui.ui.afterRender();assert.match(slots[2].innerHTML,/content-size limit/);await ui.historyPage(3);await ui.historyPage(6);
  assert.match(slots[2].innerHTML,/data-offset="3"/);assert.doesNotMatch(slots[2].innerHTML,/data-offset="0"/);await ui.historyPage(3);assert.deepEqual(reads,[0,3,6,3]);assert.match(slots[2].innerHTML,/Historical task 3/);
});
