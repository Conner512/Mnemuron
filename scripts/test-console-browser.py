import os,json,subprocess,time,traceback,select,shutil,tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
repo=Path(__file__).resolve().parents[1]
E=Path(tempfile.mkdtemp(prefix='mnemuron-browser-test-',dir=os.environ.get('RUNNER_TEMP')));os.chmod(E,0o700)
P=E/'previews';P.mkdir();node=shutil.which('node');checks=[]
print('Isolated browser evidence directory: '+str(E),flush=True)
err=open(E/'browser-fixture.stderr','w')
proc=subprocess.Popen([node,'services/oauth/test/helpers/console-functional-preview.mjs'],cwd=repo,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=err,text=True,bufsize=1)
def line(timeout=30):
 end=time.time()+timeout
 while time.time()<end:
  if select.select([proc.stdout],[],[],1)[0]:
   r=proc.stdout.readline()
   if not r: raise RuntimeError('Fixture exited: '+(E/'browser-fixture.stderr').read_text()[-2000:])
   if r.strip().startswith('{'): return json.loads(r)
 raise RuntimeError('Fixture timeout')
def cmd(command,**kwargs):
 proc.stdin.write(json.dumps(dict(command=command,**kwargs))+'\n');proc.stdin.flush();return line()
def check(name,condition=True):
 if not condition:raise AssertionError(name)
 checks.append(name)
 print('PASS',name,flush=True)
