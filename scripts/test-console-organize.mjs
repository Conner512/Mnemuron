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
  const status=page.locator('.classification-status');
  check('Uncategorized library explains that classification is not set up, with manual and model paths',await status.getAttribute('data-classification-state')==='unconfigured'&&(await status.innerText()).includes('自动分类尚未设置')&&await status.locator('a[href="/app/models"]').count()===1);
  check('No retry is offered when nothing is configured',await status.locator('[data-console-action]').count()===0&&!(await status.innerText()).includes('重试'));
  await shot('02-library-initial');
  await goto('jobs');check('Jobs page disables organizing with the reason while no model is configured',await page.locator('[data-console-action="jobs.schedule"][data-type="classification"]').isDisabled()&&(await page.locator('#console-root').innerText()).includes('请先保存并启用对应模型'));
  await shot('02a-jobs-not-configured');await goto('memories');

  // Large import through the real dialog, in chunks with progress; then straight into organizing.
  // Unusable files are explained in plain language and import nothing.
  for(const [name,content,expected] of [['malformed.json','{"format":"mnemuron-personal-portable-v1","records":[','不是有效的 JSON'],['wrong-format.json',JSON.stringify({format:'other',records:[]}),'mnemuron-personal-portable-v1'],['empty.json',JSON.stringify({format:'mnemuron-personal-portable-v1',records:[]}),'没有可导入的记录']]){
    const file=path.join(evidence,'synthetic-'+name);fs.writeFileSync(file,content,{mode:0o600});await goto('storage');await page.locator('[data-console-action="storage.import"]').click();await op.locator('form').waitFor();
    await op.locator('input[type=file]').setInputFiles(file);await op.locator('[name=confirm_import]').check();const w=writes;await op.locator('button[type=submit]').click();
    await op.locator('[data-operation-error]').filter({hasText:/\S/}).waitFor();const message=await op.locator('[data-operation-error]').innerText();
    check(`Import error for ${name} is readable and writes nothing`,message.includes(expected)&&!/Unexpected|INVALID_IMPORT ·/.test(message)&&writes===w);
    if(name==='malformed.json')await shot('03a-import-malformed',page,false);await page.keyboard.press('Escape');await op.waitFor({state:'hidden'});
  }
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

  // Over the per-step limit: exact total, the limit, a clearly disabled confirmation and a next step.
  await command('bulk',{count:2010,topic:'bulk-limit'});await goto('memories?topic=bulk-limit');await page.locator('[data-select-all]').click();
  check('Select-all banner states the per-step limit',(await page.locator('[data-memory-selection] p').innerText()).includes('2000'));
  await page.locator('[data-memory-selection] [data-console-action="memory.organize"]').click();await pick('#operation-dialog [name=category]','technical');
  await op.locator('[data-organize-step="choose"] button[type=submit]').click();await op.locator('.organize-blocked').waitFor();
  const capText=await op.locator('.organize-blocked').innerText(),confirm=op.locator('[data-organize-step="confirm"] button[type=submit]');
  check('Over-limit preview shows the exact total and the limit, not a capped "will move" count',capText.includes('2010')&&capText.includes('2000')&&!capText.includes('条记忆将移到'));
  check('Over-limit confirmation is disabled and looks disabled',await confirm.isDisabled()&&(await confirm.innerText()).includes('超过上限')&&await confirm.evaluate(b=>{const s=getComputedStyle(b);return s.borderStyle==='dashed'&&s.backgroundColor!=='rgb(174, 63, 44)'&&s.cursor==='not-allowed';}));
  check('Over-limit preview explains the next step',capText.includes('下一步')&&capText.includes('缩小'));
  await shot('20-organize-over-limit',page,false);
  await op.locator('[data-organize-narrow]').click();await op.waitFor({state:'hidden'});
  check('Narrow-the-filter closes the dialog without writing and returns to the filters',(await facets()).categories.find(c=>c.category==='technical').count===1);

  // Single-memory results read as a confirmation; the receipt stays under technical details.
  await goto('memories');await page.locator('[data-console-action="memory.create"]').first().click();await op.locator('[name=content]').fill('Synthetic result wording check');
  await op.locator('button[type=submit]').click();await op.locator('.policy-box[role=status]').waitFor();
  check('Memory create ends with a plain confirmation, receipt collapsed',(await op.locator('.policy-box[role=status]').innerText()).includes('已保存新记忆')&&await op.locator('details .operation-result').count()===1&&!(await op.locator('details').getAttribute('open')));
  await shot('20a-create-result',page,false);await page.keyboard.press('Escape');
  // Batch retract shows which memories (only the text already shown in the list) and reports each outcome.
  await goto('memories?topic=garden');const gardenBoxes=page.locator('[data-batch-memory]');await gardenBoxes.nth(0).check();await gardenBoxes.nth(1).check();
  const chosen=await page.locator('tr[data-batch-selected] .memory-text').allInnerTexts();
  await page.locator('[data-memory-selection] [data-console-action="memory.batch_retract"]').click();await op.locator('form').waitFor();const confirmText=await op.locator('.batch-confirm-list').innerText();
  check('Batch retract confirmation lists the selected memories by their visible text',chosen.every(text=>confirmText.includes([...text].slice(0,40).join('')))&&!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(confirmText));
  check('Batch retract confirmation shows no more text than the list already shows',(await op.locator('.batch-confirm-list li').allInnerTexts()).every(li=>[...li.replace(/版本 \d+$/,'').trim()].length<=120));
  await shot('20b-batch-retract-confirm',page,false);
  // A correction in another tab between confirmation and submit makes one item stale: reported, not hidden.
  const stalePage=await ctxA.newPage();watch(stalePage);await goto('memories?topic=garden',stalePage);await stalePage.locator('.memory-table [data-memory]').nth(1).click();
  await stalePage.locator('#memory-dialog [data-console-action="memory.correct"]').click();await stalePage.locator('#operation-dialog [name=content]').fill('Synthetic garden note corrected in another tab');
  await stalePage.locator('#operation-dialog button[type=submit]').click();await stalePage.locator('#operation-dialog .policy-box[role=status]').waitFor();await stalePage.close();
  await op.locator('button[type=submit]').click();await op.locator('.policy-box[role=status]').waitFor();const outcome=await op.locator('.policy-box[role=status]').innerText();
  check('Batch result summarizes successes and names each failure with a readable reason',outcome.includes('已撤回 1')&&outcome.includes('未处理 1')&&outcome.includes('记忆已更新'));
  await shot('20c-batch-retract-result',page,false);await page.keyboard.press('Escape');
  // A selection kept across pages is what the batch acts on, and the confirmation names every selected memory.
  await goto('memories?topic=billing');const firstPick=await page.locator('.memory-table tbody tr').nth(0).locator('.memory-text').innerText();await page.locator('[data-batch-memory]').nth(0).check();
  await page.locator('[data-offset="25"]').first().click();await page.locator('.memory-table').waitFor();await page.waitForFunction(()=>new URLSearchParams(location.search).get('offset')==='25');
  const secondPick=await page.locator('.memory-table tbody tr').nth(0).locator('.memory-text').innerText();await page.locator('[data-batch-memory]').nth(0).check();
  check('Toolbar counts the selection across pages',(await page.locator('[data-selection-count]').innerText())==='2');
  await page.locator('[data-memory-selection] [data-console-action="memory.batch_retract"]').click();await op.locator('form').waitFor();
  const crossList=await op.locator('.batch-confirm-list').innerText();
  check('Batch retract confirms both pages\' selections by their visible text',(await op.locator('.batch-confirm-list li').count())===2&&crossList.includes(firstPick)&&crossList.includes(secondPick));
  await page.keyboard.press('Escape');await op.waitFor({state:'hidden'});

  // Path-prefixed memories: the path gets its own line and the body wraps beneath it (verbatim, no sideways scroll).
  const pathSamples=['/Users/example/Projects/alpha-service/src/modules/billing/invoices/generator/nightly-invoice-generator.ts: Invoices are generated nightly at 02:00 UTC and retried three times.',
    '/Users/example/Projects/alpha-service/src/modules/billing/invoices/generator/nightly-invoice-generator.ts: The retry delay doubles after each failure.',
    '[services/oauth/src/console.mjs] The console BFF forwards only allow-listed error codes.'];
  for(const content of pathSamples)await page.evaluate(async content=>{const me=await (await fetch('/console-api/me')).json();
    await fetch('/console-api/action',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:me.csrf,account_id:me.account_id,action:'memory.create',operation_id:crypto.randomUUID(),payload:JSON.stringify({content,scope:'user',memory_type:'fact',sensitivity:'sensitive'})})});},content);
  await goto('memories?origin=other');const pathRows=page.locator('.memory-table tbody tr',{has:page.locator('.memory-path')});
  check('Path-prefixed rows show the path on its own line and the body below',await pathRows.count()===3&&(await pathRows.nth(0).locator('.memory-text').innerText()).startsWith('The console BFF'));
  check('Rows sharing a long path are told apart by their bodies',new Set(await pathRows.locator('.memory-text').allInnerTexts()).size===3);
  check('Desktop list does not scroll sideways',await page.evaluate(()=>[...document.querySelectorAll('.table-scroll')].every(n=>n.scrollWidth<=n.clientWidth+1)));
  await shot('20d-path-rows-desktop');

  // Narrow screen.
  const mobile=await ctxA.newPage();await mobile.setViewportSize({width:390,height:844});watch(mobile);await goto('memories',mobile);
  check('Narrow layout has no horizontal page scroll',await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await shot('17-mobile-library',mobile);
  await goto('memories?origin=other',mobile);check('Narrow list stacks rows with path and wrapped body, no sideways scroll',await mobile.locator('.memory-path').count()===3&&await mobile.evaluate(()=>[...document.querySelectorAll('.table-scroll')].every(n=>n.scrollWidth<=n.clientWidth+1)&&document.documentElement.scrollWidth<=innerWidth+1));
  await shot('17a-mobile-path-rows',mobile);
  await mobile.locator('.memory-table [data-batch-memory]').first().check();await mobile.locator('[data-memory-selection] [data-console-action="memory.organize"]').click();
  await mobile.locator('#operation-dialog [data-organize-step="choose"]').waitFor();await shot('18-mobile-dialog',mobile,false);await mobile.close();

  // Two-account isolation in the browser.
  const ctxB=await context(1),pb=await ctxB.newPage();watch(pb);pb.setDefaultTimeout(15000);await goto('memories',pb);
  const fb=await facets(pb),textB=await pb.locator('#console-root').innerText();
  check('Account B sees none of A\'s imports, categories or changes',fb.origins.imported===0&&!fb.categories.some(c=>c.category===trip)&&fb.recent_batches.length===0&&!textB.includes('Synthetic imported note')&&!textB.includes('旅行'));
  await shot('19-account-b',pb);

  const after=await command('integrity');
  check('Schema stays at version 7',after.user_version===7);
  check('No memory was deleted; only imports, the private fixture, synthetic bulk rows, one created memory and one correction were added (A)',after.users[0].memories===before.users[0].memories+301+2010+2+3);
  check('Account B memories and revisions are untouched',JSON.stringify(after.users[1])===JSON.stringify(before.users[1]));
  // A model job fenced by a category change is rescheduled from the Jobs page (account B, synthetic model).
  const bAct=(action,payload)=>pb.evaluate(async([action,payload])=>{const me=await (await fetch('/console-api/me',{credentials:'same-origin'})).json();
    const body=new URLSearchParams({csrf:me.csrf,account_id:me.account_id,action,operation_id:crypto.randomUUID(),payload:JSON.stringify(payload)});
    const r=await fetch('/console-api/action',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/x-www-form-urlencoded'},body});return {status:r.status,body:await r.json()};},[action,payload]);
  const bGet=async(view,params={})=>pb.evaluate(async([v,q])=>(await fetch('/console-api/'+v+'?'+new URLSearchParams(q),{credentials:'same-origin'})).json(),[view,params]);
  const bSchedule=async()=>bAct('jobs.schedule',{type:'classification',timezone:'UTC',periods:['daily'],include_open:true,schedule_enabled:false,settings_revision:(await bGet('jobs')).settings.revision});
  const bDrain=async()=>{for(let i=0;i<10;i++){await command('tick',{owner:1});if((await bGet('jobs')).jobs.every(j=>j.state!=='pending'))break;}};
  check('Synthetic organizer configured for B',(await bAct('models.save',{kind:'organizer',expected_revision:0,api_key:'synthetic-key',config:{enabled:true,protocol:'openai_compatible',base_url:cfg.model_url,model:'synthetic-organizer',profile_revision:'1',daily_requests:100,output_tokens:4096,batch_size:5,sensitivities:['public','internal','sensitive'],egress_approved:true,query_approved:false,native_schema:true}})).status===200);
  await bSchedule();await bDrain();const bIds=(await bGet('memories',{limit:50})).results.map(m=>m.memory_id),bCategory=async id=>(await bGet('memory-meta',{memory_id:id})).category;
  check('Model classified B before the category change',(await Promise.all(bIds.map(bCategory))).every(c=>c==='technical'));
  await bAct('memory.create',{content:'Synthetic B memory added before a category change',scope:'user',memory_type:'fact',sensitivity:'sensitive'});
  const pendingJob=(await bSchedule()).body.jobs[0];await bAct('category.create',{label:'Synthetic B later',expected_revision:(await bGet('taxonomy')).revision});
  await goto('jobs',pb);const row=pb.locator('tr',{has:pb.locator(`[data-job-detail="${pendingJob}"]`)});
  check('Fenced job shows a translated state and reason, not raw codes',(await row.innerText()).includes('需要处理')&&(await row.innerText()).includes('分类已变更'));
  check('Fenced job offers reschedule instead of a bare retry',await row.locator('[data-console-action="jobs.retry"][data-stale="true"]').count()===1&&!(await row.innerText()).includes('重试'));
  await shot('21-jobs-fenced',pb,false);
  check('Earlier classifications stay visible while the job is fenced',(await Promise.all(bIds.map(bCategory))).every(c=>c==='technical'));
  await row.locator('[data-console-action="jobs.retry"]').click();const bop=pb.locator('#operation-dialog');await bop.locator('form').waitFor();
  check('Reschedule dialog explains what happens and that classifications are kept',(await bop.innerText()).includes('当前分类')&&(await bop.innerText()).includes('保留'));
  await bop.locator('button[type=submit]').click();await bop.locator('.policy-box[role=status]').waitFor();
  check('Reschedule queues a replacement job and reports it',(await bop.locator('.policy-box[role=status]').innerText()).includes('已按新分类排队任务数 1'));
  await shot('22-jobs-rescheduled',pb,false);await bop.locator('[data-operation-close]').last().click();
  await bDrain();const afterJobs=(await bGet('jobs')).jobs;
  check('Replacement job succeeds; the outdated job is marked replaced',afterJobs[0].state==='succeeded'&&afterJobs.find(j=>j.job_id===pendingJob).last_error_code==='RESCHEDULED');
  const allB=(await bGet('memories',{limit:50})).results.map(m=>m.memory_id);
  check('All B memories classified after reschedule, earlier ones unchanged',(await Promise.all(allB.map(bCategory))).every(c=>c==='technical'));
  await goto('jobs',pb);check('Replaced job no longer offers any action',await pb.locator('tr',{has:pb.locator(`[data-job-detail="${pendingJob}"]`)}).locator('[data-console-action]').count()===0);
  check('No JavaScript or CSP failures',errors.length===0);
  await command('stop').catch(()=>{});
  fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({status:'passed',checks,integrity:{before,after}},null,2),{mode:0o600});
  console.log(JSON.stringify({status:'passed',checks:checks.length,evidence}));
}catch(error){const dialog=await activePage?.locator('#operation-dialog').innerText().catch(()=>null);await activePage?.screenshot({path:path.join(evidence,'failure.png')}).catch(()=>{});
  fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({status:'failed',checks,error:error.stack,dialog},null,2),{mode:0o600});console.error(JSON.stringify({status:'failed',evidence,error:error.message}));process.exitCode=1;}
finally{await browser?.close();if(fixture.exitCode===null){fixture.stdin.write(JSON.stringify({command:'stop'})+'\n');await new Promise(r=>{fixture.once('exit',r);setTimeout(()=>{fixture.kill('SIGTERM');r();},5000);});}}
