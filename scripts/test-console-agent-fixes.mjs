// Focused real-browser regressions for Agent revocation, inventory recovery and Codex continuity grants.
// Only disposable loopback services, synthetic identities and a fresh browser context are used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

const root=path.resolve(import.meta.dirname,'..'),base=path.resolve(process.env.MNEMURON_UI_EVIDENCE||os.tmpdir());
assert.ok(fs.existsSync(base)&&base!==root&&!base.startsWith(root+path.sep),'Evidence must be outside the worktree');
const evidence=fs.mkdtempSync(path.join(base,'agent-fixes-browser-'));fs.chmodSync(evidence,0o700);
assert.ok(process.env.PLAYWRIGHT_MODULE&&path.isAbsolute(process.env.PLAYWRIGHT_MODULE),'Set PLAYWRIGHT_MODULE to an installed module');
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const log=fs.openSync(path.join(evidence,'fixture.stderr'),'wx',0o600);
const fixture=spawn(process.execPath,['services/oauth/test/helpers/console-functional-preview.mjs'],{cwd:root,stdio:['pipe','pipe',log]});
const queue=[],waiters=[],checks=[];
createInterface({input:fixture.stdout}).on('line',line=>{if(!line.startsWith('{'))return;const value=JSON.parse(line);if(waiters.length)waiters.shift()(value);else queue.push(value);});
const read=async()=>{let timer;try{return await Promise.race([queue.length?Promise.resolve(queue.shift()):new Promise(r=>waiters.push(r)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Synthetic fixture timeout')),30000);})]);}finally{clearTimeout(timer);}};
const command=async(command,extra={})=>{fixture.stdin.write(JSON.stringify({command,...extra})+'\n');const reply=await read();assert.ok(!reply.fixture_error,reply.fixture_error);return reply;};
const check=(name,condition=true)=>{assert.ok(condition,name);checks.push(name);console.log('PASS '+name);};
let browser;
try{
 const cfg=await read();assert.equal(cfg.fixture,true);
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:1440,height:1080}});
 await context.addCookies([{name:cfg.cookie,value:cfg.accounts[0].token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);
 const page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 page.on('console',msg=>{if(msg.type()==='error'&&/Content Security Policy|Refused/.test(msg.text()))errors.push(msg.text());});
 const goto=async()=>{await page.goto(cfg.url+'/app/connections');await page.locator('[data-agents-root]').waitFor();};
 const inventory=async q=>page.evaluate(async q=>{const r=await fetch('/console-api/connections?'+new URLSearchParams(q||{}));if(!r.ok)throw new Error('Synthetic inventory unavailable');return r.json();},q);
 const pick=async(selector,value)=>{const native=page.locator(selector),trigger=native.locator('..').locator('> .select-trigger');
  if(await trigger.count()){const index=await native.evaluate((select,value)=>[...select.options].findIndex(o=>o.value===value),value);assert.ok(index>=0);await trigger.click();await page.locator('#'+await trigger.getAttribute('aria-controls')).locator(`[data-index="${index}"]`).click();}
  else await native.selectOption(value);assert.equal(await native.inputValue(),value);};
 const dialog=page.locator('.agent-dialog'),submit=async()=>{const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/console-api/action'&&r.request().method()==='POST');await dialog.locator('button[type=submit]').click();return response;};
 const row=id=>page.locator('.agents-table tbody tr').filter({has:page.locator(`[data-id="${id}"]`)});
 const filters=async(section,search='')=>{await pick('#connection-filters [name=section]',section);await page.locator('#connection-filters [name=search]').fill(search);
  const loaded=page.waitForResponse(r=>{const url=new URL(r.url());return url.pathname==='/console-api/connections'&&url.searchParams.get('section')===section&&url.searchParams.get('search')===search;});
  await page.locator('#connection-filters button[type=submit]').click();await loaded;await page.locator('[data-agents-root]').waitFor();};
 const proof=async value=>{await dialog.locator('[name=current_password]').fill(value??cfg.password);};

 await goto();const before=await inventory({section:'active'}),grant=before.legacy_connections[0]?.grants[0];assert.ok(grant);
 await page.locator(`[data-agent-row="oauth.revoke"][data-id="${grant.grant_id}"]`).click();
 check('Legacy revoke dialog requests confirmation without an unsupported password field',await dialog.locator('[name=current_password]').count()===0);
 const revoked=await submit();assert.equal(revoked.status(),200);assert.equal((await revoked.json()).status,'revoked');
 await dialog.waitFor({state:'hidden'});await page.locator(`[data-agent-row="oauth.revoke"][data-id="${grant.grant_id}"]`).waitFor({state:'detached'});
 check('Legacy revoke succeeds through the real BFF and disappears from the current inventory',!(await inventory({})).legacy_connections.flatMap(c=>c.grants).some(g=>g.grant_id===grant.grant_id));

 assert.equal((await command('seed-agent-connections')).count,21);await goto();
 const first=await inventory({section:'active'});assert.equal(first.connections.length,20);assert.equal(first.next_offset,20);
 check('First page exposes a reachable next-page control',await page.locator('[data-connection-page="20"]').isVisible());
 await page.locator('[data-connection-page="20"]').click();await page.locator('[data-connection-page="0"]').waitFor();
 const second=await inventory({section:'active',offset:20});assert.equal(second.connections.length,1);
 check('The twenty-first connection is rendered on page two',await row(second.connections[0].connection_id).count()===1&&await page.locator('[data-agent-row="connections.rotate"]').count()===1);
 await filters('active',first.connections[0].label);await row(first.connections[0].connection_id).waitFor();
 check('Changing the filter resets the offset and finds a first-page connection',await page.locator('[data-agent-row="connections.rotate"]').count()===1&&await page.locator('[data-connection-page]').count()===0);

 assert.equal((await command('expire-agent-connections')).expired,21);await goto();
 check('An all-expired inventory still offers the history selector',await page.locator('[data-agent-row="connections.rotate"]').count()===0&&await page.locator('#connection-filters [name=section] option[value=history]').count()===1);
 await filters('history');await page.locator('[data-agent-row="connections.rotate"]').first().waitFor();
 const historical=await inventory({section:'history'}),target=historical.connections[0];assert.equal(historical.total,21);
 await row(target.connection_id).locator('[data-agent-row="connections.rotate"]').click();await proof('Wrong synthetic password');
 const denied=await submit();assert.equal(denied.status(),403);await dialog.locator('.agent-error:not([hidden])').waitFor();
 check('Failed reauthentication preserves expired inventory and shows a recoverable error',(await inventory({section:'history'})).total===21);
 await proof();const rotated=await submit();assert.equal(rotated.status(),200);await dialog.locator('pre code').waitFor();
 check('An expired token can be rotated through the history table',(await inventory({section:'active'})).connections.some(c=>c.connection_id===target.connection_id));
 await dialog.locator('[data-close]').last().click();await dialog.waitFor({state:'hidden'});
 const remove=(await inventory({section:'history'})).connections[0];
 await row(remove.connection_id).locator('[data-agent-row="connections.revoke"]').click();await proof();assert.equal((await submit()).status(),200);await dialog.waitFor({state:'hidden'});
 await page.locator(`[data-agent-row="connections.revoke"][data-id="${remove.connection_id}"]`).waitFor({state:'detached'});
 // A revoked row stays visible by label, but has no actionable identifier/button.
 const revokedRow=page.locator('.agents-table tbody tr').filter({hasText:remove.label});await revokedRow.waitFor();
 check('Revoked history is visible without mutation controls',await revokedRow.locator('[data-agent-row]').count()===0&&await revokedRow.innerText().then(text=>text.includes('已撤销')));
 await page.locator('[data-agent-pick="other"]').click();await page.locator('[data-agent-generate="other:mcp"]').click();
 await dialog.locator('[name=label]').fill('Synthetic replacement after expiry');await proof();const replacement=await submit();assert.equal(replacement.status(),200);await dialog.waitFor({state:'hidden'});
 check('Revoking an expired token frees a slot for a new connection',(await inventory({section:'active'})).connections.some(c=>c.label==='Synthetic replacement after expiry'));
 await goto();await filters('history');await page.screenshot({path:path.join(evidence,'expired-history.png'),fullPage:true});

 await page.locator('[data-agent-pick="codex"]').click();await page.locator('[data-agent-method="codex:plugin"]').click();await page.locator('[data-agent-generate="codex:plugin"]').click();
 check('Codex plugin setup explicitly names its task creation and continuation grant',await dialog.locator('[name=access]').inputValue()==='continuity'&&await dialog.locator('[name=access] option[value=continuity]').textContent().then(text=>text.includes('创建与接续任务')));
 await dialog.locator('[name=label]').fill('Synthetic Codex continuity');await dialog.locator('[name=device]').fill('synthetic-codex-browser');await proof();
 const registered=await submit();assert.equal(registered.status(),200);await dialog.waitFor({state:'hidden'});
 const credential=(await inventory({})).core_connections.find(c=>c.label==='Synthetic Codex continuity');assert.ok(credential);
 const expected=['memory:read','memory:write','capture:write','resume:read','resume:confirm','task:bootstrap:preview','task:bootstrap:confirm','project:bootstrap:preview','project:bootstrap:confirm'];
 check('The UI-created Codex credential has precisely the intended memory, capture and continuity scopes',JSON.stringify([...credential.scopes].sort())===JSON.stringify(expected.sort()));
 await goto();await page.screenshot({path:path.join(evidence,'codex-current-connections.png'),fullPage:true});
 const other=await browser.newContext();await other.addCookies([{name:cfg.cookie,value:cfg.accounts[1].token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);
 const otherPage=await other.newPage();await otherPage.goto(cfg.url+'/app/connections');await otherPage.locator('[data-agents-root]').waitFor();
 check('A different account never sees the new connections or Codex credential',!(await otherPage.innerText('body')).includes('Synthetic recovery')&&!(await otherPage.innerText('body')).includes('Synthetic Codex continuity'));await other.close();
 check('No browser JavaScript or CSP errors',errors.length===0);
 fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({status:'passed',checks,count:checks.length,node:process.version,production_data_used:false,external_client_acceptance:false},null,2),{mode:0o600});
 console.log(JSON.stringify({status:'passed',checks:checks.length,evidence}));
}catch(error){fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({status:'failed',checks,error:error.stack},null,2),{mode:0o600});console.error(JSON.stringify({status:'failed',checks:checks.length,evidence,error:error.message}));process.exitCode=1;}
finally{
 await browser?.close();fixture.stdin.end('{"command":"stop"}\n');const timer=setTimeout(()=>fixture.kill('SIGTERM'),5000);await new Promise(r=>fixture.once('exit',r));clearTimeout(timer);fs.closeSync(log);
 assert.ok(fs.readFileSync(path.join(evidence,'fixture.stderr'),'utf8').includes('"synthetic_cleanup_complete":true'),'Synthetic fixture cleanup must be verified');
}