try:
 cfg=line(); url=cfg['url']
 with sync_playwright() as pw:
  browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE') or shutil.which('google-chrome') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
  context=browser.new_context(viewport={'width':1440,'height':1100},accept_downloads=True)
  context.add_cookies([dict(name=cfg['cookie'],value=cfg['accounts'][0]['token'],url=url,httpOnly=True,sameSite='Lax')])
  page=context.new_page();errors=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  page.on('console',lambda m:errors.append(m.text) if m.type=='error' and ('Content Security Policy' in m.text or 'Refused' in m.text) else None)
  def goto(name):
   page.goto(url+'/app/'+name);page.wait_for_function("document.querySelector('#console-root')?.querySelector('h1') && !document.querySelector('.loading-card')")
   page.wait_for_timeout(180)
  def begin(a,index=0):
   page.locator('[data-console-action="'+a+'"]').nth(index).click();page.locator('#operation-dialog form').wait_for()
  def submit():
   page.locator('#operation-dialog button[type=submit]').click();page.locator('#operation-dialog .operation-result').wait_for(timeout=40000)
   return json.loads(page.locator('#operation-dialog .operation-result').inner_text())
  def close():
   page.locator('#operation-dialog [data-operation-close]').first.click();page.wait_for_timeout(150)
  goto('overview');check('Actual HTTP assets, modules and CSP render overview',page.locator('#console-root h1').count()==1)
  goto('memories');check('New-memory action is enabled by real capabilities',page.locator('[data-console-action="memory.create"]').is_enabled())
  begin('memory.create');page.locator('[name=content]').fill('Synthetic browser created memory：型号 C9800-CL。');created=submit();check('UI creates persistent memory',created['status']=='saved');mid=created['memory_id'];close()
  page.locator('[data-memory="'+mid+'"]').click();page.locator('#memory-dialog [data-console-action="memory.classify"]').wait_for()
  begin('memory.classify');page.locator('#operation-dialog [name=category]').select_option('technical');r=submit();check('Manual classification reaches backend',r['category']=='technical');close()
  page.locator('[data-memory="'+mid+'"]').click();begin('memory.visibility');page.locator('#operation-dialog [name=allow]').check();r=submit();check('Exact-revision ChatGPT grant is persisted',r['allowed']);close()
  page.locator('[data-memory="'+mid+'"]').click();begin('memory.correct');page.locator('#operation-dialog [name=content]').fill('Synthetic browser corrected memory：型号 C9300。');r=submit();newmid=r['memory_id'];check('Correction creates replacement without overwriting history',newmid!=mid);close()
  page.locator('[data-memory="'+newmid+'"]').click();begin('memory.retract');r=submit();check('Retraction retains lifecycle tombstone',r['physically_deleted']==False);close()
  page.locator('[name=query]').fill('C9300');page.locator('[name=search_mode]').select_option('hybrid');page.locator('#search-form button[type=submit]').click();page.wait_for_timeout(200);check('Search form supports real retrieval-mode selection',page.locator('[name=search_mode]').input_value()=='hybrid')
  goto('models');begin('models.save');page.locator('[name=enabled]').check();page.locator('[name=base_url]').fill(cfg['model_url']);page.locator('[name=model]').fill('synthetic-organizer');page.locator('[name=sensitivity]').select_option('sensitive');page.locator('[name=egress_approved]').check();r=submit();check('Personal model settings persist through real API',r['model']['config']['model']=='synthetic-organizer');close()
  begin('models.test');r=submit();check('UI model test executes real loopback HTTP, no personal input',r['real_memory_sent']==False and r['status']=='verified');close()
  goto('jobs');begin('jobs.schedule');page.locator('[name=include_open]').check();r=submit();check('Classification is durably queued',len(r['jobs'])>=1);close();cmd('tick');page.locator('[data-retry]').click();page.wait_for_timeout(300);check('Worker publishes actual job results',page.locator('body').inner_text().count('succeeded')>0)
  begin('jobs.schedule');page.locator('[name=type]').select_option('summary');page.locator('[name=include_open]').check();r=submit();check('Summary scheduling returns actual jobs',len(r['jobs'])>=1);close();cmd('tick');cmd('tick');goto('summaries');check('Derived summaries show real worker result',page.locator('[data-summary]').count()>0)
  page.locator('[data-summary]').first.click();page.locator('#memory-content .body-content').first.wait_for();check('Summary drawer loads source-grounded quotes',len(page.locator('#memory-content .body-content').first.inner_text())>0);page.locator('#memory-dialog [data-close]').click()
  goto('connections');begin('connections.create');page.locator('[name=label]').fill('Synthetic browser connection');page.locator('[name=agent_id]').fill('browser-test');page.locator('[name=device_id]').fill('desktop-fixture');r=submit();credential=r['credential']['credential_id'];check('Connection creates real owner-bound memory-only key',r['api_key'].startswith('mnm_') and r['credential']['scopes']==['memory:read']);close()
  page.locator('[data-console-action="connections.rotate"][data-id="'+credential+'"]').click();r=submit();rotated=r['credential']['credential_id'];check('Key rotation creates replacement key',rotated!=credential);close()
  page.locator('[data-console-action="connections.revoke"][data-id="'+rotated+'"]').click();r=submit();check('Key revocation reaches backend',r['status']=='revoked');close()
  goto('storage');begin('storage.export')
  with page.expect_download() as download:
   r=submit()
  dest=E/'synthetic-personal-export.json';download.value.save_as(dest);doc=json.loads(dest.read_text());check('Download contains only this account, no credentials',doc['records'] and 'Synthetic private B sentinel' not in dest.read_text() and 'api_key' not in dest.read_text());close()
  begin('storage.import');page.locator('[name=file]').set_input_files(str(dest));page.locator('[name=confirm_import]').check();r=submit();check('Portable import adds personal records without overwriting',r['originals_overwritten']==False and r['created']>0);close()
  goto('invitations');begin('invitations.issue');page.locator('[name=count]').fill('2');page.locator('[name=ttl_minutes]').fill('10');page.locator('[name=current_password]').fill(cfg['password']);page.locator('#operation-dialog [name=otp]').fill(cmd('otp')['otp']);r=submit();check('Admin batch invitations use real reauthentication',len(r['codes'])==2);code=r['codes'][0];close()
  # Anonymous registration, using its own separate browser cookies and bound TOTP.
  registration=browser.new_context(viewport={'width':1440,'height':1100});rp=registration.new_page();rp.goto(url+'/register');rp.locator('[name=code]').fill(code);rp.locator('button[type=submit]').click();rp.wait_for_url('**/register/account')
  rp.locator('[name=username]').fill('Synthetic_Browser_New');rp.locator('[name=password]').fill('Synthetic new browser password');rp.locator('[name=password_confirm]').fill('Synthetic new browser password');rp.locator('button[type=submit]').click();rp.wait_for_url('**/register/totp');secret=rp.locator('#totp-secret').inner_text()
  otp=subprocess.run([node,'--input-type=module','-e',"import {generate} from './services/oauth/node_modules/otplib/dist/index.js'; console.log(await generate({secret:process.argv[1]}));",secret],cwd=repo,text=True,capture_output=True)
  if otp.returncode:raise RuntimeError(otp.stderr)
  rp.locator('[name=otp]').fill(otp.stdout.strip());rp.locator('button[type=submit]').click();rp.wait_for_url('**/register/recovery-codes');check('Registration binds actual TOTP and shows one-time recovery codes',rp.locator('.recovery-codes li').count()==8);rp.locator('button[type=submit]').click();rp.wait_for_url('**/register/status')
  for _ in range(12):
   if rp.locator('code').inner_text()=='active':break
   rp.wait_for_timeout(1000);rp.reload()
  check('New web registration activates through configured provisioning',rp.locator('code').inner_text()=='active');registration.close()
  # B uses the real sign-in form, not an A session or an identity selector.
  bctx=browser.new_context();bp=bctx.new_page();bp.goto(url+'/login');bp.locator('[name=username]').fill(cfg['accounts'][1]['username']);bp.locator('[name=password]').fill(cfg['password']);bp.locator('[name=otp]').fill(cmd('otp',owner=1)['otp']);bp.locator('button[type=submit]').click();bp.wait_for_url('**/app');bp.goto(url+'/app/memories');bp.locator('[data-memory]').first.wait_for();check('Real username/password/TOTP login isolates B content','Synthetic private B sentinel' in bp.inner_text('body') and '蓝色纸船' not in bp.inner_text('body'));bp.goto(url+'/app/invitations');bp.wait_for_timeout(200);check('Member sees no operator invitation controls',bp.locator('[data-console-action="invitations.issue"]').count()==0);bctx.close()
  for name in ['overview','memories','summaries','jobs','connections','models','security','audit','storage','appearance','invitations','accounts']:
   goto(name)
   check('Functional route '+name,page.locator('#console-root h1').count()==1 and page.locator('#console-root [role=alert]').count()==0)
  for width in [1280,1440,1920]:
   page.set_viewport_size({'width':width,'height':1080});goto('models')
   for theme in ['a','b','c']:
    for mode in ['light','dark']:
     for locale in ['zh-CN','en']:
      page.locator('#theme').select_option(theme);page.locator('#mode').select_option(mode);page.locator('#locale').select_option(locale)
      check('Desktop model forms '+str((width,theme,mode,locale)),page.evaluate('document.documentElement.scrollWidth<=innerWidth'))
  page.set_viewport_size({'width':1440,'height':1100});page.locator('#theme').select_option('a');page.locator('#mode').select_option('light');page.locator('#locale').select_option('zh-CN');goto('memories');page.screenshot(path=str(P/'memories-functional.png'),full_page=True)
  begin('memory.create');page.screenshot(path=str(P/'new-memory-functional.png'),full_page=True);close();goto('models');page.screenshot(path=str(P/'models-functional.png'),full_page=True)
  goto('jobs');page.screenshot(path=str(P/'jobs-functional.png'),full_page=True);goto('invitations');page.screenshot(path=str(P/'invitations-functional.png'),full_page=True)
  check('No browser JavaScript or CSP errors',not errors)
  browser.close()
 out={'status':'passed','count':len(checks),'checks':checks,'fixture':'real loopback Core/OAuth/BFF; synthetic local model; Chromium actual module/CSP loading'}; (E/'browser-result.json').write_text(json.dumps(out,ensure_ascii=False,indent=2));print('COMPLETE',len(checks),flush=True)
except Exception:
 (E/'browser-result.json').write_text(json.dumps({'status':'failed','count':len(checks),'checks':checks,'error':traceback.format_exc()},ensure_ascii=False,indent=2));raise
finally:
 try:
  proc.stdin.write('{"command":"stop"}\n');proc.stdin.flush()
 except:pass
 try:proc.wait(timeout=15)
 except:proc.kill()
 err.close()
