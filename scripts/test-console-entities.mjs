// Entity browser contracts against the real BFF/Core and synthetic accounts on loopback only.
// No external model/provider calls. Stored sources are deliberately invented. Evidence stays outside checkout.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..'),base=path.resolve(process.env.MNEMURON_UI_EVIDENCE||os.tmpdir());
assert.ok(base!==root&&!base.startsWith(root+path.sep));fs.mkdirSync(base,{recursive:true});
const evidence=fs.mkdtempSync(path.join(base,'entities-browser-'));fs.chmodSync(evidence,0o700);
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'entities-fixture-')),stderr=fs.openSync(path.join(scratch,'stderr'),'wx',0o600);
const fixture=spawn(process.execPath,['services/oauth/test/helpers/console-functional-preview.mjs'],{cwd:root,stdio:['pipe','pipe',stderr]});
const queue=[],waiters=[];createInterface({input:fixture.stdout}).on('line',line=>{if(!line.startsWith('{'))return;const x=JSON.parse(line);if(waiters.length)waiters.shift()(x);else queue.push(x);});
async function read(){let timer;try{return await Promise.race([queue.length?Promise.resolve(queue.shift()):new Promise(r=>waiters.push(r)),new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('Fixture timeout; inspect '+scratch)),30000))]);}finally{clearTimeout(timer);}}
async function command(command,args={}){fixture.stdin.write(JSON.stringify({command,...args})+'\n');const x=await read();assert.ok(!x.fixture_error,`${command}: ${x.fixture_error}`);assert.equal(x.request,command);return x;}
const snapshots=[],checks=[],check=(name,value=true)=>{assert.ok(value,name);checks.push(name);console.log('PASS '+name);};
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));let browser,page,cfg,seed,context;const errors=[],httpErrors=[];
try{
 cfg=await read();assert.equal(cfg.fixture,true);assert.match(cfg.url,/^http:\/\/127\.0\.0\.1:/);seed=await command('seed-entities');assert.equal([...seed.long_name].length,80);
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});context=await browser.newContext({viewport:{width:1440,height:1050}});
 await context.addCookies([{name:cfg.cookie,value:cfg.accounts[0].token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);
 await context.addInitScript(id=>{const key='mnemuron.appearance.v1.'+id;if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify({locale:'en'}));},cfg.accounts[0].account_id);
 page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400&&r.url().includes('/console-api/'))httpErrors.push({url:r.url(),status:r.status()});});
 const api=async(params)=>page.evaluate(async params=>{const r=await fetch('/console-api/entities?'+new URLSearchParams(params));if(!r.ok)throw new Error(`${r.status}: ${r.url()}`);return r.json();},params);
 const dialog=()=>page.locator('#entity-dialog'),pane=()=>page.locator('#memory-dialog');
 const goto=async()=>{await page.goto(cfg.url+'/app/memories');await page.locator('[data-feature="MEM-08"] [data-entity-review]').first().waitFor();};
 const close=async()=>{await dialog().locator('[data-entity-close]').first().click();await dialog().waitFor({state:'hidden'});};
 const openMemory=async()=>{await page.locator(`#memory-rows [data-memory="${seed.memory_id}"]`).click();await pane().locator(`[data-entity-open="${seed.entity_id}"]`).waitFor();};
 const manage=async()=>{if(!await pane().isVisible())await openMemory();await pane().locator(`[data-entity-open="${seed.entity_id}"]`).click();await dialog().locator('[data-entity-alias]').waitFor();};
 const submitConfirm=async()=>{await dialog().locator('[data-entity-confirm] [type=submit]').click();await dialog().locator('[data-entity-focus][role=status]').waitFor();check('Operation result moves keyboard focus to its success message',await dialog().locator('[data-entity-focus]').evaluate(n=>n===document.activeElement));};
 const screenshot=async name=>{await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));const state=()=>page.evaluate(()=>({entity:document.querySelector('#entity-dialog').open,display:getComputedStyle(document.querySelector('#entity-dialog')).display,rect:document.querySelector('#entity-dialog').getBoundingClientRect().toJSON(),memory:document.querySelector('#memory-dialog').open,width:innerWidth,wide:matchMedia('(min-width: 1180px)').matches}));const before=await state();await page.screenshot({path:path.join(evidence,name+'.png'),fullPage:false});const after=await state();snapshots.push({name,before,after});assert.ok(after.entity,`Entity dialog closed during viewport screenshot ${name}: ${JSON.stringify({before,after})}`);};
 let held=null,release=null;const holdNext=async predicate=>{let signal;const started=new Promise(r=>signal=r);await page.route('**/console-api/entities?*',async route=>{if(held||!predicate(new URL(route.request().url())))return route.continue();held=route;const response=await route.fetch();signal();await new Promise(r=>release=r);await route.fulfill({response});});return {wait:()=>started};};
 const releaseHold=async()=>{release?.();await page.waitForTimeout(150);await page.unroute('**/console-api/entities?*');held=null;release=null;};
 await goto();check('Pending MEM-08 card is loaded through the authorized entities BFF',await page.locator('[data-feature="MEM-08"] [data-entity-review]').count()>0);
 check('Pending card explains derived metadata and equal-name ambiguity',(await page.locator('[data-feature="MEM-08"]').innerText()).includes('Equal names do not establish identity'));
 await openMemory();check('Memory panel loads entity associations separately from immutable content',(await pane().locator('.entity-memory').innerText()).includes(seed.long_name));
 check('Current exact source shows context, date, source origin and secondary IDs',await pane().locator('.entity-source .entity-identifiers').count()>0&&(await pane().locator('.entity-source').first().innerText()).includes('Current exact source revision'));
 // Native dialog.close() queues a close event. Reopen in that very same JavaScript task,
 // hold the new real BFF response, and observe the old event before allowing the new response.
 // This is deterministic: no timing lottery and no mocked server interpretation.
 await manage();const reopening=await holdNext(u=>u.searchParams.get('entity_id')===seed.entity_id);
 const queuedClose=await page.evaluate(id=>new Promise(resolve=>{
  const modal=document.querySelector('#entity-dialog'),region=modal.querySelector('.entity-dialog-content');
  modal.addEventListener('close',()=>resolve({open:modal.open,children:region.childElementCount,text:region.textContent}),{once:true});
  modal.querySelector('[data-entity-close]').click();
  document.querySelector(`#memory-content [data-entity-open="${CSS.escape(id)}"]`).click();
 }),seed.entity_id);
 await reopening.wait();await releaseHold();snapshots.push({name:'close-reopen-same-task',queuedClose});
 check('Queued close from an older opening leaves the reopened loading state intact',queuedClose.open&&queuedClose.children>0);
 await dialog().locator('[data-entity-alias]').waitFor();
 check('Same-task close and reopen preserves the latest real entity response',await dialog().isVisible()&&(await dialog().locator('.entity-dialog-content > .entity-summary').innerText()).includes(seed.long_name));
 await close();
 if(!process.argv.includes('--close-reopen-only')){
 const before=await command('integrity');
 await manage();check('Anchor cannot be unlinked as a member',await dialog().locator(`[data-entity-unlink="${seed.memory_id}"]`).count()===0);
 check('Manual and source-backed names are explicitly distinguished',(await dialog().innerText()).includes('Owner-typed name')&&(await dialog().innerText()).includes('Source-backed name'));
 await dialog().locator('[data-entity-alias]').click();await dialog().locator('[name=name]').fill('Browser manual alias');await dialog().locator('[data-entity-name-form] [type=submit]').click();
 check('Alias confirmation names the exact object and proposed alias',(await dialog().locator('[data-entity-confirm]').innerText()).includes(seed.long_name)&&(await dialog().locator('[data-entity-confirm]').innerText()).includes('Browser manual alias'));
 await dialog().locator('[data-entity-back]').click();check('Cancel returns to editable form without saving',await dialog().locator('[data-entity-name-form]').count()===1&&!(await api({entity_id:seed.entity_id})).aliases.some(n=>n.name==='Browser manual alias'));
 await dialog().locator('[name=name]').fill('Browser manual alias');await dialog().locator('[data-entity-name-form] [type=submit]').click();await submitConfirm();await close();
 let current=await api({entity_id:seed.entity_id}),added=current.aliases.find(n=>n.name==='Browser manual alias');check('Manual alias actually persists with owner origin',added?.state==='accepted'&&added.origin==='manual');
 await manage();await dialog().locator(`[data-entity-name-edit="${added.name_id}"]`).click();await dialog().locator('[name=name]').fill('Browser corrected alias');await dialog().locator('[data-entity-name-form] [type=submit]').click();await submitConfirm();await close();
 current=await api({entity_id:seed.entity_id});check('Correction retires old name and creates a new owner alias',current.aliases.find(n=>n.name==='Browser manual alias').state==='retired'&&current.aliases.some(n=>n.name==='Browser corrected alias'&&n.state==='accepted'));
 const corrected=current.aliases.find(n=>n.name==='Browser corrected alias');await manage();await dialog().locator(`[data-entity-name-remove="${corrected.name_id}"]`).click();
 check('Retirement confirmation identifies exact alias',(await dialog().innerText()).includes('Browser corrected alias'));
 await submitConfirm();await close();check('Removed alias remains retired after refresh',(await api({entity_id:seed.entity_id})).aliases.find(n=>n.name_id===corrected.name_id).state==='retired');
 await manage();await dialog().locator(`[data-entity-unlink="${seed.member_id}"]`).click();check('Unlink confirmation shows selected member source',(await dialog().innerText()).includes('Synthetic linked member'));
 await submitConfirm();await close();check('Member unlink persists a tombstone state',(await api({entity_id:seed.entity_id})).memories.find(m=>m.memory_id===seed.member_id).state==='unlinked');
 await pane().locator('[data-entity-create]').click();await dialog().locator('[name=name]').fill('Manual created object');await dialog().locator('[data-entity-name-form] [type=submit]').click();await submitConfirm();await close();
 check('Manual object creation persists against the exact source revision',(await api({memory_id:seed.memory_id})).entities.some(e=>e.name==='Manual created object'&&e.origin==='manual'&&e.anchor.memory_id===seed.memory_id));
 await pane().locator('[data-entity-link-existing]').click();await dialog().locator('[name=query]').fill('Secondary synthetic server');await dialog().locator('[data-entity-search] [type=submit]').click();await dialog().locator(`[data-entity-choose="${seed.other_id}"]`).click();
 await dialog().locator('[data-entity-confirm]').waitFor();
 check('Manual link confirmation identifies the target object and source',(await dialog().innerText()).includes('Secondary synthetic server')&&(await dialog().innerText()).includes(seed.long_name));
 await submitConfirm();await close();check('Manual memory-to-object link persists in the same exact context',(await api({entity_id:seed.other_id})).memories.some(m=>m.memory_id===seed.memory_id&&m.state==='accepted'));
 const after=await command('integrity');check('Alias correction/removal and unlink preserve all original memory fields',before.users[0].fields_sha256===after.users[0].fields_sha256&&before.users[0].revisions===after.users[0].revisions);
 // Pending accept/reject and relation boundaries use real proposal actions.
 await manage();const p=(await api({entity_id:seed.entity_id})).proposals.find(p=>p.name==='Pending Alias');await dialog().locator(`[data-proposal="${p.proposal_id}"][data-entity-resolve="accept"]`).click();
 check('Accept confirmation is target-specific and explains manual alias retirement',(await dialog().innerText()).includes('Pending Alias')&&(await dialog().innerText()).includes('owner-typed aliases'));
 await submitConfirm();await close();check('Accepted alias is stored accepted',(await api({entity_id:seed.entity_id})).aliases.find(n=>n.name==='Pending Alias').state==='accepted');
 await manage();await dialog().locator(`[data-proposal="${seed.proposal_id}"][data-entity-resolve="reject"]`).click();await submitConfirm();await close();check('Rejected directed object proposal stays rejected',(await api({entity_id:seed.entity_id})).proposals.find(p=>p.proposal_id===seed.proposal_id).state==='rejected');
 // Browse homonyms through the real entities read; no name-based merging.
 await page.locator('[data-feature="MEM-08"] [data-entity-browse]').click();await dialog().locator('[name=query]').fill('Ali');await dialog().locator('[data-entity-search] [type=submit]').click();await dialog().locator(`[data-entity="${seed.person_id}"]`).waitFor();
 check('Homonymous person and place remain separate visible objects',await dialog().locator(`[data-entity="${seed.place_id}"]`).count()===1&&(await dialog().innerText()).includes('Person')&&(await dialog().innerText()).includes('Place'));
 await dialog().locator('[name=query]').fill('web-01');await dialog().locator('[data-entity-search] [type=submit]').click();await dialog().getByText('Staging project',{exact:true}).waitFor();check('Equal host names are distinguished by actual project context',(await dialog().innerText()).includes('Production project'));await close();
 await page.locator('[data-feature="MEM-08"] [data-entity-browse]').click();await dialog().locator('[name=query]').fill('Stale synthetic');await dialog().locator('[data-entity-search] [type=submit]').click();await dialog().locator(`[data-entity-open="${seed.stale_id}"]`).click();await dialog().locator('.entity-dialog-content > .entity-summary').waitFor();
 check('Inactive anchor text is never shown',(await dialog().innerText()).includes('Source is inactive')&&!(await dialog().innerText()).includes('STALE ANCHOR CONTENT MUST NEVER BE SHOWN'));
 check('Inactive proposal actions are disabled',await dialog().locator('[data-entity-resolve]:enabled').count()===0&&await dialog().locator('[data-entity-alias]').count()===0);await close();
 // Actual phone/desktop pixels, both locales, long unbroken 80-codepoint names and confirmation dialogs.
 for(const locale of ['en','zh-CN'])for(const width of [1440,900,390,320]){
  await page.setViewportSize({width,height:1050});await page.evaluate(({id,locale})=>localStorage.setItem('mnemuron.appearance.v1.'+id,JSON.stringify({locale})),{id:cfg.accounts[0].account_id,locale});await goto();await openMemory();await manage();
  check(`Entity dialog has no document or local overflow at ${width}/${locale}`,await page.evaluate(()=>document.scrollingElement.scrollWidth<=innerWidth&&document.querySelector('#entity-dialog').scrollWidth<=document.querySelector('#entity-dialog').clientWidth));
  check(`Long object name has a readable full-width column at ${width}/${locale}`,await dialog().locator('.entity-summary .entity-name').first().evaluate(n=>n.getBoundingClientRect().width>=Math.min(190,innerWidth-100)));
  await screenshot(`entities-${width}-${locale}`);await dialog().locator('[data-entity-alias]').click();await dialog().locator('[name=name]').fill('另一个很长的手动别名 AnotherOwnerAlias'+'z'.repeat(40));await dialog().locator('[data-entity-name-form] [type=submit]').click();
  check(`Target confirmation is translated and wraps at ${width}/${locale}`,await dialog().locator('[data-entity-confirm]').count()===1&&await dialog().evaluate(n=>n.scrollWidth<=n.clientWidth));check(`Focused confirmation question is visible below sticky header at ${width}/${locale}`,await dialog().evaluate(n=>n.querySelector('[data-entity-focus]').getBoundingClientRect().top>=n.querySelector('.dialog-header').getBoundingClientRect().bottom));await screenshot(`entities-confirm-${width}-${locale}`);await close();
 }
 // Every held read is a real BFF response; only its delivery is delayed. No mock server semantics.
 await page.setViewportSize({width:1440,height:1050});await goto();
 let started=await holdNext(u=>u.searchParams.get('status')==='pending');await page.locator('[data-feature="MEM-08"] [data-entity-pending-refresh]').click();await started.wait();await command('seed-entity-pending');
 await page.locator('[data-feature="MEM-08"] [data-entity-pending-refresh]').click();await page.locator('[data-feature="MEM-08"] .entity-name').filter({hasText:'Delayed pending object'}).waitFor();await releaseHold();
 check('A delayed older pending refresh cannot replace newer server evidence',(await page.locator('[data-feature="MEM-08"]').innerText()).includes('Delayed pending object'));
 started=await holdNext(u=>u.searchParams.has('memory_id'));await page.locator(`#memory-rows [data-memory="${seed.memory_id}"]`).click();await started.wait();await pane().locator('[data-close]').click();await releaseHold();check('Delayed entity memory response cannot revive closed detail',!(await pane().isVisible())&&await page.locator('#memory-content').innerText()==='');
 started=await holdNext(u=>u.searchParams.has('memory_id'));await page.locator(`#memory-rows [data-memory="${seed.memory_id}"]`).click();await started.wait();const otherMemory=page.locator('#memory-rows [data-memory]').filter({hasNotText:seed.long_name}).first();const otherId=await otherMemory.getAttribute('data-memory');await otherMemory.click();await pane().locator('[data-compare-memory="'+otherId+'"]').waitFor();await releaseHold();check('Delayed older memory response cannot replace newer detail',await pane().locator('[data-compare-memory="'+otherId+'"]').count()===1&&!((await pane().locator('.entity-memory').innerText()).includes(seed.long_name)));await pane().locator('[data-close]').click();
 await openMemory();started=await holdNext(u=>u.searchParams.has('entity_id'));await pane().locator(`[data-entity-open="${seed.entity_id}"]`).click();await started.wait();await dialog().locator('[data-entity-close]').click();await releaseHold();check('Delayed object read cannot reopen its closed dialog',!(await dialog().isVisible())&&await dialog().locator('.entity-dialog-content').innerText()==='');
 await pane().locator('[data-close]').click();started=await holdNext(u=>u.searchParams.has('memory_id'));await page.locator(`#memory-rows [data-memory="${seed.memory_id}"]`).click();await started.wait();
 await page.evaluate(()=>{const form=document.querySelector('form[action="/console-api/logout"]');form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});await releaseHold();check('Sign-out clears pending entity responses and all memory content',await page.locator('#memory-content').innerText()===''&&!(await dialog().isVisible()));
 }
 check('No browser runtime errors',errors.length===0);check('No unexpected BFF HTTP errors',httpErrors.length===0);
 fs.writeFileSync(path.join(evidence,'checks.json'),JSON.stringify({status:'passed',scope:process.argv.includes('--close-reopen-only')?'close-reopen':'full',count:checks.length,checks,snapshots,errors,httpErrors},null,2));console.log(JSON.stringify({status:'passed',count:checks.length,evidence}));
}catch(error){fs.writeFileSync(path.join(evidence,'checks.json'),JSON.stringify({status:'failed',checks,snapshots,error:error.stack,errors,httpErrors,url:page?.url(),dialog:await page?.locator('#entity-dialog').innerText().catch(()=>null)},null,2));if(page)await page.screenshot({path:path.join(evidence,'failure.png'),fullPage:false}).catch(()=>{});console.error(JSON.stringify({status:'failed',evidence,fixture_log:scratch,error:error.stack,httpErrors}));process.exitCode=1;}
finally{await browser?.close();fixture.stdin.write(JSON.stringify({command:'stop'})+'\n');await new Promise(resolve=>{if(fixture.exitCode!==null)return resolve();fixture.once('exit',resolve);setTimeout(()=>{fixture.kill('SIGTERM');resolve();},3000).unref();});}
