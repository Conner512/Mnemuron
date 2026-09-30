// Real browser acceptance against disposable loopback Core/OAuth/BFF services.
// Use an already installed Playwright module; do not install packages or touch production.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import assert from 'node:assert/strict';

const root=path.resolve(import.meta.dirname,'..');
const base=path.resolve(process.env.MNEMURON_UI_EVIDENCE||os.tmpdir());
assert.ok(fs.existsSync(base)&&!base.startsWith(root+path.sep),'Evidence must be outside the worktree');
const evidence=fs.mkdtempSync(path.join(base,'connections-browser-'));fs.chmodSync(evidence,0o700);
const module=process.env.PLAYWRIGHT_MODULE;assert.ok(module&&path.isAbsolute(module),'Set PLAYWRIGHT_MODULE to an installed module');
const {chromium}=await import(pathToFileURL(module));
const log=fs.openSync(path.join(evidence,'fixture.stderr'),'wx',0o600);
const fixture=spawn(process.execPath,['services/oauth/test/helpers/console-functional-preview.mjs'],{cwd:root,stdio:['pipe','pipe',log]});
const queue=[],waiters=[];
createInterface({input:fixture.stdout}).on('line',line=>{if(!line.startsWith('{'))return;const value=JSON.parse(line);if(waiters.length)waiters.shift()(value);else queue.push(value);});
const read=async()=>{let timer;try{return await Promise.race([queue.length?Promise.resolve(queue.shift()):new Promise(r=>waiters.push(r)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Synthetic fixture timeout')),30000);})]);}finally{clearTimeout(timer);}};
const command=async(command,extra={})=>{fixture.stdin.write(JSON.stringify({command,...extra})+'\n');const r=await read();assert.ok(!r.fixture_error,r.fixture_error);return r;};
const checks=[];const check=(name,condition=true)=>{assert.ok(condition,name);checks.push(name);console.log('PASS '+name);};
let browser;
try{
 const cfg=await read();assert.equal(cfg.fixture,true);
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:1440,height:1080},permissions:['clipboard-read','clipboard-write']});
 await context.addCookies([{name:cfg.cookie,value:cfg.accounts[0].token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);
 const page=await context.newPage(),errors=[];let mutations=0;
 page.on('request',request=>{if(request.url().includes('/console-api/action'))mutations++;});
 page.on('pageerror',error=>errors.push(error.message));page.on('console',msg=>{if(msg.type()==='error'&&/Content Security Policy|Refused/.test(msg.text()))errors.push(msg.text());});
 const goto=async name=>{await page.goto(cfg.url+'/app/'+name);await page.locator('#console-root h1').waitFor();await page.locator('.loading-card').waitFor({state:'detached'});};
 const pick=async(selector,value)=>{const native=page.locator(selector),index=await native.evaluate((s,v)=>[...s.options].findIndex(o=>o.value===v),value);assert.ok(index>=0);const button=native.locator('..').locator('> .select-trigger');await button.click();await page.locator('#'+await button.getAttribute('aria-controls')).locator(`[data-index="${index}"]`).click();assert.equal(await native.inputValue(),value);};
 const dialog=page.locator('#connection-dialog');
 const proof=async()=>{await dialog.locator('[name=current_password]').fill(cfg.password);await dialog.locator('[name=otp]').fill((await command('otp',{fresh:true})).otp);};
 const submit=async()=>{await dialog.locator('button[type=submit]').click();await dialog.locator('#connection-secret').waitFor();};
 const openNew=async kind=>{await page.locator('[data-connection-new]').click();await page.locator(`[data-connection-kind="${kind}"]`).click();};
 const basic=async(label,profile='readonly')=>{await dialog.locator('[name=label]').fill(label);await pick('#connection-dialog [name=profile]',profile);await dialog.locator('button[type=submit]').click();await proof();};
 const saveSecret=async()=>{const value=await dialog.locator('#connection-secret').inputValue();check('Secret starts masked',await dialog.locator('#connection-secret').getAttribute('type')==='password');check('Secret never appears in persistent appearance storage',!(await page.evaluate(()=>JSON.stringify(localStorage))).includes(value));await dialog.locator('[data-connection-secret-saved]').click();await dialog.locator('[data-connection-refresh]').waitFor();await command('provision-connections');await dialog.locator('[data-connection-refresh]').click();await dialog.locator('[data-connection-refresh]').waitFor();return value;};
 const close=async()=>{await dialog.locator('[data-connection-close]').first().click();await dialog.waitFor({state:'hidden'});check('Closing clears the credential DOM',await page.locator('#connection-secret').count()===0);};
 await goto('connections');check('Real empty logical list retains legacy authorization separately',await page.locator('.connection-table [data-connection-detail]').count()===0&&await page.locator('.connection-system').count()===1);
 await openNew('generic_mcp');check('Readonly profile cannot select a write-time disclosure grant',await dialog.locator('[name=allow_submitted_revision_grant]').isDisabled());await dialog.locator('[name=label]').fill('Synthetic portable reader');await pick('#connection-dialog [name=profile]','memory_readwrite');
 const beforeAppearance=mutations;
 // Exercise the real preference event handler while the modal owns focus.
 for(const [id,value] of [['locale','en'],['locale','zh-CN']])await page.locator('#'+id).evaluate((select,value)=>{select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));},value);
 check('Language changes preserve draft values without a mutation request',mutations===beforeAppearance&&await dialog.locator('[name=label]').inputValue()==='Synthetic portable reader'&&await dialog.locator('[name=profile]').inputValue()==='memory_readwrite');
 const trigger=dialog.locator('[data-select-name=profile]');await trigger.click();await page.keyboard.press('Escape');check('Escape closes the top-layer selector before the dialog',await dialog.isVisible()&&await page.locator('.select-popup:popover-open').count()===0);
 await dialog.locator('[name=allow_submitted_revision_grant]').check();await dialog.locator('button[type=submit]').click();await proof();await submit();
 const first=await saveSecret();check('Generic credential is a personal resource token, never a Core key',first.startsWith('mcp_pat_'));check('Server configuration is not fabricated connection success',!(await dialog.innerText()).includes('记忆调用已验证'));await close();
 await page.locator('.connection-table [data-connection-detail]').first().click();await dialog.locator('[data-connection-action=rotate]').click();await proof();await submit();const second=await saveSecret();check('Rotation generates a different actual credential',second!==first);await close();
 await openNew('chatgpt_oauth');await basic('Synthetic browser ChatGPT');await submit();const clientSecret=await saveSecret();check('OAuth Client Secret is distinct from a generic token',!clientSecret.startsWith('mcp_pat_')&&!clientSecret.startsWith('mnm_'));await close();
 await page.getByRole('button',{name:'Synthetic browser ChatGPT',exact:true}).click();await dialog.locator('[data-connection-action=update]').click();await dialog.locator('[name=redirect_uri]').fill('https://chatgpt.com/connector_platform_oauth_redirect');await proof();await dialog.locator('button[type=submit]').click();await dialog.locator('[data-connection-refresh]').waitFor();await command('provision-connections');await dialog.locator('[data-connection-refresh]').click();await dialog.locator('[data-connection-refresh]').waitFor();check('Exact callback persisted through real BFF',await dialog.innerText().then(v=>v.includes('https://chatgpt.com/connector_platform_oauth_redirect')));await close();
 check('Main rows represent two logical connections, not keys or grants',await page.locator('.connection-table tbody tr').count()===2);
 await page.locator('#connection-filters [name=search]').fill('portable');await page.locator('#connection-filters button[type=submit]').click();await page.getByRole('button',{name:'Synthetic browser ChatGPT',exact:true}).waitFor({state:'detached'});check('Backend filter returns one logical connection',await page.locator('.connection-table tbody tr').count()===1);await page.locator('[data-connection-reset]').click();await page.getByRole('button',{name:'Synthetic browser ChatGPT',exact:true}).waitFor();
 for(const action of ['disable','enable','revoke']){
  await page.getByRole('button',{name:'Synthetic portable reader',exact:true}).click();await dialog.locator(`[data-connection-action=${action}]`).click();await proof();await dialog.locator('button[type=submit]').click();
  if(action==='enable'){await dialog.locator('#connection-secret').waitFor();await saveSecret();}else await dialog.locator('[data-connection-refresh]').waitFor();await close();check('Real connection lifecycle '+action);
 }
 await pick('#connection-filters [name=section]','history');await page.locator('#connection-filters button[type=submit]').click();await page.getByRole('button',{name:'Synthetic portable reader',exact:true}).waitFor();check('Revoked record moves to history, preserving the logical record');
 await page.locator('[data-connection-reset]').click();await page.getByRole('button',{name:'Synthetic browser ChatGPT',exact:true}).waitFor();
 const bContext=await browser.newContext();await bContext.addCookies([{name:cfg.cookie,value:cfg.accounts[1].token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);const bp=await bContext.newPage();await bp.goto(cfg.url+'/app/connections');await bp.locator('[data-connection-new]').waitFor();check('Second account does not see first account connection names',!(await bp.innerText('body')).includes('Synthetic browser ChatGPT'));await bContext.close();
 for(const width of [1280,1440,1920]){
  await page.setViewportSize({width,height:1080});
  for(const locale of ['zh-CN','en']){
   await pick('#locale',locale);await openNew('generic_mcp');await dialog.locator('[name=label]').fill('Synthetic long connection label / 合成名称 / '+'.'.repeat(24));
   check(`Desktop ${width}/${locale}`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)&&await dialog.locator('[name=label]').inputValue().then(s=>s.startsWith('Synthetic')));
   if(width===1440)await page.screenshot({path:path.join(evidence,`wizard-${locale}.png`),fullPage:true});
   await close();
  }
 }
 await pick('#locale','en');await goto('memories');check('Language persists through real navigation',await page.locator('html').getAttribute('lang')==='en');await pick('#locale','zh-CN');
 for(const name of ['overview','memories','summaries','jobs','connections','models','security','audit','storage','invitations','accounts']){await goto(name);check('Existing console route '+name,await page.locator('#console-root [role=alert]').count()===0);}
 const operationDialog=page.locator('#operation-dialog');
 const begin=async action=>{await page.locator(`[data-console-action="${action}"]`).first().click();await operationDialog.locator('form').waitFor();};
 const runOperation=async()=>{await operationDialog.locator('button[type=submit]').click();await operationDialog.locator('.operation-result').first().waitFor();return JSON.parse(await operationDialog.locator('.operation-result').last().innerText());};
 const closeOperation=async()=>{await operationDialog.locator('[data-operation-close]').first().click();await operationDialog.waitFor({state:'hidden'});};
 await goto('memories');await begin('memory.create');await operationDialog.locator('[name=content]').fill('Synthetic browser regression: blue paper boat.');const created=await runOperation();check('Existing memory create persists',created.status==='saved');await closeOperation();
 await page.locator(`[data-memory="${created.memory_id}"]`).click();await begin('memory.classify');await pick('#operation-dialog [name=category]','technical');check('Existing manual classification persists',(await runOperation()).category==='technical');await closeOperation();
 await page.locator(`[data-memory="${created.memory_id}"]`).click();await begin('memory.visibility');await operationDialog.locator('[name=allow]').check();check('Existing exact-version visibility operation persists',(await runOperation()).allowed===true);await closeOperation();
 await page.locator(`[data-memory="${created.memory_id}"]`).click();await begin('memory.correct');await operationDialog.locator('[name=content]').fill('Synthetic browser regression: amber paper boat.');const corrected=await runOperation();check('Existing correction preserves the earlier record',corrected.memory_id!==created.memory_id);await closeOperation();
 await page.locator(`[data-memory="${corrected.memory_id}"]`).click();await begin('memory.retract');check('Existing retract does not physically delete',(await runOperation()).physically_deleted===false);await closeOperation();
 await goto('models');await begin('models.save');await operationDialog.locator('[name=enabled]').check();await operationDialog.locator('[name=base_url]').fill(cfg.model_url);await operationDialog.locator('[name=model]').fill('synthetic-organizer');await pick('#operation-dialog [name=sensitivity]','sensitive');await operationDialog.locator('[name=egress_approved]').check();check('Existing model settings persist without calling any paid model',(await runOperation()).model.config.model==='synthetic-organizer');await closeOperation();
 await begin('models.test');const modelCheck=await runOperation();check('Existing model diagnostic uses only loopback synthetic data',modelCheck.real_memory_sent===false&&modelCheck.status==='verified');await closeOperation();
 await goto('jobs');await begin('jobs.schedule');await operationDialog.locator('[name=include_open]').check();check('Existing background classification durably queues',(await runOperation()).jobs.length>0);await closeOperation();await command('tick');
 await begin('jobs.schedule');await pick('#operation-dialog [name=type]','summary');await operationDialog.locator('[name=include_open]').check();check('Existing summary job durably queues',(await runOperation()).jobs.length>0);await closeOperation();await command('tick');await command('tick');await goto('summaries');await page.locator('[data-summary]').first().waitFor();check('Existing source-grounded summaries display actual worker output');
 await goto('storage');await begin('storage.export');const downloading=page.waitForEvent('download');await runOperation();const download=await downloading,destination=path.join(evidence,'synthetic-personal-export.json');await download.saveAs(destination);const exported=fs.readFileSync(destination,'utf8');check('Existing export remains account-isolated without credentials',JSON.parse(exported).records.length>0&&!exported.includes('Synthetic private B sentinel')&&!exported.includes('api_key'));await closeOperation();
 await begin('storage.import');await operationDialog.locator('[name=file]').setInputFiles(destination);await operationDialog.locator('[name=confirm_import]').check();const imported=await runOperation();check('Existing import preserves original records',imported.originals_overwritten===false&&imported.created>0);await closeOperation();
 await goto('invitations');await begin('invitations.issue');await operationDialog.locator('[name=count]').fill('1');await operationDialog.locator('[name=ttl_minutes]').fill('10');await operationDialog.locator('[name=current_password]').fill(cfg.password);await operationDialog.locator('[name=otp]').fill((await command('otp',{fresh:true})).otp);await runOperation();const invite=(await operationDialog.locator('#issued-invitation-codes').innerText()).trim();check('Existing administrator invitation is generated after fresh proof',invite.length===43);await closeOperation();
 const registration=await browser.newContext(),rp=await registration.newPage();await rp.goto(cfg.url+'/register');await rp.locator('[name=code]').fill(invite);await rp.locator('button[type=submit]').click();await rp.waitForURL('**/register/account');await rp.locator('[name=username]').fill('Synthetic_Cloud_Browser_New');await rp.locator('[name=password]').fill('Synthetic new browser password');await rp.locator('[name=password_confirm]').fill('Synthetic new browser password');await rp.locator('button[type=submit]').click();await rp.waitForURL('**/register/totp');
 const {generate}=await import(pathToFileURL(path.join(root,'services/oauth/node_modules/otplib/dist/index.js')));const enrollmentSecret=await rp.locator('#totp-secret').innerText();await rp.locator('[name=otp]').fill(await generate({secret:enrollmentSecret}));await rp.locator('button[type=submit]').click();await rp.waitForURL('**/register/recovery-codes');check('Existing registration binds real synthetic TOTP',await rp.locator('.recovery-codes li').count()===8);await rp.locator('button[type=submit]').click();await rp.waitForURL('**/register/status');
 for(let i=0;i<15;i++){if(await rp.locator('code').innerText()==='active')break;await new Promise(r=>setTimeout(r,1000));await rp.reload();}check('New synthetic account activates only after provisioning',await rp.locator('code').innerText()==='active');await registration.close();
 const realLogin=await browser.newContext(),lp=await realLogin.newPage();await lp.goto(cfg.url+'/login');await lp.locator('[name=username]').fill(cfg.accounts[1].username);await lp.locator('[name=password]').fill(cfg.password);await lp.locator('[name=otp]').fill((await command('otp',{owner:1,fresh:true})).otp);await lp.locator('button[type=submit]').click();await lp.waitForURL('**/app');await lp.goto(cfg.url+'/app/memories');await lp.locator('[data-memory]').first().waitFor();check('Existing real password/TOTP login isolates the second account',(await lp.innerText('body')).includes('Synthetic private B sentinel')&&!(await lp.innerText('body')).includes('蓝色纸船'));await realLogin.close();
 await goto('connections');await page.screenshot({path:path.join(evidence,'connections-final.png'),fullPage:true});
 await openNew('generic_mcp');await basic('Synthetic close cleanup');await submit();
 page.once('dialog',prompt=>prompt.dismiss());await dialog.locator('[data-connection-close]').first().click();check('Unsaved credential close requires explicit acknowledgement',await dialog.isVisible());
 page.once('dialog',prompt=>prompt.accept());await dialog.locator('[data-connection-close]').first().click();await dialog.waitFor({state:'hidden'});check('Unsaved credential is cleared after confirmed close',await page.locator('#connection-secret').count()===0);
 await openNew('generic_mcp');await basic('Synthetic logout cleanup');await submit();await command('revoke-console-sessions');await dialog.locator('[data-connection-copy-secret]').click();await page.locator('#connection-secret').waitFor({state:'detached'});check('A revoked login clears secrets before any copy',await page.locator('#connection-secret').count()===0);
 check('No JavaScript or CSP errors',errors.length===0);
 fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({status:'passed',checks,count:checks.length,production_data_used:false,external_client_acceptance:false},null,2),{mode:0o600});console.log(JSON.stringify({status:'passed',checks:checks.length,evidence}));
}catch(error){fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({status:'failed',checks,error:error.stack},null,2),{mode:0o600});console.error(JSON.stringify({status:'failed',checks:checks.length,evidence,error:error.message}));process.exitCode=1;}
finally{await browser?.close();fixture.stdin.end('{"command":"stop"}\n');const timer=setTimeout(()=>fixture.kill('SIGTERM'),5000);await new Promise(r=>fixture.once('exit',r));clearTimeout(timer);fs.closeSync(log);}
