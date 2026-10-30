// Actual browser, Core, OAuth and BFF reads over disposable loopback services. This harness
// uses synthetic identities and metadata only, and never calls a real model or deployment.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';

const root=path.resolve(import.meta.dirname,'..'),base=path.resolve(process.env.MNEMURON_UI_EVIDENCE||os.tmpdir());
assert.ok(fs.existsSync(base)&&base!==root&&!base.startsWith(root+path.sep),'Evidence must be outside the worktree');
const evidence=fs.mkdtempSync(path.join(base,'memory-map-browser-'));fs.chmodSync(evidence,0o700);
assert.ok(process.env.PLAYWRIGHT_MODULE&&path.isAbsolute(process.env.PLAYWRIGHT_MODULE));
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const stderr=fs.openSync(path.join(evidence,'fixture.stderr'),'wx',0o600),child=spawn(process.execPath,['scripts/helpers/memory-map-browser-fixture.mjs'],{cwd:root,stdio:['pipe','pipe',stderr]});
const queue=[],waiters=[],checks=[],errors=[],rates=[],requests=[];let browser,page,cfg;
createInterface({input:child.stdout}).on('line',line=>{if(!line.startsWith('{'))return;const result=JSON.parse(line);if(waiters.length)waiters.shift()(result);else queue.push(result);});
const bounded=async(promise,name)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(name+' timed out')),30000);})]);}finally{clearTimeout(timer);}};
const read=()=>bounded(queue.length?Promise.resolve(queue.shift()):new Promise(resolve=>waiters.push(resolve)),'Synthetic fixture reply');
const command=async command=>{child.stdin.write(JSON.stringify({command})+'\n');const result=await read();assert.ok(!result.fixture_error,result.fixture_error);return result;};
const check=(name,value=true)=>{assert.ok(value,name);checks.push(name);console.log('PASS '+name);};
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
const graphRequest=response=>new URL(response.url()).pathname==='/console-api/attention';

