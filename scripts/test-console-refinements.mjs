// Browser acceptance for console refinements against disposable, synthetic loopback services.
// Sections: otp (six-box authenticator code on sign-in, registration, recovery and OAuth sign-in) and
// summaries (mobile layout, distinguishing facts, in-pane Back, cited-source navigation, stale replies),
// projects (editing, archive, inline context) and models (aligned cards, model-list discovery, stale replies).
//   node scripts/test-console-refinements.mjs [--section=otp,summaries]
// Needs PLAYWRIGHT_MODULE (and optionally CHROMIUM_EXECUTABLE). Screenshots and checks.json go to a new
// directory under MNEMURON_UI_EVIDENCE (outside the checkout); fixture stderr goes to a separate private
// temporary file and is never part of the evidence. Every browser context is new and isolated.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createHash,randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';

const SECTIONS=['otp','summaries','projects','models','lifecycle-search','lifecycle'];
const requested=(process.argv.find(a=>a.startsWith('--section='))?.slice(10)||SECTIONS.join(',')).split(',');
assert.ok(requested.every(s=>SECTIONS.includes(s)),`Unknown section in ${requested}`);
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
  const context=await browser.newContext({viewport,javaScriptEnabled});
  if(account!==null)await context.addCookies([{name:cfg.cookie,value:cfg.accounts[account].token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);
  if(locale!=='zh-CN')await context.addInitScript(([locale,id])=>{try{localStorage.setItem('mnemuron.appearance.v1.'+id,JSON.stringify({locale}));}catch{}},
    [locale,account===null?'signed-out':cfg.accounts[account].account_id]);
  const page=await context.newPage(),errors=[];page.setDefaultTimeout(15000);
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error'&&/Content Security Policy|Refused/.test(m.text()))errors.push(m.text());});
  return {context,page,errors};
}

// ---------------------------------------------------------------- OTP
async function otpSection() {
  const S='otp';
  // selectionchange is delivered asynchronously; read the boxes after it has been painted.
  const state=async p=>{await frame(p);return p.evaluate(()=>{const i=document.querySelector('input[data-otp]'),slots=[...document.querySelectorAll('.otp-slot')];
    return {value:i.value,start:i.selectionStart,end:i.selectionEnd,slots:slots.map(s=>s.textContent),active:slots.findIndex(s=>s.classList.contains('is-active')),
      selected:slots.flatMap((s,k)=>s.classList.contains('is-selected')?[k]:[])};});};
  const boxCenter=async(p,k)=>{const b=await p.locator('.otp-slot').nth(k).boundingBox();return {x:b.x+b.width/2,y:b.y+b.height/2};};
  const reset=async(p,value='')=>{await p.locator('input[data-otp]').fill(value);};
  const {context,page,errors}=await newPage();
  await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:cfg.url});
  await page.goto(cfg.url+'/login');
  const otp=page.locator('input[data-otp]');

  // Markup and accessibility: one named, labelled, described field; the boxes are decoration.
  const markup=await page.evaluate(()=>{const form=document.querySelector('form[action="/login"]'),i=form.querySelector('input[data-otp]');
    return {named:form.querySelectorAll('input[name*="otp"]').length,inputs:[...form.querySelectorAll('input')].map(x=>x.name),label:i.labels[0]?.textContent,
      hint:document.getElementById(i.getAttribute('aria-describedby'))?.textContent,pattern:i.pattern,required:i.required,autocomplete:i.autocomplete,inputmode:i.inputMode,
      slots:document.querySelectorAll('.otp-slots[aria-hidden="true"] .otp-slot').length,slotsFocusable:[...document.querySelectorAll('.otp-slot')].some(s=>s.tabIndex>=0)};});
  check(S,'Sign-in submits exactly one otp field (no six separate submitted fields)',markup.named===1&&markup.inputs.join()==='csrf,username,password,otp');
  check(S,'The real field keeps label, six-digit hint, pattern, required and one-time-code autofill',
    markup.label==='动态验证码'&&markup.hint.includes('6 位数字')&&markup.pattern==='[0-9]{6}'&&markup.required&&markup.autocomplete==='one-time-code'&&markup.inputmode==='numeric');
  check(S,'Six boxes are aria-hidden decoration and never take focus',markup.slots===6&&!markup.slotsFocusable);
  await shot(page,'otp-01-login-1440-zh');
  for(const name of ['username','password']){
    await page.locator('#'+name).focus();await frame(page);
    await page.evaluate(()=>Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished)));
    check(S,`${name}: focus uses the theme border and a soft halo`,await page.locator('#'+name).evaluate(e=>{const st=getComputedStyle(e);return st.borderTopColor==='rgb(174, 63, 44)'&&st.outlineStyle==='none'&&st.boxShadow!=='none'&&st.transitionDuration.includes('0.16s');}));
    await shot(page,`field-focus-${name}-1440-zh`);
  }


  // Typing, filtering and overwrite.
  await otp.click();await page.keyboard.type('123456');let s=await state(page);
  check(S,'Typing six digits fills the field and the six boxes',s.value==='123456'&&s.slots.join('')==='123456');
  await reset(page);await otp.click();await page.keyboard.type('1a2-');s=await state(page);
  check(S,'Non-digits typed into the field are ignored',s.value==='12');
  await reset(page,'123456');
  for(const k of [0,2,5]){const c=await boxCenter(page,k);await page.mouse.click(c.x,c.y);s=await state(page);
    check(S,`Clicking box ${k} puts the native caret before digit ${k} and marks that box`,s.start===k&&s.end===k&&s.active===k);}
  const c2=await boxCenter(page,2);await page.mouse.click(c2.x,c2.y);await page.keyboard.type('9');s=await state(page);
  check(S,'A digit typed on a filled box replaces that box only',s.value==='129456'&&s.start===3);
  await reset(page,'12');const c4=await boxCenter(page,4);await page.mouse.click(c4.x,c4.y);s=await state(page);
  check(S,'Clicking an empty box beyond the code puts the caret after the last digit',s.start===2&&s.active===2);

  // Native pointer drag and keyboard ranges line up with the boxes; the shown range is what an edit replaces.
  await reset(page,'123456');
  for(const [from,to,expected] of [[1,4,[1,4]],[5,2,[2,5]],[2,5,[2,5]]]){
    const a=await boxCenter(page,from),b=await boxCenter(page,to);
    await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:8});await page.mouse.up();s=await state(page);
    check(S,`Dragging from box ${from} to box ${to} selects digits ${expected[0]}–${expected[1]-1} and shows exactly those boxes`,
      s.start===expected[0]&&s.end===expected[1]&&s.selected.join()===Array.from({length:expected[1]-expected[0]},(_,k)=>k+expected[0]).join());
  }
  await shot(page,'otp-02-drag-selection-1440-zh',false);
  await page.keyboard.type('7');s=await state(page);
  check(S,'Typing over the dragged range replaces exactly the shown boxes',s.value==='1276'&&s.start===3);
  await reset(page,'123456');await otp.focus();await page.keyboard.press('End');await page.keyboard.press('Shift+ArrowLeft');await page.keyboard.press('Shift+ArrowLeft');s=await state(page);
  check(S,'Shift+ArrowLeft ranges are shown on the boxes they cover',s.start===4&&s.end===6&&s.selected.join()==='4,5');
  await page.keyboard.press('Backspace');s=await state(page);
  check(S,'Backspace removes exactly the selected boxes',s.value==='1234'&&s.start===4);
  await page.keyboard.press('Backspace');s=await state(page);
  check(S,'Backspace with a caret removes the digit before it',s.value==='123'&&s.start===3);
  await reset(page,'123456');await otp.focus();await page.keyboard.press('ControlOrMeta+a');s=await state(page);
  check(S,'Select all marks all six boxes',s.start===0&&s.end===6&&s.selected.length===6);
  await page.keyboard.type('8');s=await state(page);
  check(S,'Typing after select all replaces the whole code',s.value==='8');

  // Paste and autofill.
  const paste=async text=>{await page.evaluate(t=>navigator.clipboard.writeText(t),text);await page.keyboard.press('ControlOrMeta+v');};
  await reset(page,'123456');const c1=await boxCenter(page,1);await page.mouse.click(c1.x,c1.y);await paste('654321');s=await state(page);
  check(S,'Pasting a full code from a middle box replaces the whole code',s.value==='654321'&&s.start===6);
  await reset(page);await otp.focus();await paste(' 12 34-56 ');s=await state(page);
  check(S,'A formatted pasted code is reduced to its six digits',s.value==='123456');
  await reset(page,'1234');const c1b=await boxCenter(page,1);await page.mouse.click(c1b.x,c1b.y);await paste('78');s=await state(page);
  check(S,'A pasted fragment is inserted at the caret and the code stays six digits',s.value==='178234'&&s.start===3);
  await reset(page);await otp.focus();await paste('code');s=await state(page);
  check(S,'Pasting text without digits changes nothing',s.value==='');
  await otp.fill('987-654');s=await state(page);
  check(S,'An autofilled value (value set plus input event) is normalized to digits',s.value==='987654'&&s.slots.join('')==='987654');

  // Input method composition is left alone until it ends, then normalized (full-width digits fold).
  await reset(page);await otp.focus();const cdp=await context.newCDPSession(page);
  await cdp.send('Input.imeSetComposition',{text:'１２',selectionStart:2,selectionEnd:2});
  const composing=await otp.inputValue();
  check(S,'Provisional IME text is not erased during composition',composing==='１２');
  await cdp.send('Input.insertText',{text:'１２'});await frame(page);s=await state(page);
  check(S,'After composition ends, full-width digits are folded and kept',s.value==='12'&&s.slots.join('')==='12');

  // Contrast and keyboard focus.
  // Resting valid boxes (not focused, not :user-invalid) are compared with the resting username field.
  await reset(page,'123456');await otp.blur();await frame(page);await page.evaluate(()=>Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished)));
  const colours=await page.evaluate(()=>{const slot=getComputedStyle(document.querySelectorAll('.otp-slot')[5]);const parse=c=>c.match(/\d+(\.\d+)?/g).slice(0,3).map(Number);
    const lum=c=>{const [r,g,b]=parse(c).map(v=>{v/=255;return v<=0.03928?v/12.92:((v+0.055)/1.055)**2.4;});return 0.2126*r+0.7152*g+0.0722*b;};
    const a=lum(slot.borderTopColor),b=lum(slot.backgroundColor);return {ratio:(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05),border:slot.borderTopColor,field:getComputedStyle(document.querySelector('#username')).borderTopColor};});
  check(S,`Box borders keep at least 3:1 against the box (${colours.ratio.toFixed(2)}:1; box ${colours.border}, username field ${colours.field})`,colours.ratio>=3&&colours.border===colours.field);
  await page.locator('#password').focus();await page.keyboard.press('Tab');
  if(await page.evaluate(()=>document.activeElement?.dataset?.passwordToggle!==undefined))await page.keyboard.press('Tab');
  await page.evaluate(()=>Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished)));
  const ring=await page.evaluate(()=>{const shell=document.querySelector('.otp-shell'),style=getComputedStyle(shell.querySelector('.otp-slot.is-active,.otp-slot.is-selected'));
    return {focused:document.activeElement?.name,shadow:style.boxShadow,styleName:style.outlineStyle,shellStyle:getComputedStyle(shell).outlineStyle};});
  check(S,'Keyboard focus marks the active box without an outer frame',ring.focused==='otp'&&ring.shadow.includes('3px')&&!ring.shadow.includes('inset')&&ring.styleName==='none'&&ring.shellStyle==='none');
  await page.keyboard.type('12');await shot(page,'otp-03-keyboard-focus-1440-zh',false);

  // Native validation: an incomplete code is not submitted.
  await reset(page,'123');await page.locator('#username').fill('Synthetic_Browser_A');await page.locator('#password').fill(cfg.password);
  let posted=0;page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/login')posted++;});
  await page.locator('button.primary[type=submit]').click();await frame(page);
  const invalid=await page.evaluate(()=>{const i=document.querySelector('input[data-otp]');return {mismatch:i.validity.patternMismatch,border:getComputedStyle(document.querySelector('.otp-slot')).borderTopColor,bad:getComputedStyle(document.documentElement).getPropertyValue('--bad').trim()};});
  check(S,'An incomplete code is blocked by native validation and never posted',posted===0&&invalid.mismatch&&new URL(page.url()).pathname==='/login');
  await shot(page,'otp-04-incomplete-1440-zh',false);

  // Forced colours: decoration removed, real field and native glyph positions used directly.
  await page.emulateMedia({forcedColors:'active'});await frame(page);
  const forced=await page.evaluate(()=>{const i=document.querySelector('input[data-otp]');return {slots:getComputedStyle(document.querySelector('.otp-slots')).display,
    inline:i.getAttribute('style')||'',colour:getComputedStyle(i).color};});
  check(S,'Forced colours hide the boxes and clear the box geometry from the real field',forced.slots==='none'&&!/letter-spacing|padding-left|width/.test(forced.inline));
  await reset(page,'123456');
  const glyphs=await page.evaluate(()=>{const i=document.querySelector('input[data-otp]'),st=getComputedStyle(i),r=i.getBoundingClientRect(),ctx=document.createElement('canvas').getContext('2d');
    ctx.font=`${st.fontStyle} ${st.fontWeight} ${st.fontSize} ${st.fontFamily}`;const step=ctx.measureText('0').width+parseFloat(st.letterSpacing||'0');
    return {left:r.left+parseFloat(st.borderLeftWidth)+parseFloat(st.paddingLeft),step,y:r.top+r.height/2};});
  for(const k of [1,4]){await page.mouse.click(glyphs.left+k*glyphs.step+1,glyphs.y);s=await state(page);
    check(S,`Forced colours: clicking just inside visible glyph ${k} puts the caret before it (no box mapping)`,s.start===k);}
  await otp.blur();await page.locator('#password').focus();await page.keyboard.press('Tab');
  if(await page.evaluate(()=>document.activeElement?.dataset?.passwordToggle!==undefined))await page.keyboard.press('Tab');
  const forcedRing=await page.evaluate(()=>{const s=getComputedStyle(document.activeElement);return {name:document.activeElement.name,width:s.outlineWidth,style:s.outlineStyle};});
  check(S,'Forced colours: the real field shows its own 2px keyboard focus outline',forcedRing.name==='otp'&&forcedRing.width==='2px'&&forcedRing.style==='solid');
  await shot(page,'otp-05-forced-colors-1440-zh',false);
  await page.emulateMedia({forcedColors:'none'});await frame(page);

  // Server authentication is unchanged: a wrong code is refused, a real one signs in.
  await reset(page,'000000');posted=0;
  const wrong=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/login');
  await page.locator('button.primary[type=submit]').click();
  check(S,'A wrong six-digit code is posted once and refused by the server',(await wrong).status()===401&&posted===1);
  await page.goto(cfg.url+'/login');await page.locator('#username').fill('Synthetic_Browser_A');await page.locator('#password').fill(cfg.password);
  const code=(await command('otp',{fresh:true})).otp;await otp.click();await page.keyboard.type(code);
  await Promise.all([page.waitForURL(u=>new URL(u).pathname.startsWith('/app')),page.locator('button.primary[type=submit]').click()]);
  check(S,'A real code entered in the boxes signs in to the console',new URL(page.url()).pathname==='/app');
  check(S,'No page errors or CSP violations on the sign-in page',errors.length===0);
  await context.close();

  // Responsive and English screenshots.
  for(const [width,locale] of [[390,'zh-CN'],[320,'zh-CN'],[1440,'en'],[390,'en']]){
    const v=await newPage({width,height:900},{locale});await v.page.goto(cfg.url+'/login');
    await v.page.locator('input[data-otp]').click();await v.page.keyboard.type('1234');
    const box=await v.page.evaluate(()=>{const s=[...document.querySelectorAll('.otp-slot')].map(x=>x.getBoundingClientRect());return {min:Math.min(...s.map(r=>r.width)),right:Math.max(...s.map(r=>r.right))};});
    check(S,`${width}px ${locale}: six boxes fit without overflow`,await noOverflow(v.page)&&box.min>=32&&box.right<=width);
    const layout=await v.page.evaluate(()=>{const shell=document.querySelector('.otp-shell'),slots=shell.querySelector('.otp-slots'),u=document.querySelector('#username').getBoundingClientRect(),r=shell.getBoundingClientRect();return {aligned:Math.abs(u.left-r.left)<.5&&Math.abs(u.right-r.right)<.5,dash:getComputedStyle(slots,'::after').width,gap:parseFloat(getComputedStyle(slots).gap)};});
    check(S,`${width}px ${locale}: OTP aligns with text fields and has a centre dash`,layout.aligned&&layout.dash==='8px'&&layout.gap===16);
    await v.page.emulateMedia({reducedMotion:'reduce',colorScheme:'dark'});
    check(S,`${width}px ${locale}: reduced motion disables transitions; OS dark keeps supported palette`,await v.page.locator('.otp-slot').first().evaluate(e=>getComputedStyle(e).transitionDuration==='0s'&&getComputedStyle(document.documentElement).colorScheme==='light'));
    await shot(v.page,`otp-reduced-dark-${width}-${locale}`);
    await v.page.emulateMedia({reducedMotion:'no-preference',colorScheme:'light'});
    const c=await v.page.locator('.otp-slot').nth(3).boundingBox();await v.page.mouse.click(c.x+c.width/2,c.y+c.height/2);
    check(S,`${width}px ${locale}: clicking box 3 still places the caret before digit 3`,await v.page.evaluate(()=>document.querySelector('input[data-otp]').selectionStart)===3);
    if(locale==='en')check(S,`${width}px English hint is translated`,(await v.page.locator('#otp-hint').innerText()).includes('6 digits'));
    await shot(v.page,`otp-06-login-${width}-${locale==='en'?'en':'zh'}`);await v.context.close();
  }

  // Without JavaScript the plain single field remains and is usable.
  const nojs=await newPage({width:390,height:900},{javaScriptEnabled:false});await nojs.page.goto(cfg.url+'/login');
  const plain=await nojs.page.evaluate(()=>({shell:document.querySelectorAll('.otp-shell').length,fields:document.querySelectorAll('input[name=otp]').length}));
  await nojs.page.locator('input[name=otp]').fill('123456');
  check(S,'Without JavaScript one plain otp field is shown and accepts the code',plain.shell===0&&plain.fields===1&&await nojs.page.locator('input[name=otp]').inputValue()==='123456');
  await shot(nojs.page,'otp-07-no-javascript-390-zh',true,{scripted:false});await nojs.context.close();

  // Registration, recovery and OAuth sign-in use the same enhancement over their own single field.
  const reg=await newPage({width:390,height:900});const invitation=(await command('invitation')).codes[0];
  await reg.page.goto(cfg.url+'/register');await reg.page.locator('input[name=code]').fill(invitation);
  await Promise.all([reg.page.waitForURL(/\/register\/account$/),reg.page.locator('button.primary').click()]);
  await reg.page.locator('#username').fill('Synthetic_Refine_Reg');await reg.page.locator('#password').fill('Synthetic registration password  ');
  await reg.page.locator('#password_confirm').fill('Synthetic registration password  ');
  await Promise.all([reg.page.waitForURL(/\/register\/totp$/),reg.page.locator('button.primary').click()]);
  check(S,'Registration authenticator step uses the six boxes over one required field',
    await reg.page.evaluate(()=>document.querySelectorAll('.otp-shell input[data-otp][name=otp][required]').length===1&&document.querySelectorAll('input[name=otp]').length===1));
  await shot(reg.page,'otp-08-register-totp-390-zh');await reg.context.close();
  const rec=await newPage({width:390,height:900});await rec.page.goto(cfg.url+'/recover');
  check(S,'Recovery start keeps its optional code field (not required) with the six boxes',
    await rec.page.evaluate(()=>{const i=document.querySelector('.otp-shell input[data-otp][name=otp]');return !!i&&!i.required&&document.querySelectorAll('input[name=otp]').length===1;}));
  const codes=(await command('codes',{owner:1})).codes;
  await rec.page.evaluate(()=>{const s=document.querySelector('select[name=action]');s.value='totp';s.dispatchEvent(new Event('change',{bubbles:true}));});
  await rec.page.locator('#username').fill('Synthetic_Browser_B');await rec.page.locator('#recovery_code').fill(codes[0]);await rec.page.locator('#password').fill(cfg.password);
  await Promise.all([rec.page.waitForURL(/\/recover\/complete$/),rec.page.locator('button.primary').click()]);
  check(S,'Recovery authenticator replacement uses the six boxes over one required field',
    await rec.page.evaluate(()=>document.querySelectorAll('.otp-shell input[data-otp][name=otp][required]').length===1));
  await shot(rec.page,'otp-09-recover-totp-390-zh');await rec.context.close();
  const oauth=await newPage({width:390,height:900});const verifier=randomBytes(32).toString('base64url');
  const params=new URLSearchParams({client_id:cfg.oauth.client_id,redirect_uri:cfg.oauth.redirect_uri,response_type:'code',scope:'openid memory:read',resource:cfg.oauth.resource,
    state:randomBytes(8).toString('hex'),code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')});
  await oauth.page.goto(cfg.url+'/authorize?'+params);await oauth.page.waitForURL(/\/interaction\//);
  check(S,'OAuth sign-in uses the six boxes over its one required field',
    await oauth.page.evaluate(()=>document.querySelectorAll('.otp-shell input[data-otp][name=otp][required]').length===1&&document.querySelectorAll('input[name=otp]').length===1));
  await shot(oauth.page,'otp-10-oauth-login-390-zh');
  check(S,'No page errors on registration, recovery or OAuth sign-in pages',[...reg.errors,...rec.errors,...oauth.errors].length===0);
  await oauth.context.close();
}

// ---------------------------------------------------------------- Summaries
async function summariesSection() {
  const S='summaries';
  const seeded=await command('seed-summaries');assert.equal(seeded.summaries,9);
  const settle=async p=>{await p.locator('#console-root h1').waitFor();await p.locator('.loading-card').waitFor({state:'detached'});};
  const row=(p,text)=>p.locator('.summary-row').filter({hasText:text});
  // The pane slides in with an opacity animation; capture it only once every animation has finished
  // and the pane is fully opaque, so screenshots never show the list through a half-faded pane.
  const settledPane=async(p,label)=>{
    const opacity=await p.locator('#memory-dialog').evaluate(async d=>{await Promise.all(d.getAnimations({subtree:true}).map(a=>a.finished));return getComputedStyle(d).opacity;});
    check(S,`${label}: detail pane is settled and fully opaque before capture`,opacity==='1');};

  for(const [width,locale] of [[1440,'zh-CN'],[390,'zh-CN'],[320,'zh-CN'],[1440,'en'],[390,'en'],[320,'en']]){
    const {context,page,errors}=await newPage({width,height:900},{locale,account:0});
    await page.goto(cfg.url+'/app/summaries');await settle(page);
    const tag=`${width}-${locale==='en'?'en':'zh'}`;
    const layout=await page.evaluate(()=>{const list=document.querySelector('.list-panel').getBoundingClientRect(),index=document.querySelector('.index-panel').getBoundingClientRect();
      const narrow=[...document.querySelectorAll('.summary-row .memory-link')].map(n=>n.getBoundingClientRect().width);
      return {list:list.width,index:index.width,stacked:list.top>=index.bottom,narrowest:Math.min(...narrow),rows:narrow.length};});
    check(S,`${tag}: no horizontal overflow`,await noOverflow(page));
    if(width<=390)check(S,`${tag}: index and list are stacked at full width, summary text never squeezed (narrowest ${Math.round(layout.narrowest)}px)`,
      layout.stacked&&layout.list>=width-80&&layout.narrowest>=width-140);
    else check(S,`${tag}: wide layout keeps the index beside a wide list`,!layout.stacked&&layout.list>=600);
    if(width===390&&locale==='zh-CN'){
      const texts=await page.locator('.summary-row').allInnerTexts();
      check(S,'All nine seeded summaries are listed, current and superseded',layout.rows===9);
      check(S,'Rows show daily/weekly windows with their time zones',['日摘要','周摘要','Asia/Shanghai','UTC','America/Los_Angeles'].every(k=>texts.some(x=>x.includes(k))));
      check(S,'Rows show personal, project, task › workstream and session scopes',['个人范围','项目 Synthetic UI Project','任务 Synthetic UI Task','工作流 Synthetic branch','会话'].every(k=>texts.some(x=>x.includes(k))));
      const twins=texts.filter(x=>x.includes('工作流 Synthetic branch'));
      const readable=twins.map(x=>x.split('范围标识')[0]);
      check(S,'Same-titled task/workstream summaries in two projects read differently through their project',twins.length===2&&readable[0]!==readable[1]
        &&readable.some(x=>x.includes('Synthetic UI Project Twin'))&&readable.some(x=>x.includes('Synthetic UI Project ›')));
      check(S,'Scope and summary IDs are secondary text after the readable facts',
        await page.evaluate(()=>[...document.querySelectorAll('.summary-row')].every(r=>{const id=r.querySelector('.summary-id');return id&&id.compareDocumentPosition(r.querySelector('.summary-facts'))&Node.DOCUMENT_POSITION_PRECEDING;})));
      check(S,'The superseded revision stays labelled as not current',texts.some(x=>x.includes('已被修订')&&x.includes('此摘要已失效')));
      const ids=await page.evaluate(()=>[...document.querySelectorAll('.summary-id')].every(n=>n.getBoundingClientRect().right<=document.querySelector('.list-panel').getBoundingClientRect().right+1));
      check(S,'Long scope and summary IDs wrap inside the list',ids);
    }
    if(width===320)check(S,`${tag}: the long session identifier wraps inside its row`,await row(page,'long-identifier').evaluate(r=>r.scrollWidth<=r.clientWidth+1));
    await shot(page,`summaries-01-list-${tag}`);
    if(width<=390){
      await row(page,'Synthetic UI Project Twin').locator('button[data-summary]').click();
      await page.locator('#memory-content .claim-list').waitFor();
      const pane=await page.evaluate(()=>{const p=document.querySelector('#memory-dialog'),claim=document.querySelector('#memory-content .claim-list .body-content');
        return {fits:p.scrollWidth<=p.clientWidth,claim:claim.getBoundingClientRect().width,facts:document.querySelector('#memory-content .summary-detail-facts')?.innerText||''};});
      check(S,`${tag}: summary detail repeats the distinguishing facts and reads at full pane width (${Math.round(pane.claim)}px)`,
        pane.fits&&pane.claim>=width-80&&pane.facts.includes('Synthetic UI Project Twin'));
      await settledPane(page,tag);await shot(page,`summaries-02-detail-${tag}`,false);
      await page.locator('#memory-content [data-close]').click();
      check(S,`${tag}: in-pane Back to list closes the detail and returns focus to the row`,
        !(await page.locator('#memory-dialog').evaluate(d=>d.open))&&await page.evaluate(()=>document.activeElement?.hasAttribute('data-summary')));
    }
    check(S,`${tag}: no page errors`,errors.length===0);
    await context.close();
  }

  // Cited source and back, failed reads, and replies that arrive after the user moved on.
  const {context,page,errors}=await newPage({width:390,height:900},{account:0});
  await page.goto(cfg.url+'/app/summaries');await settle(page);
  const open=async text=>{await row(page,text).locator('button[data-summary]').click();await page.locator('#memory-content .claim-list').waitFor();};
  await open('Synthetic UI Project Twin');
  await page.locator('#memory-content .claim-list [data-memory]').first().click();
  await page.locator('#memory-content [data-detail-back]').waitFor();
  check(S,'A cited source opens in the pane with Back to its summary',await page.locator('#memory-content .claim-list').count()===0&&await page.locator('#detail-title').innerText()!=='');
  await settledPane(page,'Cited source');await shot(page,'summaries-03-cited-source-390-zh',false);
  await page.locator('#memory-content [data-detail-back]').click();await page.locator('#memory-content .claim-list').waitFor();
  check(S,'Back from the cited source returns to the originating summary',(await page.locator('#memory-content .summary-detail-facts').innerText()).includes('Synthetic UI Project Twin'));

  await page.route(/\/console-api\/memory\?/,route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Synthetic',error_code:'MEMORY_VERSION_CHANGED'})}),{times:1});
  await page.locator('#memory-content .claim-list [data-memory]').first().click();
  await page.locator('#memory-content [data-detail-return]').waitFor();
  check(S,'A failed source read offers Back to the summary and Back to list',await page.locator('#memory-content [role=alert]').count()===1&&await page.locator('#memory-content [data-close]').count()===1);
  await settledPane(page,'Failed source read');await shot(page,'summaries-04-source-error-390-zh',false);
  await page.locator('#memory-content [data-detail-return]').click();await page.locator('#memory-content .claim-list').waitFor();
  check(S,'Back after a failed source read restores the originating summary',(await page.locator('#memory-content .summary-detail-facts').innerText()).includes('Synthetic UI Project Twin'));
  await page.locator('#memory-content [data-close]').click();

  await page.route(/\/console-api\/summary\?/,route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Synthetic',error_code:'SUMMARY_VERSION_CHANGED'})}),{times:1});
  await row(page,'America/Los_Angeles').locator('button[data-summary]').click();await page.locator('#memory-content [role=alert]').waitFor();
  check(S,'A failed summary read shows the error with Back to list only',await page.locator('#memory-content [data-close]').count()===1&&await page.locator('#memory-content [data-detail-return]').count()===0);
  await page.locator('#memory-content [data-close]').click();
  check(S,'Back to list after a failed summary read closes the pane',!(await page.locator('#memory-dialog').evaluate(d=>d.open)));

  check(S,'No page errors during source navigation and failed reads',errors.length===0);
  await context.close();

  // A slow reply for an earlier summary never replaces the one opened after it (docked pane, so a
  // second row stays clickable), and a reply arriving after the pane closed never reopens it.
  const late=await newPage({width:1440,height:900},{account:0});
  {const page=late.page,errors=late.errors;
  await page.goto(cfg.url+'/app/summaries');await settle(page);
  let releaseFirst;const firstHeld=new Promise(r=>releaseFirst=r);let held=0;
  await page.route(/\/console-api\/summary\?/,async route=>{if(held++===0){await firstHeld;}await route.continue();});
  await row(page,'Asia/Shanghai').filter({hasText:'项目'}).filter({hasNotText:'任务'}).locator('button[data-summary]').click();
  await row(page,'Synthetic UI Project Twin').locator('button[data-summary]').click();await page.locator('#memory-content .claim-list').waitFor();
  releaseFirst();await page.waitForTimeout(400);
  check(S,'A late reply for an earlier summary is ignored after a newer one opened',(await page.locator('#memory-content .summary-detail-facts').innerText()).includes('Synthetic UI Project Twin'));
  await page.locator('#memory-content [data-close]').click();await page.unroute(/\/console-api\/summary\?/);
  let releaseLate;const lateHeld=new Promise(r=>releaseLate=r);
  await page.route(/\/console-api\/summary\?/,async route=>{await lateHeld;await route.continue();},{times:1});
  await row(page,'America/Los_Angeles').locator('button[data-summary]').click();await page.locator('#memory-dialog .close-button').click();
  releaseLate();await page.waitForTimeout(400);
  check(S,'A reply that arrives after the pane was closed does not reopen or fill it',
    !(await page.locator('#memory-dialog').evaluate(d=>d.open))&&await page.locator('#memory-content').evaluate(n=>n.childElementCount===0));
  check(S,'No page errors with late replies',errors.length===0);
  await late.context.close();}
}

// ---------------------------------------------------------------- Projects and tasks
async function projectsSection() {
  const S='projects';
  const seed=await command('seed-projects');assert.equal(seed.active,26);
  const settle=async p=>{await p.locator('#console-root h1').waitFor();await p.locator('.loading-card').waitFor({state:'detached'});await p.locator('.project-list,.view-switch').first().waitFor();};
  const projectRow=(p,id)=>p.locator(`[data-project-row="${id}"]`);
  const op=p=>p.locator('#operation-dialog');
  const state=async(kind,id)=>(await command(kind==='project'?'project-state':'task-state',kind==='project'?{project_id:id}:{task_id:id})).row;
  // Editor captures wait for the dialog's own entry animation to finish and assert it is fully opaque.
  const settledDialog=async(p,label)=>{const opacity=await op(p).evaluate(async d=>{await Promise.all(d.getAnimations({subtree:true}).map(a=>a.finished));return getComputedStyle(d).opacity;});
    check(S,`${label}: editor dialog is settled and fully opaque before capture`,opacity==='1');};
  const {context,page,errors}=await newPage({width:1440,height:1000},{account:0});
  let writes=0;page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/console-api/action'))writes++;});
  await page.goto(cfg.url+'/app/tasks');await settle(page);

  // Active/archived views with server counts and real paging (25 per page).
  const counts=await page.locator('.view-switch button').allInnerTexts();
  check(S,'Active and Console-archive views show server counts',counts[0].includes('26')&&counts[1].includes('0')&&await page.locator('.view-switch [aria-pressed="true"][data-project-view="false"]').count()===1);
  check(S,'Active view pages 25 projects with Next',await page.locator('.project-row').count()===25&&await page.locator('[data-project-offset="25"]').count()===1);
  check(S,'1440 zh: no horizontal overflow',await noOverflow(page));
  await shot(page,'projects-01-list-1440-zh');

  // Inline context, opened with the keyboard, showing the Core's bounded content and recorded sources.
  const main=projectRow(page,seed.main),toggle=main.locator('[data-project-context]'),region=page.locator('#'+await toggle.getAttribute('aria-controls'));
  await toggle.focus();await page.keyboard.press('Enter');await region.locator('.context-provenance').waitFor();
  check(S,'Enter expands the row context in place (aria-expanded, region shown)',await toggle.getAttribute('aria-expanded')==='true'&&await region.isVisible());
  // Open the seeded rich task (the newest, so first in the Core's context window) and each of its sections by
  // clicking their visible summaries, then the project memories; check the actual content.
  const rich=region.locator('details.context-task').filter({has:page.locator(':scope > summary',{hasText:'Synthetic task 0'})});
  check(S,'The rich task is inside the returned context window',await rich.count()===1);
  await rich.locator(':scope > summary').click();
  for(const d of await rich.locator('details.context-section').all())await d.locator(':scope > summary').click();
  await region.locator(':scope > details.context-section').filter({hasText:'结构化记忆'}).locator(':scope > summary').click();
  const opened=await region.innerText(),expected=['structured progress','structured decision','synthetic blocker','Synthetic workstream description','synthetic recorded claim','合成项目记忆'];
  const missing=expected.filter(k=>!opened.includes(k));
  check(S,`Expanded context sections show progress, decisions, blockers, workstream and conflict text${missing.length?` (missing: ${missing.join(', ')})`:''}`,!missing.length);
  const blockers=await rich.locator('details.context-section').filter({hasText:'阻碍'}).locator(':scope > summary').innerText();
  check(S,`A capped field says how many of the stored values are shown (${blockers.replace(/\s+/g,' ')})`,/4\s*\/\s*20/.test(blockers)&&blockers.includes('仅显示部分'));
  check(S,'Context states it is read-only and creates no Resume',opened.includes('不会创建接续'));
  await shot(page,'projects-02-context-1440-zh',false);
  await page.keyboard.press('Tab');await toggle.focus();await page.keyboard.press('Space');
  check(S,'Space collapses the context and clears it',await toggle.getAttribute('aria-expanded')==='false'&&await region.isHidden()&&await region.evaluate(n=>n.childElementCount===0));

  // A reply that arrives after its row was closed, or after the list was re-rendered, is ignored.
  let release;const held=new Promise(r=>release=r);
  await page.route(/\/console-api\/project-context\?/,async route=>{await held;await route.continue();},{times:1});
  await toggle.click();await toggle.click();release();await page.waitForTimeout(500);
  check(S,'A late reply after the row was closed does not reopen or fill it',await region.isHidden()&&await region.evaluate(n=>n.childElementCount===0));
  let releaseB;const heldB=new Promise(r=>releaseB=r);
  await page.route(/\/console-api\/project-context\?/,async route=>{await heldB;await route.continue();},{times:1});
  await toggle.click();await page.locator('[data-project-offset="25"]').click();await page.locator('.project-row').first().waitFor();await page.waitForFunction(()=>document.querySelectorAll('.project-row').length===1);
  releaseB();await page.waitForTimeout(500);
  check(S,'A late reply after paging away never fills a row of the new page',await page.locator('.project-context:not([hidden])').count()===0);
  await page.locator('[data-project-offset="0"]').click();await page.waitForFunction(()=>document.querySelectorAll('.project-row').length===25);
  await page.route(/\/console-api\/project-context\?/,route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic',error_code:'CONSOLE_CORE_UNAVAILABLE'})}),{times:1});
  const toggle2=projectRow(page,seed.main).locator('[data-project-context]'),region2=page.locator('#'+await toggle2.getAttribute('aria-controls'));
  await toggle2.click();await region2.locator('[role=alert]').waitFor();
  check(S,'A failed context read shows an error with Retry inside the row',await region2.locator('[data-project-context-retry]').count()===1);
  await region2.locator('[data-project-context-retry]').click();await region2.locator('.context-provenance').waitFor();
  check(S,'Retry loads the context into the same row',await toggle2.getAttribute('aria-expanded')==='true');
  await toggle2.click();

  // Edit a project: full alias list, explicit remove/add, rename; other lists unchanged.
  const before=await state('project',seed.main);
  await projectRow(page,seed.main).locator('[data-console-action="projects.update"]').click();await op(page).locator('#operation-form').waitFor();
  check(S,'Project editor lists every stored alias in full (12, including the 190-character one)',await op(page).locator('[data-list-field="aliases"] .list-value').count()===12&&(await op(page).locator('[data-list-field="aliases"]').innerText()).includes('x'.repeat(180)));
  await settledDialog(page,'Project editor 1440 zh');await shot(page,'projects-03-edit-project-1440-zh',false);
  await op(page).locator('[data-list-field="aliases"] input[type=checkbox]').nth(1).check();
  await op(page).locator('textarea[name="add_aliases"]').fill('新别名 one\n  new alias two  \n');
  // Still deliberately long, so the later phone screenshots show real long-name wrapping.
  const renamed='Atlas 合成项目（已改名）：名称仍然很长，用于检查窄屏换行 Renamed synthetic project with a long name';
  await op(page).locator('input[name="name"]').fill(renamed);
  await op(page).locator('button.primary[type=submit]').click();await op(page).locator('.operation-result,[data-operation-result]').first().waitFor().catch(()=>{});
  await page.waitForTimeout(300);const after=await state('project',seed.main),aliases=JSON.parse(after.aliases_json);
  check(S,'Saving renames, removes the checked alias and adds the new ones',after.name===renamed&&aliases.length===13&&!aliases.includes(JSON.parse(before.aliases_json)[1])&&aliases.includes('新别名 one')&&aliases.includes('new alias two'));
  check(S,'Remotes, fingerprints and path hints are unchanged',['git_remotes_json','repo_fingerprints_json','path_hints_json'].every(k=>after[k]===before[k]));
  // Keyboard focus after Save (the list re-rendered behind the dialog) then Close.
  const focused=()=>page.evaluate(()=>{const a=document.activeElement;return {connected:!!a&&a.isConnected&&a!==document.body,action:a?.dataset?.consoleAction||null,id:a?.dataset?.id||null,view:a?.dataset?.projectView||null,tag:a?.tagName};});
  await op(page).locator('[data-operation-close]').first().click();await frame(page);
  let f1=await focused();
  check(S,`After Save and Close, focus returns to the edited row's Edit button (${JSON.stringify(f1)})`,f1.connected&&f1.action==='projects.update'&&f1.id===seed.main);
  // Cancel before anything reloaded returns to the same trigger.
  await projectRow(page,seed.main).locator('[data-console-action="projects.update"]').click();await op(page).locator('#operation-form').waitFor();
  await page.keyboard.press('Escape');await frame(page);f1=await focused();
  check(S,`Escape before saving returns focus to its trigger (${JSON.stringify(f1)})`,f1.connected&&f1.action==='projects.update'&&f1.id===seed.main);

  // Untouched newline-containing fields survive exactly (HTML control normalization never writes back).
  await settle(page);const nlBefore=await state('project',seed.newline);
  await projectRow(page,seed.newline).locator('[data-console-action="projects.update"]').click();await op(page).locator('#operation-form').waitFor();
  await op(page).locator('textarea[name="add_aliases"]').fill('newline-alias-two');await op(page).locator('button.primary[type=submit]').click();await page.waitForTimeout(500);
  const nlAfter=await state('project',seed.newline);
  check(S,'An alias-only edit keeps a newline-containing project name exactly',nlAfter.name===nlBefore.name&&nlAfter.name==='Line one\nLine two'&&JSON.parse(nlAfter.aliases_json).includes('newline-alias-two'));
  if(await op(page).evaluate(d=>d.open))await op(page).locator('[data-operation-close]').first().click();
  const taskRow=t=>page.locator(`[data-feature="TSK-02"] [data-task-row="${t}"]`);
  const openTask=async id=>{for(let guard=0;!(await taskRow(id).count())&&guard<5;guard++){const next=page.locator('[data-feature="TSK-02"] [data-task-offset]').last();if(!await next.count())break;await next.click();await page.waitForTimeout(300);}
    await taskRow(id).locator('[data-console-action="tasks.update"]').click();await op(page).locator('#operation-form').waitFor();};
  const tBefore=await state('task',seed.newline_task);
  await openTask(seed.newline_task);await op(page).locator('select[name="status"]').selectOption('paused',{force:true});
  await op(page).locator('button.primary[type=submit]').click();await page.waitForTimeout(500);
  const tAfter=await state('task',seed.newline_task);
  check(S,'A status-only edit keeps a CRLF title and a leading-newline goal exactly',tAfter.status==='paused'&&tAfter.title===tBefore.title&&tAfter.goal===tBefore.goal&&tAfter.title.includes('\r\n')&&tAfter.goal.startsWith('\n'));
  if(await op(page).evaluate(d=>d.open))await op(page).locator('[data-operation-close]').first().click();
  await openTask(seed.newline_task);const writesBefore=writes;await op(page).locator('button.primary[type=submit]').click();await page.waitForTimeout(500);
  const tSame=await state('task',seed.newline_task);
  check(S,'Saving without changes writes no new canonical version',tSame.canonical_version===tAfter.canonical_version&&tSame.title===tBefore.title&&tSame.goal===tBefore.goal&&writes===writesBefore+1);
  if(await op(page).evaluate(d=>d.open))await op(page).locator('[data-operation-close]').first().click();

  // A real agent write between opening and saving: the Console save is refused and the agent change kept.
  await openTask(seed.rich_task);const retained=await op(page).locator('.policy-box').last().innerText();
  check(S,'Task editor says which structured fields are kept, not edited',retained.includes('原样保留')&&retained.includes('工作流'));
  await settledDialog(page,'Task editor 1440 zh');await shot(page,'projects-04-edit-task-1440-zh',false);
  await command('touch-task',{task_id:seed.rich_task});const agent=await state('task',seed.rich_task);
  await op(page).locator('textarea[name="goal"]').fill('Console goal over a stale view');await op(page).locator('button.primary[type=submit]').click();
  await op(page).locator('[data-operation-error]').filter({hasText:'已被其他操作修改'}).waitFor();
  const stale=await state('task',seed.rich_task);
  check(S,'A stale task save shows the conflict and keeps the agent write',stale.canonical_version===agent.canonical_version&&stale.goal===agent.goal&&stale.blockers_json.includes('synthetic agent'));
  await op(page).locator('[data-operation-close]').first().click();
  await openTask(seed.rich_task);await op(page).locator('textarea[name="goal"]').fill('Console goal after reload');await op(page).locator('button.primary[type=submit]').click();await page.waitForTimeout(500);
  const edited=await state('task',seed.rich_task);
  check(S,'After reopening, a goal edit saves and keeps structured fields exactly',edited.goal==='Console goal after reload'&&edited.canonical_version===agent.canonical_version+1&&['blockers_json','progress_json','workstreams_json','conflicts_json'].every(k=>edited[k]===agent[k]));
  if(await op(page).evaluate(d=>d.open))await op(page).locator('[data-operation-close]').first().click();

  // Task paging, from the first page (an earlier edit may have left the pager elsewhere).
  await settle(page);
  if(await page.locator('[data-feature="TSK-02"] [data-task-offset="0"]').count()){await page.locator('[data-feature="TSK-02"] [data-task-offset="0"]').click();await page.waitForFunction(()=>!document.querySelector('[data-feature="TSK-02"] [data-task-offset="0"]'));}
  const firstTasks=await page.locator('[data-feature="TSK-02"] .task-row').count();
  await page.locator('[data-feature="TSK-02"] [data-task-offset="10"]').click();await page.waitForFunction(()=>document.querySelector('[data-feature="TSK-02"] [data-task-offset="0"]'));
  check(S,'Tasks page 10 at a time with Previous and Next',firstTasks===10&&await page.locator('[data-feature="TSK-02"] [data-task-offset="0"]').count()===1);
  await page.locator('[data-feature="TSK-02"] [data-task-offset="0"]').click();await settle(page);

  // Console archive of the only row on page 2: the view steps back to page 1 instead of stranding an empty page.
  await page.locator('[data-project-offset="25"]').click();await page.waitForFunction(()=>document.querySelectorAll('.project-row').length===1);
  const last=await page.locator('.project-row').first().getAttribute('data-project-row');
  await page.locator('.project-row [data-console-action="projects.archive"]').click();await op(page).locator('#operation-form').waitFor();
  check(S,'Archive dialog says it only hides the project in the Console and is not deletion',(await op(page).innerText()).includes('这不是删除'));
  // Event synchronization: wait for the submission to complete (its result replaces the form), then Close,
  // then for the close handler to finish (dialog closed and its content emptied) before checking focus.
  const dialogState=()=>page.evaluate(()=>{const d=document.querySelector('#operation-dialog');return {open:d.open,content:d.querySelector('#operation-content').childElementCount,focused:document.activeElement?.outerHTML?.slice(0,90)||null};});
  const closeHandled=()=>page.waitForFunction(()=>{const d=document.querySelector('#operation-dialog');return !d.open&&d.querySelector('#operation-content').childElementCount===0;});
  await op(page).locator('button.primary[type=submit]').click();await op(page).locator('#operation-form').waitFor({state:'detached'});
  console.log('DIAG archive: after result',JSON.stringify(await dialogState()));
  await op(page).locator('[data-operation-close]').first().click();await closeHandled();
  console.log('DIAG archive: after close handler',JSON.stringify(await dialogState()));
  await page.waitForFunction(()=>document.querySelectorAll('.project-row').length===25);
  const f2=await page.evaluate(()=>{const a=document.activeElement;return {connected:!!a&&a.isConnected&&a!==document.body,inList:!!a?.closest?.('[data-feature="TSK-01"]'),view:a?.dataset?.projectView||null,
    tag:a?.tagName,id:a?.id||null,action:a?.dataset?.consoleAction||null,dialogOpen:document.querySelector('#operation-dialog')?.open??null,html:a?.outerHTML?.slice(0,200)||null};});
  check(S,`After archiving removed its row, focus lands on a project-list control (${JSON.stringify(f2)})`,f2.connected&&f2.inList);
  check(S,'Archiving the last row of page 2 returns to page 1 with 25 active projects',await page.locator(`[data-project-row="${last}"]`).count()===0&&(await page.locator('.view-switch button').first().innerText()).includes('25'));
  await page.locator('[data-project-view="true"]').click();await page.waitForFunction(()=>document.querySelector('[data-project-view="true"]')?.getAttribute('aria-pressed')==='true');
  check(S,'Archived view lists only the archived project with the Console-only note and Restore',await page.locator('.project-row').count()===1&&await page.locator(`[data-project-row="${last}"] [data-console-action="projects.restore"]`).count()===1&&(await page.locator('[data-feature="TSK-01"]').innerText()).includes('这不是删除'));
  await shot(page,'projects-05-archived-view-1440-zh');
  await page.locator('[data-console-action="projects.restore"]').click();await op(page).locator('#operation-form').waitFor();await op(page).locator('button.primary[type=submit]').click();
  await op(page).locator('#operation-form').waitFor({state:'detached'});await op(page).locator('[data-operation-close]').first().click();await closeHandled();
  await page.waitForFunction(()=>document.querySelectorAll('.project-row').length===0);
  check(S,'Restoring the only archived project leaves an explained empty archive view',(await page.locator('[data-feature="TSK-01"]').innerText()).includes('没有在控制台归档的项目'));
  check(S,'No page errors on the projects page',errors.length===0);
  await context.close();

  // Responsive and English views with the long names, the open context and the editor.
  for(const [width,locale] of [[390,'zh-CN'],[320,'zh-CN'],[1440,'en'],[390,'en'],[320,'en']]){
    const v=await newPage({width,height:900},{locale,account:0});await v.page.goto(cfg.url+'/app/tasks');await settle(v.page);
    const tag=`${width}-${locale==='en'?'en':'zh'}`,row=projectRow(v.page,seed.main),b=row.locator('[data-project-context]');
    await b.click();await v.page.locator('#'+await b.getAttribute('aria-controls')).locator('.context-provenance').waitFor();
    check(S,`${tag}: no horizontal overflow with long names and open context`,await noOverflow(v.page));
    // Measured against the project row's own box (page gutters and card padding are the row's business).
    const geometry=await row.evaluate(r=>{const box=r.getBoundingClientRect().width,w=s=>r.querySelector(s).getBoundingClientRect().width;
      return {row:box,name:w('.project-name'),context:w('.project-context'),lines:Math.round(r.querySelector('.project-name').getBoundingClientRect().height/parseFloat(getComputedStyle(r.querySelector('.project-name')).lineHeight||'20'))};});
    if(width<=390)check(S,`${tag}: long name and context fill the ${Math.round(geometry.row)}px row (name ${Math.round(geometry.name)}px over ${geometry.lines} lines, context ${Math.round(geometry.context)}px)`,
      geometry.name>=geometry.row*0.85&&geometry.context>=geometry.row*0.95&&geometry.lines<=6);
    await shot(v.page,`projects-06-list-${tag}`);
    // The task section itself: titles wrap across their row and every action stays inside its row.
    const tasks=v.page.locator('[data-feature="TSK-02"]');
    const taskGeometry=await tasks.evaluate(card=>[...card.querySelectorAll('.task-row')].map(r=>{const box=r.getBoundingClientRect(),title=r.querySelector('.task-title').getBoundingClientRect();
      return {row:box.width,title:title.width,actionsInside:[...r.querySelectorAll('button')].every(b=>{const x=b.getBoundingClientRect();return x.left>=box.left-1&&x.right<=box.right+1;})};}));
    // Phones stack title above actions (title spans the row); wide layouts keep actions beside a title of at least half the row.
    const share=width<=390?0.85:0.5;
    check(S,`${tag}: task titles take ≥${share*100}% of their ${Math.round(taskGeometry[0]?.row||0)}px rows and every action stays inside its row`,taskGeometry.length>0&&taskGeometry.every(g=>g.title>=g.row*share&&g.actionsInside));
    await tasks.evaluate(n=>n.scrollIntoView());await frame(v.page);await tasks.screenshot({path:path.join(evidence,`projects-08-tasks-${tag}.png`)});
    await row.locator('[data-console-action="projects.update"]').click();await v.page.locator('#operation-form').waitFor();
    check(S,`${tag}: the project editor fits without overflow`,await v.page.locator('#operation-dialog').evaluate(d=>d.scrollWidth<=d.clientWidth+1));
    await settledDialog(v.page,`Project editor ${tag}`);await shot(v.page,`projects-07-editor-${tag}`,false);
    check(S,`${tag}: no page errors`,v.errors.length===0);await v.context.close();
  }

  // Editor reads still pending when the person closes the dialog, presses Escape or signs out never reopen
  // or fill it afterwards, and never write anything.
  const c=await newPage({width:1440,height:1000},{account:0});let cwrites=0;
  c.page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/console-api/action'))cwrites++;});
  await c.page.goto(cfg.url+'/app/tasks');await settle(c.page);
  const hold=async pattern=>{let release;const held=new Promise(r=>release=r);await c.page.route(pattern,async route=>{await held;await route.continue();},{times:1});return release;};
  const closedAndEmpty=()=>op(c.page).evaluate(d=>!d.open&&d.querySelector('#operation-content').childElementCount===0);
  let resume=await hold(/\/console-api\/metadata-values\?/);
  await projectRow(c.page,seed.main).locator('[data-console-action="projects.update"]').click();await op(c.page).waitFor();
  await c.page.keyboard.press('Escape');resume();await c.page.waitForTimeout(600);
  check(S,'A pending project-editor read answered after Escape leaves the dialog closed and empty',await closedAndEmpty());
  resume=await hold(/\/console-api\/task-detail\?/);
  await c.page.locator(`[data-task-row="${seed.rich_task}"] [data-console-action="tasks.update"]`).click();await op(c.page).waitFor();
  await op(c.page).locator('[data-operation-close]').first().click();resume();await c.page.waitForTimeout(600);
  check(S,'A pending task-editor read answered after Close leaves the dialog closed and empty',await closedAndEmpty());
  check(S,'Cancelled editors wrote nothing',cwrites===0);
  // Sign out while a task-editor read is pending; the reply arrives after the session ended.
  resume=await hold(/\/console-api\/task-detail\?/);
  await c.page.locator(`[data-task-row="${seed.rich_task}"] [data-console-action="tasks.update"]`).click();await op(c.page).waitFor();
  await c.page.evaluate(()=>document.querySelector('form[action="/console-api/logout"]').requestSubmit());
  await c.page.waitForURL(u=>new URL(u).pathname==='/login');resume();await c.page.waitForTimeout(600);
  check(S,'A reply pending at sign-out shows nothing: the signed-out page has no editor or project data',
    await c.page.locator('#operation-dialog[open],.project-row,[data-task-row]').count()===0&&cwrites===0);
  check(S,'No page errors during cancellation and sign-out',c.errors.length===0);
  await c.context.close();
  // Sign-out revoked this owner's synthetic Console session; later sections get a fresh one.
  cfg.accounts[0].token=(await command('cookies',{owner:0})).token;
}

// ---------------------------------------------------------------- Models
async function modelsSection() {
  const S='models',TYPED='synthetic-browser-typed-key';
  const settle=async p=>{await p.locator('#console-root h1').waitFor();await p.locator('.loading-card').waitFor({state:'detached'});await p.locator('.model-card').first().waitFor();};
  const op=p=>p.locator('#operation-dialog');
  const requests=async()=>(await command('model-list-requests')).requests;
  const config=async()=>(await command('model-config')).models;
  const pick=async(p,name,value)=>{const s=op(p).locator(`[name="${name}"]`),index=await s.evaluate((s,v)=>[...s.options].findIndex(o=>o.value===v),value);assert.ok(index>=0,`${name} has ${value}`);
    const b=s.locator('..').locator('> .select-trigger');await b.click();await p.locator('#'+await b.getAttribute('aria-controls')).locator(`[data-index="${index}"]`).click();};
  const configure=async(p,kind)=>{await p.locator(`[data-console-action="models.save"][data-kind="${kind}"]`).click();await op(p).locator('form [data-model-discovery]').waitFor();};
  const box=p=>op(p).locator('[data-model-discovery]'),status=p=>box(p).locator('[data-discover-status]');
  const {context,page,errors}=await newPage({width:1440,height:1000},{account:0});
  await page.goto(cfg.url+'/app/models');await settle(page);

  // Unsaved form: no model name or dimensions are needed to list models; consent is explicit and per attempt.
  await configure(page,'organizer');
  const enable=await op(page).locator('input[name=enabled]').locator('..').innerText();
  check(S,'The enable checkbox reads 启用 (an action), not the 已启用 status',enable.trim()==='启用');
  await op(page).locator('[name=base_url]').fill(cfg.model_url);await op(page).locator('[name=api_key]').fill(TYPED);
  check(S,'The key note says the typed key is used this time only',(await box(page).locator('[data-discover-key]').innerText()).includes('仅本次'));
  const before=(await requests()).length;
  await box(page).locator('[data-discover-models]').click();
  check(S,'Without consent nothing is requested and the reason is shown',(await requests()).length===before&&(await status(page).innerText()).includes('仅本次'));
  await box(page).locator('[name=discover_consent]').check();
  // Keyboard: the Discover control is a normal button reached and activated from the keyboard.
  await box(page).locator('[data-discover-models]').focus();await page.keyboard.press('Enter');
  await box(page).locator('[data-discovered-model]').waitFor({state:'attached'});
  const listed=await requests();
  check(S,'One list request with the typed key, without a model name',listed.length===before+1&&listed.at(-1).authorized===true&&listed.at(-1).url==='/models');
  const options=await box(page).locator('[data-discovered-model] option').allInnerTexts();
  check(S,'Returned models are offered, sorted, after a prompt',options.length===5&&options.slice(1).join('|')==='<b>markup-like</b>|synthetic-chat-large|synthetic-chat-mini|synthetic-embed-small');
  check(S,'A markup-like model ID is plain text, never markup',await box(page).locator('[data-discovered-model] b').count()===0);
  check(S,'The status reports the count',(await status(page).innerText()).includes('找到模型 4'));
  await pick(page,'discovered_model','synthetic-chat-mini');
  check(S,'Choosing a model fills the model name; the address and typed key drafts are kept',await op(page).locator('[name=model]').inputValue()==='synthetic-chat-mini'
    &&await op(page).locator('[name=base_url]').inputValue()===cfg.model_url&&await op(page).locator('[name=api_key]').inputValue()===TYPED);
  check(S,'Discovery saved nothing',(await config()).length===0);
  check(S,'1440 zh: the discovery block fits without horizontal overflow',await noOverflow(page));
  await shot(page,'models-01-discovery-1440-zh');
  check(S,'Consent covered one request: the box is cleared afterwards',!(await box(page).locator('[name=discover_consent]').isChecked()));
  const unconsented=(await requests()).length;await box(page).locator('[data-discover-models]').click();
  check(S,'A second request without a new tick is not sent',(await requests()).length===unconsented&&(await status(page).innerText()).includes('仅本次'));

  // A newer request while one is pending: the server answers it as pending, and the older reply is then stale.
  await command('model-list-hold');
  await box(page).locator('[name=discover_consent]').check();await box(page).locator('[data-discover-models]').click();await status(page).filter({hasText:'正在请求'}).waitFor();
  await op(page).locator('[name=api_key]').fill(TYPED+'-x');await op(page).locator('[name=api_key]').fill(TYPED);
  check(S,'An edit clears consent and re-enables the button while the old request is pending',!(await box(page).locator('[name=discover_consent]').isChecked())&&await box(page).locator('[data-discover-models]').isEnabled());
  await box(page).locator('[name=discover_consent]').check();await box(page).locator('[data-discover-models]').click();
  await status(page).filter({hasText:'仍在进行'}).waitFor();
  await command('model-list-release');await page.waitForTimeout(300);
  check(S,'The superseded reply is ignored; the newer request\'s pending answer stays',await box(page).locator('[data-discovered-model]').count()===0&&(await status(page).innerText()).includes('仍在进行'));

  // Stale replies: editing the address, or closing the dialog, while a reply is held means it is never shown.
  await command('model-list-hold');
  await box(page).locator('[name=discover_consent]').check();await box(page).locator('[data-discover-models]').click();await status(page).filter({hasText:'正在请求'}).waitFor();
  await op(page).locator('[name=base_url]').fill(cfg.model_url+'/');
  await command('model-list-release');await page.waitForTimeout(300);
  check(S,'An address edit while a reply is pending discards that reply',await box(page).locator('[data-discovered-model]').count()===0&&(await status(page).innerText())==='');
  await op(page).locator('[name=base_url]').fill(cfg.model_url);

  // Save with the discovered model, then the saved key is reused for the saved address (never shown).
  await op(page).locator('input[name=enabled]').check();await op(page).locator('input[name=egress_approved]').check();
  await op(page).locator('button[type=submit]').click();await op(page).locator('.operation-result').first().waitFor({state:'attached'});
  const saved=(await config()).find(m=>m.kind==='organizer');
  check(S,'Saving keeps the discovered model and the typed key (sealed server-side)',saved?.config.model==='synthetic-chat-mini'&&saved.has_key===1);
  await op(page).locator('[data-operation-close]').first().click();await op(page).waitFor({state:'hidden'});await settle(page);
  await configure(page,'organizer');
  check(S,'Reopened: the key field is empty and the saved key will be used',await op(page).locator('[name=api_key]').inputValue()===''&&(await box(page).locator('[data-discover-key]').innerText()).includes('已保存'));
  await box(page).locator('[name=discover_consent]').check();const n=(await requests()).length;
  await command('model-list-hold');await box(page).locator('[data-discover-models]').click();await status(page).filter({hasText:'正在请求'}).waitFor();
  await op(page).locator('[data-operation-close]').first().click();await op(page).waitFor({state:'hidden'});
  await command('model-list-release');await page.waitForTimeout(300);
  await configure(page,'organizer');
  check(S,'A reply that arrives after the dialog closed is not shown when it reopens',await box(page).locator('[data-discovered-model]').count()===0&&(await status(page).innerText())==='');
  check(S,'The saved key was sent for the saved address',(await requests()).length===n+1&&(await requests()).at(-1).authorized===true);
  check(S,'No password field ever shows the saved key',!(await page.content()).includes(TYPED));
  await op(page).locator('[data-operation-close]').first().click();await op(page).waitFor({state:'hidden'});

  // Embedder: dimensions beside the model name; both cards share one aligned layout.
  await configure(page,'embedder');
  await op(page).locator('[name=base_url]').fill(cfg.model_url);await op(page).locator('[name=model]').fill('synthetic-embed-small');await op(page).locator('[name=dimensions]').fill('3');
  await op(page).locator('input[name=enabled]').check();await op(page).locator('input[name=egress_approved]').check();
  await op(page).locator('button[type=submit]').click();await op(page).locator('.operation-result').first().waitFor({state:'attached'});
  await op(page).locator('[data-operation-close]').first().click();await op(page).waitFor({state:'hidden'});await settle(page);
  check(S,'Closing the saved result returns focus to that card\'s Configure button',await page.evaluate(()=>document.activeElement?.matches('[data-console-action="models.save"][data-kind="embedder"]')===true));
  const name=await page.locator('.model-card').nth(1).locator('.metadata-grid dd').first().innerText();
  check(S,'Embedder dimensions sit beside the model name',/synthetic-embed-small\s+3\s*维/.test(name));
  check(S,'No separate dimensions row shifts the embedder card',await page.locator('.model-card').nth(1).locator('.metadata-grid dt').filter({hasText:/^维度$/}).count()===0);
  const boxes=await page.locator('.model-card').evaluateAll(cards=>cards.map(c=>{const r=c.getBoundingClientRect(),t=c.querySelector(':scope > .action-toolbar')?.getBoundingClientRect();return {top:r.top,height:r.height,toolbar:t?.top};}));
  check(S,'Both model cards are equally tall with their action rows aligned',Math.abs(boxes[0].height-boxes[1].height)<1&&Math.abs(boxes[0].toolbar-boxes[1].toolbar)<1);
  await shot(page,'models-02-cards-1440-zh');
  check(S,'No page errors (1440 zh)',errors.length===0);
  await context.close();

  // English and narrow widths: the discovery block and cards wrap inside the viewport.
  for(const [width,height] of [[390,844],[320,720]]){
    const {context:c,page:p,errors:e}=await newPage({width,height},{account:0,locale:'en'});
    await p.goto(cfg.url+'/app/models');await settle(p);
    check(S,`${width} en: cards without horizontal overflow`,await noOverflow(p));await shot(p,`models-03-cards-${width}-en`);
    await configure(p,'organizer');await box(p).locator('[name=discover_consent]').check();await box(p).locator('[data-discover-models]').click();
    await box(p).locator('[data-discovered-model]').waitFor({state:'attached'});
    check(S,`${width} en: discovery results and key note in English`,(await status(p).innerText()).startsWith('Models found 4')&&(await box(p).locator('[data-discover-key]').innerText()).includes('saved key'));
    const fits=await op(p).evaluate(d=>{const r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+0.5&&d.scrollWidth<=d.clientWidth+1;});
    check(S,`${width} en: the dialog and discovery block fit the viewport`,fits&&await noOverflow(p));
    await shot(p,`models-04-discovery-${width}-en`,false);
    check(S,`No page errors (${width} en)`,e.length===0);await c.close();
  }
}

// ---------------------------------------------------------------- Merge target search races
async function lifecycleSearchSection() {
  const S='lifecycle-search';await command('seed-lifecycle');
  const {context,page,errors}=await newPage({width:1440,height:1000},{account:0});
  const dialog=page.locator('#operation-dialog'),targets=dialog.locator('[data-lifecycle-targets]');
  const search=dialog.locator('[data-lifecycle-search]'),preview=dialog.locator('[data-lifecycle-preview]');
  const radio=id=>targets.locator(`input[value="${id}"]`),source='synthetic-life-src',target='synthetic-life-tgt';
  const posts=[];page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/console-api/action')){
    const body=new URLSearchParams(r.postData()||'');posts.push({action:body.get('action'),payload:JSON.parse(body.get('payload')||'{}')});
  }});
  const pending=new Map(),gates=[];
  const isSearch=(url,query)=>url.pathname==='/console-api/projects'&&url.searchParams.get('archived')==='any'&&(url.searchParams.get('query')||'')===query;
  const hold=query=>{let release,ready;const wait=new Promise(r=>release=r),received=new Promise(r=>ready=r);
    const gate={wait,ready,release,received,async deliver(){const response=page.waitForResponse(r=>isSearch(new URL(r.url()),query));release();await(await response).finished();await frame(page);}};
    pending.set(query,gate);gates.push(gate);return gate;
  };
  // Each gate fetches the actual owner-bound BFF response first and holds only its delivery.
  await page.route(/\/console-api\/projects\?/,async route=>{
    const url=new URL(route.request().url()),query=url.searchParams.get('query')||'',gate=pending.get(query);
    if(!isSearch(url,query)||!gate)return route.continue();pending.delete(query);
    const response=await route.fetch();gate.ready(await response.json());await gate.wait;await route.fulfill({response});
  });
  try{
    await page.goto(cfg.url+'/app/tasks');
    const merge=page.locator(`[data-project-row="${source}"] [data-console-action="projects.merge"]`);await merge.waitFor();
    const open=async()=>{await merge.click();await radio(target).waitFor();};
    const close=async()=>{await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});};
    await open();
    const first=hold('Lifecycle Target');await search.fill('Lifecycle Target');const data=await first.received;
    check(S,'The held response is a real matching owner-scoped project search',data.read_only===true&&data.projects.some(p=>p.project_id===target)&&!data.projects.some(p=>p.project_id==='synthetic-browser-project-1'));
    await radio(target).check();const oldRadio=await radio(target).elementHandle();
    check(S,'The visible target can be selected while search delivery is pending',await radio(target).isChecked());
    check(S,'Pending search announces busy and cannot preview a not-yet-validated choice',await targets.getAttribute('aria-busy')==='true'&&await preview.isDisabled());
    await radio(target).focus();await page.keyboard.press('Enter');await frame(page);
    check(S,'Enter during the held search sends no preview or confirm',posts.length===0);
    await first.deliver();await page.waitForFunction(node=>!node.isConnected,oldRadio);await oldRadio.dispose();
    check(S,'A target selected during search stays selected when the latest real response still contains its exact ID',await radio(target).isChecked()&&await preview.isEnabled());
    check(S,'The settled choice is no longer busy and keyboard focus follows its replacement radio',await targets.getAttribute('aria-busy')==='false'&&await radio(target).evaluate(input=>document.activeElement===input));
    await shot(page,'lifecycle-search-01-preserved-selection',false);

    const absent=hold('Lifecycle Keep');await search.fill('Lifecycle Keep');await absent.received;await absent.deliver();
    check(S,'A choice absent from latest eligible results is cleared rather than replaced by another target',await radio(target).count()===0&&await targets.locator('input:checked').count()===0&&await preview.isDisabled()&&await radio('synthetic-life-keep').count()===1);
    // A superseded broad result is delivered while the newer narrow result is still held.
    const old=hold('Lifecycle');await search.fill('Lifecycle');await old.received;
    const latest=hold('Lifecycle Target');await search.fill('Lifecycle Target');await old.deliver();
    check(S,'A reply for an edited query cannot replace the visible list or end the newer query busy state',await radio('synthetic-life-keep').count()===1&&await radio(target).count()===0&&await targets.getAttribute('aria-busy')==='true'&&await preview.isDisabled());
    await latest.received;await latest.deliver();await radio(target).check();
    // Now deliver the older broad result after a newer response and an explicit user choice.
    const older=hold('Lifecycle');await search.fill('Lifecycle');await older.received;
    const newer=hold('Lifecycle Target');await search.fill('Lifecycle Target');await newer.received;await newer.deliver();
    await radio(target).check();await older.deliver();
    check(S,'An out-of-order response cannot replace the newer list, exact selection, or enabled Preview',await targets.locator('input').count()===1&&await radio(target).isChecked()&&await preview.isEnabled()&&await targets.getAttribute('aria-busy')==='false');

    const empty=hold('Synthetic no matching lifecycle project');await search.fill('Synthetic no matching lifecycle project');const emptyData=await empty.received;await empty.deliver();
    check(S,'A real empty result clears the choice and keeps Preview disabled',emptyData.projects.length===0&&await targets.locator('input').count()===0&&await preview.isDisabled());
    await close();await open();
    const cancelled=hold('Lifecycle Keep');await search.fill('Lifecycle Keep');await cancelled.received;await close();await cancelled.deliver();
    check(S,'A search delivered after Escape cannot reopen the cancelled dialog',!(await dialog.isVisible()));
    await open();
    const previousDialog=hold('Lifecycle Keep');await search.fill('Lifecycle Keep');await previousDialog.received;await close();await open();await radio(target).check();await previousDialog.deliver();
    check(S,'A search from a cancelled dialog cannot replace the newer dialog or its selected target',await search.inputValue()===''&&await radio(target).isChecked()&&await preview.isEnabled()&&await targets.getAttribute('aria-busy')==='false');
    check(S,'The source and another owner project are never eligible targets',await radio(source).count()===0&&await radio('synthetic-browser-project-1').count()===0);
    await preview.click();const confirm=dialog.locator('form[data-lifecycle-step="confirm"]');await confirm.waitFor();
    const request=posts.at(-1);
    check(S,'The explicit preview submits the retained exact source and target and still requires fresh factors',request?.action==='projects.lifecycle_preview'&&request.payload.project_id===source&&request.payload.target_project_id===target&&await confirm.locator('[name=current_password]').count()===1&&await confirm.locator('[name=otp]').count()===1);
    await close();const state=await command('lifecycle-state',{project_ids:[source,target]});
    check(S,'Search, preview, and Cancel send no merge confirmation and leave both projects live',posts.length===1&&posts.every(p=>p.action==='projects.lifecycle_preview')&&state.states[source]==='live'&&state.states[target]==='live'&&state.canonical[source]===source);
    check(S,'No page errors',errors.length===0);
  }finally{for(const gate of gates)gate.release();await context.close();}
}

