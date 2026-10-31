// Real browser + real BFF/Core on disposable loopback services. All content is synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
const root=path.resolve(import.meta.dirname,'..'),base=path.resolve(process.env.MNEMURON_UI_EVIDENCE||os.tmpdir());
assert.ok(fs.existsSync(base)&&base!==root&&!base.startsWith(root+path.sep));
const evidence=fs.mkdtempSync(path.join(base,'search-workbench-browser-'));fs.chmodSync(evidence,0o700);
assert.ok(path.isAbsolute(process.env.PLAYWRIGHT_MODULE||''));
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const log=fs.openSync(path.join(evidence,'fixture.stderr'),'wx',0o600),child=spawn(process.execPath,['scripts/helpers/memory-map-browser-fixture.mjs'],{cwd:root,stdio:['pipe','pipe',log]});
const queued=[],waiters=[],checks=[],errors=[],actions=[],responses=[],navigation=[];let browser,cfg,page;
createInterface({input:child.stdout}).on('line',line=>{if(!line.startsWith('{'))return;const value=JSON.parse(line);if(waiters.length)waiters.shift()(value);else queued.push(value);});
const bounded=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('SYNTHETIC_FIXTURE_TIMEOUT')),30000);})]);}finally{clearTimeout(timer);}};
const read=()=>bounded(queued.length?Promise.resolve(queued.shift()):new Promise(resolve=>waiters.push(resolve)));
const command=async command=>{child.stdin.write(JSON.stringify({command})+'\n');const reply=await read();assert.ok(!reply.fixture_error,reply.fixture_error);return reply;};
const pass=(name,value=true)=>{assert.ok(value,name);checks.push(name);console.log('PASS '+name);};
const deferred=()=>{let resolve;return {promise:new Promise(yes=>resolve=yes),resolve:(...args)=>resolve(...args)};};
try{
 cfg=await read();assert.equal(cfg.fixture,true);assert.equal(new URL(cfg.url).hostname,'127.0.0.1');const seeded=await command('seed-workbench');
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:1440,height:1080},reducedMotion:'reduce'});page=await context.newPage();
 page.on('pageerror',error=>errors.push(error.message));page.on('console',msg=>{if(msg.type()==='error'&&/Content Security Policy|Refused/.test(msg.text()))errors.push(msg.text());});
 page.on('response',response=>{const pathname=new URL(response.url()).pathname;if(pathname.startsWith('/console-api/'))responses.push({path:pathname,status:response.status(),owner:cfg.accounts.findIndex(account=>account.account_id===response.headers()['x-mnemuron-account-id'])});});
 page.on('response',response=>{if(response.request().isNavigationRequest())navigation.push({kind:'response',path:new URL(response.url()).pathname,status:response.status(),location:response.headers().location||null});});
 page.on('request',async request=>{if(request.isNavigationRequest()){const headers=await request.allHeaders();navigation.push({kind:'request',path:new URL(request.url()).pathname,owner:cfg.accounts.findIndex(account=>(headers.cookie||'').includes(cfg.cookie+'='+account.token))});}});
 page.on('request',request=>{if(new URL(request.url()).pathname==='/console-api/action')actions.push(new URLSearchParams(request.postData()));});
 await context.addCookies([{name:cfg.cookie,value:cfg.accounts[0].token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);
 await context.addInitScript(accounts=>{for(const account of accounts)localStorage.setItem('mnemuron.appearance.v1.'+account.account_id,JSON.stringify({locale:'en'}));},cfg.accounts);
 const idle=()=>page.locator('[data-memory-map][aria-busy="false"]').waitFor();
 // The whole-library association and project-scope controls are intentionally removed from
 // Overview. Keep their read API compatibility and authorization coverage without pretending
 // that a removed control is still a supported user journey.
 const graphApi=async params=>{const response=await page.evaluate(async params=>{const response=await fetch('/console-api/attention?'+new URLSearchParams({graph_days:0,...(params.graph_focus?{graph_limit:10}:{}),...params}));return {status:response.status,owner:response.headers.get('x-mnemuron-account-id'),body:await response.json()};},params);assert.equal(response.status,200,response.body.error_code);assert.equal(response.owner,cfg.accounts[0].account_id);return response.body.graph;};
 await page.goto(cfg.url+'/app/overview');await idle();await page.locator('[data-map-filter-toggle]').click();
 pass('Overview removes full-library association, project scopes and memory search controls',await page.locator('[data-map-neighborhood],[data-neighbor-search],[data-map-project],[data-map-task],[data-map-search]').count()===0);
 const scope={graph_project_id:seeded.project_id,graph_task_id:seeded.task_id},scopedGraph=await graphApi(scope);
 pass('Preserved API filters project and exact task before counts and the graph cap',scopedGraph.filtered_total===4&&scopedGraph.scope.task_id===seeded.task_id);
 const scopedNeighbor=(await graphApi({...scope,graph_focus:'Synthetic Scoped'})).neighborhood;pass('Preserved focused API reports current and superseded scoped counts',scopedNeighbor.current_count===4&&scopedNeighbor.history_count===1);
 const historic=(await graphApi({...scope,graph_focus:'Synthetic Scoped',graph_history:1})).neighborhood;
 pass('History remains an explicit API opt-in with replacement relationships',historic.evidence.total===5&&historic.evidence.items.some(row=>row.supersedes_memory_id));
 const full=(await graphApi({graph_focus:'Synthetic Router/A'})).neighborhood;pass('Older relationships outside the newest 1000 records remain API-readable',full.current_count===13&&full.evidence.items.length===10&&full.evidence.next_offset===10);
 const firstIds=full.evidence.items.map(row=>row.memory_id),next=(await graphApi({graph_focus:'Synthetic Router/A',graph_offset:10})).neighborhood;
 pass('Preserved evidence pagination reaches every older record without duplicates',next.evidence.items.length===3&&next.evidence.next_offset===null&&next.evidence.items.every(row=>!firstIds.includes(row.memory_id)));
 const openId=next.evidence.items[0].memory_id,detail=await page.evaluate(async id=>{const response=await fetch('/console-api/memory?memory_id='+encodeURIComponent(id));return {status:response.status,body:await response.json()};},openId);
 pass('Source IDs returned by the API resolve to the actual authenticated memory',detail.status===200&&detail.body.memory.content.includes('Synthetic older full-library graph evidence'));
 const foreign=await browser.newContext();await foreign.addCookies([{name:cfg.cookie,value:cfg.accounts[1].token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);const foreignPage=await foreign.newPage();await foreignPage.goto(cfg.url+'/app/overview');
 const denied=await foreignPage.evaluate(async({id,project,task})=>{const response=await fetch('/console-api/attention?'+new URLSearchParams({graph_days:0,graph_focus:'Synthetic Scoped',graph_project_id:project,graph_task_id:task}));const memory=await fetch('/console-api/memory?memory_id='+encodeURIComponent(id));return {status:response.status,body:await response.json(),memoryStatus:memory.status,memoryError:(await memory.json()).error_code};},{id:openId,project:seeded.project_id,task:seeded.task_id});
 pass('Removed controls preserve explicit not-found denials, not incidental server errors',denied.status===404&&denied.body.error_code==='PROJECT_NOT_FOUND'&&denied.memoryStatus===404&&denied.memoryError==='MEMORY_NOT_FOUND');await foreign.close();
 await page.goto(cfg.url+'/app/memories?query=SearchFeedbackNeedle&mode=lexical');await page.locator('[data-feedback-vote="relevant"]').waitFor();
 const vote=async kind=>{const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/console-api/action');await page.locator(`[data-feedback-vote="${kind}"]`).click();const body=await(await response).json();await page.waitForFunction(()=>document.querySelector('[data-feedback-status]')?.textContent.includes('Saved'));return body;};
 const saved=await vote('relevant');pass('A real BFF action saves a revision-bound relevant vote without rewriting source/ranking',saved.status==='saved'&&saved.ranking_changed===false);
 await vote('irrelevant');await page.waitForFunction(()=>document.querySelector('[data-feedback-history]')?.textContent.includes('Irrelevant'));
 pass('Replacing a vote updates one feedback record rather than inflating counts',(await page.locator('[data-feedback-history]').innerText()).includes('scope: 1'));
 const missingResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/console-api/action');await page.locator('[data-feedback-missing] button').click();const missing=await(await missingResponse).json();
 pass('Unspecified missing feedback is explicit and has no fabricated memory ID',missing.status==='saved'&&!missing.memory_id);
 await page.waitForFunction(()=>document.querySelector('[data-feedback-missing-status]')?.textContent.includes('Saved'));
 await page.locator('[data-feedback-missing] input').fill(seeded.older[0]);const expectedResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/console-api/action');await page.locator('[data-feedback-missing] button').click();const expected=await(await expectedResponse).json();
 pass('A missing expected memory is loaded under the account and saved at its current revision',expected.status==='saved'&&expected.memory_id===seeded.older[0]&&expected.revision===1);
 await page.waitForFunction(()=>document.querySelector('[data-feedback-missing-status]')?.textContent.includes('Saved'));
 let failOnce=true;const ambiguous=async route=>{if(failOnce){failOnce=false;await route.fetch();await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error_code:'CONSOLE_CORE_UNAVAILABLE'})});}else await route.continue();};
 await page.route('**/console-api/action',ambiguous);const failedResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/console-api/action');await page.locator('[data-feedback-vote="outdated"]').click();await failedResponse;
 await page.waitForFunction(()=>!document.querySelector('[data-feedback-vote="outdated"]').disabled);
 pass('An ambiguous save never displays success',(await page.locator('[data-feedback-status]').innerText()).includes('not confirmed'));
 const recovered=await vote('outdated');const last=actions.slice(-2);pass('Explicit retry retains the exact operation ID and recovers the server receipt',recovered.replayed===true&&last[0].get('operation_id')===last[1].get('operation_id'));
 await page.unroute('**/console-api/action',ambiguous);
 pass('Feedback mutation payloads contain no original query text or password/OTP',actions.filter(row=>row.get('action')==='search.feedback').every(row=>{const payload=JSON.parse(row.get('payload')),raw=Buffer.from(payload.search_token.split('.')[0],'base64url').toString();return !/SearchFeedbackNeedle|Synthetic SearchFeedback/.test(raw)&&!Object.keys(payload).some(key=>/query|password|otp/.test(key));}));
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(evidence,'search-feedback-mobile.png'),fullPage:true});
 pass('Feedback remains within the mobile viewport',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 let historyHeld;const historyReady=deferred();const holdHistory=async route=>{historyHeld={route,response:await route.fetch()};historyReady.resolve();};
 await page.route('**/console-api/search-feedback?*',holdHistory);await page.locator('[data-feedback-refresh]').click();await bounded(historyReady.promise);
 await context.addCookies([{name:cfg.cookie,value:cfg.accounts[1].token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);
 // A different tab's sign-in is a real identity boundary, not an in-place account update.
 // Trigger a B read in the old A realm while its A history response is still held; finish
 // the mandatory clear/login transition before opening B's library. A blind reload can
 // otherwise race the old realm's guard and legitimately end at /login.
 const switchedResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/console-api/memories'&&r.headers()['x-mnemuron-account-id']===cfg.accounts[1].account_id);
 await page.locator('#search-form button[type="submit"]').click();const switched=await switchedResponse;
 pass('A real cross-tab library read is bound to the newly authenticated account',switched.status()===200&&switched.headers()['x-mnemuron-account-id']===cfg.accounts[1].account_id);
 await page.waitForURL('**/login');
 pass('Account mismatch clears the old search and feedback before the login boundary',await page.locator('[data-feedback-for],[data-search-feedback]').count()===0&&!(await page.locator('body').innerText()).includes('Synthetic SearchFeedbackNeedle'));
 await page.unroute('**/console-api/search-feedback?*',holdHistory);await historyHeld.route.fulfill({response:historyHeld.response}).catch(()=>{});
 await page.goto(cfg.url+'/app/memories?query=SearchFeedbackNeedle&mode=lexical');await page.locator('[data-search-feedback]').waitFor();
 assert.equal(await page.locator('body').getAttribute('data-account'),cfg.accounts[1].account_id);
 await page.waitForFunction(()=>document.querySelector('[data-feedback-history]')?.textContent.includes('scope: 0'));
 pass('Account switch removes old results and discards a late rich feedback history',await page.locator('[data-feedback-for]').count()===0&&!(await page.locator('[data-feedback-history]').innerText()).includes(seeded.feedback_id));
 pass('Readable evaluation entry explains synthetic results versus unrun real model quality',(await page.locator('[data-search-feedback] details').innerText()).includes('Reproducible quality checks'));
 pass('No browser JavaScript or CSP failures',errors.length===0);
 fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify({status:'passed',checks,synthetic_only:true,network_calls_to_models:0},null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify({status:'passed',checks:checks.length,evidence}));
}catch(error){const pageState=await page?.evaluate(()=>({path:location.pathname,page:document.body.dataset.page,loading:!!document.querySelector('.loading-card'),emptyRoot:document.querySelector('#console-root')?.childElementCount===0,alert:document.querySelector('#console-root > [role=alert]')?.textContent})).catch(()=>null);await page?.screenshot({path:path.join(evidence,'failure.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(evidence,'failure.json'),JSON.stringify({status:'failed',checks,error:String(error),errors,pageState,responses:responses.slice(-30),navigation},null,2),{mode:0o600});console.error(error);console.error(JSON.stringify({status:'failed',evidence,pageState}));process.exitCode=1;}
finally{await browser?.close();if(child.exitCode===null)child.stdin.write(JSON.stringify({command:'stop'})+'\n');await bounded(new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve))).catch(()=>child.kill('SIGTERM'));fs.closeSync(log);}
