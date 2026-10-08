// Standalone audit acceptance: disposable two-owner localhost services only, real BFF and headless Chromium.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
const root=path.resolve(import.meta.dirname,'..'),base=path.resolve(process.env.MNEMURON_UI_EVIDENCE||os.tmpdir());
assert.ok(base!==root&&!base.startsWith(root+path.sep),'Evidence belongs outside source');
const evidence=fs.mkdtempSync(path.join(base,'mnemuron-audit-browser-'));
fs.chmodSync(evidence,0o700);const log=fs.openSync(path.join(evidence,'fixture.stderr'),'wx',0o600);
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const fixture=spawn(process.execPath,['services/oauth/test/helpers/console-functional-preview.mjs'],{cwd:root,stdio:['pipe','pipe',log]});
const queue=[],waiters=[];createInterface({input:fixture.stdout}).on('line',line=>{if(!line.startsWith('{'))return;const value=JSON.parse(line);if(waiters.length)waiters.shift()(value);else queue.push(value);});
const read=()=>{let timer;return Promise.race([queue.length?Promise.resolve(queue.shift()):new Promise(r=>waiters.push(r)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Fixture timeout')),30000);})]).finally(()=>clearTimeout(timer));};
async function command(command){fixture.stdin.write(JSON.stringify({command})+'\n');const data=await read();assert.equal(data.request,command);assert.ok(!data.fixture_error);return data;}
const checks=[];const check=(name,value=true)=>{assert.ok(value,name);checks.push(name);console.log('PASS '+name);};
let browser,page;
try{
 const cfg=await read();assert.equal(cfg.fixture,true);assert.match(cfg.url,/^http:\/\/127\.0\.0\.1:/);const seeded=await command('seed-audit');
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 const ctx=await browser.newContext({viewport:{width:1440,height:1100},acceptDownloads:true});await ctx.addCookies([{name:cfg.cookie,value:cfg.accounts[0].token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);
 page=await ctx.newPage();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(cfg.url+'/app/audit');await page.locator('[data-audit-source="core"][aria-pressed="true"]').waitFor();
 check('Core default shows recorded actor and current owned title',(await page.locator('.audit-facts').allInnerTexts()).join(' ').includes(seeded.agent_instance_id));
 check('Unfiltered audit hides the compact optional filter',!await page.locator('#audit-filter').isVisible());
 check('Foreign target cannot become a detail link',await page.locator(`[data-memory="${seeded.foreign_memory_id}"]`).count()===0);
 check('Private memory body is absent from timeline',!(await page.locator('.audit-timeline').innerText()).includes('PRIVATE AUDIT BODY'));
 const filter=async action=>{if(!await page.locator('#audit-filter').isVisible())await page.locator('.audit-filter-panel summary').click();await page.locator('#audit-filter [name=action]').fill(action);
   const reply=page.waitForResponse(r=>r.url().includes('/console-api/audit?')&&new URL(r.url()).searchParams.get('action')===(action||null));await page.locator('#audit-filter button[type=submit]').click();const r=await reply;assert.equal(r.status(),200);await page.waitForFunction(a=>[...document.querySelectorAll('.timeline-item>div>strong')].every(n=>!a||n.textContent===a),action);};
 await filter('memory.query');check('Query rows distinguish unknown old refs and bounded lexical results',await page.locator('[data-i18n="auditRefsNotRecorded"]').count()>0&&await page.locator('[data-i18n="auditLexicalRefs"]').count()>0);
 check('Owned current memory can open full details',await page.locator(`[data-memory="${seeded.memory_id}"]`).count()>0);await page.locator(`[data-memory="${seeded.memory_id}"]`).first().click();await page.locator('#memory-content .body-content').waitFor();check('Detail fetch returns the selected owned memory',(await page.locator('#memory-content .body-content').innerText()).includes('PRIVATE AUDIT BODY'));await page.locator('#memory-dialog [data-close]').first().click();
 const download=page.waitForEvent('download');await page.locator('[data-audit-export]').click();const file=await download;await file.saveAs(path.join(evidence,'audit.json'));const exported=JSON.parse(fs.readFileSync(path.join(evidence,'audit.json'),'utf8'));
 check('Source-specific export retains bounded provenance and no bodies',exported.source==='core'&&exported.entries.every(e=>e.source==='core'&&e.action==='memory.query')&&Object.keys(exported.credentials).length>0&&!JSON.stringify(exported).includes('PRIVATE AUDIT BODY'));
 await filter('memory.read');check('Read filter pages actual rows',await page.locator('.timeline-item').count()===25);await page.locator('[data-offset="25"]').click();await page.locator('[data-offset="0"]').waitFor();check('Core second page uses its own offset',new URL(page.url()).searchParams.get('offset')==='25');
 const switchSource=async source=>{await page.locator(`[data-audit-source="${source}"]`).click();await page.locator(`[data-audit-source="${source}"][aria-pressed="true"]`).waitFor();};
 await switchSource('identity');check('Identity does not merge Core read rows',await page.locator('.timeline-item').count()===0);await switchSource('core');check('Switching back retains Core offset',await page.locator('[data-offset="0"]').count()===1);
 await filter('');await switchSource('identity');await page.locator('[data-offset="25"]').click();await page.locator('[data-offset="0"]').waitFor();await switchSource('core');check('Independent stream paging never copies identity offset',await page.locator('[data-offset="0"]').count()===0);
 // Hold a Core reply, switch again, then release it: the newer identity response owns the UI.
 let release,started;const began=new Promise(r=>started=r),gate=new Promise(r=>release=r);
 await page.route('**/console-api/audit?**',async route=>{const p=new URL(route.request().url()).searchParams;if(p.get('source')==='core'&&p.get('offset')==='25'&&p.get('limit')==='25'){const response=await route.fetch();started();await gate;await route.fulfill({response});}else await route.continue();});
 await page.locator('[data-offset="25"]').click();await began;await switchSource('identity');release();await page.waitForTimeout(150);check('Late Core page cannot replace selected identity stream',await page.locator('[data-audit-source="identity"][aria-pressed="true"]').count()===1&&!(await page.locator('.timeline-item>div>strong').allInnerTexts()).includes('memory.read'));await page.unroute('**/console-api/audit?**');
 // Changing source invalidates a pending export before a Blob/download can be created.
 await switchSource('core');let exportRelease,exportStarted;const exportBegan=new Promise(r=>exportStarted=r),exportGate=new Promise(r=>exportRelease=r);let unexpected=0;const countDownload=()=>unexpected++;page.on('download',countDownload);
 await page.route('**/console-api/audit?**',async route=>{if(new URL(route.request().url()).searchParams.get('limit')==='100'){const response=await route.fetch();exportStarted();await exportGate;await route.fulfill({response});}else await route.continue();});
 await page.locator('[data-audit-export]').click();await exportBegan;await switchSource('identity');exportRelease();await page.waitForTimeout(200);check('Source change cancels pending export with no stale download',unexpected===0);page.off('download',countDownload);await page.unroute('**/console-api/audit?**');
 for(const width of [1440,1024,390]){await page.setViewportSize({width,height:1000});await page.screenshot({path:path.join(evidence,`audit-${width}.png`),fullPage:true});check('Audit remains within viewport at '+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
 check('No browser runtime errors',errors.length===0);fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify({checks,errors},null,2));console.log('Evidence '+evidence);
}catch(error){if(page){console.error('Failed at '+page.url());await page.screenshot({path:path.join(evidence,'failure.png'),fullPage:true}).catch(()=>{});}throw error;
}finally{await browser?.close();fixture.stdin.end();await new Promise(resolve=>{fixture.once('exit',resolve);setTimeout(()=>{fixture.kill('SIGTERM');resolve();},3000).unref();});fs.closeSync(log);}
