// End-to-end task workflows through the real browser, OAuth BFF and Core. All data and Agent
// identities are synthetic; the target's pull and delivery receipts use the actual loopback HTTP API.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';

const root=path.resolve(import.meta.dirname,'..'),base=path.resolve(process.env.MNEMURON_UI_EVIDENCE||os.tmpdir());
assert.ok(fs.existsSync(base)&&base!==root&&!base.startsWith(root+path.sep),'Evidence must be outside the worktree');
const evidence=fs.mkdtempSync(path.join(base,'task-workflows-browser-'));fs.chmodSync(evidence,0o700);
assert.ok(process.env.PLAYWRIGHT_MODULE&&path.isAbsolute(process.env.PLAYWRIGHT_MODULE));
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const stderr=fs.openSync(path.join(evidence,'fixture.stderr'),'wx',0o600),child=spawn(process.execPath,['scripts/helpers/task-workflow-browser-fixture.mjs'],{cwd:root,stdio:['pipe','pipe',stderr]});
const queue=[],waiters=[],checks=[],errors=[],rates=[],actions=[];let browser,page,cfg;
createInterface({input:child.stdout}).on('line',line=>{if(!line.startsWith('{'))return;const result=JSON.parse(line);if(waiters.length)waiters.shift()(result);else queue.push(result);});
const bounded=async(promise,label)=>{let timer;try{return await Promise.race([promise,new Promise((_,no)=>{timer=setTimeout(()=>no(new Error(label+' timed out')),30000);})]);}finally{clearTimeout(timer);}};
const read=()=>bounded(queue.length?Promise.resolve(queue.shift()):new Promise(yes=>waiters.push(yes)),'Synthetic fixture reply');
const command=async(command,extra={})=>{child.stdin.write(JSON.stringify({command,...extra})+'\n');const r=await read();assert.ok(!r.fixture_error,r.fixture_error);return r;};
const check=(name,value=true)=>{assert.ok(value,name);checks.push(name);console.log('PASS '+name);};
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
const actionOf=request=>new URLSearchParams(request.postData()||'').get('action');

