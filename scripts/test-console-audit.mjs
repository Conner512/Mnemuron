// Audit acceptance against disposable synthetic loopback services only.
// Set PLAYWRIGHT_MODULE, optional CHROMIUM_EXECUTABLE, and MNEMURON_UI_EVIDENCE outside this checkout.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createHash,randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';

const root=path.resolve(import.meta.dirname,'..'),base=path.resolve(process.env.MNEMURON_UI_EVIDENCE||os.tmpdir());
assert.ok(!base.startsWith(root+path.sep)&&base!==root,'Evidence must stay outside the checkout');
const evidence=fs.mkdtempSync(path.join(base,'refinements-browser-'));fs.chmodSync(evidence,0o700);
const privateLog=fs.mkdtempSync(path.join(os.tmpdir(),'refinements-fixture-'));
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const log=fs.openSync(path.join(privateLog,'fixture.stderr'),'wx',0o600);
const fixture=spawn(process.execPath,['services/oauth/test/helpers/console-functional-preview.mjs'],{cwd:root,stdio:['pipe','pipe',log]});
const queue=[],waiters=[];
createInterface({input:fixture.stdout}).on('line',line=>{if(!line.startsWith('{'))return;const v=JSON.parse(line);if(waiters.length)waiters.shift()(v);else queue.push(v);});
async function read(){let timer;try{return await Promise.race([queue.length?Promise.resolve(queue.shift()):new Promise(r=>waiters.push(r)),
  new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Fixture timeout')),30000);})]);}finally{clearTimeout(timer);}}
async function command(name,extra={}){fixture.stdin.write(JSON.stringify({command:name,...extra})+'\n');const r=await read();assert.ok(!r.fixture_error,`${name}: ${r.fixture_error}`);assert.equal(r.request,name);return r;}
const checks=[];
const check=(section,name,value=true)=>{assert.ok(value,`${section}: ${name}`);checks.push({section,name});console.log(`PASS [${section}] ${name}`);};
const frame=p=>p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
// With javaScriptEnabled:false a requestAnimationFrame callback never runs, so the frame wait would
// never settle; those static pages are captured directly.
const shot=async(p,name,fullPage=true,{scripted=true}={})=>{if(scripted)await frame(p);await p.screenshot({path:path.join(evidence,name+'.png'),fullPage});};
const noOverflow=p=>p.evaluate(()=>document.scrollingElement.scrollWidth<=document.scrollingElement.clientWidth);
let browser,cfg;

async function newPage(viewport={width:1440,height:1000},{locale='zh-CN',account=null,javaScriptEnabled=true}={}) {
  const context=await browser.newContext({viewport,javaScriptEnabled,timezoneId:'Asia/Shanghai',permissions:['clipboard-read','clipboard-write']});
  if(account!==null)await context.addCookies([{name:cfg.cookie,value:cfg.accounts[account].token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);
  if(locale!=='zh-CN')await context.addInitScript(([locale,id])=>{try{localStorage.setItem('mnemuron.appearance.v1.'+id,JSON.stringify({locale}));}catch{}},
    [locale,account===null?'signed-out':cfg.accounts[account].account_id]);
  const page=await context.newPage(),errors=[];page.setDefaultTimeout(15000);
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error'&&/Content Security Policy|Refused/.test(m.text()))errors.push(m.text());});
  return {context,page,errors};
}



let exitCode=0;
try{
 cfg=await read();assert.equal(cfg.fixture,true);browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
 await command('seed-audit');
 for(const width of [1440,390,320])for(const locale of ['zh-CN','en']){
  const label=`${width} ${locale}`,{context,page,errors}=await newPage({width,height:width===390?844:width===320?740:1000},{account:0,locale});
  const queries=[];page.on('request',r=>{if(r.url().includes('/console-api/audit?'))queries.push(r.url());});
  await page.goto(cfg.url+'/app/audit');await page.locator('.audit-timeline li').first().waitFor();
  check('header',label+' only language/account, no search',await page.locator('.topbar-tools').evaluate(e=>e.children.length===2&&!e.querySelector('input:not([type=hidden]),[data-search-shortcut],.top-search')));
  const headerStyles=()=>page.evaluate(()=>['.topbar-tools .select-trigger','.account-menu>summary'].map(sel=>{const e=document.querySelector(sel),c=getComputedStyle(e),r=e.getBoundingClientRect();return {height:r.height,y:r.y,border:c.border,bg:c.backgroundColor,radius:c.borderRadius,font:c.font,line:c.lineHeight,shadow:c.boxShadow,outline:c.outline};}));
  const hs=await headerStyles();check('header',label+' consistent geometry/style',JSON.stringify(hs[0])===JSON.stringify(hs[1]));
  const language=page.locator('.topbar-tools .select-trigger'),account=page.locator('.account-menu>summary');
  await language.focus();await page.keyboard.press('Tab');check('header',label+' account keyboard focus visible',await account.evaluate(e=>document.activeElement===e&&getComputedStyle(e).outlineStyle!=='none'));
  await account.press('Enter');await page.locator('.account-menu[open]').waitFor();await page.waitForTimeout(200);const accountExpanded=(await headerStyles())[1];await page.keyboard.press('Escape');
  await language.focus();await language.press('Enter');await page.locator('.topbar-tools .select-trigger[aria-expanded="true"]').waitFor();await page.waitForTimeout(200);const languageExpanded=(await headerStyles())[0];
  check('header',label+' expanded keyboard styles match',accountExpanded.border===languageExpanded.border&&accountExpanded.bg===languageExpanded.bg&&accountExpanded.shadow===languageExpanded.shadow&&accountExpanded.outline===languageExpanded.outline);await page.keyboard.press('Escape');
  await language.click();await page.locator('.topbar-tools .select-trigger[aria-expanded="true"]').waitFor();check('header',label+' language opens with pointer',await page.locator('.select-popup:popover-open').count()===1);await page.keyboard.press('Escape');
  await page.locator('h1').click();const beforeShortcut=page.url();await page.keyboard.press('/');await page.keyboard.press('Control+k');check('header',label+' no cross-page search shortcut',page.url()===beforeShortcut);
  if(locale==='zh-CN')await page.locator('.topbar').screenshot({path:path.join(evidence,`header-${width}.png`)});
  check('audit',label+' four tabs',await page.locator('[data-audit-group]').count()===4);
  check('audit',label+' collapsed filters and IDs',!await page.locator('#audit-filter').isVisible()&&!await page.locator('.audit-id').first().isVisible());
  check('audit',label+' current title visible',await page.locator('.audit-event-title').allTextContents().then(a=>a.some(x=>x.includes('部署前备份与回滚准备'))));
  check('audit',label+' no horizontal overflow',await noOverflow(page));
  if(width<600)await page.locator('.audit-sources').evaluate(e=>e.scrollIntoView({block:'start'}));
  await shot(page,`audit-closed-${width}-${locale}`,false);
  await page.locator('.audit-event-details summary').first().click();const copy=page.locator('[data-audit-copy]').first(),id=await copy.getAttribute('data-audit-copy');await copy.click();
  check('audit',label+' UUID copy',await page.evaluate(()=>navigator.clipboard.readText())===id);await page.locator('.audit-event-details summary').first().click();
  for(const group of ['system','connections','security','memory']){
   await Promise.all([page.waitForResponse(r=>r.url().includes('/console-api/audit?')&&new URL(r.url()).searchParams.get('group')===group),page.locator(`[data-audit-group="${group}"]`).click()]);
   await page.locator('.audit-timeline li').first().waitFor();
   check('audit',label+' '+group+' rows loaded',await page.locator('.audit-timeline li').count()>0);
   const next=page.locator('[data-audit-next]');check('audit',label+' '+group+' pagination',await next.count()===1);
   await next.click();await page.locator('[data-audit-prev]').waitFor();await page.locator('[data-audit-prev]').click();
  }
  await page.locator('.audit-filter-panel>summary').click();await page.locator('#audit-from').waitFor();
  await shot(page,`audit-filters-${width}-${locale}`,false);
  if(width===1440){const bottoms=await page.locator('#audit-filter').evaluate(e=>[...e.querySelectorAll(':scope>label')].map(l=>l.lastElementChild.getBoundingClientRect().bottom).concat(e.querySelector(':scope>button').getBoundingClientRect().bottom));check('audit',label+' controls aligned',Math.max(...bottoms)-Math.min(...bottoms)<=1);}
  const trigger=page.locator('[data-audit-date="audit-from"]'),before=queries.length;
  await trigger.click();await page.locator('.audit-date-dialog').waitFor();
  check('audit',label+' chooser fits viewport',await page.locator('.audit-date-dialog').evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&e.scrollWidth<=e.clientWidth;}));
  await shot(page,`audit-calendar-${width}-${locale}`,false);
  const focused=await page.locator('[data-day]:focus').getAttribute('data-day');await page.keyboard.press('ArrowRight');check('audit',label+' calendar arrow key',await page.locator('[data-day]:focus').getAttribute('data-day')!==focused);await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');check('audit',label+' Escape cancels and restores focus',await page.locator('#audit-from').inputValue()===''&&await trigger.evaluate(e=>document.activeElement===e));
  check('audit',label+' cancel does not filter',queries.length===before);
  await trigger.click();await page.locator('[data-day][tabindex="0"]').click();await page.locator('[data-date-time]').fill('14:30');await page.locator('[data-date-apply]').click();check('audit',label+' apply draft only',queries.length===before&&(await page.locator('#audit-from').inputValue()).endsWith('14:30'));
  const draft=await page.locator('#audit-from').inputValue();await trigger.click();await page.locator('[data-date-clear]').click();await page.locator('[data-date-close]').first().click();check('audit',label+' clear then cancel preserves value',await page.locator('#audit-from').inputValue()===draft);
  await trigger.click();await page.locator('[data-date-clear]').click();await page.locator('[data-date-apply]').click();check('audit',label+' clear applies locally',await page.locator('#audit-from').inputValue()==='');
  await page.locator('#audit-from').fill('2026-10-09 14:00');await page.locator('#audit-to').fill('2026-10-08 14:00');await page.locator('#audit-filter>button').click();check('audit',label+' reversed range rejected',queries.length===before);check('audit',label+' range error accessible',await page.locator('#audit-to').evaluate(e=>!e.validity.valid));
  await page.locator('#audit-from').fill('2000-01-01 08:00');await page.locator('#audit-to').fill('');await page.locator('#audit-filter>button').click();await page.locator('.audit-timeline li').first().waitFor();
  check('audit',label+' local to UTC request',queries.some(u=>new URL(u).searchParams.get('from')==='2000-01-01T00:00:00.000Z'));
  check('audit',label+' manual time round-trip',await page.locator('#audit-from').inputValue()==='2000-01-01 08:00');
  await page.locator('#audit-from').fill('');await page.locator('#audit-filter>button').click();await page.locator('.audit-timeline li').first().waitFor();
  const download=page.waitForEvent('download');await page.locator('[data-audit-export]').click();const artifact=await download;const doc=JSON.parse(fs.readFileSync(await artifact.path(),'utf8'));check('audit',label+' export group and no private bodies',doc.group==='memory'&&doc.entries.every(e=>e.group==='memory')&&!JSON.stringify(doc).includes('PRIVATE'));
  if(width===1440&&locale==='zh-CN'){
   let release,started;const began=new Promise(r=>started=r),gate=new Promise(r=>release=r);
   await page.route('**/console-api/audit?**',async route=>{const p=new URL(route.request().url()).searchParams;if(p.get('group')==='memory'&&p.has('cursor')&&p.get('limit')==='25'){const response=await route.fetch();started();await gate;await route.fulfill({response});}else await route.continue();});
   await page.locator('[data-audit-next]').click();await began;await page.locator('[data-audit-group="security"]').click();await page.locator('[data-audit-group="security"][aria-pressed="true"]').waitFor();release();await page.waitForTimeout(150);
   check('audit','late grouped response cannot overwrite current tab',await page.locator('[data-audit-group="security"][aria-pressed="true"]').count()===1);await page.unroute('**/console-api/audit?**');
   let exportRelease,exportStarted;const exportBegan=new Promise(r=>exportStarted=r),exportGate=new Promise(r=>exportRelease=r);let downloads=0;page.on('download',()=>downloads++);
   await page.route('**/console-api/audit?**',async route=>{if(new URL(route.request().url()).searchParams.get('limit')==='100'){const response=await route.fetch();exportStarted();await exportGate;await route.fulfill({response});}else await route.continue();});
   await page.locator('[data-audit-export]').click();await exportBegan;await page.locator('[data-audit-group="connections"]').click();await page.locator('[data-audit-group="connections"][aria-pressed="true"]').waitFor();exportRelease();await page.waitForTimeout(150);
   check('audit','tab switch cancels stale export download',downloads===0);await page.unroute('**/console-api/audit?**');
  }
  if(width===1440&&locale==='zh-CN'){
   await page.goto(cfg.url+'/app/memories');await page.locator('#search-form [data-search-input]').waitFor();const q=page.locator('#search-form [data-search-input]');
   await page.locator('h1').click();await page.keyboard.press('/');check('search','library shortcut still focuses its input',await q.evaluate(e=>document.activeElement===e));
   await q.fill('部署前备份');await page.keyboard.type('/');check('search','typing slash is not hijacked',(await q.inputValue()).endsWith('/'));
   await q.fill('部署前备份');const waiting=page.waitForResponse(r=>r.url().includes('/console-api/memories?')&&new URL(r.url()).searchParams.get('query')==='部署前备份');await q.press('Enter');const result=await waiting,body=await result.json();check('search','library reports hybrid fallback and preserves keyword results',result.status()===200&&body.retrieval?.requested_mode==='hybrid'&&body.retrieval?.effective_mode==='lexical'&&body.retrieval?.degraded===true&&JSON.stringify(body).includes('部署前备份'));
   check('search','query URL and field agree',new URL(page.url()).searchParams.get('query')==='部署前备份'&&await q.inputValue()==='部署前备份');await page.reload();await q.waitFor();check('search','library refresh preserves query',await q.inputValue()==='部署前备份');
  }
  check('audit',label+' no JS/CSP errors',errors.length===0);await context.close();
 }
}catch(e){exitCode=1;console.error(e.stack);}
finally{await browser?.close();fixture.stdin.write(JSON.stringify({command:'stop'})+'\n');await new Promise(r=>fixture.once('exit',r));fs.writeFileSync(path.join(evidence,'checks.json'),JSON.stringify({passed:checks.length,failed:exitCode,checks},null,2));console.log('Evidence '+evidence);if(!exitCode)fs.rmSync(privateLog,{recursive:true,force:true});}
process.exit(exitCode);
