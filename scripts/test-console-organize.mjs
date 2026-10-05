// Browser acceptance of memory organization against disposable, synthetic loopback services:
// large import → facets → category create/rename/delete → preview/confirm/result → undo,
// plus loading, empty, error, interrupted, repeated, cancel/back and two-account isolation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import assert from 'node:assert/strict';

const root=path.resolve(import.meta.dirname,'..'),base=path.resolve(process.env.MNEMURON_UI_EVIDENCE||os.tmpdir());
assert.ok(!base.startsWith(root+path.sep)&&base!==root);
const evidence=fs.mkdtempSync(path.join(base,'organize-browser-'));fs.chmodSync(evidence,0o700);
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const log=fs.openSync(path.join(evidence,'fixture.stderr'),'wx',0o600);
const fixture=spawn(process.execPath,['services/oauth/test/helpers/console-functional-preview.mjs'],{cwd:root,stdio:['pipe','pipe',log]});
const queue=[],waiters=[];createInterface({input:fixture.stdout}).on('line',line=>{if(!line.startsWith('{'))return;const v=JSON.parse(line);if(waiters.length)waiters.shift()(v);else queue.push(v);});
async function read(){let timer;try{return await Promise.race([queue.length?Promise.resolve(queue.shift()):new Promise(r=>waiters.push(r)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Fixture timeout')),30000);})]);}finally{clearTimeout(timer);}}
async function command(command,extra={}){fixture.stdin.write(JSON.stringify({command,...extra})+'\n');const r=await read();assert.ok(!r.fixture_error,r.fixture_error);return r;}
const checks=[];const check=(name,value=true)=>{assert.ok(value,name);checks.push(name);console.log('PASS '+name);};let browser,activePage;

// 300 synthetic portable records: five topics, original dates, some tombstones.
const topics=['router','billing','travel','garden','reading'];
const records=Array.from({length:300},(_,i)=>({original_id:`synthetic-ui-${i}`,revision:1,content:`Synthetic imported note ${i} about ${topics[i%5]}`,memory_type:'fact',
  status:i%20===0?'retracted':'active',topic:topics[i%5],sensitivity:'sensitive',original_scope:{scope:'user'},created_at:new Date(Date.UTC(2025,0,1)+i*86400000).toISOString()}));
const importFile=path.join(evidence,'synthetic-portable-import.json');fs.writeFileSync(importFile,JSON.stringify({format:'mnemuron-personal-portable-v1',records}),{mode:0o600});

try{
  const cfg=await read();assert.equal(cfg.fixture,true);assert.match(cfg.url,/^http:\/\/127\.0\.0\.1:/);
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const context=async(i,viewport={width:1440,height:1000})=>{const ctx=await browser.newContext({viewport});await ctx.addCookies([{name:cfg.cookie,value:cfg.accounts[i].token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);return ctx;};
  const ctxA=await context(0),page=await ctxA.newPage(),errors=[];activePage=page;page.setDefaultTimeout(15000);
  const watch=p=>{p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error'&&/Content Security Policy|Refused/.test(m.text()))errors.push(m.text());});};watch(page);
  const settle=async(p=page)=>{await p.locator('#console-root h1').waitFor();await p.locator('.loading-card').waitFor({state:'detached'});};
  const goto=async(name,p=page)=>{await p.goto(cfg.url+'/app/'+name);await settle(p);};
  const shot=async(name,p=page,fullPage=true)=>{await p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));return p.screenshot({path:path.join(evidence,name+'.png'),fullPage});};
  const op=page.locator('#operation-dialog');
  const pick=async(selector,value,p=page)=>{const native=p.locator(selector),index=await native.evaluate((s,v)=>[...s.options].findIndex(o=>o.value===v),value);assert.ok(index>=0,`option ${value}`);
    const trigger=native.locator('..').locator('> .select-trigger');if(await trigger.count()){await trigger.click();await p.locator('#'+await trigger.getAttribute('aria-controls')).locator(`[data-index="${index}"]`).click();}else await native.selectOption(value);};
  const optionValue=async(selector,label)=>page.locator(selector).evaluate((s,l)=>[...s.options].find(o=>o.textContent.trim()===l)?.value,label);
  const facets=async(p=page)=>p.evaluate(async()=>(await fetch('/console-api/memories?part=facets',{credentials:'same-origin'})).json());
  const pillTexts=async()=>page.locator('.memory-table .category-pill').allInnerTexts();
  let writes=0;page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/console-api/action'))writes++;});
  const before=await command('integrity');check('Baseline schema is version 7',before.user_version===7);

  // Loading state: hold the list read so the shell's loading card is observable.
  let release;const held=new Promise(r=>release=r);
  await page.route(/\/console-api\/memories\?/,async route=>{await held;await route.continue();});
  await page.goto(cfg.url+'/app/memories');await page.locator('.loading-card').waitFor();check('Loading state is shown while the library loads',await page.locator('.loading-card[role=status]').count()===1);
  await shot('01-loading',page,false);release();await settle();await page.unroute(/\/console-api\/memories\?/);
  check('Default library view hides tombstones (status = active)',await page.locator('#search-form [name=status]').inputValue()==='active');
  check('Facet sidebar lists categories with counts',await page.locator('.library-facets [data-facet="category"]').count()>=7);
  check('Recent changes starts empty and says so',(await page.locator('.recent-changes').innerText()).includes('还没有整理记录'));
  await shot('02-library-initial');

  // Large import through the real dialog, in chunks with progress; then straight into organizing.
  await goto('storage');await page.locator('[data-console-action="storage.import"]').click();await op.locator('form').waitFor();
  await op.locator('input[type=file]').setInputFiles(importFile);await op.locator('[name=confirm_import]').check();
  const importStarted=writes;await op.locator('button[type=submit]').click();await op.locator('a[href="/app/memories?origin=imported"]').waitFor({timeout:60000});
  check('Import of 300 records uses chunked requests (≤ 20 per request)',writes-importStarted===15);
  check('Import result reports created records in plain language',(await op.locator('.policy-box[role=status]').innerText()).includes('新增 300'));
  await shot('03-import-result',page,false);
  await op.locator('a[href="/app/memories?origin=imported"]').click();await settle();
  check('Organize-imported link opens the imported view',page.url().includes('origin=imported')&&await page.locator('[data-facet="origin"][data-value="imported"][aria-pressed="true"]').count()===1);
  let f=await facets();check('Facets count imported, active and retracted separately',f.origins.imported===285&&f.statuses.retracted===15);
  check('Imported topics become browsable facets',(await page.locator('.library-facets [data-facet="topic"]').count())===5);
  check('Rows show topic and original date of imported records',(await page.locator('.memory-extra').first().innerText()).includes('原始时间'));
  await shot('04-imported-collection');

  // Category management: create (CJK name), rename, then use it.
  await page.locator('.library-facets [data-console-action="category.manage"]').click();await op.locator('.category-manager').waitFor();
  await op.locator('[data-organize-step="create"] [name=label]').fill('旅行计划');await op.locator('[data-organize-step="create"] button[type=submit]').click();
  await op.locator('.policy-box[role=status]').waitFor();check('Category with a Chinese name is created',(await op.locator('.category-manager').innerText()).includes('旅行计划'));
  const trip=await op.locator('.category-manager li').last().getAttribute('data-manage-category');
  await op.locator(`[data-category-rename="${trip}"]`).click();await op.locator('[data-organize-step="rename"] [name=label]').fill('旅行');
  await op.locator('[data-organize-step="rename"] button[type=submit]').click();await op.locator('.policy-box[role=status]',{hasText:'已重命名'}).waitFor();
  check('Rename changes only the name',(await op.locator(`[data-manage-category="${trip}"]`).innerText()).includes('旅行')&&!(await op.locator('.category-manager').innerText()).includes('旅行计划'));
  await op.locator(`[data-category-rename="${trip}"]`).click();await op.locator('[data-manage-back]').click();
  check('Cancel in rename returns to the list without writing',await op.locator('[data-organize-step="rename"]').count()===0);
  await shot('05-category-manager',page,false);
  await op.locator('[data-operation-close]').last().click();await op.waitFor({state:'hidden'});
  check('Sidebar shows the renamed category',(await page.locator(`.library-facets [data-facet="category"][data-value="${trip}"]`).innerText()).includes('旅行'));

  // One flow on a filter: topic facet → select everything matching → preview → back → cancel → confirm.
  await page.locator('.library-facets [data-facet="topic"][data-value="travel"]').click();await settle();
  await page.waitForFunction(()=>new URLSearchParams(location.search).get('topic')==='travel');
  check('Topic facet filters the list',(await page.locator('.memory-extra .topic-chip').allInnerTexts()).every(x=>x==='travel'));
  await page.locator('[data-select-all]').click();check('Select-all states that the preview gives the exact count',(await page.locator('[data-memory-selection]').innerText()).includes('预览会显示准确数量'));
  const writesBeforePreview=writes;
  await page.locator('[data-memory-selection] [data-console-action="memory.organize"]').click();await op.locator('[data-organize-step="choose"]').waitFor();
  await pick('#operation-dialog [name=category]',trip);await op.locator('[data-organize-step="choose"] button[type=submit]').click();await op.locator('[data-organize-step="confirm"]').waitFor();
  check('Preview shows the exact count, source categories and examples',(await op.locator('.organize-headline').innerText()).startsWith('60')&&await op.locator('.organize-sample li').count()===5&&(await op.locator('.organize-breakdown').innerText()).includes('未分类'));
  await shot('06-organize-preview',page,false);
  await op.locator('[data-organize-back]').click();await op.locator('[data-organize-step="choose"]').waitFor();
  check('Back returns to the choice with the category kept',await op.locator('[name=category]').inputValue()===trip);
  await page.keyboard.press('Escape');await op.waitFor({state:'hidden'});
  check('Cancel (Escape) closes without any write',writes===writesBeforePreview&&(await facets()).categories.find(c=>c.category===trip).count===0);
  await page.locator('[data-memory-selection] [data-console-action="memory.organize"]').click();await pick('#operation-dialog [name=category]',trip);
  await op.locator('[data-organize-step="choose"] button[type=submit]').click();await op.locator('[data-organize-step="confirm"]').waitFor();
  // Repeated action: a double click sends one operation; the server records one batch.
  await op.locator('[data-organize-step="confirm"] button[type=submit]').dblclick();await op.locator('.organize-result').waitFor();
  f=await facets();check('Double confirm applies once (one batch, 60 moved)',f.recent_batches.length===1&&f.recent_batches[0].changed===60);
  check('Result states what changed and offers undo',(await op.locator('.organize-headline').innerText()).includes('60')&&await op.locator('[data-organize-undo]').count()===1);
  await shot('07-organize-result',page,false);
  await op.locator('[data-organize-undo]').click();await op.locator('text=已恢复').waitFor();
  f=await facets();check('Undo from the result restores every memory',f.categories.find(c=>c.category===trip).count===0&&f.recent_batches[0].undone_at);
  await shot('08-undo-result',page,false);await op.locator('[data-operation-close]').last().click();

  // Interrupted action: the response is lost after the server applied it; confirming again replays it.
  await page.locator('[data-select-all]').click();await page.locator('[data-memory-selection] [data-console-action="memory.organize"]').click();
  await pick('#operation-dialog [name=category]',trip);await op.locator('[data-organize-step="choose"] button[type=submit]').click();await op.locator('[data-organize-step="confirm"]').waitFor();
  let dropped=false;await page.route('**/console-api/action',async route=>{if(!dropped&&route.request().postData()?.includes('memory.organize')){dropped=true;await route.fetch();await route.abort('connectionreset');}else await route.continue();});
  await op.locator('[data-organize-step="confirm"] button[type=submit]').click();await op.locator('[data-operation-error]').filter({hasText:/\S/}).waitFor();
  check('Lost response is reported as an error, not as success',await op.locator('.organize-result').count()===0);await shot('09-interrupted',page,false);
  await op.locator('[data-organize-step="confirm"] button[type=submit]').click();await op.locator('.organize-result').waitFor();await page.unroute('**/console-api/action');
  f=await facets();check('Retry after interruption replays the same operation (no second batch)',(await op.locator('.organize-result').innerText()).includes('没有重复执行')&&f.recent_batches.filter(b=>!b.undone_at).length===1);
  await op.locator('[data-operation-close]').last().click();

  // Category filter and pills use the account-defined name.
  await page.locator('[data-clear-facet="topic"]').click();await settle();
  await page.locator(`.library-facets [data-facet="category"][data-value="${trip}"]`).click();await settle();
  check('Category facet filters to the category and shows its name',(await pillTexts()).length===25&&(await pillTexts()).every(x=>x==='旅行'));
  await shot('10-category-filter');

  // Single memory from the detail pane uses the same flow.
  await page.locator('.library-facets [data-facet="category"][data-value=""]').click();await settle();
  await page.locator('[data-clear-facet="origin"]').click();await settle();
  await page.locator('.memory-table [data-memory]').first().click();await page.locator('#memory-dialog [data-console-action="memory.organize"]').click();
  await op.locator('[data-organize-step="choose"]').waitFor();await pick('#operation-dialog [name=category]','technical');
  await op.locator('[data-organize-step="choose"] button[type=submit]').click();await op.locator('[data-organize-step="confirm"]').waitFor();
  check('Single-memory preview names exactly one memory',(await op.locator('.organize-headline').innerText()).startsWith('1'));
  await op.locator('[data-organize-step="confirm"] button[type=submit]').click();await op.locator('.organize-result').waitFor();await op.locator('[data-operation-close]').last().click();

  // Stale preview: another tab changes a memory between preview and confirm.
  await page.locator(`.library-facets [data-facet="category"][data-value="${trip}"]`).click();await settle();
  await page.locator('[data-select-all]').click();await page.locator('[data-memory-selection] [data-console-action="memory.organize"]').click();
  await pick('#operation-dialog [name=category]','personal');await op.locator('[data-organize-step="choose"] button[type=submit]').click();await op.locator('[data-organize-step="confirm"]').waitFor();
  const other=await ctxA.newPage();watch(other);await goto('memories?category='+trip,other);
  await other.locator('.memory-table [data-batch-memory]').first().check();await other.locator('[data-memory-selection] [data-console-action="memory.organize"]').click();
  await pick('#operation-dialog [name=category]','decisions',other);await other.locator('[data-organize-step="choose"] button[type=submit]').click();
  await other.locator('[data-organize-step="confirm"] button[type=submit]').click();await other.locator('.organize-result').waitFor();await other.close();
  await op.locator('[data-organize-step="confirm"] button[type=submit]').click();await op.locator('.organize-preview .policy-box[role=status]').waitFor();
  check('A stale preview is refused and refreshed with the new count',(await op.locator('.organize-preview').innerText()).includes('预览之后记忆有变化')&&(await op.locator('.organize-headline').innerText()).startsWith('59'));
  await shot('11-stale-preview',page,false);await page.keyboard.press('Escape');await op.waitFor({state:'hidden'});

  // Merge: delete the category, moving members; then undo it from the manager message.
  await page.locator('.library-facets [data-console-action="category.manage"]').click();await op.locator('.category-manager').waitFor();
  await op.locator(`[data-category-delete="${trip}"]`).click();await pick('#operation-dialog [name=move_to]','personal');
  check('Delete explains that no memory is deleted',(await op.locator('[data-organize-step="delete"]').innerText()).includes('不会删除任何记忆'));
  await shot('12-category-delete-confirm',page,false);
  await op.locator('[data-organize-step="delete"] button[type=submit]').click();await op.locator('.policy-box[role=status] [data-organize-undo]').waitFor();
  f=await facets();check('Merge moves 59 memories and removes the category',!f.categories.some(c=>c.category===trip)&&f.categories.find(c=>c.category==='personal').count===59);
  await op.locator('.policy-box[role=status] [data-organize-undo]').click();await op.locator('text=已恢复分类').waitFor();
  f=await facets();check('Undo of the merge restores the category and its members',f.categories.find(c=>c.category===trip)?.count===59);
  await op.locator('[data-operation-close]').last().click();await op.waitFor({state:'hidden'});
  // Undo from Recent changes with confirmation; a conflicting undo is explained.
  await goto('memories');
  const undoable=page.locator('.recent-changes [data-console-action="memory.organize_undo"]');
  check('Recent changes lists undoable batches',await undoable.count()>=1);await shot('13-recent-changes');
  await undoable.first().click();await op.locator('[data-organize-step="undo"]').waitFor();check('Undo asks for confirmation first',(await op.innerText()).includes('之后又被改动过的记忆保持现状'));
  await op.locator('[data-organize-step="undo"] button[type=submit]').click();await op.locator('text=已恢复').waitFor();await op.locator('[data-operation-close]').last().click();

  // Empty and error states.
  await page.locator('#search-form [name=query]').fill('no-such-synthetic-term-zz');await page.locator('#search-form button[type=submit]').click();await settle();
  await page.locator('.empty').waitFor();check('Empty filtered state explains how to recover',(await page.locator('.empty').innerText()).includes('清除筛选'));await shot('14-empty-filtered');
  await page.locator('[data-reset-filters]').click();await settle();
  await page.route(/part=facets/,route=>route.fulfill({status:500,contentType:'application/json',body:'{"error_code":"UNAVAILABLE"}'}));
  await page.reload();await settle();check('Facet failure degrades only the sidebar',(await page.locator('.library-facets').innerText()).includes('分类统计暂不可用')&&await page.locator('.memory-table tbody tr').count()>0);
  await shot('15-facets-error');await page.unroute(/part=facets/);
  await page.route(/\/console-api\/memories\?offset/,route=>route.fulfill({status:500,contentType:'application/json',body:'{"error_code":"UNAVAILABLE"}'}));
  await page.reload();await page.locator('[role=alert] [data-retry]').waitFor();check('List failure shows an error with retry',true);await shot('16-list-error');
  await page.unroute(/\/console-api\/memories\?offset/);await page.locator('[data-retry]').click();await page.locator('.memory-table').waitFor();check('Retry recovers the list',true);

  // Filters survive reload (URL state); browser back leaves the page normally.
  await page.locator('.library-facets [data-facet="topic"][data-value="garden"]').click();await settle();await page.reload();await settle();
  check('Facet filters survive a reload',page.url().includes('topic=garden')&&await page.locator('[data-facet="topic"][data-value="garden"][aria-pressed="true"]').count()===1);
  await goto('overview');await page.goBack();await settle();check('Browser back returns to the filtered library',page.url().includes('topic=garden'));

  // keep_private: organizing a private memory never makes it visible to ChatGPT web.
  const priv=await command('keep-private');await goto('memories?topic=privacy-check');
  await page.locator(`[data-memory="${priv.memory_id}"]`).click();await page.locator('#memory-dialog [data-console-action="memory.organize"]').click();
  await pick('#operation-dialog [name=category]','personal');await op.locator('[data-organize-step="choose"] button[type=submit]').click();
  await op.locator('[data-organize-step="confirm"] button[type=submit]').click();await op.locator('.organize-result').waitFor();await op.locator('[data-operation-close]').last().click();
  const vis=await command('web-visible',{memory_id:priv.memory_id});check('keep_private still rejects web reads after organizing',vis.visible===false&&vis.denied===true);

  // Narrow screen.
  const mobile=await ctxA.newPage();await mobile.setViewportSize({width:390,height:844});watch(mobile);await goto('memories',mobile);
  check('Narrow layout has no horizontal page scroll',await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await shot('17-mobile-library',mobile);
  await mobile.locator('.memory-table [data-batch-memory]').first().check();await mobile.locator('[data-memory-selection] [data-console-action="memory.organize"]').click();
  await mobile.locator('#operation-dialog [data-organize-step="choose"]').waitFor();await shot('18-mobile-dialog',mobile,false);await mobile.close();

  // Two-account isolation in the browser.
  const ctxB=await context(1),pb=await ctxB.newPage();watch(pb);pb.setDefaultTimeout(15000);await goto('memories',pb);
  const fb=await facets(pb),textB=await pb.locator('#console-root').innerText();
  check('Account B sees none of A\'s imports, categories or changes',fb.origins.imported===0&&!fb.categories.some(c=>c.category===trip)&&fb.recent_batches.length===0&&!textB.includes('Synthetic imported note')&&!textB.includes('旅行'));
  await shot('19-account-b',pb);

  const after=await command('integrity');
  check('Schema stays at version 7',after.user_version===7);
  check('No memory was deleted; only imports and the private fixture were added (A)',after.users[0].memories===before.users[0].memories+301);
  check('Account B memories and revisions are untouched',JSON.stringify(after.users[1])===JSON.stringify(before.users[1]));
  check('No JavaScript or CSP failures',errors.length===0);
  await command('stop').catch(()=>{});
  fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({status:'passed',checks,integrity:{before,after}},null,2),{mode:0o600});
  console.log(JSON.stringify({status:'passed',checks:checks.length,evidence}));
}catch(error){const dialog=await activePage?.locator('#operation-dialog').innerText().catch(()=>null);await activePage?.screenshot({path:path.join(evidence,'failure.png')}).catch(()=>{});
  fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({status:'failed',checks,error:error.stack,dialog},null,2),{mode:0o600});console.error(JSON.stringify({status:'failed',evidence,error:error.message}));process.exitCode=1;}
finally{await browser?.close();if(fixture.exitCode===null){fixture.stdin.write(JSON.stringify({command:'stop'})+'\n');await new Promise(r=>{fixture.once('exit',r);setTimeout(()=>{fixture.kill('SIGTERM');r();},5000);});}}