// ---------------------------------------------------------------- Project lifecycle (5G)
async function lifecycleSection() {
  const S='lifecycle';
  const seed=await command('seed-lifecycle');const names=seed.projects;
  const state=async(...ids)=>(await command('lifecycle-state',{project_ids:ids})).states;
  const canonical=async id=>(await command('lifecycle-state',{project_ids:[id]})).canonical[id];
  const settle=async p=>{await p.locator('#console-root h1').waitFor();await p.locator('.loading-card').waitFor({state:'detached'});await p.locator('.project-list,.view-switch').first().waitFor();};
  const op=p=>p.locator('#operation-dialog');
  const row=(p,id)=>p.locator(`[data-project-row="${id}"]`);
  const factors=async(p,{otp}={})=>{await op(p).locator('[name=current_password]').fill(cfg.password);await op(p).locator('[name=otp]').fill(otp??(await command('otp',{fresh:true})).otp);};
  const confirmForm=p=>op(p).locator('form[data-lifecycle-step="confirm"]');
  const {context,page,errors}=await newPage({width:1440,height:1000},{account:0});
  const posts=[];page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/console-api/action'))posts.push(new URLSearchParams(r.postData()||'').get('action'));});
  const confirms=()=>posts.filter(a=>a!=='projects.lifecycle_preview').length;
  // The project list holds 26+ projects; find a row by switching pages until it appears.
  // A view switch is done when that view's button is the pressed one (the previous list can still be on screen before).
  const switchView=async(p,view)=>{await p.locator(`[data-project-view="${view}"]`).click();await p.locator(`[data-project-view="${view}"][aria-pressed="true"]`).waitFor();await settle(p);};
  const showRow=async(p,id,view='false')=>{await switchView(p,view);
    // Page forward with the project pager's Next button (its data offset is past the current one) until the row shows.
    for(let i=0;i<4&&!(await row(p,id).count());i++){const next=p.locator('[data-project-offset]').filter({hasText:/下一页|Next/});if(!(await next.count()))break;await next.first().click();await settle(p);}
    await row(p,id).waitFor();};
  await page.goto(cfg.url+'/app/tasks');await settle(page);
  check(S,'Three project views (active, archived, deleted) with server counts',await page.locator('[data-project-view]').count()===3&&(await page.locator('[data-project-view="deleted"] .figure').innerText()).trim()==='0');

  // Delete: the preview shows the impact, the typed-name box and the re-authentication fields.
  await showRow(page,'synthetic-life-del');
  const del=row(page,'synthetic-life-del').locator('[data-console-action="projects.lifecycle_delete"]');
  await del.focus();await page.keyboard.press('Enter');await confirmForm(page).waitFor();
  check(S,'Delete opens from the keyboard with impact, typed name and password + code fields',await op(page).locator('.lifecycle-impact').count()===1&&await op(page).locator('[name=confirm_name]').count()===1&&await op(page).locator('[name=current_password]').count()===1&&await op(page).locator('[name=otp]').count()===1);
  check(S,'The impact lists the project, its task and its memory',(await op(page).locator('.lifecycle-impact').innerText()).includes(names['synthetic-life-del'].slice(0,20)));
  await op(page).evaluate(async d=>{await Promise.all(d.getAnimations({subtree:true}).map(a=>a.finished));});
  await shot(page,'lifecycle-01-delete-preview-1440-zh');
  // Cancel writes nothing (no confirm) and returns focus to the Delete button.
  await op(page).locator('[data-operation-close]').first().click();await op(page).waitFor({state:'hidden'});
  check(S,'Cancel sends no confirm and leaves the project live',confirms()===0&&(await state('synthetic-life-del'))['synthetic-life-del']==='live');
  check(S,'Cancel returns focus to the Delete button',await page.evaluate(()=>document.activeElement?.dataset?.consoleAction==='projects.lifecycle_delete'));

  // A typo in the name is answered before the factors are used; wrong factors are refused and cleared.
  await del.click();await confirmForm(page).waitFor();
  await op(page).locator('[name=confirm_name]').fill('Synthetic typo');await factors(page);
  const code=await op(page).locator('[name=otp]').inputValue();
  await op(page).locator('form[data-lifecycle-step="confirm"] button[type=submit]').click();
  await op(page).locator('[data-operation-error]').filter({hasText:/名称|name/}).waitFor();
  check(S,'A name typo is refused, the project stays live, and focus is on the name field',(await state('synthetic-life-del'))['synthetic-life-del']==='live'&&await page.evaluate(()=>document.activeElement?.name==='confirm_name'));
  check(S,'After a name typo the (unused) factors are kept',await op(page).locator('[name=otp]').inputValue()===code&&await op(page).locator('[name=current_password]').inputValue()===cfg.password);
  await op(page).locator('[name=confirm_name]').fill(names['synthetic-life-del']);await op(page).locator('[name=otp]').fill('000000');
  const typoText=await op(page).locator('[data-operation-error]').innerText();
  await op(page).locator('form[data-lifecycle-step="confirm"] button[type=submit]').click();
  await page.waitForFunction(old=>{const n=document.querySelector('#operation-dialog [data-operation-error]');return n&&n.textContent&&n.textContent!==old;},typoText);
  check(S,'Wrong factors are refused, cleared, and the typed name kept',(await state('synthetic-life-del'))['synthetic-life-del']==='live'&&await op(page).locator('[name=otp]').inputValue()===''&&await op(page).locator('[name=confirm_name]').inputValue()===names['synthetic-life-del']);
  // A stale preview (an unrelated write) is refreshed in place; the typed name and factors are kept and still work.
  await command('unrelated-write');
  await factors(page);const before=await confirmForm(page).getAttribute('data-preview-id');
  await op(page).locator('form[data-lifecycle-step="confirm"] button[type=submit]').click();
  await op(page).locator('[data-lifecycle-message]').waitFor();
  check(S,'A stale preview is refreshed in place; the name and password are kept and a new code is asked for',await confirmForm(page).getAttribute('data-preview-id')!==before&&await op(page).locator('[name=confirm_name]').inputValue()===names['synthetic-life-del']&&await op(page).locator('[name=current_password]').inputValue()===cfg.password&&await op(page).locator('[name=otp]').inputValue()==='');
  check(S,'The refresh message has focus for screen readers',await page.evaluate(()=>document.activeElement?.hasAttribute('data-lifecycle-message')));
  // Repeated submission sends one confirm: Enter pressed twice in the code field.
  await op(page).locator('[name=otp]').fill((await command('otp',{fresh:true})).otp);
  const sent=confirms();await op(page).locator('[name=otp]').focus();await page.keyboard.press('Enter');await page.keyboard.press('Enter');
  await op(page).locator('[data-lifecycle-result]').waitFor();
  check(S,'Enter pressed twice sends one confirm and the project is deleted',confirms()-sent===1&&(await state('synthetic-life-del'))['synthetic-life-del']==='deleted');
  check(S,'The result is announced and focused',await page.evaluate(()=>document.activeElement?.hasAttribute('data-lifecycle-result')));
  await shot(page,'lifecycle-02-delete-result-1440-zh');
  await op(page).locator('[data-operation-close]').first().click();await op(page).waitFor({state:'hidden'});await settle(page);

  // Deleted view and restore.
  await switchView(page,'deleted');await row(page,'synthetic-life-del').waitFor({timeout:5000}).catch(()=>{});
  check(S,'The deleted view lists the project with Restore',await row(page,'synthetic-life-del').locator('[data-console-action="projects.lifecycle_restore"]').count()===1);
  await shot(page,'lifecycle-03-deleted-view-1440-zh');
  await row(page,'synthetic-life-del').locator('[data-console-action="projects.lifecycle_restore"]').click();await confirmForm(page).waitFor();
  check(S,'Restore needs no typed name but does need factors',await op(page).locator('[name=confirm_name]').count()===0&&await op(page).locator('[name=otp]').count()===1);
  await factors(page);await op(page).locator('form[data-lifecycle-step="confirm"] button[type=submit]').click();await op(page).locator('[data-lifecycle-result]').waitFor();
  check(S,'Restore brings the project back',(await state('synthetic-life-del'))['synthetic-life-del']==='live');
  await op(page).locator('[data-operation-close]').first().click();await op(page).waitFor({state:'hidden'});await settle(page);

  // Merge: searchable targets, conflicts, Back writes nothing, the no-undo statement, then the merge.
  await showRow(page,'synthetic-life-src');
  await row(page,'synthetic-life-src').locator('[data-console-action="projects.merge"]').click();
  await op(page).locator('[data-lifecycle-search]').waitFor();
  await op(page).locator('[data-lifecycle-search]').fill('Lifecycle Target');
  await op(page).locator('[data-lifecycle-targets] input[value="synthetic-life-tgt"]').waitFor();
  check(S,'Target search lists matching projects and never the source',await op(page).locator('[data-lifecycle-targets] input[value="synthetic-life-src"]').count()===0);
  await op(page).locator('[data-lifecycle-targets] input[value="synthetic-life-tgt"]').check();
  await op(page).locator('[data-lifecycle-preview]').click();await confirmForm(page).waitFor();
  const impact=await op(page).locator('.lifecycle-impact').innerText();
  check(S,'Merge preview shows the same-title conflict and the no-undo statement',/Shared lifecycle task/.test(impact)&&await op(page).locator('.lifecycle-conflicts li').count()>=1&&/撤销/.test(impact));
  await shot(page,'lifecycle-04-merge-preview-1440-zh');
  const beforeBack=confirms();await op(page).locator('[data-lifecycle-back]').click();await op(page).locator('[data-lifecycle-search]').waitFor();
  check(S,'Back returns to target choice and writes nothing',confirms()===beforeBack&&(await state('synthetic-life-src'))['synthetic-life-src']==='live');
  // Keyboard only, after the current query is ready: pending-search selection is exercised with
  // held real replies in lifecycleSearchSection, including its disabled Preview and retained focus.
  await op(page).locator('[data-lifecycle-search]').fill('Lifecycle Target');const radio=op(page).locator('[data-lifecycle-targets] input[value="synthetic-life-tgt"]');await radio.waitFor();
  await op(page).locator('[data-lifecycle-targets][aria-busy="false"]').waitFor();
  await radio.focus();await page.keyboard.press('Space');
  check(S,'A target is chosen from the keyboard',await radio.isChecked()&&await op(page).locator('[data-lifecycle-preview]').isEnabled());
  await op(page).locator('[data-lifecycle-preview]').focus();await page.keyboard.press('Enter');await confirmForm(page).waitFor();
  await factors(page);await op(page).locator('form[data-lifecycle-step="confirm"] button[type=submit]').click();await op(page).locator('[data-lifecycle-result]').waitFor();
  check(S,'The merge routes the source to the target',await canonical('synthetic-life-src')==='synthetic-life-tgt');
  await op(page).locator('[data-operation-close]').first().click();await op(page).waitFor({state:'hidden'});await settle(page);
  await showRow(page,'synthetic-life-tgt');
  check(S,'The target lists its merged project',(await row(page,'synthetic-life-tgt').innerText()).includes('synthetic-life-src')&&await row(page,'synthetic-life-src').count()===0);

  if(process.env.LC_DEBUG)console.log('STEP late-responses');
  // Late and reordered responses: a slow first preview never replaces a newer one; a reply after Cancel never reopens.
  // The server handles each request at once; only the delivery of the chosen reply is delayed (a slow network), so the
  // request itself is valid and the late reply carries a real preview.
  let delay=true;await page.route('**/console-api/action',async route=>{const action=new URLSearchParams(route.request().postData()||'').get('action');
    const slow=action==='projects.lifecycle_preview'&&delay;if(slow)delay=false;const response=await route.fetch();
    if(slow)await new Promise(r=>setTimeout(r,1200));await route.fulfill({response});});
  await showRow(page,'synthetic-life-keep');
  await row(page,'synthetic-life-keep').locator('[data-console-action="projects.lifecycle_delete"]').click();
  await page.waitForTimeout(150);await op(page).locator('[data-operation-close]').first().click();await op(page).waitFor({state:'hidden'});
  await page.waitForTimeout(1500);
  check(S,'A preview that arrives after Cancel never reopens the dialog',!(await op(page).isVisible()));
  // Reordered replies across Cancel and reopen: the slow reply of the first dialog arrives after the second dialog's reply.
  const previewIds=[];page.on('response',async r=>{if(r.url().endsWith('/console-api/action')&&new URLSearchParams(r.request().postData()||'').get('action')==='projects.lifecycle_preview'){try{previewIds.push((await r.json()).preview_id);}catch{}}});
  delay=true;await row(page,'synthetic-life-keep').locator('[data-console-action="projects.lifecycle_delete"]').click();await page.waitForTimeout(100);
  await op(page).locator('[data-operation-close]').first().click();await op(page).waitFor({state:'hidden'});
  await row(page,'synthetic-life-keep').locator('[data-console-action="projects.lifecycle_delete"]').click();await confirmForm(page).waitFor({timeout:5000});
  const shownFirst=await confirmForm(page).getAttribute('data-preview-id');await page.waitForTimeout(1500);
  check(S,'A slow reply from a cancelled dialog never replaces the newer preview',previewIds.length>=2&&previewIds.every(Boolean)&&await confirmForm(page).getAttribute('data-preview-id')===shownFirst&&shownFirst===previewIds[0]&&previewIds.at(-1)!==shownFirst);
  const first=await confirmForm(page).getAttribute('data-preview-id');delay=true;
  await op(page).locator('[data-lifecycle-refresh]').click();await page.waitForTimeout(100);
  check(S,'The confirm stays disabled while a refresh is pending',await op(page).locator('form[data-lifecycle-step="confirm"] button[type=submit]').isDisabled());
  await op(page).locator('[data-lifecycle-message]').waitFor({timeout:5000});
  check(S,'The refreshed preview replaces the old one',await confirmForm(page).getAttribute('data-preview-id')!==first);
  await page.unroute('**/console-api/action');
  if(process.env.LC_DEBUG)console.log('STEP revoked');
  // A revoked session cannot confirm.
  await op(page).locator('[name=confirm_name]').fill(names['synthetic-life-keep']);await factors(page);
  await command('revoke-console-sessions');
  await op(page).locator('form[data-lifecycle-step="confirm"] button[type=submit]').click();
  await page.waitForURL(/\/login/,{timeout:10000});
  check(S,'A revoked session cannot delete: the browser is sent to sign-in and the project stays live',/\/login/.test(page.url())&&(await state('synthetic-life-keep'))['synthetic-life-keep']==='live');
  check(S,'No page errors (1440 zh)',errors.length===0);
  await context.close();
  cfg.accounts[0].token=(await command('cookies',{owner:0})).token;

  // The language and width matrix: zh and en at 1440, 390 and 320 (zh 1440 is the run above).
  for(const [width,height,locale] of [[1440,1000,'en'],[390,844,'en'],[320,720,'en'],[390,844,'zh-CN'],[320,720,'zh-CN']]){
    const {context:c,page:p,errors:e}=await newPage({width,height},{account:0,locale});const tag=`${width} ${locale==='en'?'en':'zh'}`;
    await p.goto(cfg.url+'/app/tasks');await settle(p);await showRow(p,'synthetic-life-keep');
    check(S,`${tag}: list without horizontal overflow`,await noOverflow(p));
    await row(p,'synthetic-life-keep').locator('[data-console-action="projects.lifecycle_delete"]').click();await confirmForm(p).waitFor();
    const fits=await op(p).evaluate(d=>{const r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+0.5&&d.scrollWidth<=d.clientWidth+1;});
    check(S,`${tag}: the delete dialog fits, in its language`,fits&&await noOverflow(p)&&(locale==='en'?/Impact/:/影响范围/).test(await op(p).locator('.lifecycle-impact').innerText()));
    const opacity=await op(p).evaluate(async d=>{await Promise.all(d.getAnimations({subtree:true}).map(a=>a.finished));return getComputedStyle(d).opacity;});
    check(S,`${tag}: the dialog is settled and opaque before capture`,opacity==='1');
    await shot(p,`lifecycle-05-delete-${width}-${locale==='en'?'en':'zh'}`,false);
    await op(p).locator('[data-operation-close]').first().click();await op(p).waitFor({state:'hidden'});
    check(S,`No page errors (${tag})`,e.length===0);await c.close();
  }
}

