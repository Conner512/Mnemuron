// Real-browser control geometry over a disposable Core + BFF and synthetic identities.
// No production sessions, model provider, or personal memories are used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';

const root=path.resolve(import.meta.dirname,'..'),base=path.resolve(process.env.MNEMURON_UI_EVIDENCE||os.tmpdir());
assert.ok(base!==root&&!base.startsWith(root+path.sep),'Synthetic evidence must stay outside source');
const evidence=fs.mkdtempSync(path.join(base,'control-alignment-browser-'));fs.chmodSync(evidence,0o700);
const log=fs.openSync(path.join(evidence,'fixture.stderr'),'wx',0o600);
const fixture=spawn(process.execPath,['services/oauth/test/helpers/console-functional-preview.mjs'],{cwd:root,stdio:['pipe','pipe',log]});
const queue=[],waiters=[],checks=[],failures=[],geometry=[],errors=[],rates=[],mutations=[];
createInterface({input:fixture.stdout}).on('line',line=>{if(!line.startsWith('{'))return;const reply=JSON.parse(line);if(waiters.length)waiters.shift()(reply);else queue.push(reply);});
const bounded=async(promise,label)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' timed out')),30000);})]);}finally{clearTimeout(timer);}};
const read=()=>bounded(queue.length?Promise.resolve(queue.shift()):new Promise(resolve=>waiters.push(resolve)),'Synthetic fixture reply');
const command=async name=>{fixture.stdin.write(JSON.stringify({command:name})+'\n');const r=await read();assert.equal(r.request,name);assert.ok(!r.fixture_error,r.fixture_error);return r;};
const check=(name,pass,detail)=>{checks.push({name,pass:!!pass});if(!pass)failures.push(name);console.log(`${pass?'PASS':'FAIL'} ${name}${!pass&&detail?' '+JSON.stringify(detail):''}`);};
let browser,page;

async function bounds(locator){return locator.evaluateAll(nodes=>nodes.filter(n=>n.getBoundingClientRect().width&&n.getBoundingClientRect().height).map(n=>{
 const r=n.getBoundingClientRect();return {name:n.getAttribute('name')||n.getAttribute('data-i18n')||n.className,top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height};
}));}
function sameHeight(items,size){return items.length>0&&items.every(n=>Math.abs(n.height-size)<=1);}
function sameBaseline(items){return items.length>1&&Math.max(...items.map(n=>n.bottom))-Math.min(...items.map(n=>n.bottom))<=1;}
async function formCheck(tag,form){
 const result=await form.evaluate(form=>{const r=form.getBoundingClientRect(),nodes=[...form.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]),button.select-trigger,button[type=submit]')].filter(n=>n.getBoundingClientRect().width&&n.getBoundingClientRect().height);
  return {count:nodes.length,overflow:nodes.filter(n=>{const b=n.getBoundingClientRect();return b.left<r.left-1||b.right>r.right+1;}).map(n=>n.name||n.className),horizontal:document.documentElement.scrollWidth>innerWidth+1};});
 check(tag+': controls fit their form and viewport',result.count>0&&!result.overflow.length&&!result.horizontal,result);
}
async function popupCheck(tag,trigger){
 await trigger.scrollIntoViewIfNeeded();const initial=await trigger.boundingBox();await trigger.click();
 const popup=page.locator('#'+await trigger.getAttribute('aria-controls'));await popup.waitFor();
 const box=await popup.boundingBox(),opened=await trigger.boundingBox(),viewport=page.viewportSize();
 const r={trigger:opened,popup:box};geometry.push({tag:tag+' popup',...r});
 check(tag+': opening menu leaves its trigger in place',Math.abs(initial.x-opened.x)<=1&&Math.abs(initial.y-opened.y)<=1,r);
 check(tag+': menu is aligned to its trigger and stays in viewport',Math.abs(box.x-opened.x)<=1&&box.x>=0&&box.x+box.width<=viewport.width+1&&box.y>=0&&box.y+box.height<=viewport.height+1,r);
 await page.keyboard.press('Escape');await popup.waitFor({state:'hidden'});
 check(tag+': Escape returns keyboard focus to the menu trigger',await trigger.evaluate(n=>document.activeElement===n));
}