try{
  cfg=await read();assert.equal(cfg.fixture,true);assert.equal(new URL(cfg.url).hostname,'127.0.0.1');
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const context=await browser.newContext({viewport:{width:1440,height:1080}});
  await context.addCookies([{name:cfg.cookie,value:cfg.accounts[0].token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);
  await context.addInitScript(({account})=>localStorage.setItem('mnemuron.appearance.v1.'+account,JSON.stringify({locale:'en'})),{account:cfg.accounts[0].account_id});
  context.on('response',r=>{if(r.status()===429)rates.push(new URL(r.url()).pathname);});
  page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/Content Security Policy|Refused/.test(m.text()))errors.push(m.text());});
  page.on('request',request=>{if(new URL(request.url()).pathname==='/console-api/action'){
    const data=new URLSearchParams(request.postData()||''),p=JSON.parse(data.get('payload')||'{}');
    // Retain only metadata, never proof values or rich context, in diagnostic state.
    actions.push({action:data.get('action'),operation:data.get('operation_id'),keys:Object.keys(p).sort(),preview_id:p.preview_id,resume_id:p.resume_id,preview_version:p.preview_version,confirmed:p.confirmed,decision:p.decision});
  }});
  await page.goto(cfg.url+'/app/tasks');const dialog=page.locator('#task-workflow-dialog');
  await page.locator('[data-feature="TSK-05"] [data-task-workflow="project"]').waitFor();
  await page.locator('[data-task-workflow-slot="history"][aria-busy]').waitFor({state:'detached'});
  for(const id of ['TSK-05','TSK-06','TSK-07','TSK-08','TSK-09','TSK-10'])check(id+' is a live integrated card',await page.locator(`[data-feature="${id}"][data-status="live"]`).count()===1);

  const apiRaw=(view,params={})=>page.evaluate(async({view,params})=>{const r=await fetch('/console-api/'+view+'?'+new URLSearchParams(params));return {status:r.status,body:await r.json()};},{view,params});
  const api=async(view,params={})=>{const r=await apiRaw(view,params);assert.equal(r.status,200,`${view}: ${r.body.error_code||r.status}`);return r.body;};
  const rawMutation=async(action,payload)=>{const r=await page.evaluate(async({action,payload})=>{const me=await(await fetch('/console-api/me')).json();const response=await fetch('/console-api/action',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:me.csrf,account_id:me.account_id,action,operation_id:crypto.randomUUID(),payload:JSON.stringify(payload)})});return {status:response.status,body:await response.json()};},{action,payload});assert.equal(r.status,200,`${action}: ${r.body.error_code||r.status}`);return r.body;};
  const opened=async type=>{await page.locator(`[data-task-workflow="${type}"]`).first().click();await dialog.locator('[data-task-editor]').waitFor();};
  const close=async()=>{await dialog.locator('[data-task-workflow="close"]').last().click();await dialog.waitFor({state:'hidden'});};
  const responseFor=action=>page.waitForResponse(r=>new URL(r.url()).pathname==='/console-api/action'&&actionOf(r.request())===action);
  const submit=async(action,decision)=>{const pending=responseFor(action);await dialog.locator(decision?`[data-task-decision="${decision}"]`:'[data-task-editor] button[type="submit"]').click();const r=await pending,body=await r.json();assert.equal(r.status(),200,`${action}: ${body.error_code||r.status()}`);return body;};
  const proof=async()=>{const {otp}=await command('otp',{fresh:true});await dialog.locator('[name="current_password"]').fill(cfg.password);await dialog.locator('[name="otp"]').fill(otp);};
  const choose=async(name,value)=>{const select=dialog.locator(`select[name="${name}"]`);await page.waitForFunction(({name,value})=>[...document.querySelector(`#task-workflow-dialog select[name="${name}"]`).options].some(o=>o.value===value),{name,value});
    const index=await select.evaluate((s,v)=>[...s.options].findIndex(o=>o.value===v),value);await select.locator('..').locator('.select-trigger').click();await page.locator(`.select-popup:popover-open [data-index="${index}"]`).click();};
  const fillProject=async(name='Synthetic browser created project')=>{await opened('project');await dialog.locator('[name="project_name"]').fill(name);await dialog.locator('[name="task_title"]').fill('Synthetic created initial task');await dialog.locator('[name="task_goal"]').fill('Frozen browser goal <b>literal text</b>');};
  const renderedPreview=()=>dialog.locator('[data-task-confirm]').waitFor();
  const current=async()=>{const pending=page.waitForResponse(r=>['/console-api/resume-status','/console-api/task-workflow-preview'].includes(new URL(r.url()).pathname));await dialog.locator('[data-task-workflow="refresh-preview"]').click();const response=await pending,body=await response.json();assert.equal(response.status(),200);await dialog.locator(`[data-task-state="${body.status}"]`).waitFor();};

  const initial=await command('state');await fillProject();
  let lostPreview;const losePreview=async route=>{if(actionOf(route.request())==='projects.bootstrap_preview'&&!lostPreview){const response=await route.fetch();assert.equal(response.status(),200);lostPreview=await response.json();await route.abort('failed');}else await route.continue();};
  await page.route('**/console-api/action',losePreview);await dialog.locator('[data-task-editor] button[type="submit"]').click();await dialog.locator('[data-task-error]:not([hidden])').waitFor();
  check('A lost preview response creates no project or task',(await command('state')).tasks===initial.tasks);
  const preview=await submit('projects.bootstrap_preview');await renderedPreview();await page.unroute('**/console-api/action',losePreview);
  const previewCalls=actions.filter(a=>a.action==='projects.bootstrap_preview');
  check('Preview response loss retries the identical operation and retained preview',previewCalls.length===2&&previewCalls[0].operation===previewCalls[1].operation&&preview.preview_id===lostPreview.preview_id&&(await command('state')).previews===initial.previews+1);
  check('Frozen creation content is escaped and read from the guarded preview',(await dialog.innerText()).includes('Frozen browser goal <b>literal text</b>')&&await dialog.locator('b').count()===0);
  check('Creation explains its Console-only binding boundary',(await dialog.innerText()).includes('does not impersonate'));
  let created;const loseConfirm=async route=>{if(actionOf(route.request())==='projects.bootstrap_confirm'&&!created){const response=await route.fetch();assert.equal(response.status(),200);created=await response.json();await route.abort('failed');}else await route.continue();};
  await page.route('**/console-api/action',loseConfirm);await proof();await dialog.locator('[data-task-decision="confirm"]').click();await dialog.locator('[data-task-error]:not([hidden])').waitFor();
  check('The lost confirmation response committed exactly one real project and initial task',(await command('state')).tasks===initial.tasks+1);
  check('Proof fields are cleared after a transport failure',await dialog.locator('[name="current_password"]').inputValue()===''&&await dialog.locator('[name="otp"]').inputValue()==='');
  await proof();await dialog.locator('[data-task-decision="confirm"]').click();await dialog.locator('[data-task-decision="confirm"]').waitFor({state:'detached'});
  check('Confirmation retry reads terminal current state without duplicating the create',actions.filter(a=>a.action==='projects.bootstrap_confirm').length===1&&(await command('state')).tasks===initial.tasks+1);
  await page.unroute('**/console-api/action',loseConfirm);await close();

  await opened('task');await choose('project_id',created.project_id);await dialog.locator('[name="title"]').fill('Verify database transport limits');await dialog.locator('[name="goal"]').fill('Task creation in the exact selected project');
  const taskPreview=await submit('tasks.bootstrap_preview');await renderedPreview();const stored=await api('task-workflow-preview',{preview_id:taskPreview.preview_id});
  check('New-task preview is bound to the selected real project',stored.preview.project.project_id===created.project_id&&stored.preview.task?.title==='Verify database transport limits');
  let failedReload=0;const failReload=async route=>{failedReload++;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error_code:'CORE_UNAVAILABLE'})});};
  await page.route('**/console-api/projects?*',failReload);await proof();const madeTask=await submit('tasks.bootstrap_confirm','confirm');
  await dialog.locator('[data-task-error]:not([hidden])').waitFor();
  check('A real refresh 503 preserves the committed creation receipt and shows its refresh failure',madeTask.status==='confirmed'&&failedReload>0&&(await dialog.innerText()).includes('operation receipt arrived'));
  await page.unroute('**/console-api/projects?*',failReload);await close();await page.goto(cfg.url+'/app/tasks');await page.locator('[data-task-workflow="reconcile"]').waitFor();

  await opened('reconcile');await choose('task_id',cfg.scope.task_id);await submit('tasks.reconciliation_preview');await renderedPreview();
  check('A real no-effect reconciliation is readable and offers no false acceptance',(await dialog.innerText()).includes('No new changes')&&await dialog.locator('[data-task-decision]').count()===0);await close();
  const firstCheckpoint=await command('checkpoint'),canonicalBefore=(await command('state')).task;
  await opened('reconcile');await choose('task_id',cfg.scope.task_id);const proposal=await submit('tasks.reconciliation_preview');await renderedPreview();
  check('The entire proposed change and whole-proposal decision boundary are visible',(await dialog.innerText()).includes(firstCheckpoint.text)&&(await dialog.innerText()).includes('Individual fields cannot be selected'));
  check('Reconciliation preview leaves the canonical baseline unchanged',(await command('state')).task.canonical_version===canonicalBefore.canonical_version);
  await proof();const accepted=await submit('tasks.reconciliation_resolve','confirm');await dialog.locator('[data-task-workflow="refresh-preview"]').waitFor();
  const afterAccept=(await command('state')).task;
  check('Whole-proposal acceptance applies the real canonical revision',accepted.status==='applied'&&afterAccept.canonical_version===canonicalBefore.canonical_version+1&&JSON.stringify(afterAccept.progress).includes(firstCheckpoint.text));await close();
  const rejectedCheckpoint=await command('checkpoint');await opened('reconcile');await choose('task_id',cfg.scope.task_id);await submit('tasks.reconciliation_preview');await renderedPreview();
  check('The next whole proposal exposes its distinct pending change',(await dialog.innerText()).includes(rejectedCheckpoint.text));
  await proof();const rejected=await submit('tasks.reconciliation_resolve','reject');await dialog.locator('[data-task-workflow="refresh-preview"]').waitFor();
  check('Whole-proposal rejection records a decision without applying its changes',rejected.status==='rejected'&&(await command('state')).task.canonical_version===afterAccept.canonical_version&&!JSON.stringify((await command('state')).task.progress).includes(rejectedCheckpoint.text));await close();

  await fillProject('Synthetic expiring preview');const expiring=await submit('projects.bootstrap_preview');await renderedPreview();await command('expire-preview',{preview_id:expiring.preview_id});
  const priorConfirm=actions.filter(a=>a.action==='projects.bootstrap_confirm').length;await proof();await dialog.locator('[data-task-decision="confirm"]').click();await dialog.locator('[data-task-confirm]').waitFor({state:'detached'});
  check('Real expiry is checked before consuming proof or posting a confirmation',actions.filter(a=>a.action==='projects.bootstrap_confirm').length===priorConfirm&&(await dialog.innerText()).includes('preview expired'));
  check('Expired review clears its old content and proof fields',!(await dialog.innerText()).includes('Frozen browser goal')&&await dialog.locator('[name="otp"],[name="current_password"]').count()===0);await close();

  let sourceReads=0;const sourceUnavailable=async route=>{if(new URL(route.request().url()).searchParams.get('task_id')===cfg.scope.task_id&&++sourceReads===1){await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error_code:'CORE_UNAVAILABLE'})});return;}await route.continue();};
  const resumeEditor=async(recover=false)=>{await opened('resume');await choose('project_id',cfg.scope.project_id);await choose('task_id',cfg.scope.task_id);
    if(recover){await dialog.locator('[data-task-workflow="retry-sources"]').waitFor();const before=actions.length;check('A source HTTP 503 is shown as a failed read rather than no source data',(await dialog.innerText()).includes('Source branches could not be loaded'));
      await dialog.locator('[data-task-workflow="retry-sources"]').click();await dialog.locator(`input[name="source_workstream_ids"][value="${cfg.scope.source_workstream_id}"]`).waitFor({state:'attached'});check('Source retry reads the same task and performs no mutation',sourceReads===2&&actions.length===before);}
    await dialog.locator(`input[name="source_workstream_ids"][value="${cfg.scope.source_workstream_id}"]`).waitFor({state:'attached'});await choose('source_mode','selected');await dialog.locator(`input[name="source_workstream_ids"][value="${cfg.scope.source_workstream_id}"]`).check();await choose('target_event_id',cfg.scope.target_event_id);};
  await page.route('**/console-api/task-branches?*',sourceUnavailable);await resumeEditor(true);await page.unroute('**/console-api/task-branches?*',sourceUnavailable);
  check('Target selection is limited to observed server records with an honest availability note',await dialog.locator('input[name="session_id"]').count()===0&&(await dialog.innerText()).includes('does not prove that the Agent is online'));
  const resume=await submit('resume.preview');await renderedPreview();const frozen=await api('resume-status',{resume_id:resume.resume_id});
  check('Resume preview freezes the exact source subset and selected target',frozen.target.target_event_id===cfg.scope.target_event_id&&JSON.stringify(frozen.preview.branch_selection.selected_workstream_ids)===JSON.stringify([cfg.scope.source_workstream_id]));
  check('Only the selected source context is shown for review',(await dialog.innerText()).includes('Synthetic selected source context 0')&&!(await dialog.innerText()).includes('Synthetic unselected source sentinel 0'));
  const pendingBefore=await command('pending');check('Unconfirmed preview is not available to the target',pendingBefore.status==='empty');
  await proof();const queued=await submit('resume.confirm','confirm');await dialog.locator('[data-task-workflow="refresh-preview"]').waitFor();
  check('Resume confirmation returns only queued metadata and never fabricates delivery',queued.status==='queued'&&!Object.hasOwn(queued,'resume_packet')&&!Object.hasOwn(queued,'preview'));
  await current();let status=await api('resume-status',{resume_id:resume.resume_id});
  check('Queued UI and API keep both delivery and completion false',status.status==='queued'&&!status.delivery.delivered&&!status.delivery.completed&&(await dialog.innerText()).includes('No successful delivery recorded'));
  const pulled=await command('pending');check('The exact bound target can pull the real pending packet',pulled.status==='pending'&&pulled.resume_id===resume.resume_id&&pulled.delivery_recorded===false);
  await current();status=await api('resume-status',{resume_id:resume.resume_id});check('Fetching the packet alone does not claim delivery or completion',status.status==='queued'&&!status.delivery.delivered&&!status.delivery.completed);
  await command('receipt',{resume_id:resume.resume_id,phase:'delivered'});await current();status=await api('resume-status',{resume_id:resume.resume_id});
  check('An actual target delivery receipt changes delivery without completing the turn',status.status==='delivered'&&status.delivery.delivered&&!status.delivery.completed&&(await dialog.innerText()).includes('No turn completion receipt'));
  await command('receipt',{resume_id:resume.resume_id,phase:'acknowledged'});await current();status=await api('resume-status',{resume_id:resume.resume_id});
  check('A paired target completion receipt changes the visible state to completed',status.status==='completed'&&status.delivery.completed&&(await dialog.innerText()).includes('Turn completed'));
  check('The actual receipt attempt and delivery method are visible',await dialog.locator('[data-task-receipts] tbody tr').count()===1&&(await dialog.locator('[data-task-receipts]').innerText()).includes('codex-mcp-tool-result'));
  await dialog.screenshot({path:path.join(evidence,'resume-completed-dialog.png')});await page.setViewportSize({width:390,height:844});
  check('The actual receipt table fits the mobile dialog',await dialog.evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&el.scrollWidth<=el.clientWidth+1;}));
  await dialog.screenshot({path:path.join(evidence,'resume-completed-mobile.png')});await page.setViewportSize({width:1440,height:1080});await close();

  await resumeEditor();const cancelledPreview=await submit('resume.preview');await renderedPreview();await proof();const cancelled=await submit('resume.confirm','cancel');
  await dialog.locator('[data-task-workflow="refresh-preview"]').waitFor();const cancelledStatus=await api('resume-status',{resume_id:cancelledPreview.resume_id});
  check('Explicit cancellation records cancelled and creates no delivery or completion',cancelled.status==='cancelled'&&cancelledStatus.status==='cancelled'&&!cancelledStatus.delivery.delivered&&!cancelledStatus.delivery.completed);
  check('Cancellation sends the frozen version with an explicit false decision',actions.at(-1).action==='resume.confirm'&&actions.at(-1).resume_id===cancelledPreview.resume_id&&actions.at(-1).preview_version===cancelledPreview.preview_version&&actions.at(-1).confirmed===false);await close();

  // More than one page of real, authorized previews verifies that history is not a demonstration list.
  for(let i=0;i<11;i++)await rawMutation('resume.preview',{task_id:cfg.scope.task_id,target_event_id:cfg.scope.target_event_id});
  await page.locator('[data-task-workflow-slot="history"] [data-task-workflow="history-refresh"]').click();
  await page.locator('[data-task-workflow-slot="history"] [data-task-workflow="history-page"][data-offset="10"]').click();
  await page.locator(`[data-task-workflow-slot="history"] [data-task-workflow="status"][data-id="${resume.resume_id}"]`).waitFor();
  check('Resume history paginates to the older real completed receipt',await page.locator('[data-task-workflow-slot="history"] [data-offset="0"]').count()===1&&(await page.locator('[data-task-workflow-slot="history"]').innerText()).includes('Turn completed'));
  await page.locator(`[data-task-workflow-slot="history"] [data-task-workflow="status"][data-id="${resume.resume_id}"]`).click();await renderedPreview();
  check('History details re-read the actual receipt and expose no stale confirmation',await dialog.locator('[data-task-decision]').count()===0&&(await dialog.innerText()).includes('Turn completed'));await close();
  const other=await browser.newContext();other.on('response',r=>{if(r.status()===429)rates.push(new URL(r.url()).pathname);});await other.addCookies([{name:cfg.cookie,value:cfg.accounts[1].token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);const otherPage=await other.newPage();otherPage.on('pageerror',e=>errors.push(e.message));otherPage.on('console',m=>{if(m.type()==='error'&&/Content Security Policy|Refused/.test(m.text()))errors.push(m.text());});await otherPage.goto(cfg.url+'/app/tasks');await otherPage.locator('[data-feature="TSK-05"] [data-task-workflow="project"]').waitFor();
  const denied=await otherPage.evaluate(async id=>{const r=await fetch('/console-api/resume-status?'+new URLSearchParams({resume_id:id}));return {status:r.status,body:await r.json()};},resume.resume_id);
  check('Another account cannot read the resume content or target receipt',[403,404].includes(denied.status)&&!denied.body.preview&&!denied.body.target);await other.close();

  await resumeEditor();const invalidated=await submit('resume.preview');await renderedPreview();await command('revoke-target');await current();const blocked=await api('resume-status',{resume_id:invalidated.resume_id});
  check('Revoked target clears reviewable source content and disables confirmation',blocked.content_withheld&&blocked.preview===null&&await dialog.locator('[data-task-decision="confirm"]').count()===0&&!(await dialog.innerText()).includes('Synthetic selected source context'));
  check('The blocked state shows a translated recovery reason',(await dialog.innerText()).includes('target is no longer available'));await close();

  // Preserve the real filled editor while switching both supported languages at mobile width.
  await fillProject('Synthetic mobile form retained');await page.setViewportSize({width:390,height:844});
  for(const locale of ['zh-CN','en']){
    await page.evaluate(locale=>{const select=document.querySelector('[data-pref="locale"]');select.value=locale;select.dispatchEvent(new Event('change',{bubbles:true}));},locale);
    check(locale+' translates the open workflow title without discarding input',await dialog.locator('[name="project_name"]').inputValue()==='Synthetic mobile form retained'&&(await dialog.locator('h2').innerText())===(locale==='en'?'New project':'新建项目'));
    check(locale+' task editor stays within the mobile viewport',await dialog.evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&el.scrollWidth<=el.clientWidth+1;}));
    await page.screenshot({path:path.join(evidence,`task-editor-${locale}-mobile.png`),fullPage:true});
  }
  await submit('projects.bootstrap_preview');await renderedPreview();await proof();await command('revoke-console');await dialog.locator('[data-task-workflow="refresh-preview"]').click();await page.waitForURL('**/login');
  check('Session revocation clears rich preview and factors before redirecting to login',await page.locator('#task-workflow-dialog').count()===0);
  check('No browser JavaScript or CSP failures',errors.length===0);check('No 429 response masks workflow or authorization state',rates.length===0);
  fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({status:'passed',checks,count:checks.length,production_data_used:false,errors,rates},null,2),{mode:0o600});
  console.log(JSON.stringify({status:'passed',checks:checks.length,evidence}));
}catch(error){if(page)await page.screenshot({path:path.join(evidence,'failure.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({status:'failed',checks,error:error.stack,errors,rates},null,2),{mode:0o600});console.error(JSON.stringify({status:'failed',checks:checks.length,evidence,error:error.message}));process.exitCode=1;}
finally{await browser?.close();if(child.exitCode===null&&child.signalCode===null){if(!child.stdin.destroyed)child.stdin.end('{"command":"stop"}\n');const timer=setTimeout(()=>child.kill('SIGTERM'),5000);try{await bounded(new Promise(resolve=>child.once('exit',resolve)),'Synthetic fixture shutdown');}finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}}fs.closeSync(stderr);
  assert.ok(fs.readFileSync(path.join(evidence,'fixture.stderr'),'utf8').includes('"synthetic_cleanup_complete":true'),'Synthetic fixture cleanup must be verified');console.log(JSON.stringify({synthetic_cleanup_verified:true}));}