let exitCode=0;
try{
  cfg=await read();assert.equal(cfg.fixture,true);assert.match(cfg.url,/^http:\/\/127\.0\.0\.1:/);
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  if(requested.includes('otp'))await otpSection();
  if(requested.includes('summaries'))await summariesSection();
  if(requested.includes('projects'))await projectsSection();
  if(requested.includes('models'))await modelsSection();
  if(requested.includes('lifecycle-search'))await lifecycleSearchSection();
  if(requested.includes('lifecycle'))await lifecycleSection();
}catch(error){exitCode=1;console.error(`FAIL ${error.message}`);}
finally{
  await browser?.close();
  fixture.stdin.write(JSON.stringify({command:'stop'})+'\n');
  await new Promise(r=>fixture.once('exit',r));
  fs.writeFileSync(path.join(evidence,'checks.json'),JSON.stringify({sections:requested,passed:checks.length,failed:exitCode,checks},null,1),{mode:0o600});
  // A failing run keeps the private fixture log for local diagnosis; it is never copied into evidence.
  if(exitCode)console.error('Private fixture log (not evidence): '+privateLog);else fs.rmSync(privateLog,{recursive:true,force:true});
  console.log(`${exitCode?'FAILED':'PASSED'} ${checks.length} checks; evidence ${evidence}`);
}
process.exit(exitCode);
