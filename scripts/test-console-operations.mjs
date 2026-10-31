// Real browser + authenticated HTTP acceptance. Everything sent to the model and backed up is synthetic.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
const root=path.resolve(import.meta.dirname,'..'),base=path.resolve(process.env.MNEMURON_UI_EVIDENCE||os.tmpdir());assert.ok(base!==root&&!base.startsWith(root+path.sep));
const evidence=fs.mkdtempSync(path.join(base,'operations-browser-'));fs.chmodSync(evidence,0o700);
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const log=fs.openSync(path.join(evidence,'fixture.stderr'),'wx',0o600),fixture=spawn(process.execPath,['scripts/helpers/operations-browser-fixture.mjs'],{cwd:root,stdio:['pipe','pipe',log]});
const queue=[],waiters=[];createInterface({input:fixture.stdout}).on('line',line=>{if(line.startsWith('{')){const data=JSON.parse(line);if(waiters.length)waiters.shift()(data);else queue.push(data);}});
async function read(){let timer;try{return await Promise.race([queue.length?Promise.resolve(queue.shift()):new Promise(r=>waiters.push(r)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Synthetic fixture timeout')),30000);})]);}finally{clearTimeout(timer);}}
async function command(command,extra={}){fixture.stdin.write(JSON.stringify({command,...extra})+'\n');const r=await read();assert.ok(!r.fixture_error);return r;}
const checks=[],check=(name,pass=true)=>{assert.ok(pass,name);checks.push(name);console.log('PASS '+name);};let browser;
try{
  const cfg=await read();assert.equal(cfg.fixture,true);assert.equal(new URL(cfg.url).hostname,'127.0.0.1');
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addCookies([{name:cfg.cookie,value:cfg.accounts[0].token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);
  const page=await context.newPage(),errors=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/Content Security Policy|Refused/.test(m.text()))errors.push(m.text());});
  const goto=async slug=>{await page.goto(cfg.url+'/app/'+slug);await page.locator('#console-root h1').waitFor();await page.locator('.loading-card').waitFor({state:'detached'});};
  const op=page.locator('#operation-dialog'),begin=async action=>{await page.locator(`[data-console-action="${action}"][data-kind=organizer]`).click();await op.locator('form').waitFor();};
  const submit=async()=>{await op.locator('button[type=submit]').click();await op.locator('.operation-result').first().waitFor({state:'attached'});return JSON.parse(await op.locator('.operation-result').first().textContent());};
  const close=async()=>{await op.locator('[data-operation-close]').first().click();await op.waitFor({state:'hidden'});};
  const usage=()=>page.evaluate(()=>fetch('/console-api/model-usage').then(r=>r.json())).then(r=>r.observed_usage);
  await goto('models');check('Read-only model page does not dispatch or manufacture usage',(await command('metrics')).calls===0&&(await usage()).totals.attempts===0);
  await begin('models.save');await op.locator('[name=enabled]').check();await op.locator('[name=base_url]').fill(cfg.model_url);await op.locator('[name=model]').fill('synthetic <b>model</b>');await op.locator('[name=egress_approved]').check();
  await op.locator('[name=pricing_enabled]').check();await op.locator('[name=price_version]').fill('synthetic <v1>');await op.locator('[name=price_input]').fill('2');await op.locator('[name=price_output]').fill('4');
  check('Optional prices persist through the real model configuration form',(await submit()).status==='saved');await close();await begin('models.test');check('Synthetic capability probe succeeds',(await submit()).status==='verified');await close();await goto('models');
  let u=await usage();check('Successful request has real reported tokens, latency and a request-time estimate',u.totals.attempts===1&&u.recent[0].input_tokens===100&&u.recent[0].duration_ms>=0&&u.recent[0].estimated_amount===0.00028);
  check('The UI explicitly separates unknowns and estimates and escapes saved labels',await page.locator('.usage-evidence').count()===1&&await page.locator('.usage-evidence b').count()===0&&(await page.locator('.usage-evidence').innerText()).includes('synthetic <b>model</b>'));
  await begin('models.save');await op.locator('[name=price_version]').fill('synthetic-v2');await op.locator('[name=price_input]').fill('10');await submit();await close();
  await begin('models.test');await submit();await close();u=await usage();check('Changing prices never reprices previous observations',u.recent.some(r=>r.pricing.version==='synthetic <v1>'&&r.estimated_amount===0.00028)&&u.recent.some(r=>r.pricing.version==='synthetic-v2'&&r.estimated_amount===0.00108));
  await command('model-mode',{mode:'unknown'});await begin('models.test');await submit();await close();u=await usage();check('A response without usage remains unknown, never zero tokens or free',u.recent[0].input_tokens===null&&u.recent[0].estimated_amount===null&&u.recent[0].estimate_status==='unknown_usage');
  await command('model-mode',{mode:'failed'});await begin('models.test');await op.locator('button[type=submit]').click();await op.locator('[data-operation-error]').waitFor();await close();await goto('models');u=await usage();check('A failed supplier call remains visible without leaking its body',u.totals.failed===1&&u.recent[0].error_code==='REMOTE_UNAVAILABLE'&&!JSON.stringify(u).includes('upstream-private'));
  check('Unknown attempts and unestimated counts are visible',(await page.locator('.usage-evidence').innerText()).includes('无法估算')&&(await page.locator('.usage-evidence').innerText()).includes('未知'));
  await page.locator('.usage-evidence details summary').click();
  // Capture this panel without the unrelated host-configuration list, and tall enough that the sticky topbar
  // cannot occlude its counters. Responsive checks below still use the normal desktop/mobile viewport.
  await page.setViewportSize({width:1440,height:1600});await page.locator('.usage-evidence').screenshot({path:path.join(evidence,'usage-desktop.png')});await page.setViewportSize({width:1440,height:1000});
  const calls=(await command('metrics')).calls;await goto('health');check('Unconfigured backup evidence is explicit',await page.locator('[data-backup-state=not_configured]').count()===1);
  await command('backup-configure');await goto('health');check('Configured directory without commands stays missing',await page.locator('[data-backup-state=missing]').count()===1);
  await command('backup-create');await goto('health');check('Creating a snapshot is not labelled independently verified',await page.locator('[data-backup-state=created]').count()===1);
  await command('backup-verify');await command('backup-restore');await goto('health');check('Real synthetic backup, verification and isolated restore evidence are displayed',await page.locator('[data-backup-state=verified]').count()===1&&await page.locator('[data-backup-evidence] tbody tr').count()===3&&(await page.locator('[data-backup-evidence]').innerText()).includes('对应最近创建的备份'));
  const payload=await page.evaluate(()=>fetch('/console-api/backups').then(r=>r.json()));check('Backup API is metadata-only and read-only',payload.read_only===true&&payload.operations_enabled===false&&!JSON.stringify(payload).match(/sqlite3|\/var\/|credentials|OTHER OWNER|private operations/));
  await page.screenshot({path:path.join(evidence,'backup-desktop.png'),fullPage:true});check('Reading backup status never calls a model',(await command('metrics')).calls===calls);
  await command('backup-corrupt');check('Corrupt manifest verification fails',(await command('backup-verify')).error_code==='BACKUP_MANIFEST_MISMATCH');await goto('health');check('New failed verification replaces an earlier green status',await page.locator('[data-backup-state=failed]').count()===1);
  const other=await browser.newContext();await other.addCookies([{name:cfg.cookie,value:cfg.accounts[1].token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);const otherPage=await other.newPage();await otherPage.goto(cfg.url+'/app/models');await otherPage.locator('.usage-evidence').waitFor();
  const otherUsage=await otherPage.evaluate(()=>fetch('/console-api/model-usage').then(r=>r.json()));check('Another account sees no model attempts or prices',otherUsage.observed_usage.totals.attempts===0&&!JSON.stringify(otherUsage).includes('synthetic-v2'));
  const status=await otherPage.evaluate(()=>fetch('/console-api/backups').then(r=>r.status));check('Non-operator accounts cannot read platform backup evidence',status===403);await other.close();
  for(const locale of ['en','zh-CN']){
    const select=page.locator('#locale'),index=await select.evaluate((s,v)=>[...s.options].findIndex(o=>o.value===v),locale),button=select.locator('..').locator('> .select-trigger');await button.click();await page.locator('#'+await button.getAttribute('aria-controls')).locator(`[data-index="${index}"]`).click();
    for(const width of [1440,390])for(const slug of ['models','health']){await page.setViewportSize({width,height:1000});await goto(slug);check(`${locale} ${slug} stays within ${width}px viewport`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));if(width===390){if(slug==='models')await page.locator('.usage-evidence').screenshot({path:path.join(evidence,`${slug}-${locale}-mobile.png`)});else await page.screenshot({path:path.join(evidence,`${slug}-${locale}-mobile.png`),fullPage:true});}}
  }
  check('No JavaScript or CSP errors',errors.length===0);fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify({synthetic:true,real_model_called:false,checks},null,2),{mode:0o600});console.log(JSON.stringify({passed:checks.length,evidence}));
}finally{await browser?.close();if(!fixture.killed){fixture.stdin.write('{"command":"stop"}\n');await new Promise(resolve=>{const timer=setTimeout(()=>{fixture.kill('SIGTERM');resolve();},3000);fixture.once('exit',()=>{clearTimeout(timer);resolve();});});}fs.closeSync(log);assert.ok(fs.readFileSync(path.join(evidence,'fixture.stderr'),'utf8').includes('"synthetic_cleanup_complete":true'),'Synthetic fixture cleanup must be verified');}
