// Browser acceptance of completed features against disposable, synthetic loopback services.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import assert from 'node:assert/strict';

const root=path.resolve(import.meta.dirname,'..'),base=path.resolve(process.env.MNEMURON_UI_EVIDENCE||os.tmpdir());
assert.ok(!base.startsWith(root+path.sep)&&base!==root);
const evidence=fs.mkdtempSync(path.join(base,'completion-browser-'));fs.chmodSync(evidence,0o700);
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const log=fs.openSync(path.join(evidence,'fixture.stderr'),'wx',0o600);
const fixture=spawn(process.execPath,['services/oauth/test/helpers/console-functional-preview.mjs'],{cwd:root,stdio:['pipe','pipe',log]});
const queue=[],waiters=[];createInterface({input:fixture.stdout}).on('line',line=>{if(!line.startsWith('{'))return;const v=JSON.parse(line);if(waiters.length)waiters.shift()(v);else queue.push(v);});
async function read(){let timer;try{return await Promise.race([queue.length?Promise.resolve(queue.shift()):new Promise(r=>waiters.push(r)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Fixture timeout')),30000);})]);}finally{clearTimeout(timer);}}
async function command(command,extra={}){fixture.stdin.write(JSON.stringify({command,...extra})+'\n');const r=await read();assert.ok(!r.fixture_error);return r;}
const checks=[];const check=(name,value=true)=>{assert.ok(value,name);checks.push(name);console.log('PASS '+name);};let browser;
try{
  const cfg=await read();assert.equal(cfg.fixture,true);assert.match(cfg.url,/^http:\/\/127\.0\.0\.1:/);
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const ctx=await browser.newContext({viewport:{width:1440,height:1100},acceptDownloads:true});
  await ctx.addCookies([{name:cfg.cookie,value:cfg.accounts[0].token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);
  const page=await ctx.newPage(),errors=[];page.setDefaultTimeout(15000);
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/Content Security Policy|Refused/.test(m.text()))errors.push(m.text());});
  const goto=async name=>{await page.goto(cfg.url+'/app/'+name);await page.locator('#console-root h1').waitFor();await page.locator('.loading-card').waitFor({state:'detached'});};
  const shot=async(name,fullPage=true)=>{if(fullPage)await page.evaluate(()=>new Promise(resolve=>{scrollTo(0,0);requestAnimationFrame(()=>requestAnimationFrame(resolve));}));return page.screenshot({path:path.join(evidence,name+'.png'),fullPage});};
  const op=page.locator('#operation-dialog'),detail=page.locator('#feature-dialog');
  const begin=async action=>{await page.locator(`[data-console-action="${action}"]`).first().click();await op.locator('form').waitFor();};
  const pick=async(selector,value)=>{const native=page.locator(selector),index=await native.evaluate((s,v)=>[...s.options].findIndex(o=>o.value===v),value);assert.ok(index>=0);const button=native.locator('..').locator('> .select-trigger');await button.click();await page.locator('#'+await button.getAttribute('aria-controls')).locator(`[data-index="${index}"]`).click();};
  const submit=async()=>{await op.locator('button[type=submit]').click();await op.locator('.operation-result').first().waitFor({state:'attached'});return JSON.parse(await op.locator('.operation-result').first().textContent());};
  const close=async()=>{await op.locator('[data-operation-close]').first().click();await op.waitFor({state:'hidden'});};
  await goto('overview');const overview=await page.evaluate(()=>fetch('/console-api/overview').then(r=>r.json()));
  check('Overview keeps library and system details folded behind the graph and activity',await page.locator('[data-overview-library][open],[data-overview-system][open]').count()===0);
  await shot('overview');
  await page.locator('[data-overview-library]>summary').click();await page.locator('[data-overview-system]>summary').click();
  check('Overview shows real account counts after expanding secondary information',await page.locator('[data-metric=memories] strong').innerText()===overview.counts.memories.toLocaleString()&&await page.locator('.attention-card').count()===1);
  await goto('summaries');check('Summaries page offers no category editing',await page.locator('[data-console-action="taxonomy.save"],[data-console-action="category.manage"]').count()===0);
  check('Summaries are grouped by what they cover',await page.locator('.summary-group,.empty').count()>0);
  await goto('memories');
  const selection=page.locator('[data-memory-selection]'),boxes=page.locator('[data-batch-memory]'),search=page.locator('#search-form [name=query]');
  check('No batch action is enabled before selection',await selection.locator('[data-console-action]:enabled').count()===0);
  const placeholder=await search.getAttribute('placeholder');await search.focus();
  check('Search focus hides the placeholder without removing its label',await search.evaluate(n=>getComputedStyle(n,'::placeholder').color)==='rgba(0, 0, 0, 0)'&&await search.getAttribute('placeholder')===placeholder);
  await search.fill('Synthetic typed query');await page.locator('#console-root h1').click();
  check('Blur preserves typed search content',await search.inputValue()==='Synthetic typed query');await search.fill('');await page.locator('#console-root h1').click();
  check('Unfocused empty search restores its placeholder',await search.evaluate(n=>getComputedStyle(n,'::placeholder').color)!=='rgba(0, 0, 0, 0)');
  for(const width of [1440,1024]){
    await page.setViewportSize({width,height:1100});
    check('Checkbox is beside memory text at '+width,await boxes.first().evaluate(n=>{const c=n.getBoundingClientRect(),text=n.closest('td').querySelector('.memory-title,.memory-text').getBoundingClientRect();return c.right<=text.left&&Math.abs(c.y+c.height/2-(text.y+parseFloat(getComputedStyle(n.closest('td').querySelector('.memory-link')).lineHeight)/2))<8;}));
  }
  await page.setViewportSize({width:1440,height:1100});
  check('Selection has no extra visible label',!(await page.locator('.memory-table').innerText()).includes('选择这条记忆')&&await boxes.first().getAttribute('aria-label')==='选择这条记忆');
  let selectionWrites=0;const countWrites=req=>{if(req.method()==='POST')selectionWrites++;};page.on('request',countWrites);
  await boxes.first().focus();await page.keyboard.press('Space');await boxes.nth(1).check();
  check('Keyboard selection enables retraction and the exact count',await selection.locator('[data-selection-count]').innerText()==='2'&&await selection.locator('[data-console-action]:enabled').count()===1&&await selection.locator('[data-console-action="memory.batch_retract"]').isEnabled());
  check('Selecting does not open memory detail',!(await page.locator('#memory-dialog').isVisible()));
  await shot('memory-selection');await selection.locator('[data-clear-selection]').click();
  check('Clear resets checkboxes and action state',await page.locator('[data-batch-memory]:checked').count()===0&&await selection.locator('[data-selection-count]').innerText()==='0'&&await selection.locator('[data-console-action]:enabled').count()===0);
  check('Selection alone performs no write',selectionWrites===0);page.off('request',countWrites);
  await boxes.first().check();await page.locator('[data-reset-filters]').click();await page.waitForFunction(()=>document.querySelector('[data-selection-count]')?.textContent==='0');
  check('Reload clears stale selection',await page.locator('[data-batch-memory]:checked').count()===0);
  // Types are chosen by the writer; the only batch action is retraction, and a correction can change the type.
  check('No category filing is offered',await page.locator('[data-console-action="memory.organize"],[data-console-action="memory.batch_classify"]').count()===0);
  check('Rows show the type column',await page.locator('.memory-table .kind-pill').count()>0);
  await page.locator('[data-memory]').first().click();await begin('memory.correct');await op.locator('[name=content]').fill('Synthetic revised body with Unicode 😀.');check('Correction creates a real replacement',(await submit()).status==='superseded');await close();
  await page.locator('[data-memory]').first().click();await page.locator('[data-compare-memory]').click();await detail.locator('[data-comparison] pre').nth(1).waitFor();
  check('Comparison highlights the actual changed region',(await detail.locator('ins').innerText()).includes('revised'));
  check('Version comparison loads both complete sides',(await detail.locator('[data-comparison] pre').first().innerText()).length>0);await shot('version-comparison',false);
  await detail.locator('[data-feature-close]').click();await page.locator('#memory-dialog [data-close]').click();
  await page.locator('[data-batch-memory]').first().check();await begin('memory.batch_retract');check('Batch retract reports a real outcome',(await submit()).results[0].ok===true);await close();await shot('memory-library');
  // The privacy/retention page was removed from the web Console; its backend stays. Set the account default through the
  // same Console action endpoint (session + CSRF) so the memory form below still proves the default is honored.
  const backend=await page.evaluate(async()=>{const me=await (await fetch('/console-api/me',{credentials:'same-origin'})).json(),current=await (await fetch('/console-api/privacy-defaults',{credentials:'same-origin'})).json();
    const body=new URLSearchParams({csrf:me.csrf,account_id:me.account_id,action:'privacy.defaults',operation_id:crypto.randomUUID(),payload:JSON.stringify({expected_revision:current.revision,sensitivity:'secret',cloud_readable:false})});
    const r=await fetch('/console-api/action',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/x-www-form-urlencoded'},body});return {status:r.status,data:await r.json()};});
  check('Private defaults are persisted through the retained backend',backend.status===200&&backend.data.status==='saved');
  check('No privacy page remains in the navigation',await page.locator('a[href="/app/privacy"]').count()===0);
  await goto('memories');await begin('memory.create');check('New form has no sensitivity field (levels were removed)',await op.locator('[name=sensitivity]').count()===0);await op.locator('[name=content]').fill('Synthetic private default acceptance.');const created=await submit();check('Private memory saved',created.status==='saved');await close();
  const metadata=await (await ctx.request.get(cfg.url+'/console-api/memory-meta?memory_id='+created.memory_id)).json();check('No sensitivity and no per-memory ChatGPT flag are exposed',metadata.sensitivity===undefined&&metadata.web_allowed===undefined);
  await goto('connections');await page.locator('[data-agent-pick=codex]').click();await page.locator('[data-agent-generate="codex:plugin"]').click();
  const agentDialog=page.locator('.agent-dialog'),agentRow=page.locator('.agents-table tbody tr').filter({hasText:'Synthetic browser Agent'});
  const agentSubmit=async action=>{const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/console-api/action'&&r.request().method()==='POST'&&new URLSearchParams(r.request().postData()||'').get('action')===action);
    await agentDialog.locator('[name=current_password]').fill(cfg.password);await agentDialog.locator('button[type=submit]').click();const r=await response;assert.equal(r.status(),200);return r.json();};
  await agentDialog.locator('[name=label]').fill('Synthetic browser Agent');await agentDialog.locator('[name=device]').fill('synthetic-device');
  const registered=await agentSubmit('devices.register');check('Agent key is minted through the real authenticated BFF',registered.api_key.startsWith('mnm_'));await agentDialog.waitFor({state:'hidden'});await agentRow.waitFor();
  check('The one-time setup instructions contain the issued key',(await page.locator('.agent-panel').innerText()).includes(registered.api_key));
  await agentRow.locator('[data-agent-row="devices.rotate"]').click();const rotated=await agentSubmit('devices.rotate');check('Agent rotation changes the actual key',rotated.api_key.startsWith('mnm_')&&rotated.api_key!==registered.api_key);
  await agentDialog.locator('.agent-code code').waitFor();check('The rotation dialog preserves the new key',await agentDialog.locator('.agent-code code').innerText()===rotated.api_key);await agentDialog.locator('[data-close]').last().click();await agentDialog.waitFor({state:'hidden'});
  const capture=await page.evaluate(()=>fetch('/console-api/capture-status').then(r=>r.json()));check('Server observations leave local hook and queue health unknown',capture.local_hook_failures==='not_observable'&&capture.local_queue==='not_observable'&&await agentRow.locator('[data-state="未使用"]').count()===1);await shot('connections');
  // Password-only connection reauthentication is a security audit event; the login-history view lists sign-ins.
  // Perform a real password + authenticator sign-in so the history assertion has its own current-contract evidence.
  const login=await browser.newContext(),lp=await login.newPage();await lp.goto(cfg.url+'/login');await lp.locator('#username').fill(cfg.accounts[0].username);await lp.locator('#password').fill(cfg.password);await lp.locator('[name=otp]').fill((await command('otp',{fresh:true})).otp);
  await Promise.all([lp.waitForURL(u=>u.pathname.startsWith('/app')),lp.locator('button.primary[type=submit]').click()]);await login.close();
  await goto('security');check('Authentication history shows the real password and authenticator sign-in',(await page.locator('[data-feature="SEC-05"] tbody tr').allInnerTexts()).some(text=>text.includes('account.login')));await shot('security');
  await goto('audit?group=system');await page.locator('.audit-filter-panel summary').click();await page.locator('#audit-filter [name=action]').fill('console.privacy.defaults');await page.locator('#audit-filter button[type=submit]').click();
  await page.waitForFunction(()=>{const rows=[...document.querySelectorAll('.audit-event-title strong')];return rows.length>0&&rows.every(n=>n.textContent==='console.privacy.defaults');});
  check('Audit filter returns only the privacy action performed above',(await page.locator('.audit-event-title strong').allInnerTexts()).every(s=>s==='console.privacy.defaults'));
  const download=page.waitForEvent('download');await page.locator('[data-audit-export]').click();const file=await download;await file.saveAs(path.join(evidence,'synthetic-audit.json'));
  const exported=JSON.parse(fs.readFileSync(path.join(evidence,'synthetic-audit.json'),'utf8'));check('Audit export uses real filtered metadata',exported.entries.length>0&&exported.entries.every(e=>e.action==='console.privacy.defaults'));await shot('audit');
  await goto('models');check('Unconfigured usage is not fabricated',await page.locator('[data-feature="MOD-04"] table').count()===1);
  // Project/task editing and Console archive are offered (phase 3); handoff bootstrap and reconciliation writes are not.
  await goto('tasks');check('Task page does not expose handoff bootstrap or reconciliation writes',await page.locator('[data-console-action$=".bootstrap"],[data-console-action="tasks.reconcile"]').count()===0);
  for(const view of ['task-branches','task-checkpoints','task-reconciliation']){
    await page.locator(`[data-feature-read="${view}"]`).first().click();await detail.locator('.operation-result').waitFor();const data=JSON.parse(await detail.locator('.operation-result').innerText());check('Real owner task inspector '+view,data.read_only===true);await detail.locator('[data-feature-close]').click();
  }
  // Project context now opens inside its project row instead of the detached inspector.
  const contextButton=page.locator('[data-project-context]').first(),contextRegion=page.locator('#'+await contextButton.getAttribute('aria-controls'));
  await contextButton.click();await contextRegion.locator('.context-provenance').waitFor();
  const detachedOpen=await detail.count()?await detail.evaluate(d=>d.open):false;
  check('Real owner project context opens inline and read-only',await contextButton.getAttribute('aria-expanded')==='true'&&(await contextRegion.innerText()).trim().length>0&&!detachedOpen);
  await shot('tasks');
  // The health page uses service tiles; backups retain a separate operator-only read API.
  await goto('storage');check('Health shows the actual ready Core service',await page.locator('.health-tile[data-health=ok]',{hasText:'核心服务'}).count()===1);
  const backups=await ctx.request.get(cfg.url+'/console-api/backups'),backupState=await backups.json();check('Unconfigured backups remain explicit and unverified',backups.status()===200&&backupState.status==='not_configured'&&backupState.verified===false&&backupState.entries.length===0);await shot('health');
  await page.locator('#locale').selectOption({value:'en'},{force:true});check('English page title follows the locale',(await page.locator('#console-root h1').innerText()).trim()==='Health');await shot('health-en');
  const member=await browser.newContext();await member.addCookies([{name:cfg.cookie,value:cfg.accounts[1].token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);const mp=await member.newPage();await mp.goto(cfg.url+'/app/storage');await mp.locator('#console-root h1').waitFor();await mp.locator('.health-head').waitFor();
  check('Member sees no operator service data',await mp.locator('.health-tile',{hasText:'核心服务'}).count()===0);check('Member denied at the service and backup APIs',(await member.request.get(cfg.url+'/console-api/system-health')).status()===403&&(await member.request.get(cfg.url+'/console-api/backups')).status()===403);await member.close();
  await command('basic-memory-only');await goto('memories');
  check('Basic-only account keeps new-memory operation',await page.locator('[data-console-action="memory.create"]').count()===1);
  // Basic memory rights cover create, correct and retract; batch actions need full console rights.
  check('Basic-only account offers no batch actions',await page.locator('[data-console-action^="memory.batch_"],[data-console-action="memory.organize"]').count()===0);
  await shot('memory-basic-only-en');
  fs.writeFileSync(path.join(evidence,'browser-errors.json'),JSON.stringify(errors,null,2),{mode:0o600});check('No JavaScript or CSP failures',errors.length===0);
  fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({status:'passed',checks},null,2),{mode:0o600});console.log(JSON.stringify({status:'passed',checks:checks.length,evidence}));
}catch(error){fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({status:'failed',checks,error:error.stack},null,2),{mode:0o600});console.error(JSON.stringify({status:'failed',evidence,error:error.message}));process.exitCode=1;}
finally{
 await browser?.close();
 const exited=new Promise(resolve=>fixture.once('exit',resolve));
 fixture.stdin.end('{"command":"stop"}\n');
 const timer=setTimeout(()=>fixture.kill('SIGTERM'),5000);
 await exited;clearTimeout(timer);fs.closeSync(log);
 assert.ok(fs.readFileSync(path.join(evidence,'fixture.stderr'),'utf8').includes('"synthetic_cleanup_complete":true'),'Synthetic fixture cleanup must be verified');
}
