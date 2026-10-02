// Real browser and HTTP model contracts; all accounts, memories and vector storage are disposable synthetic fixtures.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..'),base=path.resolve(process.env.MNEMURON_UI_EVIDENCE||os.tmpdir());
assert.ok(base!==root&&!base.startsWith(root+path.sep));
const evidence=fs.mkdtempSync(path.join(base,'model-browser-'));fs.chmodSync(evidence,0o700);
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const log=fs.openSync(path.join(evidence,'fixture.stderr'),'wx',0o600);
const fixture=spawn(process.execPath,['services/oauth/test/helpers/console-functional-preview.mjs'],{cwd:root,stdio:['pipe','pipe',log]});
const queue=[],waiters=[];createInterface({input:fixture.stdout}).on('line',line=>{if(!line.startsWith('{'))return;const value=JSON.parse(line);if(waiters.length)waiters.shift()(value);else queue.push(value);});
async function read(){let timer;try{return await Promise.race([queue.length?Promise.resolve(queue.shift()):new Promise(r=>waiters.push(r)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Fixture timeout')),30000);})]);}finally{clearTimeout(timer);}}
async function command(command){fixture.stdin.write(JSON.stringify({command})+'\n');const r=await read();assert.ok(!r.fixture_error);return r;}
const checks=[],check=(name,pass=true)=>{assert.ok(pass,name);checks.push(name);console.log('PASS '+name);};let browser;
try{
 const cfg=await read();assert.equal(cfg.fixture,true);assert.match(cfg.url,/^http:\/\/127\.0\.0\.1:/);
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:1440,height:1050}});await context.addCookies([{name:cfg.cookie,value:cfg.accounts[0].token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);
 const page=await context.newPage(),errors=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/Content Security Policy|Refused/.test(m.text()))errors.push(m.text());});
 const goto=async name=>{await page.goto(cfg.url+'/app/'+name);await page.locator('#console-root h1').waitFor();await page.locator('.loading-card').waitFor({state:'detached'});};
 const op=page.locator('#operation-dialog'),begin=async(action,kind)=>{await page.locator(`[data-console-action="${action}"]${kind?`[data-kind="${kind}"]`:''}`).first().click();await op.locator('form').waitFor();};
 const submit=async()=>{await op.locator('button[type=submit]').click();await op.locator('.operation-result').first().waitFor();return JSON.parse(await op.locator('.operation-result').first().innerText());};
 const close=async()=>{await op.locator('[data-operation-close]').first().click();await op.waitFor({state:'hidden'});};
 const pick=async(name,value)=>{const s=op.locator(`[name="${name}"]`),index=await s.evaluate((s,v)=>[...s.options].findIndex(o=>o.value===v),value);assert.ok(index>=0);const b=s.locator('..').locator('> .select-trigger');await b.click();await page.locator('#'+await b.getAttribute('aria-controls')).locator(`[data-index="${index}"]`).click();};
 const shot=async name=>{await page.screenshot({path:path.join(evidence,name+'.png'),fullPage:true});};
 await goto('models');check('Models page has two distinct configurable roles',await page.locator('.model-card').count()===2);
 check('Missing worker and vector storage are explained',(await page.locator('#console-root').innerText()).includes('后台处理尚未启用')&&(await page.locator('#console-root').innerText()).includes('向量库尚未配置'));
 check('Unconfigured processing cannot be launched',await page.locator('.model-pipeline button:enabled').count()===0);await shot('models-unconfigured');
 for(const kind of ['organizer','embedder']){
  await begin('models.save',kind);await op.locator('[name=base_url]').fill(cfg.model_url);await op.locator('[name=model]').fill('synthetic-browser-'+kind);
  await op.locator('[name=api_key]').fill('synthetic-local-only-key');await op.locator('[name=enabled]').check();await op.locator('[name=egress_approved]').check();await pick('sensitivity','sensitive');
  if(kind==='embedder'){await op.locator('[name=dimensions]').fill('3');await op.locator('[name=query_approved]').check();}
  await shot('configure-'+kind);check(kind+' configuration persists through real BFF',(await submit()).status==='saved');await close();
  await begin('models.test',kind);const result=await submit();check(kind+' capability tests succeed with synthetic data only',result.status==='verified'&&result.real_memory_sent===false&&result.checks.length===2);await close();
 }
 check('Both current revisions show successful verification',await page.locator('[data-i18n=probeVerified]').count()===2);
 check('The saved secret never appears in page text',!(await page.locator('#console-root').innerText()).includes('synthetic-local-only-key'));
 await command('enable-synthetic-processing');await goto('models');check('Ready pipelines have enabled actions',await page.locator('.model-pipeline button:enabled').count()===3);
 await page.locator('[data-model-stage=classification] [data-console-action]').click();await op.locator('form').waitFor();check('Classification submits to the worker',(await submit()).status==='queued');await close();await command('tick');
 await goto('memories');check('LLM classifications are visible in the memory library',(await page.locator('.memory-table').innerText()).includes('技术'));
 await goto('jobs');await page.locator('[data-console-action="jobs.schedule"][data-type=summary]').click();await op.locator('form').waitFor();await op.locator('[name=include_open]').check();await pick('periods','daily');
 check('Daily summary submits explicitly',(await submit()).status==='queued');await close();await command('tick');await goto('summaries');check('LLM grounded summaries have inspectable records',await page.locator('[data-summary]').count()>0);
 await command('enable-synthetic-processing');await goto('models');await begin('vector.schedule');check('Vector indexing is explicitly queued',(await submit()).status==='queued');await close();await command('tick');await goto('models');
 const data=await page.evaluate(()=>fetch('/console-api/models').then(r=>r.json()));check('Personal index completes with real HTTP embeddings',data.processing.vector.state==='succeeded'&&data.processing.vector.indexed_documents===2&&data.processing.vector.search_ready===true);
 const search=await page.evaluate(()=>fetch('/console-api/memories?query=network&mode=semantic').then(r=>r.json()));check('Semantic retrieval returns only this account',search.results.length===2&&!JSON.stringify(search).includes('private B sentinel'));
 for(const width of [1440,1024]){await page.setViewportSize({width,height:1050});check('Model page has no horizontal overflow at '+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await shot('models-ready-'+width);}
 await begin('models.save','embedder');await op.locator('[name=dimensions]').fill('4');check('Configuration change is saved',(await submit()).status==='saved');await close();check('Changed configuration invalidates its probe',await page.locator('[data-i18n=probeNotRun]').count()===1);
 await begin('models.test','embedder');await op.locator('button[type=submit]').click();await op.locator('[data-operation-error]').filter({hasText:'向量'}).waitFor();check('Wrong dimensions produce actionable failure',true);await close();await goto('models');check('Failed test remains visible',await page.locator('[data-i18n=probeFailed]').count()===1);await shot('models-failed');
 const other=await browser.newContext();await other.addCookies([{name:cfg.cookie,value:cfg.accounts[1].token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);const otherPage=await other.newPage();await otherPage.goto(cfg.url+'/app/models');await otherPage.locator('.model-card').first().waitFor();
 check('Another account sees neither configuration nor test results',!(await otherPage.locator('#console-root').innerText()).includes('synthetic-browser-organizer')&&await otherPage.locator('[data-i18n=probeNotRun]').count()===2);await other.close();
 await command('basic-memory-only');await goto('models');check('Memory-only policy cannot configure or execute models',await page.locator('#console-root [data-console-action]').count()===0);
 check('No JavaScript or CSP errors',errors.length===0);
 fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify({synthetic:true,real_model_called:false,real_qdrant_used:false,checks},null,2),{mode:0o600});console.log(JSON.stringify({passed:checks.length,evidence}));
}finally{await browser?.close();if(!fixture.killed){fixture.stdin.write('{"command":"stop"}\n');await new Promise(resolve=>{const timer=setTimeout(()=>{fixture.kill('SIGTERM');resolve();},3000);fixture.once('exit',()=>{clearTimeout(timer);resolve();});});}fs.closeSync(log);assert.ok(fs.readFileSync(path.join(evidence,'fixture.stderr'),'utf8').includes('"synthetic_cleanup_complete":true'),'Synthetic fixture cleanup must be verified');}
