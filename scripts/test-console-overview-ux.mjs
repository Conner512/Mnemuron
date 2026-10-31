// Graph-first overview acceptance over disposable, synthetic Core + OAuth + BFF services.
// Browser time may advance and genuine HTTP replies may be delayed or failed; successful
// audit responses always come from the fixture. No production account, data or model is used.
// Run with PLAYWRIGHT_MODULE, optional CHROMIUM_EXECUTABLE and MNEMURON_UI_EVIDENCE.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';

const root=path.resolve(import.meta.dirname,'..'),base=path.resolve(process.env.MNEMURON_UI_EVIDENCE||os.tmpdir());
assert.ok(base!==root&&!base.startsWith(root+path.sep),'Synthetic evidence stays outside the checkout');
const evidence=fs.mkdtempSync(path.join(base,'overview-ux-browser-')),privateLog=fs.mkdtempSync(path.join(os.tmpdir(),'overview-ux-fixture-'));
fs.chmodSync(evidence,0o700);fs.chmodSync(privateLog,0o700);
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const log=fs.openSync(path.join(privateLog,'fixture.stderr'),'wx',0o600);
const fixture=spawn(process.execPath,['services/oauth/test/helpers/console-functional-preview.mjs'],{cwd:root,stdio:['pipe','pipe',log]});
const queue=[],waiters=[],checks=[],failures=[],errors=[],rates=[],requests=[],geometry=[];
createInterface({input:fixture.stdout}).on('line',line=>{if(!line.startsWith('{'))return;const r=JSON.parse(line);if(waiters.length)waiters.shift()(r);else queue.push(r);});
const bounded=async(promise,label)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' timed out')),30000);})]);}finally{clearTimeout(timer);}};
const read=()=>bounded(queue.length?Promise.resolve(queue.shift()):new Promise(resolve=>waiters.push(resolve)),'Synthetic fixture reply');
const command=async(name,extra={})=>{fixture.stdin.write(JSON.stringify({command:name,...extra})+'\n');const r=await read();assert.ok(!r.fixture_error,`${name}: ${r.fixture_error}`);assert.equal(r.request,name);return r;};
const check=(name,pass=true)=>{checks.push({name,pass:!!pass});if(!pass)failures.push(name);console.log(`${pass?'PASS':'FAIL'} ${name}`);};
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
const isAudit=response=>{const u=new URL(response.url());return u.pathname==='/console-api/audit'&&u.searchParams.get('group')==='memory';};
const idle=async page=>{await page.locator('[data-memory-map][aria-busy="false"]').waitFor();await page.locator('[data-stream-state][data-state="live"]').waitFor();};
const state=async(page,value)=>page.locator(`[data-stream-state][data-state="${value}"]`).waitFor();
const screenshot=async(page,name,fullPage=false)=>page.screenshot({path:path.join(evidence,name+'.png'),fullPage,animations:'disabled'});
let browser,cfg,page;

