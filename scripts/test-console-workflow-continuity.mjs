// Cross-layer browser regressions against disposable loopback Core/OAuth/BFF services.
// All identities, memories and model endpoints are synthetic; production configuration is never loaded.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

const root=path.resolve(import.meta.dirname,'..'),base=path.resolve(process.env.MNEMURON_UI_EVIDENCE||os.tmpdir());
assert.ok(fs.existsSync(base)&&base!==root&&!base.startsWith(root+path.sep),'Evidence must be outside the worktree');
const evidence=fs.mkdtempSync(path.join(base,'workflow-continuity-browser-'));fs.chmodSync(evidence,0o700);
assert.ok(process.env.PLAYWRIGHT_MODULE&&path.isAbsolute(process.env.PLAYWRIGHT_MODULE),'Set PLAYWRIGHT_MODULE to an installed module');
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const log=fs.openSync(path.join(evidence,'fixture.stderr'),'wx',0o600);
const fixture=spawn(process.execPath,['services/oauth/test/helpers/console-functional-preview.mjs'],{cwd:root,stdio:['pipe','pipe',log]});
const queue=[],waiters=[],checks=[];
createInterface({input:fixture.stdout}).on('line',line=>{if(!line.startsWith('{'))return;const value=JSON.parse(line);if(waiters.length)waiters.shift()(value);else queue.push(value);});
const read=async()=>{let timer;try{return await Promise.race([queue.length?Promise.resolve(queue.shift()):new Promise(r=>waiters.push(r)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Synthetic fixture timeout')),30000);})]);}finally{clearTimeout(timer);}};
const command=async(command,extra={})=>{fixture.stdin.write(JSON.stringify({command,...extra})+'\n');const reply=await read();assert.ok(!reply.fixture_error,reply.fixture_error);return reply;};
const check=(name,condition=true)=>{assert.ok(condition,name);checks.push(name);console.log('PASS '+name);};
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
const bounded=async(promise,label)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' timed out')),30000);})]);}finally{clearTimeout(timer);}};
let browser;

