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
  const proof=async()=>{await op.locator('[name=current_password]').fill(cfg.password);await op.locator('[name=otp]').fill((await command('otp',{fresh:true})).otp);};
  const submit=async()=>{await op.locator('button[type=submit]').click();await op.locator('.operation-result').first().waitFor({state:'attached'});return JSON.parse(await op.locator('.operation-result').first().textContent());};
  const close=async()=>{await op.locator('[data-operation-close]').first().click();await op.waitFor({state:'hidden'});};
  await goto('overview');check('Attention shows real account counts',await page.locator('[data-feature="OVW-03"] .metadata-grid').count()===1);await shot('overview');
  await goto('summaries');await begin('taxonomy.save');await op.locator('[name=categories]').fill('uncategorized\ntechnical\nsynthetic');check('Taxonomy saved through real BFF', (await submit()).status==='saved');await close();
  check('Saved taxonomy appears in the page',(await page.locator('[data-feature="SUM-03"]').innerText()).includes('synthetic'));
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
  check('Keyboard selection enables nearby actions and exact count',await selection.locator('[data-selection-count]').innerText()==='2'&&await selection.locator('[data-console-action]:enabled').count()===2);
  check('Selecting does not open memory detail',!(await page.locator('#memory-dialog').isVisible()));
  await shot('memory-selection');await selection.locator('[data-clear-selection]').click();
  check('Clear resets checkboxes and action state',await page.locator('[data-batch-memory]:checked').count()===0&&await selection.locator('[data-selection-count]').innerText()==='0'&&await selection.locator('[data-console-action]:enabled').count()===0);
  check('Selection alone performs no write',selectionWrites===0);page.off('request',countWrites);
  await boxes.first().check();await page.locator('[data-reset-filters]').click();await page.waitForFunction(()=>document.querySelector('[data-selection-count]')?.textContent==='0');
  check('Reload clears stale selection',await page.locator('[data-batch-memory]:checked').count()===0);
  // Selected memories are filed through the one organize flow: choose → preview → confirm → result.
  await boxes.first().check();await begin('memory.organize');await pick('#operation-dialog [name=category]','synthetic');
  await op.locator('[data-organize-step="choose"] button[type=submit]').click();await op.locator('[data-organize-step="confirm"]').waitFor();
  check('Organize preview states the exact change before writing',(await op.locator('.organize-headline').innerText()).startsWith('1'));
  await op.locator('[data-organize-step="confirm"] button[type=submit]').click();await op.locator('.organize-result').waitFor();
  check('Selected memory is actually classified',(await page.locator('.category-pill[data-category="synthetic"]').count())===1);await close();
  await page.locator('[data-memory]').first().click();await begin('memory.correct');await op.locator('[name=content]').fill('Synthetic revised body with Unicode 😀.');check('Correction creates a real replacement',(await submit()).status==='superseded');await close();
  await page.locator('[data-memory]').first().click();await page.locator('[data-compare-memory]').click();await detail.locator('[data-comparison] pre').nth(1).waitFor();
  check('Comparison highlights the actual changed region',(await detail.locator('ins').innerText()).includes('revised'));
  check('Version comparison loads both complete sides',(await detail.locator('[data-comparison] pre').first().innerText()).length>0);await shot('version-comparison',false);
  await detail.locator('[data-feature-close]').click();await page.locator('#memory-dialog [data-close]').click();
  await page.locator('[data-batch-memory]').first().check();await begin('memory.batch_retract');check('Batch retract reports a real outcome',(await submit()).results[0].ok===true);await close();await shot('memory-library');
  await goto('privacy');await begin('privacy.defaults');await pick('#operation-dialog [name=sensitivity]','secret');check('Private defaults are persisted',(await submit()).status==='saved');await close();
  await begin('retention.save');await op.locator('[name=raw_retention_days]').fill('7');check('Retention saves own future default',(await submit()).raw_retention_days===7);await close();
  await begin('retention.prune');await op.locator('[name=confirmed]').check();await proof();check('Confirmed prune uses real empty fixture, not fake success',(await submit()).expired_events===0);await close();await shot('privacy');
  await goto('memories');await begin('memory.create');check('New form honors account sensitivity default',await op.locator('[name=sensitivity]').inputValue()==='secret');await op.locator('[name=content]').fill('Synthetic private default acceptance.');const created=await submit();check('Private memory saved',created.status==='saved');await close();
  const metadata=await (await ctx.request.get(cfg.url+'/console-api/memory-meta?memory_id='+created.memory_id)).json();check('Default sensitivity applied; no per-memory ChatGPT flag is exposed',metadata.sensitivity==='secret'&&metadata.web_allowed===undefined);
  await goto('connections');await begin('devices.register');await op.locator('[name=label]').fill('Synthetic browser Agent');await op.locator('[name=agent_id]').fill('synthetic-console-agent');await op.locator('[name=device_id]').fill('synthetic-device');await proof();
  const registered=await submit();check('Agent key minted, not a simulated credential',registered.api_key.startsWith('mnm_'));await close();
  await begin('devices.rotate');await proof();const rotated=await submit();check('Agent rotation changes actual key',rotated.api_key!==registered.api_key);await close();
  check('Server observations do not claim local hooks are healthy',(await page.locator('[data-feature="CON-04"]').innerText()).includes('Hook'));await shot('connections');
  await goto('security');check('Authentication history shows real proof activity',await page.locator('[data-feature="SEC-05"] tbody tr').count()>0);await shot('security');
  await goto('audit');await page.locator('#audit-filter [name=action]').fill('console.taxonomy.save');await page.locator('#audit-filter button[type=submit]').click();
  await page.waitForFunction(()=>{const rows=[...document.querySelectorAll('.timeline-item strong')];return rows.length>0&&rows.every(n=>n.textContent==='console.taxonomy.save');});
  check('Audit filter returns only selected action',(await page.locator('.timeline-item strong').allInnerTexts()).every(s=>s==='console.taxonomy.save'));
  const download=page.waitForEvent('download');await page.locator('[data-audit-export]').click();const file=await download;await file.saveAs(path.join(evidence,'synthetic-audit.json'));
  const exported=JSON.parse(fs.readFileSync(path.join(evidence,'synthetic-audit.json'),'utf8'));check('Audit export uses real filtered metadata',exported.entries.length>0&&exported.entries.every(e=>e.action==='console.taxonomy.save'));await shot('audit');
  await goto('models');check('Unconfigured usage is not fabricated',await page.locator('[data-feature="MOD-04"] table').count()===1);
  await goto('tasks');check('Task page does not expose handoff writes',await page.locator('[data-console-action^="tasks."],[data-console-action^="projects."]').count()===0);
  for(const view of ['task-branches','project-context','task-checkpoints','task-reconciliation']){
    await page.locator(`[data-feature-read="${view}"]`).first().click();await detail.locator('.operation-result').waitFor();const data=JSON.parse(await detail.locator('.operation-result').innerText());check('Real owner task inspector '+view,data.read_only===true);await detail.locator('[data-feature-close]').click();
  }await shot('tasks');
  await goto('system');check('Unknown backup status is explicit',(await page.locator('[data-feature="SYS-04"]').innerText()).includes('无法确认'));await shot('system');
  await page.locator('#locale').selectOption({value:'en'},{force:true});check('English translation includes new features',(await page.locator('[data-feature="SYS-04"]').innerText()).includes('No trusted backup-status source'));await shot('system-en');
  const member=await browser.newContext();await member.addCookies([{name:cfg.cookie,value:cfg.accounts[1].token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);const mp=await member.newPage();await mp.goto(cfg.url+'/app/system');await mp.locator('#console-root h1').waitFor();
  check('Member sees no operator service data',await mp.locator('[data-feature="SYS-02"]').count()===0);check('Member denied at BFF as well',(await member.request.get(cfg.url+'/console-api/system-health')).status()===403);await member.close();
  await command('basic-memory-only');await goto('memories');
  check('Basic-only account keeps new-memory operation',await page.locator('[data-console-action="memory.create"]').count()===1);
  // Basic memory rights include organizing (same gate as memory.classify), never batch retract.
  check('Basic-only account selection offers only the organize flow',await boxes.count()>0&&await selection.locator('[data-console-action]').count()===1&&await selection.locator('[data-console-action="memory.organize"]').count()===1&&await page.locator('[data-console-action^="memory.batch_"]').count()===0);
  check('Basic-only organize scope is explained',await page.locator('[data-i18n="organizeNote"]').count()===1);
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