async function newPage({width=1440,height=900,locale='zh-CN',owner=0,clock=false}={}){
 const context=await browser.newContext({viewport:{width,height},reducedMotion:'reduce'});
 await context.addCookies([{name:cfg.cookie,value:cfg.accounts[owner].token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);
 await context.addInitScript(({account,locale,origin})=>{if(location.origin===origin)localStorage.setItem('mnemuron.appearance.v1.'+account,JSON.stringify({locale}));},{account:cfg.accounts[owner].account_id,locale,origin:cfg.url});
 const p=await context.newPage();p.setDefaultTimeout(15000);
 p.on('pageerror',error=>errors.push(error.message));p.on('console',message=>{if(message.type()==='error'&&/Content Security Policy|Refused/.test(message.text()))errors.push(message.text());});
 p.on('response',response=>{if(response.status()===429)rates.push(new URL(response.url()).pathname);});
 const ownRequests=[];p.on('request',request=>{const url=new URL(request.url());if(!url.pathname.startsWith('/console-api/'))return;const r={path:url.pathname,method:request.method(),group:url.searchParams.get('group')};requests.push(r);ownRequests.push(r);});
 if(clock){const time=Date.now();await p.clock.install({time});await p.clock.pauseAt(time+1000);}
 return {context,page:p,auditCount:()=>ownRequests.filter(r=>r.path==='/console-api/audit'&&r.group==='memory').length};
}

try{
 cfg=await read();assert.equal(cfg.fixture,true);assert.equal(new URL(cfg.url).hostname,'127.0.0.1');
 await command('seed-kinds');await command('seed-lifecycle');await command('seed-map');
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});

 // First-fold geometry is an explicit requirement, not merely absence of horizontal overflow.
 // Narrow-screen navigation keeps every active destination available by touch and keyboard.
 for(const [width,locale] of [[1280,'zh-CN'],[1440,'zh-CN'],[1920,'zh-CN'],[390,'zh-CN'],[320,'zh-CN'],[1440,'en'],[390,'en']]){
  const view=await newPage({width,locale});page=view.page;await page.goto(cfg.url+'/app/overview');await idle(page);
  const tag=`${width}-${locale==='en'?'en':'zh'}`;
  const dimensions=await page.evaluate(()=>{const bounds=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height,width:r.width};};return {
   viewport:{width:innerWidth,height:innerHeight},card:bounds('[data-memory-map]'),graph:bounds('.map-board'),activity:bounds('[data-live-stream]'),activityTitle:bounds('[data-live-stream] .section-head'),firstEvent:bounds('[data-stream-list] .stream-event'),
   filtersHidden:document.querySelector('[data-map-filters]').hidden,sectionsVisible:[...document.querySelectorAll('[data-overview-system],[data-overview-library]')].every(n=>n.tagName==='SECTION'&&n.getBoundingClientRect().height>0&&!n.querySelector(':scope>summary')),
   overflow:document.documentElement.scrollWidth>innerWidth+1};});geometry.push({tag,...dimensions});
  await screenshot(page,'overview-'+tag+'-fold');
  if(width===1440&&locale==='zh-CN'||width===390&&locale==='zh-CN')await screenshot(page,'overview-'+tag+'-full',true);
  check(tag+': graph, activity and controls never overflow the viewport',!dimensions.overflow);
  check(tag+': only filters start closed; lower insights are permanently visible sections',dimensions.filtersHidden&&dimensions.sectionsVisible);
  check(tag+': the actual graph is visible, with useful height, in the initial viewport',dimensions.graph.top<(width>760?330:width<=360?500:430)&&dimensions.graph.bottom<=900&&dimensions.graph.height>=(width>760?400:250));
  if(width!==320)check(tag+': live-activity heading is visible in the initial viewport',dimensions.activityTitle.bottom<=900);
  if(width>1100)check(tag+': graph and activity outer cards align at both top and bottom',Math.abs(dimensions.activity.top-dimensions.card.top)<1&&Math.abs(dimensions.activity.bottom-dimensions.card.bottom)<1&&dimensions.activity.left>dimensions.graph.right);
  check(tag+': overview contains no memory search, project controls or full-library association',await page.locator('[data-search-input],[data-map-query],[data-map-scope-form],[data-neighborhood-form],.map-neighborhood').count()===0);
  const sameRect=(a,b)=>['x','y','width','height'].every(key=>Math.abs(a[key]-b[key])<1);
  const before={card:await page.locator('[data-memory-map]').boundingBox(),graph:await page.locator('.map-board').boundingBox(),activity:await page.locator('[data-live-stream]').boundingBox()};
  await page.locator('[data-map-filter-toggle]').click();
  const opened={card:await page.locator('[data-memory-map]').boundingBox(),graph:await page.locator('.map-board').boundingBox(),activity:await page.locator('[data-live-stream]').boundingBox(),filter:await page.locator('[data-map-filters]').boundingBox()};geometry.push({tag,before,opened});
  check(tag+': floating filters do not change either card or the graph dimensions',sameRect(before.card,opened.card)&&sameRect(before.graph,opened.graph)&&sameRect(before.activity,opened.activity));
  check(tag+': filter is bounded inside the graph with a compact footprint',opened.filter.width<=360&&opened.filter.height<=Math.min(360,opened.graph.height)&&opened.filter.x>=opened.graph.x&&opened.filter.y>=opened.graph.y&&opened.filter.x+opened.filter.width<=opened.graph.x+opened.graph.width+1&&opened.filter.y+opened.filter.height<=opened.graph.y+opened.graph.height+1&&(width<=1100||opened.filter.width*opened.filter.height<=opened.graph.width*opened.graph.height*.5));
  await page.locator('[data-map-filter-tab="nodes"]').click();
  const nodes=page.locator('[data-map-nodes] [data-map-node-key]');
  check(tag+': node browsing is inside filters and bounded to a page',await nodes.count()>0&&await nodes.count()<=8&&await page.locator('[data-map-filters] [data-map-node-page="next"]').count()===1);
  const firstKey=await nodes.first().getAttribute('data-map-node-key');
  await nodes.first().click();await nodes.nth(1).click();
  check(tag+': two ordinary clicks multi-select without reflowing cards',await page.locator('[data-memory-map]').getAttribute('data-selection-count')==='2'&&sameRect(before.card,await page.locator('[data-memory-map]').boundingBox())&&sameRect(before.graph,await page.locator('.map-board').boundingBox())&&sameRect(before.activity,await page.locator('[data-live-stream]').boundingBox()));
  if(await page.locator('[data-map-node-page="next"]').isEnabled()){
   await page.locator('[data-map-node-page="next"]').click();
   check(tag+': node pagination preserves selections without growing the filter',await nodes.count()<=8&&await nodes.first().getAttribute('data-map-node-key')!==firstKey&&await page.locator('[data-memory-map]').getAttribute('data-selection-count')==='2'&&sameRect(before.graph,await page.locator('.map-board').boundingBox()));
  }
  await screenshot(page,'overview-'+tag+'-filters');
  await page.keyboard.press('Escape');
  check(tag+': Escape closes floating filters and restores their trigger',await page.locator('[data-map-filters]').isHidden()&&await page.locator('[data-map-filter-toggle]').evaluate(n=>document.activeElement===n));
  await page.locator('[data-map-clear]').click();
  check(tag+': clearing selection leaves no highlighted node state or layout growth',await page.locator('[data-memory-map]').getAttribute('data-selection-count')==='0'&&await page.locator('[data-map-node-key][aria-pressed="true"]').count()===0&&sameRect(before.graph,await page.locator('.map-board').boundingBox()));
  await page.locator('[data-map-filter-toggle]').click();await page.locator('#console-root h1').click();
  check(tag+': outside click dismisses the filter without moving the cards',await page.locator('[data-map-filters]').isHidden()&&sameRect(before.card,await page.locator('[data-memory-map]').boundingBox())&&sameRect(before.activity,await page.locator('[data-live-stream]').boundingBox()));
  const nav=page.locator('.sidebar nav a'),paths=await nav.evaluateAll(links=>links.map(a=>new URL(a.href).pathname));
  check(tag+': all nine active destinations remain, with projects hidden',paths.length===9&&new Set(paths).size===9&&paths.includes('/app/security')&&paths.includes('/app/summaries')&&!paths.includes('/app/projects'));
  if(width<=390){
   const navBox=await page.locator('.sidebar nav').boundingBox();
   check(tag+': mobile navigation uses one compact horizontal row',navBox.height<=60&&await nav.evaluateAll(links=>Math.max(...links.map(n=>n.getBoundingClientRect().top))-Math.min(...links.map(n=>n.getBoundingClientRect().top))<3));
   await nav.first().focus();const navigation=[];
   for(let i=0;i<paths.length;i++){
    if(i)await page.keyboard.press('Tab');
    navigation.push(await page.evaluate(index=>{const nav=document.querySelector('.sidebar nav'),links=[...nav.querySelectorAll('a')],r=links[index].getBoundingClientRect(),b=nav.getBoundingClientRect();return {destination:links[index].getAttribute('href'),focused:document.activeElement===links[index],left:r.left,right:r.right,navLeft:b.left,navRight:b.right,scrollLeft:nav.scrollLeft};},i));
   }
   const keyboardReachable=navigation.every(n=>n.focused&&n.left>=n.navLeft-1&&n.right<=n.navRight+1);geometry.push({tag,navigation});if(!keyboardReachable)console.log(JSON.stringify({navigation_debug:tag,steps:navigation}));
   check(tag+': Tab reaches and scrolls every navigation destination into view',keyboardReachable);
  }
  await page.locator('#main').focus();await page.keyboard.press('/');
  check(tag+': slash on overview does not resurrect search or navigate elsewhere',await page.locator('[data-search-input]').count()===0&&new URL(page.url()).pathname==='/app/overview');
  await page.locator('[data-overview-system]').scrollIntoViewIfNeeded();
  check(tag+': system checks and statistics can be read by scrolling, without expansion',await page.locator('.status-strip').isVisible()&&await page.locator('.metrics').isVisible());
  await page.locator('.overview-library-link').click();await page.waitForURL('**/app/memories');await page.locator('[data-search-input]').waitFor();
  await page.locator('#main').focus();await page.keyboard.press('/');
  check(tag+': searching is focused in the Memory Library',await page.locator('[data-search-input]').evaluate(n=>document.activeElement===n));
  await page.locator('[data-search-input]').fill('Synthetic / typed');
  await page.keyboard.press('/');check(tag+': the shortcut does not steal a slash typed in the search field',(await page.locator('[data-search-input]').inputValue()).endsWith('/'));
  await contextClose(view);
 }

 // The clock controls scheduling only; every successful event is read from the real fixture.
 const activity=await newPage({clock:true});page=activity.page;await page.goto(cfg.url+'/app/overview');await idle(page);
 const initial=activity.auditCount(),initialStamp=await page.locator('[data-stream-updated]').innerText();
 await page.clock.fastForward(29999);check('Automatic updates do not run before 30 seconds',activity.auditCount()===initial);
 await command('unrelated-write');let response=page.waitForResponse(isAudit);await page.clock.fastForward(1);await response;await state(page,'live');
 check('At 30 seconds a real newly saved memory appears without manual refresh',activity.auditCount()===initial+1&&(await page.locator('[data-stream-list]').innerText()).includes('Synthetic unrelated write'));
 check('The last-success timestamp advances only after a successful read',(await page.locator('[data-stream-updated]').innerText())!==initialStamp);
 check('The feed names its account-wide scope and snapshot polling boundary',(await page.locator('.stream-note').innerText()).includes('不随图谱筛选')&&(await page.locator('.stream-note').innerText()).includes('非实时推送'));
 await page.locator('[data-stream-pause]').click();await state(page,'paused');let before=activity.auditCount();
 await page.clock.fastForward(90000);check('Pause stops three automatic refresh intervals while preserving the visible events',activity.auditCount()===before&&await page.locator('[data-stream-list] .stream-event').count()>0);
 response=page.waitForResponse(isAudit);await page.locator('[data-stream-refresh]').click();await response;await state(page,'paused');
 check('Manual refresh works while paused without silently resuming automatic updates',activity.auditCount()===before+1&&await page.locator('[data-stream-pause]').getAttribute('aria-pressed')==='true');
 before=activity.auditCount();await page.clock.fastForward(30000);check('A manual paused refresh does not re-arm the poll',activity.auditCount()===before);
 response=page.waitForResponse(isAudit);await page.locator('[data-stream-pause]').click();await response;await state(page,'live');
 check('Resume immediately refreshes genuine events and turns automatic updates back on',activity.auditCount()===before+1&&await page.locator('[data-stream-pause]').getAttribute('aria-pressed')==='false');

 const retained=await page.locator('[data-stream-list]').innerHTML(),retainedStamp=await page.locator('[data-stream-updated]').innerText();
 await page.route('**/console-api/audit?*',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error_code:'CORE_UNAVAILABLE'})}),{times:1});
 response=page.waitForResponse(isAudit);await page.clock.fastForward(30000);await response;await state(page,'error');
 check('HTTP 503 keeps the exact last-success list and timestamp instead of claiming no events',await page.locator('[data-stream-list]').innerHTML()===retained&&await page.locator('[data-stream-updated]').innerText()===retainedStamp);
 await screenshot(page,'activity-retained-after-error');
 response=page.waitForResponse(isAudit);await page.locator('[data-stream-refresh]').click();await response;await state(page,'live');
 check('Retry clears the failure only after the real BFF succeeds',await page.locator('[data-stream-list] .stream-event').count()>0);
 await activity.context.setOffline(true);await state(page,'offline');before=activity.auditCount();
 await page.clock.fastForward(60000);await page.locator('[data-stream-refresh]').click();
 check('Offline automatic and manual triggers do not create network attempts or erase content',activity.auditCount()===before&&await page.locator('[data-stream-list] .stream-event').count()>0);
 response=page.waitForResponse(isAudit);await activity.context.setOffline(false);await response;await state(page,'live');
 check('A restored connection re-reads the audit snapshot immediately',activity.auditCount()===before+1);

 // Headless Chromium keeps tabs visible, even when another tab is brought to the front.
 // Simulate only visibility state/event on the real document; all listeners, DOM rendering,
 // timers and successful audit reads remain production code and genuine BFF responses.
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
 await state(page,'hidden');before=activity.auditCount();
 await page.clock.fastForward(60000);check('A simulated hidden state stops automatic polling through the real DOM listener',activity.auditCount()===before);
 response=page.waitForResponse(isAudit);await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});await response;await state(page,'live');
 check('Restoring actual visibility refreshes before scheduling the next interval',activity.auditCount()===before+1);

 // A delayed successful audit may arrive only after navigation. It must not restore the old feed.
 const gate=deferred();let held;
 await page.route('**/console-api/audit?*',async route=>{held={route,response:await route.fetch()};gate.resolve();},{times:1});
 await page.locator('[data-stream-refresh]').click();await bounded(gate.promise,'Delayed real audit');
 await page.locator('.sidebar nav a[href="/app/summaries"]').click();await page.waitForURL('**/app/summaries');await page.locator('[data-overview-library]').waitFor({state:'detached'});
 await held.route.fulfill({response:held.response}).catch(()=>{});before=activity.auditCount();await page.clock.fastForward(60000);
 check('Navigating away discards late audit replies and disposes the overview poll',await page.locator('[data-live-stream]').count()===0&&activity.auditCount()===before);
 await contextClose(activity);

 // Simulate another tab signing in as a different real synthetic account: the browser cookie
 // changes, but the already mounted UI still belongs to A. Never mix B's events into A's page.
 const switching=await newPage();page=switching.page;await page.goto(cfg.url+'/app/overview');await idle(page);
 const oldAccount=await page.locator('body').getAttribute('data-account');
 await switching.context.addCookies([{name:cfg.cookie,value:cfg.accounts[1].token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);
 response=page.waitForResponse(isAudit);await page.locator('[data-stream-refresh]').click();const switched=await response;
 check('The BFF binds audit responses to the authenticated account',switched.headers()['x-mnemuron-account-id']===cfg.accounts[1].account_id);
 await page.waitForURL('**/login');
 check('A cross-tab account switch clears the stale account graph and feed before redirect',oldAccount===cfg.accounts[0].account_id&&await page.locator('[data-memory-map],[data-live-stream]').count()===0&&!((await page.locator('body').innerText()).includes('Synthetic B second memory')));
 await contextClose(switching);

 const revoked=await newPage();page=revoked.page;await page.goto(cfg.url+'/app/overview');await idle(page);
 await command('revoke-console-sessions');await page.locator('[data-stream-refresh]').click();await page.waitForURL('**/login');
 check('A revoked real session removes cached graph and activity before login',await page.locator('[data-memory-map],[data-live-stream]').count()===0);await contextClose(revoked);
 check('Overview browsing sends no operation request',requests.every(r=>r.path!=='/console-api/action'));
 check('No browser JavaScript or CSP errors occur',errors.length===0);check('No HTTP 429 masks an acceptance case',rates.length===0);
 assert.equal(failures.length,0,failures.join('\n'));
 fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({status:'passed',count:checks.length,checks,geometry,errors,rates,production_data_used:false},null,2),{mode:0o600});
 console.log(JSON.stringify({status:'passed',checks:checks.length,evidence}));
}catch(error){
 if(page&&!page.isClosed())await screenshot(page,'failure',true).catch(()=>{});
 fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({status:'failed',checks,failures,geometry,errors,rates,error:error.stack,production_data_used:false},null,2),{mode:0o600});
 console.error(JSON.stringify({status:'failed',checks:checks.length,evidence,error:error.message}));process.exitCode=1;
}finally{
 await browser?.close();
 if(fixture.exitCode===null&&fixture.signalCode===null){fixture.stdin.end('{"command":"stop"}\n');const timer=setTimeout(()=>fixture.kill('SIGTERM'),5000);try{await bounded(new Promise(resolve=>fixture.once('exit',resolve)),'Synthetic fixture cleanup');}finally{clearTimeout(timer);if(fixture.exitCode===null&&fixture.signalCode===null)fixture.kill('SIGKILL');}}
 fs.closeSync(log);assert.ok(fs.readFileSync(path.join(privateLog,'fixture.stderr'),'utf8').includes('"synthetic_cleanup_complete":true'),'Synthetic storage cleanup must be verified');
 console.log(JSON.stringify({synthetic_cleanup_verified:true}));
}

async function contextClose(view){await view.context.close();}