async function jobsSection({page,cfg,api,mutate}){
  assert.equal((await command('seed-projects')).active,26);
  await mutate('models.save',{kind:'organizer',expected_revision:0,config:{enabled:true,protocol:'openai_compatible',base_url:cfg.model_url,model:'synthetic-workflow-continuity',profile_revision:'1',daily_requests:100,batch_size:5,output_tokens:4096,native_schema:true,egress_approved:true,query_approved:false}});
  const projects=[];let offset=0;
  do{const data=await api('projects',{offset,limit:25});projects.push(...data.projects);offset=data.next_offset;}while(offset!==null);
  for(const project of projects)await mutate('memory.create',{scope:'project',project_id:project.project_id,content:`Synthetic workflow recovery for ${project.project_id}`,kind:'fact'});
  const scheduled=await mutate('jobs.schedule',{type:'summary',timezone:'UTC',periods:['daily','weekly'],include_open:true});
  check('Real Console scheduling creates a durable multi-page summary queue',scheduled.status==='queued'&&scheduled.jobs.length>40);
  const grouped=await api('jobs',{group:'batch'}),batch=grouped.batches.find(b=>b.jobs>20);assert.ok(batch);
  const batchId=batch.batch_id,dialog=page.locator('#operation-dialog');
  const goto=async()=>{await page.goto(cfg.url+'/app/jobs');await page.locator(`[data-batch-toggle="${batchId}"]`).waitFor();};
  const expand=async()=>{await page.locator(`[data-batch-toggle="${batchId}"]`).click();await page.locator(`[data-batch-jobs="${batchId}"] .batch-jobs`).waitFor();};
  const box=()=>page.locator(`[data-batch-jobs="${batchId}"]`);
  const submit=async action=>{const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/console-api/action'&&new URLSearchParams(r.request().postData()||'').get('action')===action);await dialog.locator('button[type=submit]').click();const r=await response;assert.equal(r.status(),200);return r.json();};
  const close=async()=>{await dialog.locator('[data-operation-close]').last().click();await dialog.waitFor({state:'hidden'});};
  await goto();await expand();
  const cancel=box().locator('[data-console-action="jobs.cancel"]').first(),jobId=await cancel.getAttribute('data-id');assert.ok(jobId);
  await cancel.click();assert.equal((await submit('jobs.cancel')).status,'cancelled');await dialog.locator('.operation-result').waitFor();await close();
  check('A grouped pending job can be cancelled through the real dialog and BFF',(await api('jobs',{job_id:jobId})).job.state==='cancelled');
  await expand();await box().locator(`[data-console-action="jobs.retry"][data-id="${jobId}"]`).click();
  assert.equal((await submit('jobs.retry')).status,'queued');await dialog.locator('.operation-result').waitFor();
  check('Retry reports queued work and does not claim processing is complete',JSON.parse(await dialog.locator('.operation-result').innerText()).status==='queued');
  await close();check('Grouped retry restores the exact cancelled job to pending',(await api('jobs',{job_id:jobId})).job.state==='pending');
  await expand();await box().locator('[data-batch-page="10"]').click();await box().locator('.batch-pager').getByText(/第 2 \//).waitFor();

  let held=null;const ready=deferred();
  const holdFirst=async route=>{const u=new URL(route.request().url());if(u.searchParams.get('batch_id')===batchId&&u.searchParams.get('offset')==='0'){
    held={route,response:await route.fetch()};ready.resolve();
  }else await route.continue();};
  await page.route('**/console-api/jobs?*',holdFirst);
  await box().locator('[data-batch-page="0"]').click();await bounded(ready.promise,'Held first-page response');
  await box().locator('[data-batch-page="20"]').click();await box().locator('.batch-pager').getByText(/第 3 \//).waitFor();
  const beforeLate=await box().locator('[data-job-detail]').evaluateAll(nodes=>nodes.map(n=>n.dataset.jobDetail));
  const lateResponse=page.waitForResponse(r=>{const u=new URL(r.url());return u.pathname==='/console-api/jobs'&&u.searchParams.get('batch_id')===batchId&&u.searchParams.get('offset')==='0';});
  await held.route.fulfill({response:held.response});await (await lateResponse).finished();await page.waitForTimeout(100);
  check('A late real first-page response cannot replace the newer third-page selection',JSON.stringify(await box().locator('[data-job-detail]').evaluateAll(nodes=>nodes.map(n=>n.dataset.jobDetail)))===JSON.stringify(beforeLate));
  await page.unroute('**/console-api/jobs?*',holdFirst);

  let reads=0,mutations=0;
  const observe=r=>{if(new URL(r.url()).pathname==='/console-api/action'&&r.method()==='POST')mutations++;};page.on('request',observe);
  const failNext=async route=>{const u=new URL(route.request().url());if(u.searchParams.get('batch_id')===batchId&&u.searchParams.get('offset')==='10'){
    reads++;if(reads===1){await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error_code:'CORE_UNAVAILABLE'})});return;}
  }await route.continue();};
  await page.route('**/console-api/jobs?*',failNext);
  await box().locator('[data-batch-page="10"]').click();await box().locator('[data-batch-retry="10"]').waitFor();
  check('A batch HTTP 503 leaves the prior page and its job controls visible',JSON.stringify(await box().locator('[data-job-detail]').evaluateAll(nodes=>nodes.map(n=>n.dataset.jobDetail)))===JSON.stringify(beforeLate)&&await box().locator('[data-console-action="jobs.cancel"]').count()>0);
  check('The failed read has a visible status and explicit retry control',await box().locator('[data-batch-error] [role=status]').isVisible());
  await box().locator('[data-batch-retry="10"]').click();await box().locator('.batch-pager').getByText(/第 2 \//).waitFor();
  check('Retry reads the failed offset exactly once and removes the error after success',reads===2&&await box().locator('[data-batch-error]').count()===0);
  check('Pagination recovery never sends a mutation',mutations===0);page.off('request',observe);
  await page.unroute('**/console-api/jobs?*',failNext);

  await page.locator(`[data-batch-toggle="${batchId}"]`).click();let initialReads=0;
  const failInitial=async route=>{const u=new URL(route.request().url());if(u.searchParams.get('batch_id')===batchId&&u.searchParams.get('offset')==='0'){
    initialReads++;if(initialReads===1){await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error_code:'CORE_UNAVAILABLE'})});return;}
  }await route.continue();};
  await page.route('**/console-api/jobs?*',failInitial);
  await page.locator(`[data-batch-toggle="${batchId}"]`).click();await box().locator('[data-batch-retry="0"]').waitFor();
  check('An initial expansion failure offers retry without a permanent loading message',await box().locator('.batch-jobs').count()===0&&!(await box().innerText()).includes('加载中'));
  await box().locator('[data-batch-retry="0"]').click();await box().locator('.batch-jobs').waitFor();
  check('Initial expansion recovers without closing or reopening the batch',initialReads===2&&await box().locator('[data-batch-error]').count()===0);
  await page.unroute('**/console-api/jobs?*',failInitial);
  await page.setViewportSize({width:390,height:844});
  check('Expanded job recovery controls stay inside the mobile page',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:path.join(evidence,'jobs-recovery-mobile.png'),fullPage:true});await page.setViewportSize({width:1440,height:1080});
  const other=await browser.newContext();await other.addCookies([{name:cfg.cookie,value:cfg.accounts[1].token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);const otherPage=await other.newPage();await otherPage.goto(cfg.url+'/app/jobs');
  const foreign=await otherPage.evaluate(async batch_id=>(await fetch('/console-api/jobs?'+new URLSearchParams({batch_id}))).json(),batchId);
  check('A different account cannot read the expanded batch or its action targets',foreign.total===0&&foreign.jobs.length===0);await other.close();
}

async function searchSection({page,cfg,mutate}){
  const query='semantic continuity needle',content='Synthetic semantic continuity needle for retrieval recovery';
  await mutate('memory.create',{scope:'user',content,kind:'fact'});
  const params=new URLSearchParams({query,mode:'lexical',kind:'fact',status:'active',origin:'other'});
  await page.goto(cfg.url+'/app/memories?'+params);
  const result=()=>page.locator('.memory-table [data-memory]').filter({hasText:content});await result().waitFor();
  check('A real lexical read returns the synthetic memory before a semantic failure',await result().count()===1);
  const choose=async(selector,value)=>{const index=await page.locator(selector+' select').evaluate((s,v)=>[...s.options].findIndex(o=>o.value===v),value);assert.ok(index>=0);
    await page.locator(selector+' .select-trigger').click();await page.locator(`.select-popup:popover-open [data-index="${index}"]`).click();};
  const submit=()=>page.locator('#search-form button[type=submit]').click();
  let reason='VECTOR_FILTER_TOO_BROAD';const semanticRequests=[];
  // Inject only the typed HTTP failure at the browser boundary. Core/MCP/BFF reason propagation has separate
  // real-HTTP tests; all successful reads here still reach the disposable services and their real SQLite data.
  const unavailable=async route=>{const u=new URL(route.request().url());if(u.searchParams.get('part')!=='facets'&&u.searchParams.get('mode')==='semantic'){
    semanticRequests.push(Object.fromEntries(u.searchParams));await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error_code:'SEMANTIC_UNAVAILABLE',degradation_code:reason,error_message:'PRIVATE_SYNTHETIC_PROVIDER_DETAIL'})});
  }else await route.continue();};
  await page.route('**/console-api/memories?*',unavailable);
  await choose('.filter-mode','semantic');await submit();
  const failure=()=>page.locator('[data-search-failure]');await failure().locator('[data-i18n="retrieval_VECTOR_FILTER_TOO_BROAD"]').waitFor();
  check('Semantic query-limit failure is an alert with a localized actionable reason',(await failure().getAttribute('role'))==='alert'&&(await failure().innerText()).includes('缩小范围'));
  check('A failed search preserves the query, mode, kind, status and origin chip',await page.locator('#search-form input[name=query]').inputValue()===query&&await page.locator('#search-form select[name=search_mode]').inputValue()==='semantic'&&await page.locator('#search-form select[name=kind]').inputValue()==='fact'&&await page.locator('#search-form select[name=status]').inputValue()==='active'&&await page.locator('#search-form select[name=origin]').inputValue()==='other'&&await page.locator('[data-clear-facet="origin"]').isVisible());
  check('A failed semantic read shows neither stale rows, zero-result success nor batch actions',await page.locator('.memory-table,.library-footer,.empty-state,[data-memory-selection],[data-search-degraded]').count()===0);
  reason='VECTOR_AUTH_FAILED';await failure().locator('[data-retry]').click();await failure().locator('[data-i18n="retrieval_VECTOR_AUTH_FAILED"]').waitFor();
  check('An explicit retry presents the new authentication failure, not an old query-limit reason',(await failure().innerText()).includes('认证失败')&&await failure().locator('[data-i18n="retrieval_VECTOR_FILTER_TOO_BROAD"]').count()===0);
  await choose('.language-control','en');
  check('Changing language translates the failure without repeating the search',(await failure().innerText()).includes('rejected authentication')&&semanticRequests.length===2);
  reason='PRIVATE_SYNTHETIC_PROVIDER_DETAIL';await failure().locator('[data-retry]').click();await failure().locator('[data-i18n="retrievalUnavailableReason"]').waitFor();
  check('Unknown provider diagnostics are replaced by the safe generic explanation',!(await page.locator('body').innerText()).includes('PRIVATE_SYNTHETIC_PROVIDER_DETAIL')&&(await failure().innerText()).includes('Check the model and index status'));
  check('Each explicit retry keeps the original request filters',semanticRequests.length===3&&semanticRequests.every(r=>r.query===query&&r.mode==='semantic'&&r.kind==='fact'&&r.status==='active'&&r.origin==='other'&&r.offset==='0'));
  await page.setViewportSize({width:390,height:844});
  check('The search recovery form and alert fit a mobile viewport',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:path.join(evidence,'search-recovery-mobile-en.png'),fullPage:true});await page.setViewportSize({width:1440,height:1080});
  await choose('.filter-mode','lexical');await submit();await result().waitFor();
  check('Changing to keyword search recovers the real result without resetting filters',await failure().count()===0&&await page.locator('#search-form input[name=query]').inputValue()===query&&await page.locator('#search-form select[name=kind]').inputValue()==='fact'&&await page.locator('[data-clear-facet="origin"]').isVisible());
  await choose('.filter-mode','hybrid');await submit();await page.locator('[data-search-degraded]').waitFor();await result().waitFor();
  check('Real hybrid degradation keeps lexical results and is distinct from semantic failure',await failure().count()===0&&(await page.locator('[data-search-degraded]').innerText()).includes('Hybrid search fell back to keywords')&&await result().count()===1);
  check('Hybrid degradation explains its reason through a local translation',await page.locator('[data-search-degraded] [data-i18n^="retrieval_"]').count()===1);
  await page.unroute('**/console-api/memories?*',unavailable);
}

