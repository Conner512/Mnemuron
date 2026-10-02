// The console feature map is the development standard's source of truth (docs/console-feature-standard.md).
// These checks keep the map, the rendered placeholders, the server allowlists, the catalog and the doc in step.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pages,renderPage} from '../../../web/console/render.mjs';
import {featureMap,featureKey,prototypePages,prototypeView,prototypeOrder,roadmapCard,pageState,revisionDifference} from '../../../web/console/visuals.mjs';
import {catalog,text} from '../../../web/console/catalog.mjs';
import {CONSOLE_ACTIONS} from '../../../shared/console-contract.mjs';
import {consoleAllowedActions} from '../src/console-policy.mjs';

const read=path=>fs.readFileSync(new URL(`../../../${path}`,import.meta.url),'utf8');
const features=Object.entries(featureMap).flatMap(([page,list])=>list.map(f=>({...f,page})));
const t=key=>text(key,'zh-CN');
// Every write the server can ever allow: all switches on, an operator, a writable Core binding.
const serverActions=new Set(consoleAllowedActions({identity:{console_operations:true,connection_management:{enabled:true}}},{writable:true,actions:[...CONSOLE_ACTIONS]},true));
// Views the BFF answers: its own handlers plus the Core passthrough, as written in the route source.
const bff=read('services/oauth/src/console.mjs');
const servedViews=new Set([...bff.matchAll(/'\/console-api\/([a-z-]+)'/g)].map(m=>m[1]).concat(bff.match(/\/\^\\\/console-api\\\/\(([^)]+)\)\$\//)[1].split('|')));
const ingress=read('docs/console-ingress.example.yml');
const ingressGroup=name=>new Set(ingress.match({app:/app\(\/\(([a-z|]+)\)\)/,'console-api':/console-api\/\(([a-z|-]+)\)/}[name])[1].split('|'));

test('Revision comparison preserves exact Unicode and highlights the changed region',()=>{
  for(const pair of [['A😀旧文末','A😃新文末'],['same','same'],['','insert'],['delete',''],['<script>','<img>']]){
    const diff=revisionDifference(...pair);diff.forEach((d,i)=>assert.equal(d.prefix+d.changed+d.suffix,pair[i]));
  }
  assert.deepEqual(revisionDifference('A😀旧文末','A😃新文末'),[{prefix:'A',changed:'😀旧',suffix:'文末'},{prefix:'A',changed:'😃新',suffix:'文末'}]);
});

test('Feature map: one entry per menu page, in navigation order',()=>{
 assert.deepEqual(Object.keys(featureMap),pages);
 for(const page of prototypePages)assert.ok(pages.includes(page),page);
 const nav=renderPage({title:'overview',page:'overview',account:{account_id:'synthetic',username:'Synthetic'}});
 assert.deepEqual([...nav.matchAll(/<a href="\/app\/([a-z]+)"/g)].map(m=>m[1]),pages);
});

test('Feature map: IDs are well formed, sequential per page and one prefix per page',()=>{
 const prefixes=new Map();
 for(const [page,list] of Object.entries(featureMap)){
  assert.ok(list.length>0,page);
  const prefix=list[0].id.slice(0,3);
  assert.ok(!prefixes.has(prefix),`prefix ${prefix} reused by ${page}`);prefixes.set(prefix,page);
  list.forEach((f,i)=>assert.equal(f.id,`${prefix}-${String(i+1).padStart(2,'0')}`,`${page}: IDs are never reused or reordered`));
 }
});

test('Feature map: every title, note and wireframe label exists in both locales',()=>{
 for(const f of features){
  const labels=[featureKey(f.id),`${featureKey(f.id)}Note`,...(f.ui?.table||[]),...(f.ui?.form||[]).map(spec=>spec.split(':')[1]),...(f.ui?.actions||[]),...(f.ui?.stats||[]),...(f.ui?.submit?[f.ui.submit]:[])];
  for(const locale of ['zh-CN','en'])for(const key of labels)assert.ok(Object.hasOwn(catalog[locale],key),`${f.id}: ${locale}.${key}`);
  for(const spec of f.ui?.form||[])assert.match(spec,/^(select|number|text|check):[A-Za-z]+$/,f.id);
 }
 for(const locale of ['zh-CN','en'])for(const key of ['live','planned','policy','partial'].map(s=>`featureStatus_${s}`).concat(pages,pages.filter(p=>p!=='overview').map(p=>`pageNote_${p}`)))
  assert.ok(Object.hasOwn(catalog[locale],key),`${locale}.${key}`);
});

test('Feature map: live features are backed by served, routed views and allowed actions',()=>{
 const routedViews=ingressGroup('console-api');
 for(const f of features.filter(f=>f.status==='live')){
  assert.ok((f.read||[]).length+(f.write||[]).length>0,`${f.id} names its endpoints`);
  for(const view of f.read||[]){assert.ok(servedViews.has(view),`${f.id}: BFF serves ${view}`);assert.ok(routedViews.has(view),`${f.id}: ingress routes ${view}`);}
  for(const action of f.write||[])assert.ok(serverActions.has(action),`${f.id}: server allows ${action}`);
 }
});

test('Feature map: planned features name their contract and cannot be called yet',()=>{
 for(const f of features.filter(f=>f.status==='planned')){
  assert.ok((f.read||[]).length+(f.write||[]).length>0,`${f.id} names the endpoints it will need`);
  for(const action of f.write||[]){
   assert.match(action,/^[a-z]+\.[a-z_.]+$/,`${f.id}: ${action} is <domain>.<verb>`);
   assert.ok(!serverActions.has(action),`${f.id}: ${action} is already allowed; mark the feature live`);
  }
  for(const view of f.read||[])assert.match(view,/^[a-z]+(?:-[a-z]+)*$/,f.id);
  for(const api of f.core||[])assert.match(api,/^(GET|POST|PUT) \/(?:v1\/|readyz)/,f.id);
 }
 for(const f of features.filter(f=>f.status==='policy'))assert.ok(!f.read&&!f.write,`${f.id}: a feature that is not offered declares no endpoints`);
 for(const f of features)assert.ok(['live','planned','policy'].includes(f.status),f.id);
});

test('Placeholders render every feature and never trigger a request',()=>{
 const caps={operator:true,enabled:true,writable:true,management:{invitations:true,accounts:true,roles:true},connection_management:{enabled:true}};
 for(const page of pages){
  const html=prototypePages.includes(page)?prototypeView(t,page,{data:{projects:[],models:[],web_policy:{read_all:false,revision:0}},caps}):roadmapCard(t,page);
  const shown=[...html.matchAll(/data-feature="([A-Z]{3}-\d{2})"/g)].map(m=>m[1]);
  const expected=(prototypePages.includes(page)?prototypeOrder(page):featureMap[page].filter(f=>f.status!=='live')).map(f=>f.id);
  assert.deepEqual(shown,expected,page);
  // Live cards may carry real actions; a placeholder (planned or not offered) never does.
  const placeholders=prototypePages.includes(page)?(html.match(/<section class="card feature-card" data-status="(?:planned|policy)"[\s\S]*?<\/section>/g)||[]).join(''):html;
  assert.doesNotMatch(placeholders,/data-console-action|data-connection-|<form\b|\son[a-z]+=|https?:\/\//,page);
  assert.doesNotMatch(html,/<form\b|\son[a-z]+=|https?:\/\//,page);
  for(const control of placeholders.match(/<(?:button|input|select|textarea)\b[^>]*>/g)||[])assert.match(control,/\sdisabled\b/,`${page}: ${control}`);
  for(const f of featureMap[page].filter(f=>f.status==='planned'))assert.ok(html.includes(`console-feature-standard.md`)&&html.includes(`${f.id}</summary>`),`${page}: ${f.id} has developer notes`);
 }
 assert.equal(roadmapCard(t,'jobs'),'','a page with nothing planned shows no roadmap');
 assert.deepEqual(prototypePages.map(pageState),['partial','planned','live','live']);
});

test('Live cards on prototype pages escape data and degrade on their own',()=>{
 const tasks=prototypeView(t,'tasks',{data:{projects:[{project_id:'p"1',name:'<img src=x onerror=alert(1)>'}]}});
 assert.ok(tasks.includes('&lt;img src=x onerror=alert(1)&gt;'));assert.ok(tasks.includes('p&quot;1'));
 assert.doesNotMatch(tasks,/<img/);
 for(const page of ['tasks','privacy']){
  const html=prototypeView(t,page,{data:{unavailable:true}});
  assert.match(html,/data-i18n="unavailable"/,page);
  assert.equal((html.match(/data-status="planned" data-feature=/g)||[]).length,featureMap[page].filter(f=>f.status==='planned').length,page);
 }
 const system=prototypeView(t,'system',{caps:{enabled:true,management:{invitations:true}}});
 assert.match(system,/class="card feature-progress"/);
 assert.equal((system.match(/data-state="enabled"/g)||[]).length,2);
});

test('The development standard lists every feature with its current status and every page route',()=>{
 const doc=read('docs/console-feature-standard.md');
 const rows=new Map([...doc.matchAll(/^\| ([A-Z]{3}-\d{2}) \| [^|]+ \| [^|]+ \| (live|planned|policy) \|/gm)].map(m=>[m[1],m[2]]));
 assert.deepEqual(rows,new Map(features.map(f=>[f.id,f.status])));
 for(const page of pages)assert.match(doc,new RegExp(`\\| \`/app/${page}\` \\| \`${featureMap[page][0].id.slice(0,3)}\` \\|`),page);
});

test('The ingress example routes every menu page',()=>{
 assert.deepEqual([...ingressGroup('app')].sort(),[...pages].sort());
});

test('PRV-06: the ChatGPT read scope card shows the real policy and offers only the permitted switch',()=>{
 const caps={allowed_actions:['memory.web_policy']};
 const card=(data,c=caps)=>prototypeView(t,'privacy',{data,caps:c}).match(/<section class="card feature-card" data-status="live" data-feature="PRV-06">[\s\S]*?<\/section>/)[0];
 const off=card({web_policy:{read_all:false,revision:0}});
 assert.match(off,/data-state="disabled"/);assert.match(off,/data-console-action="memory.web_policy" data-enabled="true"/);assert.match(off,/data-i18n="webPolicyEnable"/);
 const on=card({web_policy:{read_all:true,revision:3}});
 assert.match(on,/data-state="enabled"/);assert.match(on,/data-console-action="memory.web_policy" data-enabled="false"/);assert.match(on,/data-i18n="webReadAllOn"/);
 assert.doesNotMatch(card({web_policy:{read_all:false,revision:0}},{allowed_actions:[]}),/data-console-action/);
 assert.match(card({}),/data-i18n="unavailable"/);
 assert.deepEqual(prototypeOrder('privacy').map(f=>f.id),['PRV-01','PRV-02','PRV-03','PRV-04','PRV-06','PRV-05'],'implemented features come before policy-disabled features');
});
