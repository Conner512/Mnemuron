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
 const submit=async()=>{await op.locator('button[type=submit]').click();await op.locator('.operation-result').first().waitFor({state:'attached'});return JSON.parse(await op.locator('.operation-result').first().textContent());};
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
 await command('enable-synthetic-processing');await goto('models');check('Ready pipelines have enabled actions',await page.locator('.model-pipeline button:enabled').count()===4);
check('The vector stage offers the bounded first-run preparation',await page.locator('.model-pipeline [data-first-run] [data-console-action="vector.prepare"]:enabled').count()===1);
 await page.locator('[data-model-stage=classification] [data-console-action]').click();await op.locator('form').waitFor();check('Classification submits to the worker',(await submit()).status==='queued');await close();await command('tick');
 await goto('memories');check('LLM classifications are visible in the memory library',(await page.locator('.memory-table').innerText()).includes('技术'));
 await goto('jobs');await page.locator('[data-console-action="jobs.schedule"][data-type=summary]').click();await op.locator('form').waitFor();await op.locator('[name=include_open]').check();await pick('periods','daily');
 check('Daily summary submits explicitly',(await submit()).status==='queued');await close();await command('tick');await goto('summaries');check('LLM grounded summaries have inspectable records',await page.locator('[data-summary]').count()>0);
 await command('enable-synthetic-processing');await goto('models');await begin('vector.schedule');check('Vector indexing is explicitly queued',(await submit()).status==='queued');await close();await command('tick');await goto('models');
 const data=await page.evaluate(()=>fetch('/console-api/models').then(r=>r.json()));check('Personal index completes with real HTTP embeddings',data.processing.vector.state==='succeeded'&&data.processing.vector.indexed_documents===2&&data.processing.vector.search_ready===true);
 const search=await page.evaluate(()=>fetch('/console-api/memories?query=network&mode=semantic').then(r=>r.json()));check('Semantic retrieval returns only this account',search.results.length===2&&!JSON.stringify(search).includes('private B sentinel'));
 // Bounded first run: freeze → probe → confirmed build → explicit activation → rollback, against a pre-created synthetic collection.
 await command('enable-first-run-vector');await goto('models');
 await begin('vector.prepare');await op.locator('[name=budget_calls]').fill('10');const prepared=await submit();
 check('First run freezes a manifest and opens a finite budget without calling a model',prepared.status==='prepared'&&prepared.collection==='synthetic_first_v1'&&prepared.budget.total===10&&prepared.budget.used===0&&prepared.probe_required===false);await close();
 await goto('models');const firstRunText=()=>page.locator('[data-first-run]').innerText();
 check('The frozen count, digest and budget are shown before any build',(await firstRunText()).includes(prepared.manifest.digest)&&(await firstRunText()).includes('0 / 10'));await shot('first-run-prepared');
 await begin('models.test','embedder');check('Synthetic dimension probe passes inside the budget',(await submit()).dimensions===3);await close();await goto('models');
 const startBuild=async count=>{await page.locator('[data-first-run] [data-console-action="vector.schedule"]').click();await op.locator('form').waitFor();await op.locator('[name=expected_count]').fill(String(count));};
 await startBuild(prepared.manifest.count+1);await op.locator('button[type=submit]').click();await op.locator('[data-operation-error]').waitFor();
 check('A count that differs from the frozen list stops the build',(await op.locator('[data-operation-error]').innerText()).includes('清单'));await close();
 await goto('models');await startBuild(prepared.manifest.count);check('The confirmed build waits for an explicit activation',(await submit()).activation==='explicit');await close();
 await command('tick');await goto('models');
 const first=(await page.evaluate(()=>fetch('/console-api/models').then(r=>r.json()))).processing.vector.first_run;
 check('The build covers exactly the frozen list and is not switched on',first.build==='built'&&first.manifest.indexed===prepared.manifest.count&&first.serving===false&&first.budget.used===2+prepared.manifest.count);await shot('first-run-built');
 await begin('vector.activate');check('Explicit activation switches the index on',(await submit()).status==='activated');await close();
 const served=await page.evaluate(()=>fetch('/console-api/memories?query=network&mode=semantic').then(r=>r.json()));check('The activated first-run index serves semantic search',served.results?.length>0);
 await goto('models');await begin('vector.deactivate');check('Deactivation is the rollback',(await submit()).status==='deactivated');await close();
 const fallback=await page.evaluate(()=>fetch('/console-api/memories?query=network&mode=hybrid').then(r=>r.json()));check('After rollback search falls back to keywords and says why',fallback.retrieval?.effective_mode==='lexical'&&fallback.retrieval?.degradation_code==='VECTOR_NOT_READY');
 await goto('models');check('The rolled-back index can be activated again',await page.locator('[data-first-run] [data-console-action="vector.activate"]').count()===1);await shot('first-run-rolled-back');
 // Owner call limits: explicit "no limit", a malformed value refused, a zero cap, and no reset, activation or call on change.
 const models=()=>page.evaluate(()=>fetch('/console-api/models').then(r=>r.json()));
 const legacy=(await models()).processing;check('Before any setting the embedder shows its legacy caps',legacy.quotas.embedder.mode==='legacy'&&legacy.quotas.embedder.total.limit===10&&(await page.locator('[data-call-limits=embedder]').innerText()).includes('/ 10'));
 const setLimits=async(kind,daily,total)=>{await begin('models.quota',kind);for(const [name,value] of [['daily_limit',daily],['total_limit',total]]){await pick(name+'_mode',value===null?'limit_unlimited':'limit_limited');if(value!==null)await op.locator(`[name=${name}]`).fill(String(value));}};
 await setLimits('embedder',null,null);await shot('call-limits-form');const unlimited=await submit();
 // The account total counts every embedder call since counting began (here also the probe before the first run), never fewer than the first-run record.
 check('No limit is saved as an explicit null and no count is lowered',unlimited.status==='saved'&&unlimited.quota.mode==='manual'&&unlimited.quota.daily.limit===null&&unlimited.quota.total.limit===null&&unlimited.quota.total.used>=legacy.quotas.embedder.total.used);await close();
 const after=(await models()).processing.vector.first_run;check('Changing limits keeps the first-run state, budget record and inactive index',JSON.stringify(after)===JSON.stringify(legacy.vector.first_run)&&after.serving===false&&after.budget.used===legacy.vector.first_run.budget.used&&after.budget.total===10);
 await goto('models');check('The card shows no limit in words',(await page.locator('[data-call-limits=embedder]').innerText()).includes('不限制'));
 check('Replaced legacy caps are labelled as records, not limits',(await page.locator('[data-first-run]').innerText()).includes('已由手动调用次数限制取代')&&(await page.locator('.model-card').nth(1).innerText()).includes('已由手动调用次数限制取代'));
 check('Usage table states no limit in words',(await page.locator('[data-feature="MOD-04"]').innerText()).includes('不限制'));await shot('call-limits-unlimited');
 await setLimits('embedder',null,'');await op.locator('button[type=submit]').click();await op.locator('[data-operation-error]').waitFor();
 check('A limit without a number is refused, not read as 0 or no limit',(await op.locator('[data-operation-error]').innerText()).includes('上限必须'));await close();
 check('The refused value left the setting unchanged',(await models()).processing.quotas.embedder.total.limit===null);
 await goto('models');await setLimits('embedder',null,0);check('Zero is saved as a cap that allows no calls',(await submit()).quota.exhausted.includes('TOTAL_BUDGET_EXHAUSTED'));await close();
 await goto('models');check('Readiness shows the reached total',(await page.locator('[data-call-limits=embedder]').innerText()).includes('累计调用上限'));await shot('call-limits-zero');
 await setLimits('embedder',null,null);const removed=(await submit()).quota;check('The limit can be removed again and the count never reset',removed.exhausted.length===0&&removed.total.used===unlimited.quota.total.used);await close();await goto('models');
 for(const width of [1440,1024]){await page.setViewportSize({width,height:1050});check('Model page has no horizontal overflow at '+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await shot('models-ready-'+width);}
 await begin('models.save','embedder');await op.locator('[name=dimensions]').fill('4');check('Configuration change is saved',(await submit()).status==='saved');await close();check('Changed configuration invalidates its probe',await page.locator('[data-i18n=probeNotRun]').count()===1);
 await begin('models.test','embedder');await op.locator('button[type=submit]').click();await op.locator('[data-operation-error]').filter({hasText:'向量'}).waitFor();check('Wrong dimensions produce actionable failure',true);await close();await goto('models');check('Failed test remains visible',await page.locator('[data-i18n=probeFailed]').count()===1);await shot('models-failed');
 const other=await browser.newContext();await other.addCookies([{name:cfg.cookie,value:cfg.accounts[1].token,url:cfg.url,httpOnly:true,sameSite:'Lax'}]);const otherPage=await other.newPage();await otherPage.goto(cfg.url+'/app/models');await otherPage.locator('.model-card').first().waitFor();
 check('Another account sees neither configuration nor test results',!(await otherPage.locator('#console-root').innerText()).includes('synthetic-browser-organizer')&&await otherPage.locator('[data-i18n=probeNotRun]').count()===2);await other.close();
 await command('basic-memory-only');await goto('models');check('Memory-only policy cannot configure or execute models',await page.locator('#console-root [data-console-action]').count()===0);
 check('No JavaScript or CSP errors',errors.length===0);
 fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify({synthetic:true,real_model_called:false,real_qdrant_used:false,checks},null,2),{mode:0o600});console.log(JSON.stringify({passed:checks.length,evidence}));
}finally{await browser?.close();if(!fixture.killed){fixture.stdin.write('{"command":"stop"}\n');await new Promise(resolve=>{const timer=setTimeout(()=>{fixture.kill('SIGTERM');resolve();},3000);fixture.once('exit',()=>{clearTimeout(timer);resolve();});});}fs.closeSync(log);assert.ok(fs.readFileSync(path.join(evidence,'fixture.stderr'),'utf8').includes('"synthetic_cleanup_complete":true'),'Synthetic fixture cleanup must be verified');}