try{
 cfg=await read();assert.equal(cfg.fixture,true);assert.equal(new URL(cfg.url).protocol,'http:');assert.equal(new URL(cfg.url).hostname,'127.0.0.1');
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:1440,height:1080},reducedMotion:'reduce'});
 const observe=context=>{context.on('response',response=>{if(response.status()===429)rates.push(new URL(response.url()).pathname);});context.on('page',p=>{p.on('pageerror',error=>errors.push(error.stack||error.message));p.on('console',message=>{if(message.type()==='error'&&/Content Security Policy|Refused/.test(message.text()))errors.push(message.text());});});};observe(context);
 await context.addCookies([{name:cfg.cookie,value:cfg.accounts[0].token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);
 await context.addInitScript(({account,origin})=>{if(location.origin===origin)localStorage.setItem('mnemuron.appearance.v1.'+account,JSON.stringify({locale:'en'}));},{account:cfg.accounts[0].account_id,origin:cfg.url});
 page=await context.newPage();page.on('request',request=>{const url=new URL(request.url());if(url.pathname.startsWith('/console-api/'))requests.push({path:url.pathname,method:request.method(),query:url.pathname==='/console-api/attention'?url.searchParams.get('graph_query'):null});});
 const idle=()=>page.locator('[data-memory-map][aria-busy="false"]').waitFor();
 const api=async params=>{const result=await page.evaluate(async params=>{const response=await fetch('/console-api/attention?'+new URLSearchParams(params));return {status:response.status,body:await response.json()};},params);assert.equal(result.status,200,result.body.error_code);return result.body.graph;};
 const readScope=()=>page.locator('[data-map-scope]').innerText();
 const query=async value=>{await page.locator('[data-map-query]').fill(value);const reply=page.waitForResponse(response=>graphRequest(response)&&new URL(response.url()).searchParams.get('graph_query')===value);await page.locator('[data-map-search] button[type=submit]').click();await reply;await idle();};
 await page.goto(cfg.url+'/app/overview');await idle();
 let graph=await api({});
 check('Default 30-day graph reads the actual Core count through the BFF',graph.returned===cfg.expected.default_count&&graph.filtered_total===cfg.expected.default_count&&graph.scope.days===30);
 check('A recently filled keyword on an old source stays in the current activity window',graph.memories.some(memory=>memory.id===cfg.expected.renewed)&&!graph.memories.some(memory=>memory.id===cfg.expected.outside));
 check('The graph has metadata only and no foreign or retracted source',graph.memories.every(memory=>!Object.hasOwn(memory,'content'))&&!JSON.stringify(graph).includes('Synthetic Other Owner')&&!JSON.stringify(graph).includes('Synthetic Retracted'));
 check('An untagged aggregate bucket remains present in the keyboard node list',await page.locator('[data-map-nodes] [data-map-node-key="unmapped:fact"]').count()===1);
 await page.locator('[data-map-nodes] [data-map-node-key="unmapped:fact"]').focus();await page.keyboard.press('Enter');
 check('Keyboard Enter opens real aggregate members and moves focus to its close control',await page.locator('[data-map-panel]').isVisible()&&await page.locator('[data-map-panel] [data-map-memory]').count()===10&&await page.locator('[data-map-close]').evaluate(node=>node===document.activeElement));
 const firstIds=await page.locator('[data-map-panel] [data-map-memory]').evaluateAll(nodes=>nodes.map(node=>node.dataset.mapMemory));
 await page.locator('[data-map-memory-offset="10"]').click();
 const secondIds=await page.locator('[data-map-panel] [data-map-memory]').evaluateAll(nodes=>nodes.map(node=>node.dataset.mapMemory));
 check('The next member page contains different real IDs without dropping the remainder',secondIds.length===10&&secondIds.every(id=>!firstIds.includes(id)));
 await page.locator('[data-map-panel] [data-map-memory]').first().click();await page.locator('#memory-dialog[open]').waitFor();await page.locator('#memory-content .body-content').waitFor();
 check('An aggregate member opens its authenticated current memory body',(await page.locator('#memory-content').innerText()).includes('Synthetic untagged map memory'));
 // Native dialog.close removes open synchronously, then runs the close handler and restores width.
 // Wait for that observable completion before starting the next keyboard interaction; no timed sleep.
 await page.locator('#memory-dialog [data-close]').first().click();await page.locator('body.pane-open').waitFor({state:'detached'});await page.locator('[data-map-close]').focus();await page.keyboard.press('Escape');
 const returnedFocus=!await page.locator('[data-map-panel]').isVisible()&&await page.locator('[data-map-nodes] [data-map-node-key="unmapped:fact"]').evaluate(node=>node===document.activeElement);
 if(!returnedFocus)console.log(JSON.stringify({focus_debug:await page.evaluate(()=>({paneOpen:document.querySelector('#memory-dialog')?.open,widePane:document.body.classList.contains('pane-open'),panelHidden:document.querySelector('[data-map-panel]')?.hidden,activeTag:document.activeElement?.tagName,activeId:document.activeElement?.id,node:document.activeElement?.dataset?.mapNodeKey}))}));
 check('Escape closes details and restores keyboard focus to the same stable node',returnedFocus);

 await query('Synthetic Shared');graph=await api({graph_query:'Synthetic Shared'});
 check('Search filters keyword/topic metadata before drawing and shows the exact matching count',graph.returned===2&&graph.memories.every(memory=>cfg.expected.shared.includes(memory.id))&&(await page.locator('[data-map-coverage]').innerText()).includes('2 / 2'));
 check('Markup-like keywords remain plain text in accessible node buttons',await page.locator('[data-map-nodes] b').count()===0&&(await page.locator('[data-map-nodes]').innerText()).includes('<b>Synthetic label</b>'));
 check('Unicode-equivalent spellings produce one shared graph node',await page.locator('[data-map-nodes] [data-map-node-key="concept:pve"]').count()===1&&(await page.locator('[data-map-nodes] [data-map-node-key="concept:pve"]').innerText()).includes('2'));
 await page.locator('[data-map-nodes] [data-map-node-key="concept:pve"]').click();await page.locator('[data-map-panel] a.button').click();await page.waitForURL('**/app/memories?concept=*');await page.locator('.memory-table tbody tr').first().waitFor();
 const library=await page.evaluate(async()=>{const params=new URLSearchParams(location.search);params.set('status','active');params.set('limit','25');const response=await fetch('/console-api/memories?'+params);return {status:response.status,body:await response.json()};});
 check('Graph-to-library navigation returns the full equivalent keyword group under the same owner and active boundary',library.status===200&&library.body.results.length===2&&library.body.results.every(memory=>cfg.expected.shared.includes(memory.memory_id)));
 await page.goto(cfg.url+'/app/overview');await idle();await query('Synthetic Shared');
 await page.locator('[data-map-kind="preference"]').click();await idle();
 check('Hiding the only matching type shows an explicit all-types-hidden state',await page.locator('[data-map-nodes] button').count()===0&&(await page.locator('[data-map-empty]').innerText()).includes('All types are hidden'));
 await page.locator('[data-map-kind="preference"]').click();await idle();
 check('The same legend can restore a hidden type after server-side filtering',await page.locator('[data-map-nodes] button').count()>0&&(await page.locator('[data-map-coverage]').innerText()).includes('2 / 2'));

 const ready=deferred();let held;
 const hold=async route=>{const url=new URL(route.request().url());if(url.searchParams.get('graph_query')==='Synthetic Shared'){held={route,response:await route.fetch()};ready.resolve();}else await route.continue();};
 await page.route('**/console-api/attention?*',hold);await page.locator('[data-map-query]').fill('Synthetic Shared');await page.locator('[data-map-search] button[type=submit]').click();await bounded(ready.promise,'Held graph reply');
 await query('Synthetic Renewed');const currentScope=await readScope();
 await held.route.fulfill({response:held.response});await page.waitForTimeout(100);
 check('A late older filter response cannot replace a newer scope or its nodes',(await readScope())===currentScope&&(await page.locator('[data-map-coverage]').innerText()).includes('1 / 1'));
 await page.unroute('**/console-api/attention?*',hold);
 let failures=0;const fail=async route=>{if(new URL(route.request().url()).searchParams.get('graph_query')==='Synthetic Shared'&&failures++===0)await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error_code:'CORE_UNAVAILABLE'})});else await route.continue();};
 await page.route('**/console-api/attention?*',fail);await query('Synthetic Shared');
 check('A real HTTP 503 retains the old graph and names the unapplied filter',await page.locator('[data-map-retry]').isVisible()&&(await readScope())===currentScope&&(await page.locator('[data-map-status]').innerText()).includes('have not been applied'));
 const retried=page.waitForResponse(response=>graphRequest(response)&&new URL(response.url()).searchParams.get('graph_query')==='Synthetic Shared');await page.locator('[data-map-retry]').click();await retried;await idle();
 check('Explicit retry reads the same scope once and removes its error after success',failures===2&&await page.locator('[data-map-retry]').count()===0&&(await page.locator('[data-map-coverage]').innerText()).includes('2 / 2'));
 await page.unroute('**/console-api/attention?*',fail);
 const beforeLong=requests.filter(request=>request.path==='/console-api/attention').length;await page.locator('[data-map-query]').fill('x'.repeat(201));await page.locator('[data-map-search] button[type=submit]').click();
 check('An oversized query is explained before any request is sent',await page.locator('[data-map-query]').evaluate(node=>!node.checkValidity()&&node.validationMessage.includes('200'))&&requests.filter(request=>request.path==='/console-api/attention').length===beforeLong);

 await page.locator('[data-map-reset]').click();await idle();
 const all=page.waitForResponse(response=>graphRequest(response)&&new URL(response.url()).searchParams.get('graph_days')==='0');await page.locator('[data-map-days="0"]').click();await all;await idle();
 check('All-time view restores the actual older active memory',(await page.locator('[data-map-coverage]').innerText()).includes(`${cfg.expected.all_count} / ${cfg.expected.all_count}`));
 await query('Synthetic old memory outside');check('Graph search does not pretend to search original memory bodies',await page.locator('[data-map-nodes] button').count()===0&&(await page.locator('[data-map-empty]').innerText()).includes('No active memories match'));

 let initialFailure=true;const failInitial=async route=>{if(initialFailure)await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error_code:'CORE_UNAVAILABLE'})});else await route.continue();};
 await page.route('**/console-api/attention?*',failInitial);await page.reload();await idle();
 check('An initial unavailable graph renders a retry card and never claims zero memories',await page.locator('[data-map-retry]').isVisible()&&(await page.locator('[data-map-coverage]').innerText()).includes('does not mean')&&!/Showing 0/.test(await page.locator('[data-map-coverage]').innerText()));
 initialFailure=false;await page.locator('[data-map-retry]').click();await idle();check('Initial read recovery returns a real graph',await page.locator('[data-map-nodes] button').count()>0&&await page.locator('[data-map-retry]').count()===0);await page.unroute('**/console-api/attention?*',failInitial);

 await command('seed-large');await page.reload();await idle();graph=await api({graph_days:0});
 await page.waitForFunction(total=>document.querySelector('[data-nav-badge="memories"]')?.textContent.trim()===String(total),graph.active_total);
 check('Long CJK metadata fits the actual BFF response bound and reports the omitted records',graph.truncated&&graph.truncation_reason==='response_budget'&&graph.returned<graph.filtered_total&&Buffer.byteLength(JSON.stringify(graph))<=180*1024);
 check('The visible graph always explains the byte limit',(await page.locator('[data-map-coverage]').innerText()).includes('safe display-size limit'));
 await page.locator('[data-map-nodes] button').first().focus();await page.keyboard.press('Enter');await page.setViewportSize({width:800,height:900});
 check('Resize preserves a stable selected node or safely clears a removed one',await page.locator('[data-map-panel]').isVisible()?await page.locator('[data-map-panel] [data-map-memory]').count()>0:true);
 if(await page.locator('[data-map-panel]').isVisible())await page.locator('[data-map-close]').click();
 await page.setViewportSize({width:1440,height:1080});await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(evidence,'map-desktop.png'),fullPage:true});
 for(const locale of ['zh-CN','en']){
  await page.evaluate(locale=>{const select=document.querySelector('[data-pref="locale"]');select.value=locale;select.dispatchEvent(new Event('change',{bubbles:true}));},locale);
  await page.setViewportSize({width:390,height:844});
  check(locale+' map filters and coverage fit the mobile viewport',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)&&await page.locator('[data-map-coverage]').isVisible()&&await page.locator('[data-map-hint]').isVisible());
  check(locale+' long keyword labels wrap without covering their counts',await page.locator('[data-map-nodes] button').evaluateAll(buttons=>buttons.every(button=>{const label=button.querySelector('.node-key'),count=button.lastElementChild;return label.scrollWidth<=label.clientWidth+1&&label.getBoundingClientRect().right<=count.getBoundingClientRect().left-4;})));
  check(locale+' translates graph controls and the co-occurrence boundary',(await page.locator('[data-map-hint]').innerText()).includes(locale==='en'?'entity identity':'同一实体')&&(await page.locator('[data-map-days="30"]').innerText())===(locale==='en'?'Last 30 days':'近 30 天'));
  await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(evidence,`map-${locale}-mobile.png`),fullPage:true});
 }
 await page.setViewportSize({width:320,height:760});check('The smallest supported viewport keeps graph controls and node buttons inside the page',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));

 const other=await browser.newContext();observe(other);await other.addCookies([{name:cfg.cookie,value:cfg.accounts[1].token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);const otherPage=await other.newPage();await otherPage.goto(cfg.url+'/app/overview');await otherPage.locator('[data-memory-map][aria-busy="false"]').waitFor();
 const foreign=await otherPage.evaluate(async()=>{const response=await fetch('/console-api/attention?graph_days=0');return response.json();});
 check('A separate signed-in account gets its own graph and none of the first account metadata',foreign.graph.returned===1&&foreign.graph.memories[0].concepts.includes('Synthetic Other Owner')&&!JSON.stringify(foreign.graph).includes('Synthetic Shared'));
 await other.close();
 check('Graph browsing and recovery never submit an operation',requests.every(request=>request.path!=='/console-api/action'));
 await command('revoke-console');await page.locator('[data-map-refresh]').click();await page.waitForURL('**/login');
 check('Revoked sessions clear graph nodes and details before redirecting',await page.locator('[data-memory-map],[data-map-panel]').count()===0);
 check('No browser JavaScript or CSP failures',errors.length===0);check('No HTTP 429 masks a graph or session failure',rates.length===0);
 fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({status:'passed',count:checks.length,checks,errors,rates,production_data_used:false},null,2),{mode:0o600});console.log(JSON.stringify({status:'passed',checks:checks.length,evidence}));
}catch(error){if(page)await page.screenshot({path:path.join(evidence,'failure.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({status:'failed',checks,error:error.stack,errors,rates},null,2),{mode:0o600});console.error(JSON.stringify({status:'failed',checks:checks.length,evidence,error:error.message}));process.exitCode=1;}
finally{await browser?.close();if(child.exitCode===null&&child.signalCode===null){if(!child.stdin.destroyed)child.stdin.end('{"command":"stop"}\n');const timer=setTimeout(()=>child.kill('SIGTERM'),5000);try{await bounded(new Promise(resolve=>child.once('exit',resolve)),'Synthetic fixture shutdown');}finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}}fs.closeSync(stderr);assert.ok(fs.readFileSync(path.join(evidence,'fixture.stderr'),'utf8').includes('"synthetic_cleanup_complete":true'),'Synthetic fixture cleanup must be verified');console.log(JSON.stringify({synthetic_cleanup_verified:true}));}
