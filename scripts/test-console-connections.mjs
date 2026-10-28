// Real browser acceptance against disposable loopback Core/OAuth/BFF services.
// Use an already installed Playwright module; do not install packages or touch production.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';

const root=path.resolve(import.meta.dirname,'..');
const base=path.resolve(process.env.MNEMURON_UI_EVIDENCE||os.tmpdir());
assert.ok(fs.existsSync(base)&&!base.startsWith(root+path.sep),'Evidence must be outside the worktree');
const evidence=fs.mkdtempSync(path.join(base,'connections-browser-'));fs.chmodSync(evidence,0o700);
const module=process.env.PLAYWRIGHT_MODULE;assert.ok(module&&path.isAbsolute(module),'Set PLAYWRIGHT_MODULE to an installed module');
const {chromium}=await import(pathToFileURL(module));
const log=fs.openSync(path.join(evidence,'fixture.stderr'),'wx',0o600);
const fixture=spawn(process.execPath,['services/oauth/test/helpers/console-functional-preview.mjs'],{cwd:root,stdio:['pipe','pipe',log]});
const queue=[],waiters=[];
createInterface({input:fixture.stdout}).on('line',line=>{if(!line.startsWith('{'))return;const value=JSON.parse(line);if(waiters.length)waiters.shift()(value);else queue.push(value);});
const read=async()=>{let timer;try{return await Promise.race([queue.length?Promise.resolve(queue.shift()):new Promise(r=>waiters.push(r)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Synthetic fixture timeout')),30000);})]);}finally{clearTimeout(timer);}};
const command=async(command,extra={})=>{fixture.stdin.write(JSON.stringify({command,...extra})+'\n');const r=await read();assert.ok(!r.fixture_error,r.fixture_error);return r;};
const checks=[];const check=(name,condition=true)=>{assert.ok(condition,name);checks.push(name);console.log('PASS '+name);};
const requestTimes=[],httpStatuses={},rateLimited=[];let originRequests=0;
const traffic=()=>({requests:originRequests,recent_requests:requestTimes.filter(t=>t>Date.now()-62000).length,statuses:httpStatuses,rate_limited:rateLimited});
let browser;
try{
 const cfg=await read();assert.equal(cfg.fixture,true);
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 const origin=new URL(cfg.url).origin;
 const newContext=async options=>{const c=await browser.newContext(options);
  c.on('request',r=>{if(new URL(r.url()).origin===origin){originRequests++;requestTimes.push(Date.now());}});
  c.on('response',r=>{const url=new URL(r.url());if(url.origin!==origin)return;httpStatuses[r.status()]=(httpStatuses[r.status()]||0)+1;
   if(r.status()===429)rateLimited.push({route:url.pathname.startsWith('/console-api/')?url.pathname:'/other',status:429});});return c;};
 // CI can execute this many-page suite inside one server rate window. Keep every context below the
 // unchanged 1500/minute peer limit, leaving headroom for each flow's assets and background reads.
 const pace=async()=>{for(;;){const cutoff=Date.now()-62000;while(requestTimes.length&&requestTimes[0]<=cutoff)requestTimes.shift();if(requestTimes.length<=1000)return;
  const delay=Math.max(1,requestTimes[requestTimes.length-1000]+62000-Date.now());console.log(`PACE synthetic browser requests for ${delay}ms`);await new Promise(r=>setTimeout(r,delay));}};
 const navigate=async(p,url)=>{await pace();return p.goto(url);};
 // Model an old browser/edge cache whose palette still requires the removed theme attribute.
 const cachedContext=await newContext();let staleStyles=0;
 await cachedContext.route(url=>url.pathname==='/assets/styles.css'&&!url.search,route=>{
  staleStyles++;
  return route.fulfill({contentType:'text/css',body:'[data-theme="a"]{--bg:#F5F1E8;--text:#1C1B18;--line:#CFC6B3}body{background:var(--bg)}input{border:1px solid var(--line)}button{background:var(--text);color:var(--bg)}'});
 });
 const cachedPage=await cachedContext.newPage();await navigate(cachedPage,cfg.url+'/login');await cachedPage.locator('[name=username]').waitFor();
 const paint=await cachedPage.evaluate(()=>({bg:getComputedStyle(document.body).backgroundColor,border:getComputedStyle(document.querySelector('[name=username]')).borderTopStyle,button:getComputedStyle(document.querySelector('button[type=submit]')).backgroundColor}));
 check('Login bypasses an obsolete unversioned stylesheet cache',staleStyles===0&&paint.bg!=='rgba(0, 0, 0, 0)'&&paint.border==='solid'&&paint.button!=='rgba(0, 0, 0, 0)');
 await cachedPage.screenshot({path:path.join(evidence,'login-versioned-styles.png'),fullPage:true});await cachedContext.close();
 const context=await newContext({viewport:{width:1440,height:1080},permissions:['clipboard-read','clipboard-write']});
 await context.addCookies([{name:cfg.cookie,value:cfg.accounts[0].token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);
 const page=await context.newPage(),errors=[];let mutations=0;
 page.on('request',request=>{if(request.url().includes('/console-api/action'))mutations++;});
 page.on('pageerror',error=>errors.push(error.message));page.on('console',msg=>{if(msg.type()==='error'&&/Content Security Policy|Refused/.test(msg.text()))errors.push(msg.text());});
 const goto=async name=>{await navigate(page,cfg.url+'/app/'+name);await page.locator('#console-root h1').waitFor();await page.locator('.loading-card').waitFor({state:'detached'});};
 const pick=async(selector,value)=>{const native=page.locator(selector),index=await native.evaluate((s,v)=>[...s.options].findIndex(o=>o.value===v),value);assert.ok(index>=0);const button=native.locator('..').locator('> .select-trigger');if(await button.count()){await button.click();await page.locator('#'+await button.getAttribute('aria-controls')).locator(`[data-index="${index}"]`).click();}else await native.selectOption(value);assert.equal(await native.inputValue(),value);};
 const dialog=page.locator('#connection-dialog'),agentDialog=page.locator('.agent-dialog');
 const inventory=async()=>page.evaluate(async()=>{const r=await fetch('/console-api/connections');if(!r.ok)throw new Error('Synthetic inventory unavailable');return r.json();});
 const row=label=>page.locator('.agents-table tbody tr').filter({has:page.locator('td small',{hasText:label})});
 const openDetail=async label=>{await row(label).locator('[data-connection-detail]').click();await dialog.locator('[data-connection-refresh]').waitFor();};
 const footerCheck=async label=>{
  const back=dialog.locator('[data-connection-back]'),next=dialog.locator('button[type=submit]'),cancel=dialog.locator('form [data-connection-close]');
  await back.scrollIntoViewIfNeeded();const [b,n,c]=await Promise.all([back.boundingBox(),next.boundingBox(),cancel.boundingBox()]);
  check(label,b&&n&&c&&Math.abs(b.y-n.y)<2&&Math.abs(n.y-c.y)<2&&b.x+b.width<n.x&&n.x<c.x&&b.width<160&&Math.abs(b.height-n.height)<2);
 };
 // This private fixture command resets the reauthentication limiter between independent cases.
 // The current Console confirmation itself requires a password, not another OTP field.
 const proof=async()=>{await command('otp',{fresh:true});await dialog.locator('[name=current_password]').fill(cfg.password);};
 const submit=async()=>{await dialog.locator('button[type=submit]').click();await dialog.locator('#connection-secret').waitFor();};
 const openNew=async kind=>{await goto('connections');const agent=kind==='chatgpt_oauth'?'chatgpt':'other';await page.locator(`[data-agent-pick="${agent}"]`).click();await page.locator(`[data-agent-generate="${agent}:${agent==='chatgpt'?'connector':'mcp'}"]`).click();await agentDialog.locator('[name=label]').waitFor();};
 const basic=async(label,profile='readonly')=>{await command('otp',{fresh:true});await agentDialog.locator('[name=label]').fill(label);await pick('.agent-dialog [name=access]',profile==='memory_readwrite'?'write':'read');await agentDialog.locator('[name=current_password]').fill(cfg.password);};
 const submitNew=async({double=false}={})=>{const responded=page.waitForResponse(r=>new URL(r.url()).pathname==='/console-api/action'&&r.request().method()==='POST');await agentDialog.locator('button[type=submit]')[double?'dblclick':'click']();const response=await responded;assert.equal(response.status(),200);const result=await response.json();await agentDialog.waitFor({state:'hidden'});await page.locator('.agent-issued').waitFor();assert.ok((await page.locator('.agent-steps').innerText()).includes(result.secret),'the credential is present in the actual generated setup');assert.ok(!(await page.evaluate(()=>JSON.stringify(localStorage))).includes(result.secret),'issued credentials are not persisted');return result;};
 const cancelNew=async()=>{await agentDialog.locator('[data-close]').last().click();await agentDialog.waitFor({state:'hidden'});};
 const saveSecret=async()=>{const value=await dialog.locator('#connection-secret').inputValue();check('Secret starts masked',await dialog.locator('#connection-secret').getAttribute('type')==='password');check('Secret never appears in persistent appearance storage',!(await page.evaluate(()=>JSON.stringify(localStorage))).includes(value));await dialog.locator('[data-connection-secret-saved]').click();await dialog.locator('[data-connection-refresh]').waitFor();await command('provision-connections');await dialog.locator('[data-connection-refresh]').click();await dialog.locator('[data-connection-refresh]').waitFor();return value;};
 const close=async()=>{await dialog.locator('[data-connection-close]').first().click();await dialog.waitFor({state:'hidden'});check('Closing clears the credential DOM',await page.locator('#connection-secret').count()===0);};
 const guardShortcut=async(label,locator,ownerDialog=dialog)=>{
  const url=page.url(),value=await locator.inputValue(),before=mutations;
  for(const key of ['Meta+k','Control+k']){
   await locator.focus();await page.keyboard.press(key);
   await page.waitForTimeout(200);
   check(`${label} survives ${key}`,page.url()===url&&await ownerDialog.isVisible()&&await locator.inputValue()===value&&mutations===before);
  }
 };
 const viewMutations=mutations;await goto('connections');check('Real empty logical list retains legacy authorization separately',await page.locator('.agents-table [data-connection-detail]').count()===0&&await page.locator('[data-agent-row="oauth.revoke"]').count()>0);
 const existingAuthorized=Number(await page.locator('.connection-stat').first().locator('strong').innerText());
 // The pre-existing synthetic ChatGPT authorization: visible, unchanged by viewing, and compared again at the end.
 const gptState=async()=>({grants:(await inventory()).legacy_connections.flatMap(c=>c.grants).map(g=>g.grant_id).sort(),revokes:await page.locator('[data-agent-row="oauth.revoke"]').count()});
 const gptBefore=await gptState();
 check('Existing ChatGPT authorization is shown as authorized with its grants',gptBefore.grants.length>=1&&gptBefore.revokes===gptBefore.grants.length&&await page.locator('.agents-table tr').filter({has:page.locator('[data-agent-row="oauth.revoke"]')}).innerText().then(v=>v.includes('已授权')));
 check('Viewing connections sends no write request',mutations===viewMutations);
 // Header: the account caret is drawn like the language chevron, same size and vertical centre.
 const chevrons=await page.evaluate(()=>{const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return {w:r.width,h:r.height,cy:r.top+r.height/2}};const style=s=>{const c=getComputedStyle(document.querySelector(s));return [c.borderRightWidth,c.borderBottomWidth,c.transform].join('|')};
  return {account:box('.account-chevron'),language:box('.language-control .select-chevron'),accountButton:box('.account-menu>summary'),accountStyle:style('.account-chevron'),languageStyle:style('.language-control .select-chevron'),glyph:/[⌄∨▾]/.test(document.querySelector('.account-menu>summary').textContent)};});
 console.log('Header chevron geometry '+JSON.stringify(chevrons));
 check('Account caret matches the language chevron size, stroke and rotation',!chevrons.glyph&&chevrons.accountStyle===chevrons.languageStyle&&Math.abs(chevrons.account.w-chevrons.language.w)<0.5&&Math.abs(chevrons.account.h-chevrons.language.h)<0.5);
 // Only the lower "V" of the rotated square is drawn, so its optical centre is a quarter-height below the box centre.
 check('Account and language chevrons share one vertical centre, and the drawn V is centred in the account button',Math.abs(chevrons.account.cy-chevrons.language.cy)<=1&&Math.abs(chevrons.account.cy+chevrons.account.h/4-chevrons.accountButton.cy)<=1);
 await page.locator('.account-menu>summary').click();check('Open account menu rotates the caret and shows the panel',await page.locator('.account-menu-panel').isVisible()&&(await page.locator('.account-chevron').evaluate(el=>getComputedStyle(el).transform))!==chevrons.accountStyle.split('|')[2]);
 await page.locator('.account-menu>summary').click();
 await page.locator('.topbar').screenshot({path:path.join(evidence,'header-account-caret.png')});
 await page.screenshot({path:path.join(evidence,'connections-desktop-zh-CN.png'),fullPage:true});
 await openNew('generic_mcp');await basic('Synthetic portable reader','memory_readwrite');
 await guardShortcut('Connection draft',agentDialog.locator('[name=label]'),agentDialog);
 const beforeAppearance=mutations;
 // Exercise the real preference event handler while the modal owns focus.
 for(const [id,value] of [['locale','en'],['locale','zh-CN']])await page.locator('#'+id).evaluate((select,value)=>{select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));},value);
 check('Language changes preserve draft values without a mutation request',mutations===beforeAppearance&&await agentDialog.locator('[name=label]').inputValue()==='Synthetic portable reader'&&await agentDialog.locator('[name=access]').inputValue()==='write');
 const generated=await submitNew();check('Agent generation returns a personal resource token, never a Core key',generated.secret.startsWith('mcp_pat_'));
 await command('provision-connections');await goto('connections');await openDetail('Synthetic portable reader');await dialog.locator('[data-connection-action=update]').click();
 await footerCheck('Back/Confirm/Cancel share one footer, with compact Back on the left');await pick('#connection-dialog [name=profile]','readonly');check('Readonly profile cannot select a write-time disclosure grant',await dialog.locator('[name=allow_submitted_revision_grant]').isDisabled());await pick('#connection-dialog [name=profile]','memory_readwrite');
 const trigger=dialog.locator('[data-select-name=profile]');await trigger.click();await page.keyboard.press('Escape');check('Escape closes the top-layer selector before the dialog',await dialog.isVisible()&&await page.locator('.select-popup:popover-open').count()===0);
 await dialog.locator('[name=allow_submitted_revision_grant]').check();await proof();await submit();
 await guardShortcut('Unsaved credential',dialog.locator('#connection-secret'));
 const first=await saveSecret();check('Generic credential is a personal resource token, never a Core key',first.startsWith('mcp_pat_'));check('Server configuration is not fabricated connection success',!(await dialog.innerText()).includes('记忆调用已验证'));await close();
 await openDetail('Synthetic portable reader');await dialog.locator('[data-connection-action=rotate]').click();await proof();await submit();const second=await saveSecret();check('Rotation generates a different actual credential',second!==first);await close();
 await openNew('chatgpt_oauth');await basic('Synthetic browser ChatGPT');
 // A failed metadata read must not lose the one-time secret or silently invent endpoints.
 const guideMatch=url=>url.pathname==='/console-api/connections'&&url.searchParams.has('connection_id');
 await page.route(guideMatch,route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error_code:'TEMPORARILY_UNAVAILABLE'})}),{times:1});
 const chatgpt=await submitNew();await page.locator('[data-i18n=agentsGuideUnavailable]').waitFor();
 const issuedSecret=chatgpt.secret;check('Guide failure retains the issued credential without inventing scopes or discovery',!!issuedSecret&&!(await page.locator('.agent-steps .agent-step').nth(2).locator('code').innerText()).includes('openid')&&!(await page.locator('.agent-steps .agent-step').nth(3).locator('code').innerText()).includes('/.well-known/'));
 let beforeGuide=mutations;await page.locator('.agent-steps [data-connection-detail]').click();await dialog.locator('[data-connection-copy=url]').waitFor();
 check('Guide retry does not create another connection or rotate the credential',mutations===beforeGuide&&(await page.locator('.agent-steps').innerText()).includes(issuedSecret));
 await dialog.locator('[data-connection-copy=scopes]').click();await page.waitForFunction(async()=>await navigator.clipboard.readText()==='openid offline_access memory:read');check('Copied OAuth scopes include refresh support without adding write permission');
 await dialog.locator('[data-connection-copy=client_id]').click();await page.waitForFunction(async()=>(await navigator.clipboard.readText()).startsWith('mnmc_'));check('Client ID copy matches actual registry value');
 check('Connection-specific OIDC URL is visible without expanding technical details',await dialog.locator('[data-connection-copy=discovery_url]').isVisible());
 await dialog.locator('[data-connection-copy=discovery_url]').click();await page.waitForFunction(async()=>(await navigator.clipboard.readText()).includes('/.well-known/openid-configuration?client_id='));const scopedUrl=await page.evaluate(()=>navigator.clipboard.readText());check('Copied discovery URL keeps the public client selector',new URL(scopedUrl).searchParams.get('client_id')?.startsWith('mnmc_'));
 await command('provision-connections');const discovered=await page.evaluate(async url=>(await fetch(url)).json(),scopedUrl);check('Readonly connection discovers only allowed scopes',JSON.stringify(discovered.scopes_supported)===JSON.stringify(['openid','offline_access','memory:read']));
 await dialog.locator('.plugin-advanced summary').click();check('Advanced setup exposes discovered endpoints and exact resource',await dialog.locator('[data-connection-copy=authorization_url]').isVisible()&&await dialog.locator('[data-connection-copy=resource]').isVisible());
 const iconEvent=page.waitForEvent('download');await dialog.locator('[data-connection-icon]').click();const icon=await iconEvent,iconFile=path.join(evidence,'synthetic-plugin-icon.png');await icon.saveAs(iconFile);const png=fs.readFileSync(iconFile);
 check('Plugin icon is a real local PNG within the form size limit',png.subarray(1,4).toString()==='PNG'&&png.readUInt32BE(16)===512&&png.length<=10240);
 check('OAuth Client Secret is distinct from a generic token',!issuedSecret.startsWith('mcp_pat_')&&!issuedSecret.startsWith('mnm_'));await close();await goto('connections');await openDetail('Synthetic browser ChatGPT');await page.screenshot({path:path.join(evidence,'chatgpt-plugin-setup.png'),animations:'disabled'});
 check('Creating with the exact callback avoids a second configuration round',await dialog.locator('.plugin-status').getAttribute('data-status')==='connStatus_ready');
 await command('connection-evidence',{label:'Synthetic browser ChatGPT',state:'authorized'});
 await dialog.locator('.plugin-status[data-status=connStatus_authorized]').waitFor({timeout:10000});check('Bounded polling reflects persisted consent without claiming a tool call');
 await command('connection-evidence',{label:'Synthetic browser ChatGPT',state:'verified'});
 await dialog.locator('.plugin-status[data-status=connStatus_verified]').waitFor({timeout:10000});check('Polling reflects persisted successful-call evidence');
 await command('connection-evidence',{label:'Synthetic browser ChatGPT',state:'revoked'});
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await dialog.locator('.plugin-status[data-status=connStatus_ready]').waitFor();check('Returning to the guide detects revoked consent despite historical success');await close();
 await goto('connections');
 const pendingRow=row('Synthetic browser ChatGPT');
 check('Saved OAuth configuration without current consent is shown as awaiting authorization',await pendingRow.locator('[data-i18n=connNotAuthorized]').count()===1);
 const counted=await page.evaluate(async()=>{const response=await fetch('/console-api/connections');if(!response.ok)throw new Error('Synthetic inventory unavailable');return (await response.json()).authorization_counts;});
 check('Personal inventory counts only the usable generic credential, with OAuth authorization pending',counted.usable===1&&counted.pending===1);
 check('Summary adds the usable credential to existing legacy and agent authorizations, not the pending OAuth configuration',Number(await page.locator('.connection-stat').first().locator('strong').innerText())===existingAuthorized+1&&await page.locator('.connection-stat').last().locator('strong').innerText()==='1');
 await openDetail('Synthetic browser ChatGPT');await dialog.locator('[data-connection-action=update]').click();await dialog.locator('[name=redirect_uri]').fill('https://chatgpt.com/connector_platform_oauth_redirect');await proof();await dialog.locator('button[type=submit]').click();await dialog.locator('[data-connection-refresh]').waitFor();await command('provision-connections');await dialog.locator('[data-connection-refresh]').click();await dialog.locator('[data-connection-refresh]').waitFor();check('Exact callback persisted through real BFF',await dialog.innerText().then(v=>v.includes('https://chatgpt.com/connector_platform_oauth_redirect')));await close();
 check('Main rows represent two logical connections, not keys or grants',await page.locator('.agents-table tbody tr:has([data-connection-detail])').count()===2);
 await openDetail('Synthetic browser ChatGPT');await dialog.locator('[data-connection-action=update]').click();await dialog.locator('[name=profile]').selectOption('memory_readwrite');await proof();await dialog.locator('button[type=submit]').click();await dialog.locator('[data-connection-refresh]').waitFor();await command('provision-connections');await dialog.locator('[data-connection-refresh]').click();await dialog.locator('[data-i18n=connWriteConsentCheck]').waitFor();
 const setupData=await page.evaluate(async()=>{const list=await fetch('/console-api/connections').then(r=>r.json()),c=list.connections.find(c=>c.label==='Synthetic browser ChatGPT');return fetch('/console-api/connections?connection_id='+c.connection_id).then(r=>r.json());});
 const writable=await page.evaluate(async url=>(await fetch(url)).json(),setupData.guide.discovery_url);check('Read/write guide discovers memory:write without project scope',JSON.stringify(writable.scopes_supported)===JSON.stringify(['openid','offline_access','memory:read','memory:write']));
 await dialog.locator('[data-connection-copy=scopes]').click();await page.waitForFunction(async()=>(await navigator.clipboard.readText())==='openid offline_access memory:read memory:write');check('Read/write Base scopes copy includes actual requested write permission');
 await page.screenshot({path:path.join(evidence,'chatgpt-readwrite-guide.png'),fullPage:true});await close();
 for(const writing of [true,false]){
  const authPage=await page.context().newPage(),verifier=randomBytes(32).toString('base64url');
  const scopes=writable.scopes_supported.filter(s=>writing||s!=='memory:write');
  const authUrl=setupData.guide.authorization_url+'?'+new URLSearchParams({client_id:setupData.connection.client_id,redirect_uri:setupData.connection.redirect_uri,response_type:'code',scope:scopes.join(' '),resource:setupData.guide.resource,state:randomBytes(24).toString('base64url'),code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')});
  await navigate(authPage,authUrl);
  if(await authPage.locator('[name=username]').count()){
   await authPage.locator('[name=username]').fill(cfg.accounts[0].username);await authPage.locator('[name=password]').fill(cfg.password);await authPage.locator('[name=otp]').fill((await command('otp',{fresh:true})).otp);await authPage.locator('form[action$="/login"] button[type=submit]').click();
  }
  await authPage.locator('form[action$="/confirm"]').waitFor();
  check(writing?'Actual consent offers memory read/write':'Underscoped request warns instead of silently gaining writes',writing?await authPage.locator('form [data-i18n=allowMemoryWrite]').count()===1:await authPage.locator('[role=alert] [data-i18n=oauthWriteNotRequested]').count()===1&&await authPage.locator('form [data-i18n=allowMemoryWrite]').count()===0);
  await authPage.screenshot({path:path.join(evidence,writing?'oauth-readwrite-consent.png':'oauth-underscoped-warning.png'),fullPage:true});await authPage.close();
 }
 await page.locator('#connection-filters [name=search]').fill('portable');await page.locator('#connection-filters button[type=submit]').click();await row('Synthetic browser ChatGPT').waitFor({state:'detached'});check('Backend filter returns one logical connection',await page.locator('.agents-table tbody tr:has([data-connection-detail])').count()===1);await page.locator('[data-connection-reset]').click();await row('Synthetic browser ChatGPT').waitFor();
 // Back from a destructive confirmation returns to the unchanged connection without any request.
 await openDetail('Synthetic portable reader');
 check('Managing an existing connection is titled as such, not as adding one',await dialog.locator('#connection-title [data-i18n=connManageTitle]').count()===1);
 check('Routine actions and disable/revoke are in separate groups',await dialog.locator('.connection-danger [data-connection-action=revoke]').count()===1&&await dialog.locator('.connection-danger [data-connection-action=rotate]').count()===0&&await dialog.locator('.connection-danger [data-connection-action=disable]').count()===1);
 let held=mutations;await dialog.locator('[data-connection-action=revoke]').click();await proof();await dialog.locator('[data-connection-back=detail]').click();await dialog.locator('[data-connection-refresh]').waitFor();
 check('Back from revoke keeps the connection and sends nothing',mutations===held&&await dialog.locator('.connection-chips [data-state=ready]').count()===1&&await dialog.locator('[name=current_password]').count()===0);
 await close();
 for(const action of ['disable','enable','revoke']){
  await openDetail('Synthetic portable reader');await dialog.locator(`[data-connection-action=${action}]`).click();
  if(action!=='enable'){check(`${action} confirmation states the consequence and uses an explicit red button`,await dialog.locator('.connection-warning').isVisible()&&await dialog.locator(`button.danger[type=submit] [data-i18n=connConfirm_${action}]`).count()===1);if(action==='revoke')await dialog.screenshot({path:path.join(evidence,'revoke-confirmation.png'),animations:'disabled'});}
  await proof();await dialog.locator('button[type=submit]').click();
  if(action==='enable'){await dialog.locator('#connection-secret').waitFor();await saveSecret();}else await dialog.locator('[data-connection-refresh]').waitFor();await close();check('Real connection lifecycle '+action);
 }
 await pick('#connection-filters [name=section]','history');await page.locator('#connection-filters button[type=submit]').click();await row('Synthetic portable reader').waitFor();check('Revoked record moves to history, preserving the logical record');
 await page.locator('[data-connection-reset]').click();await row('Synthetic browser ChatGPT').waitFor();
 const bContext=await newContext();await bContext.addCookies([{name:cfg.cookie,value:cfg.accounts[1].token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);const bp=await bContext.newPage();await navigate(bp,cfg.url+'/app/connections');await bp.locator('[data-agents-root]').waitFor();check('Second account does not see first account connection names',!(await bp.innerText('body')).includes('Synthetic browser ChatGPT'));await bContext.close();
 // Current Agent issuance has one form. Cancel and repeated submits still must not mutate twice.
 held=mutations;await openNew('generic_mcp');await basic('Synthetic cancelled draft');
 check('The selected Agent opens one credential form',await page.locator('.agent-dialog[open]').count()===1&&await agentDialog.locator('[name=label]').count()===1);await cancelNew();check('Cancelled Agent draft sends nothing',mutations===held);
 await openNew('generic_mcp');await basic('Synthetic double submit');held=mutations;await submitNew({double:true});
 check('Double-clicking Generate creates exactly one credential',mutations===held+1&&(await inventory()).connections.filter(c=>c.label==='Synthetic double submit').length===1);
 // Lose an actual committed response, then retry the same visible form.
 await openNew('generic_mcp');await basic('Synthetic lost create response');let committed,firstOperation;
 await page.route('**/console-api/action',async route=>{firstOperation=new URLSearchParams(route.request().postData()).get('operation_id');const response=await route.fetch();assert.equal(response.status(),200);committed=await response.json();await route.abort('failed');},{times:1});
 await agentDialog.locator('button[type=submit]').click();await agentDialog.locator('.agent-error:not([hidden])').waitFor();
 const recovered=await submitNew();check('A committed response loss replays the same operation and credential',recovered.replayed===true&&recovered.operation_id===firstOperation&&recovered.secret===committed.secret&&(await inventory()).connections.filter(c=>c.label==='Synthetic lost create response').length===1);
 // Exercise the real app.load path: a 503 must not replace the issued credential with a page error.
 await openNew('generic_mcp');await basic('Synthetic refresh failure');
 await page.route(url=>url.pathname==='/console-api/connections'&&!url.searchParams.has('connection_id'),route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error_code:'TEMPORARILY_UNAVAILABLE'})}),{times:1});
 const refreshResult=await submitNew();await page.locator('[data-i18n=agentsRefreshUnavailable]').waitFor();
 check('Inventory HTTP 503 leaves the committed credential visible with a refresh warning',(await page.locator('.agent-steps').innerText()).includes(refreshResult.secret)&&await page.locator('[data-agents-root]').count()===1&&(await inventory()).connections.filter(c=>c.label==='Synthetic refresh failure').length===1);
 await goto('connections');
 // Narrow layout: no page overflow, readable dialog, both languages.
 for(const locale of ['zh-CN','en']){
  await page.setViewportSize({width:390,height:844});await goto('connections');await pick('#locale',locale);
  check(`Narrow connections page ${locale} has no horizontal overflow`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(evidence,`connections-narrow-${locale}.png`),fullPage:true});
  await openDetail('Synthetic browser ChatGPT');await dialog.locator('[data-connection-copy=url]').waitFor();
  check(`Narrow ChatGPT detail ${locale} shows the same state as its list row`,await dialog.locator('.connection-chips [data-state=review_required] [data-i18n=connAwaitingAuthorization]').count()===1);
  check(`Narrow ChatGPT detail ${locale} fits the dialog`,await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)&&await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(evidence,`connection-detail-narrow-${locale}.png`),animations:'disabled'});await close();
 }
 await page.setViewportSize({width:1440,height:1080});await goto('connections');await pick('#locale','zh-CN');
 for(const width of [1280,1440,1920]){
  await page.setViewportSize({width,height:1080});
  for(const locale of ['zh-CN','en']){
   await pick('#locale',locale);await openNew('generic_mcp');await agentDialog.locator('[name=label]').fill('Synthetic long connection label / 合成名称 / '+'.'.repeat(24));
   check(`Desktop ${width}/${locale}`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)&&await agentDialog.locator('[name=label]').inputValue().then(s=>s.startsWith('Synthetic'))&&await agentDialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
   if(width===1440)await page.screenshot({path:path.join(evidence,`agent-setup-${locale}.png`),fullPage:true});
   await cancelNew();
   await openDetail('Synthetic browser ChatGPT');await dialog.locator('[data-connection-copy=url]').waitFor();
   check(`ChatGPT setup ${width}/${locale}`,await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)&&await dialog.locator('[data-connection-copy=callback]').isVisible());
   if(width===1440)await page.screenshot({path:path.join(evidence,`chatgpt-guide-${locale}.png`),animations:'disabled'});await close();
  }
 }
 await pick('#locale','en');await goto('memories');check('Language persists through real navigation',await page.locator('html').getAttribute('lang')==='en');await pick('#locale','zh-CN');
 for(const name of ['overview','memories','summaries','entities','jobs','connections','agents','tasks','models','storage','usage','audit','security','system','resume']){await goto(name);check('Existing console route '+name,await page.locator('#console-root [role=alert]').count()===0);}
 const operationDialog=page.locator('#operation-dialog');
 const begin=async action=>{await page.locator(`[data-console-action="${action}"]`).first().click();await operationDialog.locator('form').waitFor();};
 const runOperation=async()=>{await operationDialog.locator('button[type=submit]').click();await operationDialog.locator('.operation-result').first().waitFor({state:'attached'});return JSON.parse(await operationDialog.locator('.operation-result').last().textContent());};
 const closeOperation=async()=>{await operationDialog.locator('[data-operation-close]').first().click();await operationDialog.waitFor({state:'hidden'});};
 await goto('memories');await begin('memory.create');await operationDialog.locator('[name=content]').fill('Synthetic browser regression: blue paper boat.');await pick('#operation-dialog [name=kind]','pattern');const created=await runOperation();check('Existing memory create persists',created.status==='saved');await closeOperation();
 check('The writer-selected memory type persists through the actual metadata API',(await page.evaluate(async id=>(await fetch('/console-api/memory-meta?memory_id='+encodeURIComponent(id),{credentials:'same-origin'})).json(),created.memory_id)).kind==='pattern');
 await page.locator(`[data-memory="${created.memory_id}"]`).click();await page.locator('#memory-dialog .detail-facts').waitFor();check('Per-memory ChatGPT visibility is no longer offered',await page.locator('#memory-dialog [data-console-action="memory.visibility"]').count()===0);
 await page.locator(`[data-memory="${created.memory_id}"]`).click();await begin('memory.correct');await operationDialog.locator('[name=content]').fill('Synthetic browser regression: amber paper boat.');const corrected=await runOperation();check('Existing correction preserves the earlier record',corrected.memory_id!==created.memory_id);await closeOperation();
 await page.locator(`[data-memory="${corrected.memory_id}"]`).click();await begin('memory.retract');check('Existing retract does not physically delete',(await runOperation()).physically_deleted===false);await closeOperation();
 await goto('models');await begin('models.save');await operationDialog.locator('[name=enabled]').check();await operationDialog.locator('[name=base_url]').fill(cfg.model_url);await operationDialog.locator('[name=model]').fill('synthetic-organizer');await operationDialog.locator('[name=egress_approved]').check();check('Existing model settings persist without calling any paid model',(await runOperation()).model.config.model==='synthetic-organizer');await closeOperation();
 await begin('models.test');const modelCheck=await runOperation();check('Existing model diagnostic uses only loopback synthetic data',modelCheck.real_memory_sent===false&&modelCheck.status==='verified');await closeOperation();
 await goto('jobs');await begin('jobs.schedule');await pick('#operation-dialog [name=periods]','daily');await operationDialog.locator('[name=include_open]').check();const daily=await runOperation();check('Daily summaries durably queue',daily.jobs.length>0);await closeOperation();await command('tick',{job_ids:daily.jobs});
 await begin('jobs.schedule');await pick('#operation-dialog [name=periods]','weekly');await operationDialog.locator('[name=include_open]').check();const weekly=await runOperation();check('Weekly summaries durably queue',weekly.jobs.length>0);await closeOperation();await command('tick',{job_ids:weekly.jobs});await goto('summaries');await page.locator('[data-summary]').first().waitFor();check('Existing source-grounded summaries display actual worker output');
 await goto('storage');await begin('storage.export');const downloading=page.waitForEvent('download');await runOperation();const download=await downloading,destination=path.join(evidence,'synthetic-personal-export.json');await download.saveAs(destination);const exported=fs.readFileSync(destination,'utf8');check('Existing export remains account-isolated without credentials',JSON.parse(exported).records.length>0&&!exported.includes('Synthetic private B sentinel')&&!exported.includes('api_key'));await closeOperation();
 await begin('storage.import');await operationDialog.locator('[name=file]').setInputFiles(destination);await operationDialog.locator('[name=confirm_import]').check();const imported=await runOperation();check('Existing import preserves original records',imported.originals_overwritten===false&&imported.created>0);await closeOperation();
 // Invitation codes are issued by the operator CLI now (the web page was removed); the fixture issues one the same way.
 const invite=(await command('invitation')).codes[0];check('Synthetic invitation is issued outside the web Console',typeof invite==='string'&&invite.length===43);
 const registration=await newContext(),rp=await registration.newPage();await navigate(rp,cfg.url+'/register');await rp.locator('[name=code]').fill(invite);await rp.locator('button[type=submit]').click();await rp.waitForURL('**/register/account');await rp.locator('[name=username]').fill('Synthetic_Cloud_Browser_New');await rp.locator('[name=password]').fill('Synthetic new browser password');await rp.locator('[name=password_confirm]').fill('Synthetic new browser password');await rp.locator('button[type=submit]').click();await rp.waitForURL('**/register/totp');
 const {generate}=await import(pathToFileURL(path.join(root,'services/oauth/node_modules/otplib/dist/index.js')));const enrollmentSecret=await rp.locator('#totp-secret').innerText();await rp.locator('[name=otp]').fill(await generate({secret:enrollmentSecret}));await rp.locator('button[type=submit]').click();await rp.waitForURL('**/register/recovery-codes');check('Existing registration binds real synthetic TOTP',await rp.locator('.recovery-codes li').count()===8);await rp.locator('button[type=submit]').click();await rp.waitForURL('**/register/status');
 for(let i=0;i<15;i++){if(await rp.locator('code').innerText()==='active')break;await new Promise(r=>setTimeout(r,1000));await rp.reload();}check('New synthetic account activates only after provisioning',await rp.locator('code').innerText()==='active');await registration.close();
 const realLogin=await newContext(),lp=await realLogin.newPage();await navigate(lp,cfg.url+'/login');await lp.locator('[name=username]').fill(cfg.accounts[1].username);await lp.locator('[name=password]').fill(cfg.password);await lp.locator('[name=otp]').fill((await command('otp',{owner:1,fresh:true})).otp);await lp.locator('button[type=submit]').click();await lp.waitForURL('**/app');await navigate(lp,cfg.url+'/app/memories');await lp.locator('[data-memory]').first().waitFor();check('Existing real password/TOTP login isolates the second account',(await lp.innerText('body')).includes('Synthetic private B sentinel')&&!(await lp.innerText('body')).includes('蓝色纸船'));await realLogin.close();
 await goto('connections');await page.screenshot({path:path.join(evidence,'connections-final.png'),fullPage:true});
 // Rotate an existing synthetic client and close before its real guide response arrives.
 await openDetail('Synthetic browser ChatGPT');await dialog.locator('[data-connection-action=rotate]').click();await proof();
 let releaseGuide,guideStarted;const guideStart=new Promise(r=>guideStarted=r),guideGate=new Promise(r=>releaseGuide=r);
 await page.route(guideMatch,async route=>{const response=await route.fetch();guideStarted();await guideGate;await route.fulfill({response});},{times:1});
 await submit();await guideStart;page.once('dialog',prompt=>prompt.accept());await dialog.locator('[data-connection-close]').first().click();await dialog.waitFor({state:'hidden'});releaseGuide();await page.waitForTimeout(250);
 check('A late guide response cannot resurrect a closed credential dialog',!await dialog.isVisible()&&await page.locator('#connection-secret').count()===0);
 await openDetail('Synthetic browser ChatGPT');await dialog.locator('[data-connection-action=rotate]').click();await proof();
 await page.route('**/console-api/action',async route=>{const response=await route.fetch(),data=await response.json();assert.ok(data.secret);data.secret_expires_at=Date.now()/1000+2;await route.fulfill({response,json:data});},{times:1});
 await submit();await dialog.locator('#connection-secret').waitFor({state:'detached',timeout:6000});check('Credential display expires and disables reveal and copy',await dialog.locator('[data-connection-show]').count()===0||await dialog.locator('[data-connection-show]').isDisabled());await close();
 await openNew('generic_mcp');await basic('Synthetic close cleanup');await submitNew();await goto('connections');await openDetail('Synthetic close cleanup');await dialog.locator('[data-connection-action=rotate]').click();await proof();await submit();
 page.once('dialog',prompt=>prompt.dismiss());await dialog.locator('[data-connection-close]').first().click();check('Unsaved credential close requires explicit acknowledgement',await dialog.isVisible());
 page.once('dialog',prompt=>prompt.accept());await dialog.locator('[data-connection-close]').first().click();await dialog.waitFor({state:'hidden'});check('Unsaved credential is cleared after confirmed close',await page.locator('#connection-secret').count()===0);
 // A session revoked while a one-time credential is on screen. Creating a connection starts a background
 // refresh (connections + capture-status); whichever request first meets the revoked session wipes the
 // secret and goes to sign-in. Wait for those exact reads (a load-state wait returns at once on an idle
 // page), then test each order deterministically.
 const refreshAfterCreate=()=>Promise.all(['/console-api/connections?','/console-api/capture-status?'].map(part=>page.waitForResponse(r=>r.url().includes(part)).then(r=>r.finished())));
 const issueManagedSecret=async label=>{await openNew('generic_mcp');await basic(label);await submitNew();await goto('connections');await openDetail(label);await dialog.locator('[data-connection-action=rotate]').click();await proof();const refreshed=refreshAfterCreate();await submit();await refreshed;};
 // A sentinel proves the clipboard is readable and untouched; a failed read cannot pass the check.
 const sentinel='synthetic-clipboard-sentinel',setSentinel=()=>page.evaluate(v=>navigator.clipboard.writeText(v),sentinel);
 const clipboardUntouched=async()=>(await page.evaluate(()=>navigator.clipboard.readText().catch(()=>'unreadable')))===sentinel;
 const signInAgain=async()=>{const {token}=await command('cookies');await context.addCookies([{name:cfg.cookie,value:token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);await goto('connections');};
 // Order 1: Copy is the first request after revocation; a double-click must not copy or error.
 await issueManagedSecret('Synthetic logout cleanup');
 const firstSecret=await page.locator('#connection-secret').inputValue();await pace();await setSentinel();await command('revoke-console-sessions');
 const copySession=page.waitForResponse(r=>new URL(r.url()).pathname==='/console-api/me');
 await dialog.locator('[data-connection-copy-secret]').dblclick();check('Copy checks the revoked session and receives HTTP 401',(await copySession).status()===401);await page.waitForURL('**/login');
 check('A revoked login clears secrets before any copy',await page.locator('#connection-secret').count()===0);
 check('Double-clicking Copy after revocation copies nothing',await clipboardUntouched());
 await page.goBack().catch(()=>{});await page.waitForURL('**/login');
 check('Browser back after the redirect never shows the credential again',await page.locator('#connection-secret').count()===0&&!(await page.content()).includes(firstSecret));
 // Order 2: a background session check (returning to the tab) meets the revocation before any click.
 await signInAgain();await issueManagedSecret('Synthetic background revoke');
 const secondSecret=await page.locator('#connection-secret').inputValue();await pace();await setSentinel();await command('revoke-console-sessions');
 const backgroundSession=page.waitForResponse(r=>new URL(r.url()).pathname==='/console-api/me');
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));check('Background checking the revoked session receives HTTP 401',(await backgroundSession).status()===401);await page.waitForURL('**/login');
 check('A background check after revocation wipes the credential and goes to sign-in',await page.locator('#connection-secret').count()===0&&await clipboardUntouched()&&!(await page.content()).includes(secondSecret));
 // Signing in again: the connection exists, its one-time secret is never shown again; rotation is the way forward.
 await signInAgain();await openDetail('Synthetic background revoke');await dialog.locator('[data-connection-action=rotate]').waitFor();
 check('After signing in again the connection remains and its secret is not re-displayed',await dialog.locator('#connection-secret').count()===0&&!(await page.content()).includes(secondSecret));
 await goto('connections');check('The pre-existing ChatGPT authorization is unchanged after every flow',JSON.stringify(await gptState())===JSON.stringify(gptBefore));
 check('Every browser context stays within the unchanged server request limit',rateLimited.length===0);
 check('No JavaScript or CSP errors',errors.length===0);
 fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({status:'passed',checks,count:checks.length,network:traffic(),production_data_used:false,external_client_acceptance:false},null,2),{mode:0o600});console.log(JSON.stringify({status:'passed',checks:checks.length,evidence}));
}catch(error){fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({status:'failed',checks,error:error.stack,network:traffic()},null,2),{mode:0o600});console.error(JSON.stringify({status:'failed',checks:checks.length,evidence,error:error.message,network:traffic()}));process.exitCode=1;}
finally{await browser?.close();fixture.stdin.end('{"command":"stop"}\n');const timer=setTimeout(()=>fixture.kill('SIGTERM'),5000);await new Promise(r=>fixture.once('exit',r));clearTimeout(timer);fs.closeSync(log);assert.ok(fs.readFileSync(path.join(evidence,'fixture.stderr'),'utf8').includes('"synthetic_cleanup_complete":true'),'Synthetic fixture cleanup must be verified');}