try{
  const cfg=await read();assert.equal(cfg.fixture,true);
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const context=await browser.newContext({viewport:{width:1440,height:1080}});await context.addCookies([{name:cfg.cookie,value:cfg.accounts[0].token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);
  const page=await context.newPage(),errors=[],rateLimited=[];
  page.on('pageerror',error=>errors.push(error.message));page.on('console',msg=>{if(msg.type()==='error'&&/Content Security Policy|Refused/.test(msg.text()))errors.push(msg.text());});
  context.on('response',r=>{if(r.status()===429)rateLimited.push(new URL(r.url()).pathname);});
  await page.goto(cfg.url+'/app/jobs');await page.locator('#console-root').waitFor();
  const api=async(view,params={})=>{const r=await page.evaluate(async({view,params})=>{const r=await fetch('/console-api/'+view+'?'+new URLSearchParams(params));return {status:r.status,body:await r.json()};},{view,params});assert.equal(r.status,200,`${view}: ${r.body.error_code||r.status}`);return r.body;};
  const mutate=async(action,payload)=>{const r=await page.evaluate(async({action,payload})=>{const me=await(await fetch('/console-api/me')).json();const r=await fetch('/console-api/action',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:me.csrf,account_id:me.account_id,action,operation_id:crypto.randomUUID(),payload:JSON.stringify(payload)})});return {status:r.status,body:await r.json()};},{action,payload});assert.equal(r.status,200,`${action}: ${r.body.error_code||r.status}`);return r.body;};
  await jobsSection({page,cfg,api,mutate});
  await searchSection({page,cfg,mutate});
  check('No browser JavaScript or CSP errors',errors.length===0);check('No rate-limited requests mask task state or authorization',rateLimited.length===0);
  fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({status:'passed',checks,count:checks.length,node:process.version,production_data_used:false},null,2),{mode:0o600});
  console.log(JSON.stringify({status:'passed',checks:checks.length,evidence}));
}catch(error){fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({status:'failed',checks,error:error.stack},null,2),{mode:0o600});console.error(JSON.stringify({status:'failed',checks:checks.length,evidence,error:error.message}));process.exitCode=1;}
finally{
  await browser?.close();fixture.stdin.end('{"command":"stop"}\n');const timer=setTimeout(()=>fixture.kill('SIGTERM'),5000);await new Promise(r=>fixture.once('exit',r));clearTimeout(timer);fs.closeSync(log);
  assert.ok(fs.readFileSync(path.join(evidence,'fixture.stderr'),'utf8').includes('"synthetic_cleanup_complete":true'),'Synthetic fixture cleanup must be verified');
}