try{
 const cfg=await read();assert.equal(cfg.fixture,true);assert.equal(new URL(cfg.url).hostname,'127.0.0.1');
 await command('seed-summaries');await command('owner-mode');
 const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 for(const locale of ['zh-CN','en'])for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'});
  await context.addCookies([{name:cfg.cookie,value:cfg.accounts[0].token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);
  await context.addInitScript(({account,locale})=>localStorage.setItem('mnemuron.appearance.v1.'+account,JSON.stringify({locale})),{account:cfg.accounts[0].account_id,locale});
  page=await context.newPage();page.setDefaultTimeout(15000);
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/Content Security Policy|Refused/.test(m.text()))errors.push(m.text());});
  page.on('response',r=>{if(r.status()===429)rates.push(new URL(r.url()).pathname);});
  page.on('request',r=>{if(new URL(r.url()).pathname==='/console-api/action')mutations.push(r.method());});
  const tag=`${width} ${locale}`,goto=async name=>{await page.goto(cfg.url+'/app/'+name);await page.locator('#console-root h1').waitFor();await page.locator('.loading-card').waitFor({state:'detached'});};
  await goto('memories');
  const topbar=await bounds(page.locator('.topbar-tools .select-trigger,.topbar-tools .account-menu>summary'));geometry.push({tag:tag+' topbar',items:topbar});
  check(tag+': language and account menu share height and baseline',sameHeight(topbar,38)&&sameBaseline(topbar),topbar);
  await popupCheck(tag+' language',page.locator('.topbar-tools .language-control .select-trigger'));
  const memory=page.locator('#search-form');await formCheck(tag+' memory',memory);
  const memoryControls=await bounds(memory.locator('input[name=query],button.select-trigger,.filter-actions>button'));geometry.push({tag:tag+' memory',items:memoryControls});
  check(tag+': memory inputs, selects and filter actions share a 40px control height',sameHeight(memoryControls,40),memoryControls);
  await popupCheck(tag+' memory search mode',memory.locator('.filter-mode .select-trigger'));
  await page.screenshot({path:path.join(evidence,`memory-${width}-${locale}.png`),fullPage:true});
  const create=page.locator('[data-console-action="memory.create"]').first();await create.click();
  const operation=page.locator('#operation-dialog');await operation.locator('form').waitFor();
  await formCheck(tag+' memory create',operation.locator('form'));
  const createControls=await bounds(operation.locator('input:not([type=hidden]):not([type=checkbox]):not([type=radio]),button.select-trigger,form>.actions>button'));
  check(tag+': memory create uses the same field and action sizes',sameHeight(createControls,40),createControls);
  await page.keyboard.press('Escape');await operation.waitFor({state:'hidden'});

  await goto('connections');
  const connection=page.locator('#connection-filters');await connection.waitFor();await formCheck(tag+' connections',connection);
  const connectionControls=await bounds(connection.locator('input,button.select-trigger,.connection-filter-actions>button'));geometry.push({tag:tag+' connections',items:connectionControls});
  check(tag+': connection filters use the same input/select/button height',sameHeight(connectionControls,40),connectionControls);
  if(width===1440)check(tag+': connection record, name and Apply/Reset share one baseline',sameBaseline(connectionControls),connectionControls);
  await popupCheck(tag+' connection records',connection.locator('[name=section]').locator('..').locator('>.select-trigger'));
  await page.screenshot({path:path.join(evidence,`connections-${width}-${locale}.png`),fullPage:true});

  await goto('models');await page.locator('[data-console-action="models.save"][data-kind=organizer]').first().click();await operation.locator('form').waitFor();
  await formCheck(tag+' organizer settings',operation.locator('form'));
  const modelControls=await bounds(operation.locator('input:not([type=hidden]):not([type=checkbox]):not([type=radio]),button.select-trigger,form>.actions>button'));geometry.push({tag:tag+' organizer',items:modelControls});
  check(tag+': organizer settings align single-line fields, menus and actions',sameHeight(modelControls,40),modelControls);
  await popupCheck(tag+' organizer protocol',operation.locator('[name=protocol]').locator('..').locator('>.select-trigger'));
  await page.screenshot({path:path.join(evidence,`organizer-${width}-${locale}.png`)});
  await page.keyboard.press('Escape');await operation.waitFor({state:'hidden'});

  await goto('processing');await page.locator('[data-console-action="schedule.save"]').first().click();await operation.locator('form').waitFor();
  await formCheck(tag+' summary schedule',operation.locator('form'));
  const scheduleControls=await bounds(operation.locator('input:not([type=hidden]):not([type=checkbox]):not([type=radio]),button.select-trigger,form>.actions>button'));
  check(tag+': extraction/summary scheduling retains consistent control sizes',sameHeight(scheduleControls,40),scheduleControls);
  await page.keyboard.press('Escape');await operation.waitFor({state:'hidden'});

  await goto('audit');await page.locator('.audit-filter-panel>summary').click();await page.locator('#audit-filter').waitFor();await formCheck(tag+' audit',page.locator('#audit-filter'));
  const auditControls=await bounds(page.locator('#audit-filter>label>input,#audit-filter .audit-date-field,#audit-filter>button[type=submit]'));geometry.push({tag:tag+' audit',items:auditControls});
  check(tag+': audit text/date fields and Apply share a control height',sameHeight(auditControls,40),auditControls);
  if(width===1440)check(tag+': audit controls share their row baseline',sameBaseline(auditControls),auditControls);
  await page.screenshot({path:path.join(evidence,`audit-${width}-${locale}.png`),fullPage:true});

  await goto('summaries');await page.locator('[data-summary]').first().click();await page.locator('.summary-reader').waitFor();
  check(tag+': summary reading pane fits the viewport without horizontal overflow',await page.locator('.summary-reader').evaluate(n=>{const r=n.getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1&&document.documentElement.scrollWidth<=innerWidth+1;}));
  await page.screenshot({path:path.join(evidence,`summary-${width}-${locale}.png`)});
  await context.close();
 }
 check('No JavaScript or CSP exceptions',errors.length===0,errors);check('No HTTP 429 masks alignment coverage',rates.length===0,rates);
 check('Inspecting form geometry sends no mutation request',mutations.length===0,mutations);
 check('No model inference is triggered by layout verification',(await command('owner-state')).inference_calls===0);
 assert.equal(failures.length,0,failures.join('\n'));
 console.log(JSON.stringify({status:'passed',checks:checks.length,evidence}));
}catch(error){failures.push(error.message);console.error(error.stack);process.exitCode=1;if(page&&!page.isClosed())await page.screenshot({path:path.join(evidence,'failure.png'),fullPage:true}).catch(()=>{});}
finally{
 await browser?.close();
 if(fixture.exitCode===null&&fixture.signalCode===null){fixture.stdin.end('{"command":"stop"}\n');const timer=setTimeout(()=>fixture.kill('SIGTERM'),5000);try{await bounded(new Promise(resolve=>fixture.once('exit',resolve)),'Synthetic cleanup');}finally{clearTimeout(timer);if(fixture.exitCode===null&&fixture.signalCode===null)fixture.kill('SIGKILL');}}
 fs.closeSync(log);const cleaned=fs.readFileSync(path.join(evidence,'fixture.stderr'),'utf8').includes('"synthetic_cleanup_complete":true');
 fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({checks,failures,geometry,errors,rates,mutations,synthetic_cleanup_verified:cleaned,production_data_used:false},null,2),{mode:0o600});
 if(!cleaned){process.exitCode=1;console.error('Synthetic fixture cleanup was not verified');}
}
