// Workbench presentation contracts; these do not replace authentication or isolation suites.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {renderPage,sendPage,serveAsset,pages} from '../../../web/console/render.mjs';
import {overviewView,appearanceView,icon,libraryView,memoryDetailView,memoryRows} from '../../../web/console/visuals.mjs';
import {text,catalog} from '../../../web/console/catalog.mjs';
import {declarations,rules} from './helpers/css.mjs';

const view = (data={}) => overviewView(data,{t:text,memoryRows:()=>'<div class="synthetic-row"></div>'});
const response = () => ({writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=body;}});

test('Shell: home counts are source-backed and never invent trends or connection claims',()=>{
 const html=view({counts:{memories:42,sources:68,summaries:7,jobs:3}});
 for(const value of [42,68,7,3])assert.ok(html.includes(`<strong>${value}</strong>`));
 assert.equal((html.match(/class="metric"/g)||[]).length,4);
 assert.equal((html.match(/class="processing-stage"/g)||[]).length,3);
 assert.match(html,/class="synthetic-row"/);
 assert.match(html,/<form class="ask" action="\/app\/memories" method="get"/);
 assert.doesNotMatch(html,/1,248|24\s*\/\s*24|已连接|已完成|<canvas|<progress/);
});
test('Shell: unavailable and invalid metric data never becomes a zero or HTML',()=>{
 const html=view({counts:{memories:-1,sources:'<img src=x onerror=alert(1)>',summaries:NaN,jobs:Infinity}});
 assert.equal((html.match(/<strong>—<\/strong>/g)||[]).length,7);
 assert.doesNotMatch(html,/<img|onerror|<strong>0<\/strong>/);
 const zero=view({counts:{memories:0}});assert.ok(zero.includes('<strong>0</strong>'));
});
test('Shell: appearance offers three themes plus independent mode and language controls',()=>{
 const html=appearanceView(text);
 assert.equal((html.match(/class="theme-option"/g)||[]).length,3);
 assert.equal((html.match(/aria-pressed="false" disabled/g)||[]).length,7);
 for(const value of ['a','b','c','light','dark','zh-CN','en'])assert.ok(html.includes(`data-pref-value="${value}"`));
 assert.doesNotMatch(html,/<form|https?:\/\//);
});
test('Shell: both locales cover shell and view strings without unsafe interpolation',()=>{
 assert.deepEqual(Object.keys(catalog.en).sort(),Object.keys(catalog['zh-CN']).sort());
 for(const locale of ['zh-CN','en']){
  const t=key=>text(key,locale),html=appearanceView(t)+overviewView({}, {t,memoryRows:()=>''})+libraryView(t,{data:{results:[]}})+pages.map(p=>renderPage({title:p,page:p})).join('');
  for(const [,key] of html.matchAll(/data-i18n="([^"]+)"/g))assert.ok(Object.hasOwn(catalog[locale],key),key);
 }
 assert.ok(appearanceView(()=>'<script>synthetic</script>').includes('&lt;script&gt;'));
 assert.doesNotMatch(appearanceView(()=>'<script>synthetic</script>'),/<script>/);
 assert.doesNotMatch(overviewView({},{t:()=>'<script>x</script>'}),/<script>/);
});
test('Shell: auth has one H1 and retains the exact trusted form and OAuth purpose',()=>{
 const body='<form method="post" action="/interaction/synthetic-uid/login"><input name="csrf" value="synthetic-csrf"><input name="password" type="password"></form>';
 const html=renderPage({title:'oauthLogin',body,auth:true,authPurpose:'oauth'});
 assert.equal((html.match(/<h1\b/g)||[]).length,1);
 assert.ok(html.includes(body));
 assert.match(html,/<span class="brand">/);
 assert.doesNotMatch(html,/href="\/login"|src="\/assets\/app.mjs"/);
 assert.match(html,/class="auth-story"/);
 assert.doesNotMatch(html,/class="rail"|\/console-api\/logout/);
});
test('Shell: every route keeps identity escaping, logout CSRF and a single current location',()=>{
 for(const page of pages){
  const html=renderPage({title:page,page,csrf:'" onfocus="synthetic',account:{account_id:'synthetic-account',username:'<script>synthetic</script>'}});
  assert.match(html,/action="\/console-api\/logout" method="post"/);
  assert.match(html,/name="csrf" value="&quot; onfocus=&quot;synthetic"/);
  assert.ok(html.includes('&lt;script&gt;synthetic&lt;/script&gt;'));
  assert.doesNotMatch(html,/<script>synthetic/);
  assert.equal((html.match(/aria-current="page"/g)||[]).length,1);
 }
});
test('Shell: assets remain on a fixed same-origin allowlist',()=>{
 const res=response();assert.equal(serveAsset({method:'GET'},res,'/assets/visuals.mjs'),true);
 assert.equal(res.status,200);assert.match(res.headers['content-type'],/text\/javascript/);
 for(const route of ['/assets/../catalog.mjs','/assets/secret.json','/v1/memories','/assets/visuals.mjs/extra','/assets/controls.css','/assets/render.mjs'])
  assert.equal(serveAsset({method:'GET'},response(),route),false);
 assert.equal(serveAsset({method:'POST'},response(),'/assets/visuals.mjs'),false);
});
test('Shell: pages preserve CSP, no-store and anti-framing headers',()=>{
 const res=response();sendPage(res,{title:'oauthConsent',auth:true,authPurpose:'oauth'},{redirectUri:'https://callback.example.test/exact'});
 assert.equal(res.status,200);assert.equal(res.headers['cache-control'],'no-store');
 assert.equal(res.headers['x-frame-options'],'DENY');assert.equal(res.headers['referrer-policy'],'same-origin');
 const bootstrap=res.body.match(/<script data-appearance-account="[^"]*">([\s\S]*?)<\/script>/);
 assert.ok(bootstrap);
 const hash=createHash('sha256').update(bootstrap[1]).digest('base64');
 assert.equal(res.headers['content-security-policy'],`default-src 'none'; style-src 'self'; script-src 'self' 'sha256-${hash}'; connect-src 'self'; img-src 'self'; form-action 'self' https://callback.example.test/exact; frame-ancestors 'none'; base-uri 'none'`);
});
test('Shell: the sidebar keeps three groups and all twelve destinations with route codes',()=>{
 const account={account_id:'synthetic',username:'Synthetic'};
 for(const page of pages){
  const html=renderPage({title:page,page,account,csrf:'c'});
  const nav=html.slice(html.indexOf('<aside class="sidebar">'),html.indexOf('</aside>'));
  assert.equal((nav.match(/class="nav-group"/g)||[]).length,3);
  assert.equal((nav.match(/<a href="\/app\//g)||[]).length,12);
  assert.match(nav,new RegExp(`href="/app/${page}" aria-current="page"`));
  assert.match(html,/<dialog id="memory-dialog" class="pane"/);
  assert.match(html,/id="status-clock"/);assert.match(html,/id="status-link" data-state="pending"/);
  assert.match(html,/data-skin="hud"/);
 }
 const css=fs.readFileSync(new URL('../../../web/console/styles.css',import.meta.url),'utf8');
 assert.equal(declarations(css,'.pane').position,'fixed');
 assert.ok(rules(css).some(r=>r.selectors.includes('body.pane-open .workspace')),'docked pane reserves space instead of covering the list');
});
test('Shell: the HUD radar draws only real category shares and daily counts',()=>{
 const html=view({counts:{memories:3},insights:{categories:[{value:'technical',count:3},{value:'<i>x</i>',count:1},{value:'zero',count:0}],activity:[{day:'2026-09-01',count:2},{day:'2026-09-02',count:0}]}});
 assert.equal((html.match(/class="sector /g)||[]).length,2);
 assert.equal((html.match(/<line class="tick/g)||[]).length,2);
 assert.doesNotMatch(html,/<i>x<\/i>/);assert.match(html,/75%/);
 assert.match(view({counts:{}}),/radar is-empty/);
});
test('Shell: decorative SVG cannot incorporate caller-supplied markup',()=>{
 const svg=icon('<script>synthetic</script>');
 assert.doesNotMatch(svg,/<script|<image|https?:\/\//);
 assert.match(svg,/aria-hidden="true"/);
});
test('Shell: home charts render only owner aggregates and escape labels',()=>{
 const insights={activity:[{day:'2026-09-01',count:2},{day:'2026-09-02',count:0},{day:'bad',count:9},{day:'2026-09-03',count:-1}],
  types:[{value:'fact',count:3},{value:'<img src=x>',count:1}],categories:[{value:'<script>x</script>',count:1}]};
 const html=view({counts:{memories:4},insights});
 assert.match(html,/class="activity-strip"/);assert.match(html,/class="breakdown"/);
 assert.equal((html.match(/<rect class="cell/g)||[]).length,2);
 assert.doesNotMatch(html,/<img src=x|<script>x/);
 assert.doesNotMatch(view({counts:{memories:0}}),/activity-strip|breakdown/);
});
test('Shell: library and detail keep business hooks and escape memory content',()=>{
 const row={memory_id:'m"1',content:'<b>synthetic</b>',memory_type:'decision',status:'active',category:'technical',created_at:'2026-09-01T00:00:00Z'};
 const lib=libraryView(text,{data:{results:[row],next_offset:null},categories:['technical']});
 for(const name of ['query','search_mode','category','status'])assert.match(lib,new RegExp(`name="${name}"`));
 assert.match(lib,/id="search-form"/);assert.match(lib,/class="card memory-library"/);assert.match(lib,/class="memory-table"/);
 assert.equal((lib.match(/<th>/g)||[]).length,4);assert.match(lib,/data-memory="m&quot;1"/);assert.match(lib,/data-reset-filters/);
 assert.doesNotMatch(lib,/<b>synthetic/);
 const detail=memoryDetailView(text,{memory:{...row,memory_id:'m1'},revision:2,content_offset:0,content_length:17,content_complete:true,source_manifest:{sources:[{source_id:'s<1>',source_kind:'explicit'}]}},{actions:'<button data-console-action="memory.classify">x</button>'});
 assert.match(detail,/class="body-content">&lt;b&gt;synthetic/);assert.match(detail,/data-console-action="memory.classify"/);assert.doesNotMatch(detail,/s<1>/);
 assert.doesNotMatch(memoryDetailView(text,{memory:{...row,status:'retracted'},revision:1,content_offset:0,content_length:1},{actions:'<button data-console-action="memory.correct">x</button>'}),/data-console-action/);
 assert.match(memoryRows([row],text),/data-memory="m&quot;1"/);
});
test('html template escapes interpolations, joins arrays and only trusts explicit fragments',async()=>{
 const {html,trusted}=await import('../../../web/console/html.mjs');
 const user='<img src=x onerror=alert(1)> & "q"';
 const out=String(html`<p title="${user}">${user}${[html`<b>${1}</b>`,null,false,undefined,2]}${trusted('<i></i>')}</p>`);
 assert.equal(out,'<p title="&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot;">&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot;<b>1</b>2<i></i></p>');
});
