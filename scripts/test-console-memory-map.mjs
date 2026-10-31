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
 const openFilters=async()=>{if(!await page.locator('[data-map-filters]').isVisible())await page.locator('[data-map-filter-toggle]').click();};
 const openNodes=async()=>{await openFilters();await page.locator('[data-map-filter-tab="nodes"]').click();};
 const settings=async()=>{await openFilters();await page.locator('[data-map-filter-tab="settings"]').click();};
 const findNode=async key=>{await openNodes();while(await page.locator('[data-map-node-page="previous"]').isEnabled())await page.locator('[data-map-node-page="previous"]').click();const node=page.locator(`[data-map-nodes] [data-map-node-key="${key}"]`);for(let i=0;i<8&&!await node.count();i++){assert.ok(await page.locator('[data-map-node-page="next"]').isEnabled(),'missing stable node '+key);await page.locator('[data-map-node-page="next"]').click();}return node;};
 const typeOnly=async kind=>{await settings();for(const other of await page.locator('[data-map-kind][aria-pressed="true"]').evaluateAll((nodes,kind)=>nodes.map(node=>node.dataset.mapKind).filter(value=>value!==kind),kind)){await page.locator(`[data-map-kind="${other}"]`).click();await idle();}};
 const days=async value=>{const reply=page.waitForResponse(response=>graphRequest(response)&&new URL(response.url()).searchParams.get('graph_days')===String(value));await page.locator(`[data-map-days="${value}"]`).click();await reply;await idle();};
 const bounds=()=>page.evaluate(()=>Object.fromEntries(['[data-memory-map]','.map-board','[data-live-stream]'].map(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return [selector,{top:r.top,bottom:r.bottom,height:r.height}];})));
 await page.goto(cfg.url+'/app/overview');await idle();
 check('Advanced filters are initially collapsed and the graph dominates the first desktop view',!await page.locator('[data-map-filters]').isVisible()&&await page.locator('[data-map-filter-toggle]').getAttribute('aria-expanded')==='false'&&await page.locator('.map-board').evaluate(node=>node.getBoundingClientRect().top<400&&node.getBoundingClientRect().height>=340));
 await page.setViewportSize({width:390,height:900});await page.evaluate(()=>scrollTo(0,0));
 check('The mobile first view contains the graph and the live-activity heading',await page.locator('.map-board').evaluate(node=>node.getBoundingClientRect().top<450&&node.getBoundingClientRect().height>=280)&&await page.locator('#stream-title').evaluate(node=>node.getBoundingClientRect().bottom<innerHeight));
 await page.screenshot({path:path.join(evidence,'map-first-view-mobile.png'),fullPage:false});await page.setViewportSize({width:1440,height:1080});
 let graph=await api({});
 check('Default 30-day graph reads the actual Core count through the BFF',graph.returned===cfg.expected.default_count&&graph.filtered_total===cfg.expected.default_count&&graph.scope.days===30);
 check('A recently filled keyword on an old source stays in the current activity window',graph.memories.some(memory=>memory.id===cfg.expected.renewed)&&!graph.memories.some(memory=>memory.id===cfg.expected.outside));
 check('The graph has metadata only and no foreign or retracted source',graph.memories.every(memory=>!Object.hasOwn(memory,'content'))&&!JSON.stringify(graph).includes('Synthetic Other Owner')&&!JSON.stringify(graph).includes('Synthetic Retracted'));
 const closedBounds=await bounds();await openFilters();const openBounds=await bounds();
 check('Opening floating filters leaves graph and both hero card edges unchanged',JSON.stringify(closedBounds)===JSON.stringify(openBounds));
 check('The filter is compact, inside the board, and has no search, project, task or whole-library controls',await page.locator('[data-map-filters]').evaluate(node=>{const r=node.getBoundingClientRect(),b=node.closest('.map-board').getBoundingClientRect();return getComputedStyle(node).position==='absolute'&&r.width<=340&&r.height<=336&&r.top>=b.top&&r.bottom<=b.bottom&&r.right<=b.right;})&&await page.locator('[data-map-search],[data-map-query],[data-map-neighborhood],[data-map-explore],[data-map-project],[data-map-task]').count()===0);
 await page.locator('[data-map-refresh]').focus();check('Keyboard focus can leave the non-modal filter and dismisses it without a focus trap',!await page.locator('[data-map-filters]').isVisible()&&await page.locator('[data-map-refresh]').evaluate(node=>node===document.activeElement));await openFilters();
 await page.locator('[data-map-filter-tab="settings"]').focus();await page.keyboard.press('ArrowRight');check('Arrow keys switch accessible filter tabs without leaving their tablist',await page.locator('[data-map-filter-tab="nodes"]').evaluate(node=>node===document.activeElement&&node.getAttribute('aria-selected')==='true'));
 const untagged=await findNode('unmapped:fact');
 check('Every node remains reachable through bounded pages, including the untagged aggregate bucket',await untagged.count()===1&&await page.locator('[data-map-nodes] button').count()<=8);
 const pinnedControls=()=>page.locator('[data-map-filters]').evaluate(node=>{const panel=node.getBoundingClientRect(),list=node.querySelector('[data-map-nodes]').getBoundingClientRect();return ['.map-node-pages','[data-map-show-selection]'].every(selector=>{const control=node.querySelector(selector).getBoundingClientRect();return control.top>=list.bottom-1&&control.bottom<=panel.bottom-5&&control.left>=panel.left&&control.right<=panel.right;});});
 check('Desktop node pagination and view-selection action stay fully visible below the scrolling list',await pinnedControls());
 await untagged.focus();await page.keyboard.press('Enter');
 check('Keyboard Enter selects real aggregate members without obscuring the node controls',!await page.locator('[data-map-panel]').isVisible()&&await page.locator('[data-map-panel] [data-map-memory]').count()===10&&await untagged.evaluate(node=>node===document.activeElement&&node.getAttribute('aria-pressed')==='true'&&node.matches(':focus-visible')));
 await page.locator('[data-map-show-selection]').click();
 check('Viewing selected memories closes the filter and opens the bounded result panel',!await page.locator('[data-map-filters]').isVisible()&&await page.locator('[data-map-panel]').isVisible());
 const firstIds=await page.locator('[data-map-panel] [data-map-memory]').evaluateAll(nodes=>nodes.map(node=>node.dataset.mapMemory));
 await page.locator('[data-map-memory-offset="10"]').click();
 const secondIds=await page.locator('[data-map-panel] [data-map-memory]').evaluateAll(nodes=>nodes.map(node=>node.dataset.mapMemory));
 check('The next member page contains different real IDs without dropping the remainder',secondIds.length===10&&secondIds.every(id=>!firstIds.includes(id)));
 await page.locator('[data-map-panel] [data-map-memory]').first().click();await page.locator('#memory-dialog[open]').waitFor();await page.locator('#memory-content .body-content').waitFor();
 check('An aggregate member opens its authenticated current memory body',(await page.locator('#memory-content').innerText()).includes('Synthetic untagged map memory'));
 // Native dialog.close removes open synchronously, then runs the close handler and restores width.
 // Wait for that observable completion before starting the next keyboard interaction; no timed sleep.
 await page.locator('#memory-dialog [data-close]').first().click();await page.locator('body.pane-open').waitFor({state:'detached'});await page.locator('[data-map-close]').focus();await page.keyboard.press('Escape');
 const returnedFocus=!await page.locator('[data-map-panel]').isVisible()&&await page.locator('[data-map-filter-toggle]').evaluate(node=>node===document.activeElement);
 if(!returnedFocus)console.log(JSON.stringify({focus_debug:await page.evaluate(()=>({paneOpen:document.querySelector('#memory-dialog')?.open,widePane:document.body.classList.contains('pane-open'),panelHidden:document.querySelector('[data-map-panel]')?.hidden,activeTag:document.activeElement?.tagName,activeId:document.activeElement?.id,node:document.activeElement?.dataset?.mapNodeKey}))}));
 check('Escape closes details and restores keyboard focus to the visible filter trigger',returnedFocus);

 await typeOnly('preference');graph=await api({graph_query:'Synthetic Shared'});await openNodes();
 check('Library-compatible metadata query API is preserved while type filtering drives this graph',graph.returned===2&&graph.memories.every(memory=>cfg.expected.shared.includes(memory.id))&&(await page.locator('[data-map-coverage]').innerText()).includes('2 / 2'));
 check('Markup-like keywords remain plain text in accessible node buttons',await page.locator('[data-map-nodes] b').count()===0&&(await page.locator('[data-map-nodes]').innerText()).includes('<b>Synthetic label</b>'));
 check('Unicode-equivalent spellings produce one shared graph node',await page.locator('[data-map-nodes] [data-map-node-key="concept:pve"]').count()===1&&(await page.locator('[data-map-nodes] [data-map-node-key="concept:pve"]').innerText()).includes('2'));
 const pve=page.locator('[data-map-nodes] [data-map-node-key="concept:pve"]'),sharedNode=page.locator('[data-map-nodes] [data-map-node-key="concept:synthetic shared"]');
 await pve.click();await sharedNode.click();
 check('Plain clicks add two nodes and overlapping source memories count once',await page.locator('[data-memory-map]').getAttribute('data-selection-count')==='2'&&await page.locator('[data-map-panel] [data-map-memory]').count()===2&&(await page.locator('[data-map-selection-count]').innerText()).includes('2 nodes · 2 memories')&&await page.locator('[data-map-panel]').innerText().then(text=>text.includes('any selected node')&&text.includes('not a full-library result')));
 await sharedNode.click();check('Deselecting one node keeps the other selection without a lingering pointer focus outline',await pve.getAttribute('aria-pressed')==='true'&&await sharedNode.getAttribute('aria-pressed')==='false'&&await sharedNode.evaluate(node=>getComputedStyle(node).outlineStyle==='none'));
 await sharedNode.focus();await page.keyboard.press('Space');check('Space adds the second node without moving keyboard focus',await sharedNode.evaluate(node=>node===document.activeElement&&node.matches(':focus-visible'))&&await page.locator('[data-memory-map]').getAttribute('data-selection-count')==='2');
 await page.setViewportSize({width:1000,height:900});await page.waitForFunction(()=>document.querySelector('[data-map-canvas]')?.dataset.selectedCount==='2');
 await page.evaluate(()=>document.dispatchEvent(new CustomEvent('appearancechange')));
 check('Resize and appearance refresh preserve both still-valid node keys',await pve.getAttribute('aria-pressed')==='true'&&await sharedNode.getAttribute('aria-pressed')==='true'&&await page.locator('[data-map-panel] [data-map-memory]').count()===2);
 await page.keyboard.press('Escape');check('Escape dismisses filters first and preserves selected nodes',!await page.locator('[data-map-filters]').isVisible()&&await page.locator('[data-memory-map]').getAttribute('data-selection-count')==='2'&&await page.locator('[data-map-filter-toggle]').evaluate(node=>node===document.activeElement));
 await page.locator('[data-map-clear]').click();check('Clear removes panel, selection chips, canvas state and every selected button',!await page.locator('[data-map-panel]').isVisible()&&await page.locator('[data-map-nodes] [aria-pressed="true"]').count()===0&&await page.locator('[data-map-selection-chips] button').count()===0&&await page.locator('[data-map-canvas]').getAttribute('data-selected-count')==='0');
 await openNodes();const beforeSelection=await bounds();await pve.click();const afterSelection=await bounds();check('Selection count and chips do not grow the card or shift the canvas',JSON.stringify(beforeSelection)===JSON.stringify(afterSelection));
 await page.locator('[data-map-canvas]').click({position:{x:2,y:2}});check('Clicking outside dismisses filters and empty canvas clears selection without opening a memory',!await page.locator('[data-map-filters]').isVisible()&&!await page.locator('[data-map-panel]').isVisible()&&await page.locator('#memory-dialog[open]').count()===0&&await pve.getAttribute('aria-pressed')==='false');
 await page.setViewportSize({width:1440,height:1080});
 await openNodes();await page.locator('[data-map-nodes] [data-map-node-key="concept:pve"]').click();await page.locator('[data-map-show-selection]').click();await page.locator('[data-map-panel] a.button').click();await page.waitForURL('**/app/memories?concept=*');await page.locator('.memory-table tbody tr').first().waitFor();
 const library=await page.evaluate(async()=>{const params=new URLSearchParams(location.search);params.set('status','active');params.set('limit','25');const response=await fetch('/console-api/memories?'+params);return {status:response.status,body:await response.json()};});
 check('Graph-to-library navigation returns the full equivalent keyword group under the same owner and active boundary',library.status===200&&library.body.results.length===2&&library.body.results.every(memory=>cfg.expected.shared.includes(memory.memory_id)));
 await page.goto(cfg.url+'/app/overview');await idle();await typeOnly('preference');
 await page.locator('[data-map-kind="preference"]').click();await idle();
 check('Hiding the only matching type shows an explicit all-types-hidden state',await page.locator('[data-map-nodes] button').count()===0&&(await page.locator('[data-map-empty]').innerText()).includes('All types are hidden'));
 await page.locator('[data-map-kind="preference"]').click();await idle();
 check('The same legend can restore a hidden type after server-side filtering',await page.locator('[data-map-nodes] button').count()>0&&(await page.locator('[data-map-coverage]').innerText()).includes('2 / 2'));

 const ready=deferred();let held;
 const hold=async route=>{const url=new URL(route.request().url());if(url.searchParams.get('graph_days')==='7'){held={route,response:await route.fetch()};ready.resolve();}else await route.continue();};
 await page.route('**/console-api/attention?*',hold);const beforeLoading=await bounds();await page.locator('[data-map-days="7"]').click();await bounded(ready.promise,'Held graph reply');
 check('A delayed real graph read displays status without shifting the board or either card',await page.locator('[data-map-status]').isVisible()&&JSON.stringify(beforeLoading)===JSON.stringify(await bounds()));
 await days(90);const currentScope=await readScope();
 await held.route.fulfill({response:held.response});await page.waitForTimeout(100);
 check('A late older filter response cannot replace a newer scope or its nodes',(await readScope())===currentScope&&currentScope.includes('90')&&(await page.locator('[data-map-coverage]').innerText()).includes('2 / 2'));
 await page.unroute('**/console-api/attention?*',hold);
 let failures=0;const fail=async route=>{if(new URL(route.request().url()).searchParams.get('graph_days')==='7'&&failures++===0)await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error_code:'CORE_UNAVAILABLE'})});else await route.continue();};
 await page.route('**/console-api/attention?*',fail);const beforeFailure=await bounds();await days(7);
 check('A real HTTP 503 retains the old graph and names the unapplied filter',await page.locator('[data-map-retry]').isVisible()&&(await readScope())===currentScope&&(await page.locator('[data-map-status]').innerText()).includes('have not been applied'));
 check('Failed-read feedback and retry float over the board without changing its geometry',JSON.stringify(beforeFailure)===JSON.stringify(await bounds())&&await page.locator('[data-map-status]').evaluate(node=>{const r=node.getBoundingClientRect(),board=node.closest('.map-board').getBoundingClientRect(),zoom=node.closest('.map-board').querySelector('.map-zoom').getBoundingClientRect();return getComputedStyle(node).position==='absolute'&&r.top>=board.top&&r.bottom<=zoom.top&&r.right<=board.right;}));
 await openNodes();check('An open filter exposes the same error and retry while preserving its pinned actions',await page.locator('[data-map-filters] [data-map-retry]').isVisible()&&await pinnedControls()&&JSON.stringify(beforeFailure)===JSON.stringify(await bounds()));
 for(const width of [390,320]){
  await page.setViewportSize({width,height:900});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.evaluate(()=>scrollTo(0,0));const errorBounds=await bounds();
  check(width+' error and retry remain inside the filter without clipping node-page actions',await pinnedControls()&&await page.locator('[data-map-retry]').evaluate(node=>{const r=node.getBoundingClientRect(),p=node.closest('[data-map-filters]').getBoundingClientRect();return r.top>=p.top&&r.bottom<=p.bottom&&r.right<=p.right&&r.left>=p.left;})&&await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.locator('[data-map-filter-close]').click();check(width+' closing a failed-read filter does not move the graph or either card',JSON.stringify(errorBounds)===JSON.stringify(await bounds()));await openNodes();
 }
 await page.setViewportSize({width:1440,height:1080});
 await page.locator('[data-map-filter-close]').click();
 const retried=page.waitForResponse(response=>graphRequest(response)&&new URL(response.url()).searchParams.get('graph_days')==='7');await page.locator('[data-map-retry]').focus();await page.keyboard.press('Enter');await retried;await idle();
 check('Explicit retry reads the same scope once and removes its error after success',failures===2&&await page.locator('[data-map-retry]').count()===0&&(await page.locator('[data-map-coverage]').innerText()).includes('2 / 2'));
 check('Keyboard retry keeps focus on the stable filter trigger when its transient button disappears',await page.locator('[data-map-filter-toggle]').evaluate(node=>node===document.activeElement));
 await page.unroute('**/console-api/attention?*',fail);
 const invalid=await page.evaluate(async()=>{const response=await fetch('/console-api/attention?graph_query='+encodeURIComponent('x'.repeat(201)));return response.status;});check('Removed UI does not weaken graph API validation',invalid===400);

 await settings();await page.locator('[data-map-reset]').click();await idle();
 const all=page.waitForResponse(response=>graphRequest(response)&&new URL(response.url()).searchParams.get('graph_days')==='0');await page.locator('[data-map-days="0"]').click();await all;await idle();
 check('All-time view restores the actual older active memory',(await page.locator('[data-map-coverage]').innerText()).includes(`${cfg.expected.all_count} / ${cfg.expected.all_count}`));
 const bodyQuery=await api({graph_days:0,graph_query:'Synthetic old memory outside'});check('Preserved graph query API only examines metadata, never original bodies',bodyQuery.returned===0&&bodyQuery.memories.length===0);

 let initialFailure=true;const failInitial=async route=>{if(initialFailure)await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error_code:'CORE_UNAVAILABLE'})});else await route.continue();};
 await page.route('**/console-api/attention?*',failInitial);await page.reload();await idle();
 check('An initial unavailable graph renders a retry card and never claims zero memories',await page.locator('[data-map-retry]').isVisible()&&(await page.locator('[data-map-coverage]').innerText()).includes('does not mean')&&!/Showing 0/.test(await page.locator('[data-map-coverage]').innerText()));
 initialFailure=false;await page.locator('[data-map-retry]').click();await idle();check('Initial read recovery returns a real graph',await page.locator('[data-map-nodes] button').count()>0&&await page.locator('[data-map-retry]').count()===0);await page.unroute('**/console-api/attention?*',failInitial);

 await command('seed-large');await page.reload();await idle();graph=await api({graph_days:0});
 await page.waitForFunction(total=>document.querySelector('[data-nav-badge="memories"]')?.textContent.trim()===String(total),graph.active_total);
 check('Long CJK metadata fits the actual BFF response bound and reports the omitted records',graph.truncated&&graph.truncation_reason==='response_budget'&&graph.returned<graph.filtered_total&&Buffer.byteLength(JSON.stringify(graph))<=180*1024);
 check('The visible graph always explains the byte limit',(await page.locator('[data-map-coverage]').innerText()).includes('safe display-size limit'));
 await openNodes();await page.locator('[data-map-nodes] button').first().focus();await page.keyboard.press('Enter');await page.setViewportSize({width:800,height:900});
 check('Resize preserves a stable selected node or safely clears a removed one',Number(await page.locator('[data-memory-map]').getAttribute('data-selection-count'))?await page.locator('[data-map-panel] [data-map-memory]').count()>0:true);
 if(Number(await page.locator('[data-memory-map]').getAttribute('data-selection-count')))await page.locator('[data-map-clear]').click();
 await page.setViewportSize({width:1440,height:1080});await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(evidence,'map-desktop.png'),fullPage:true});
 for(const locale of ['zh-CN','en']){
  await page.evaluate(locale=>{const select=document.querySelector('[data-pref="locale"]');select.value=locale;select.dispatchEvent(new Event('change',{bubbles:true}));},locale);
  await page.setViewportSize({width:390,height:844});
  await openNodes();
  check(locale+' mobile node pagination and view-selection action are pinned inside the overlay',await pinnedControls());
  check(locale+' map filters and coverage fit the mobile viewport',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)&&await page.locator('[data-map-coverage]').isVisible()&&await page.locator('[data-map-hint]').isVisible());
  check(locale+' long keyword labels wrap without covering their counts',await page.locator('[data-map-nodes] button').evaluateAll(buttons=>buttons.every(button=>{const label=button.querySelector('.node-key'),count=button.lastElementChild;return label.scrollWidth<=label.clientWidth+1&&label.getBoundingClientRect().right<=count.getBoundingClientRect().left-4;})));
  check(locale+' translates compact graph controls and their full accessible labels',(await page.locator('[data-map-hint]').innerText()).includes(locale==='en'?'entity identity':'同一实体')&&(await page.locator('[data-map-days="30"]').innerText())===(locale==='en'?'30 days':'近 30 天')&&(await page.locator('[data-map-days="30"]').getAttribute('aria-label'))===(locale==='en'?'Last 30 days':'近 30 天'));
  await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(evidence,`map-${locale}-mobile.png`),fullPage:true});
 }
 await page.setViewportSize({width:320,height:760});check('The smallest supported viewport keeps graph controls and node buttons inside the page',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 check('Dense mobile nodes scroll within a bounded overlay rather than expanding the graph',await page.locator('[data-map-filters]').evaluate(node=>{const r=node.getBoundingClientRect(),board=node.closest('.map-board').getBoundingClientRect();return r.height<=board.height-18&&r.width<=board.width-18;})&&await page.locator('[data-map-nodes] button').count()<=8);
 check('The narrowest overlay keeps pagination and the full selection action visible',await pinnedControls());

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
