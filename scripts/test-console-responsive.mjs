// Whole-Console responsive acceptance against populated synthetic loopback data.
// No production account, provider, configuration or memory is read.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';

const root=path.resolve(import.meta.dirname,'..');
const base=path.resolve(process.env.MNEMURON_UI_EVIDENCE||os.tmpdir());
assert.ok(base!==root&&!base.startsWith(root+path.sep),'Evidence belongs outside source');
const evidence=fs.mkdtempSync(path.join(base,'responsive-browser-'));fs.chmodSync(evidence,0o700);
const privateDir=fs.mkdtempSync(path.join(os.tmpdir(),'responsive-fixture-'));
const log=fs.openSync(path.join(privateDir,'fixture.stderr'),'wx',0o600);
const fixture=spawn(process.execPath,['services/oauth/test/helpers/console-functional-preview.mjs'],{cwd:root,stdio:['pipe','pipe',log]});
const queued=[],waiting=[];let fixtureEnded=false;
createInterface({input:fixture.stdout}).on('line',line=>{if(!line.startsWith('{'))return;const value=JSON.parse(line);if(waiting.length)waiting.shift()(value);else queued.push(value);});
fixture.once('exit',()=>{fixtureEnded=true;});
async function read(){let timer;try{return await Promise.race([queued.length?Promise.resolve(queued.shift()):new Promise(r=>waiting.push(r)),new Promise((_,r)=>{timer=setTimeout(()=>r(new Error('Fixture response timed out')),30000);})]);}finally{clearTimeout(timer);}}
async function command(command,params={}){fixture.stdin.write(JSON.stringify({command,...params})+'\n');const reply=await read();assert.equal(reply.request,command);assert.ok(!reply.fixture_error,reply.fixture_error);return reply;}
const checks=[],failures=[],screenshots=[];
function check(name,ok,detail){checks.push({name,passed:!!ok,...(detail?{detail}: {})});if(!ok)failures.push(name);console.log(`${ok?'PASS':'FAIL'} ${name}${!ok&&detail?' '+JSON.stringify(detail):''}`);}
const controlsOnly=process.argv.includes('--controls-only');
const connectionsOnly=process.argv.includes('--connections-only');
const pages=controlsOnly?['overview','security']:connectionsOnly?['connections']:['overview','memories','summaries','entities','jobs','connections','agents','tasks','models','storage','usage','audit','security'];
let browser,cfg,exitCode=0,windowStart=Date.now(),requestsInWindow=0;
try{
 assert.ok(!(controlsOnly&&connectionsOnly),'Choose one focused responsive surface');
 cfg=await read();assert.equal(cfg.fixture,true);assert.match(cfg.url,/^http:\/\/127\.0\.0\.1:/);
 await command('seed-projects');await command('seed-summaries');await command('seed-responsive');await command('seed-audit');
 const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE||'/usr/bin/chromium'});
 for(const locale of controlsOnly?['en']:['zh-CN','en'])for(const width of controlsOnly?[320]:[1440,900,390,320]){
  const context=await browser.newContext({viewport:{width,height:width<500?844:1000}});
  await context.addCookies([{name:cfg.cookie,value:cfg.accounts[0].token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);
  await context.addInitScript(([locale,id])=>localStorage.setItem('mnemuron.appearance.v1.'+id,JSON.stringify({locale})),[locale,cfg.accounts[0].account_id]);
  const page=await context.newPage(),errors=[],rateLimited=[];page.setDefaultTimeout(15000);
  page.on('pageerror',e=>errors.push(e.message));page.on('request',()=>requestsInWindow++);page.on('response',r=>{if(r.status()===429)rateLimited.push(new URL(r.url()).pathname);});
  for(const name of pages){
   if(Date.now()-windowStart>=62000){windowStart=Date.now();requestsInWindow=0;}
   if(requestsInWindow>600){await page.waitForTimeout(Math.max(0,62000-(Date.now()-windowStart)));windowStart=Date.now();requestsInWindow=0;}
   const response=await page.goto(cfg.url+'/app/'+name);
   try{await page.locator('.loading-card').waitFor({state:'detached'});await page.locator('#console-root h1').waitFor();}
   catch(e){throw new Error(`${e.message}; URL ${page.url()}; HTTP ${response.status()}; rate limited ${JSON.stringify(rateLimited)}; browser errors ${JSON.stringify(errors)}`);}
   await page.evaluate(()=>Promise.all(document.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{}))));
   const label=`${name} ${width} ${locale}`;
   check(label+' HTTP and translated page',response.status()===200&&await page.locator('#console-root h1').innerText()!==name);
   const geometry=await page.evaluate(()=>{
    const root=document.scrollingElement,main=document.querySelector('#main');
    const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';};
    const overflowing=[...document.querySelectorAll('#console-root .card,#console-root .feature-card,#console-root .project-row,#console-root .task-row,.topbar')].filter(visible).filter(e=>{const r=e.getBoundingClientRect();return r.left<-.5||r.right>innerWidth+.5;}).map(e=>e.className);
    const narrow=[...document.querySelectorAll('#console-root .body-content,#console-root .memory-title,#console-root .project-title,#console-root .task-title,#console-root td,#console-root dd,#console-root .roadmap-list>li>div:first-child')].filter(visible).filter(e=>e.textContent.trim().length>10&&e.getBoundingClientRect().width<80).map(e=>({class:e.className,width:e.getBoundingClientRect().width}));
    return {page:root.scrollWidth<=root.clientWidth,overflowing,narrow,main:main?.getBoundingClientRect().width};
   });
   check(label+' no viewport or card overflow',geometry.page&&!geometry.overflowing.length,geometry);
   check(label+' readable text columns',!geometry.narrow.length,geometry.narrow);
   check(label+' no failed page panel',await page.locator('#console-root > [role=alert]').count()===0);
   if(name==='overview'){
    const destinations=await page.locator('.sidebar nav a').evaluateAll(links=>links.map(link=>new URL(link.href).pathname));
    const expected=['/app/overview','/app/memories','/app/summaries','/app/processing','/app/connections','/app/models','/app/health','/app/audit','/app/security'];
    check(label+' memory-first navigation retains all nine active destinations',JSON.stringify(destinations)===JSON.stringify(expected),destinations);
    check(label+' paused work navigation is absent, not merely visually clipped',await page.locator('.sidebar [data-i18n="navWork"],.sidebar a[href="/app/projects"],.sidebar a[href="/app/tasks"],.sidebar a[href="/app/resume"]').count()===0);
   }
   if(name==='tasks')check(label+' legacy project route is retained with a visible pause notice',await page.locator('.paused-page-notice').isVisible()&&await page.locator('.sidebar a[aria-current="page"]').count()===0&&new URL(page.url()).pathname==='/app/projects');
   if(name==='overview'){
    check(label+' overview has no duplicate memory search',await page.locator('[data-search-input],[data-map-query],[data-neighborhood-form]').count()===0);
    check(label+' lower insight sections stay visible without disclosure controls',await page.locator('[data-overview-system],[data-overview-library]').evaluateAll(nodes=>nodes.length===2&&nodes.every(n=>n.tagName==='SECTION'&&n.getBoundingClientRect().height>0&&!n.querySelector(':scope>summary'))));
   }
   if(name==='security'){
    const badge=await page.locator('.identity-row .tag').evaluate(tag=>{const r=tag.getBoundingClientRect(),parent=tag.parentElement.getBoundingClientRect();return {inside:r.left>=parent.left&&r.right<=parent.right,wraps:getComputedStyle(tag).whiteSpace!=='nowrap',width:r.width,parentWidth:parent.width};});
    check(label+' authentication badge fits profile',badge.inside,badge);
   }
   if(name==='connections'){
    const gap=await page.locator('[data-agents-root] + .card').first().evaluate(card=>{
     const r=card.getBoundingClientRect(),before=card.previousElementSibling.getBoundingClientRect();
     return {actual:r.top-before.bottom,expected:parseFloat(getComputedStyle(card).getPropertyValue('--gap'))};
    });
    check(label+' health card keeps the standard gap after agent setup',gap.actual>0&&Math.abs(gap.actual-gap.expected)<=1,gap);
   }
   const filename=`${name}-${width}-${locale}.png`;await page.screenshot({path:path.join(evidence,filename),fullPage:true,animations:'disabled'});screenshots.push(filename);
   // Do not weaken the production per-peer limit. Natural browser paint and screenshot pacing prevents bursts.
   await page.waitForTimeout(200);
  }
  if(controlsOnly){await context.close();continue;}
  if(connectionsOnly){
   check(`${width} ${locale} no browser exceptions`,errors.length===0,errors);
   check(`${width} ${locale} no rate-limit masking`,rateLimited.length===0,rateLimited);
   await context.close();continue;
  }
  // Exercise generic form, Cancel/Escape and result focus at each viewport and language.
  await page.goto(cfg.url+'/app/memories');await page.locator('[data-console-action="memory.create"]').waitFor();
  const create=page.locator('[data-console-action="memory.create"]').first();await create.focus();await page.keyboard.press('Enter');
  const dialog=page.locator('#operation-dialog');await dialog.locator('form').waitFor();
  check(`${width} ${locale} modal fits`,await dialog.evaluate(d=>{const r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+.5&&d.scrollWidth<=d.clientWidth+1;}));
  await page.screenshot({path:path.join(evidence,`memory-create-${width}-${locale}.png`),fullPage:false,animations:'disabled'});
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  check(`${width} ${locale} Escape restores trigger focus`,await create.evaluate(e=>e===document.activeElement));
  await create.click();await dialog.locator('[name=content]').fill('Synthetic responsive acceptance '+width+' '+locale+' '+Date.now());
  await dialog.locator('button[type=submit]').click();await dialog.locator('.operation-result').waitFor({state:'attached'});
  check(`${width} ${locale} result remains inside keyboard focus`,await dialog.evaluate(d=>d.contains(document.activeElement)&&document.activeElement!==d));
  await dialog.locator('[data-operation-close]').last().click();await dialog.waitFor({state:'hidden'});
  check(`${width} ${locale} result Close restores trigger focus`,await create.evaluate(e=>e===document.activeElement));
  check(`${width} ${locale} no browser exceptions`,errors.length===0,errors);
  check(`${width} ${locale} no rate-limit masking`,rateLimited.length===0,rateLimited);
  await context.close();
 }
 exitCode=failures.length?1:0;
}catch(e){exitCode=1;failures.push(e.message);console.error(e.stack);}
finally{
 await browser?.close();if(!fixtureEnded){fixture.stdin.write(JSON.stringify({command:'stop'})+'\n');await new Promise(r=>fixture.once('exit',r));}
 fs.closeSync(log);const cleaned=fs.readFileSync(path.join(privateDir,'fixture.stderr'),'utf8').includes('"synthetic_cleanup_complete":true');
 check('Synthetic fixture cleanup is verified',cleaned);if(!cleaned)exitCode=1;
 if(!exitCode)fs.rmSync(privateDir,{recursive:true,force:true});
 fs.writeFileSync(path.join(evidence,'checks.json'),JSON.stringify({status:exitCode?'failed':'passed',passed:checks.filter(x=>x.passed).length,failed:failures.length,checks,failures,screenshots},null,2),{mode:0o600});
 console.log(`${exitCode?'FAILED':'PASSED'} ${checks.filter(x=>x.passed).length} checks; evidence ${evidence}`);
 if(exitCode)console.error('Private fixture diagnostics: '+privateDir);
}
process.exitCode=exitCode;
