// Presentation regressions; these do not replace authentication or isolation suites.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {renderPage,sendPage,serveAsset,pages} from '../../../web/console/render.mjs';
import {overviewView,appearanceView,icon} from '../../../web/console/visuals.mjs';
import {text,catalog} from '../../../web/console/catalog.mjs';

const view = (data={}) => overviewView(data,{t:text,memoryRows:()=>'<div class="synthetic-row"></div>'});
const response = () => ({writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=body;}});

test('Layout A: overview uses source-backed counts, not demo trends or connection claims',()=>{
 const html=view({counts:{memories:42,sources:68,summaries:7,jobs:3}});
 for(const value of [42,68,7,3])assert.ok(html.includes(`<strong>${value}</strong>`));
 assert.equal((html.match(/class="card metric"/g)||[]).length,4);
 assert.match(html,/class="processing-card|class="card processing-card/);
 assert.match(html,/class="synthetic-row"/);
 assert.doesNotMatch(html,/1,248|24\s*\/\s*24|已连接|已完成|<canvas|<progress/);
});
test('Layout A: unavailable and invalid metric data never becomes a zero or HTML',()=>{
 const html=view({counts:{memories:-1,sources:'<img src=x onerror=alert(1)>',summaries:NaN,jobs:Infinity}});
 assert.equal((html.match(/<strong>—<\/strong>/g)||[]).length,7);
 assert.doesNotMatch(html,/<img|onerror|<strong>0<\/strong>/);
 const zero=view({counts:{memories:0}});assert.ok(zero.includes('<strong>0</strong>'));
});
test('Layout A: appearance contains three theme previews and independent mode/language controls',()=>{
 const html=appearanceView(text);
 assert.equal((html.match(/class="theme-option"/g)||[]).length,3);
 assert.equal((html.match(/class="mini-shell"/g)||[]).length,3);
 assert.equal((html.match(/aria-pressed="false" disabled/g)||[]).length,7);
 for(const value of ['a','b','c','light','dark','zh-CN','en'])assert.ok(html.includes(`data-pref-value="${value}"`));
 assert.doesNotMatch(html,/<form|https?:\/\//);
});
test('Layout A: both locales cover new shell and settings strings without unsafe interpolation',()=>{
 assert.deepEqual(Object.keys(catalog.en).sort(),Object.keys(catalog['zh-CN']).sort());
 for(const locale of ['zh-CN','en']){
  const t=key=>text(key,locale),html=appearanceView(t)+overviewView({}, {t,memoryRows:()=>''});
  for(const [,key] of html.matchAll(/data-i18n="([^"]+)"/g))assert.ok(Object.hasOwn(catalog[locale],key),key);
 }
 assert.ok(appearanceView(()=>'<script>synthetic</script>').includes('&lt;script&gt;'));
 assert.doesNotMatch(appearanceView(()=>'<script>synthetic</script>'),/<script>/);
});
test('Layout A: auth has one H1 and retains the exact trusted form and OAuth purpose',()=>{
 const body='<form method="post" action="/interaction/synthetic-uid/login"><input name="csrf" value="synthetic-csrf"><input name="password" type="password"></form>';
 const html=renderPage({title:'oauthLogin',body,auth:true,authPurpose:'oauth'});
 assert.equal((html.match(/<h1\b/g)||[]).length,1);
 assert.ok(html.includes(body));
 assert.match(html,/<span class="brand">/);
 assert.doesNotMatch(html,/href="\/login"|src="\/assets\/app.mjs"/);
 assert.match(html,/class="auth-story"/);
});
test('Layout A: all existing routes keep identity escaping and the original logout CSRF form',()=>{
 for(const page of pages){
  const html=renderPage({title:page,page,csrf:'" onfocus="synthetic',account:{account_id:'synthetic-account',username:'<script>synthetic</script>'}});
  assert.match(html,/action="\/console-api\/logout" method="post"/);
  assert.match(html,/name="csrf" value="&quot; onfocus=&quot;synthetic"/);
  assert.ok(html.includes('&lt;script&gt;synthetic&lt;/script&gt;'));
  assert.doesNotMatch(html,/<script>synthetic/);
  assert.equal((html.match(/aria-current="page"/g)||[]).length,1);
 }
});
test('Layout A: assets remain on a fixed same-origin allowlist',()=>{
 const res=response();assert.equal(serveAsset({method:'GET'},res,'/assets/visuals.mjs'),true);
 assert.equal(res.status,200);assert.match(res.headers['content-type'],/text\/javascript/);
 for(const route of ['/assets/../catalog.mjs','/assets/secret.json','/v1/memories','/assets/visuals.mjs/extra'])
  assert.equal(serveAsset({method:'GET'},response(),route),false);
 assert.equal(serveAsset({method:'POST'},response(),'/assets/visuals.mjs'),false);
});
test('Layout A: UI additions preserve CSP, no-store and anti-framing headers',()=>{
 const res=response();sendPage(res,{title:'oauthConsent',auth:true,authPurpose:'oauth'},{redirectUri:'https://callback.example.test/exact'});
 assert.equal(res.status,200);assert.equal(res.headers['cache-control'],'no-store');
 assert.equal(res.headers['x-frame-options'],'DENY');assert.equal(res.headers['referrer-policy'],'same-origin');
 assert.equal(res.headers['content-security-policy'],"default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self' https://callback.example.test/exact; frame-ancestors 'none'; base-uri 'none'");
});
test('Layout A: desktop metric layout no longer collapses at 1280px',()=>{
 const css=fs.readFileSync(new URL('../../../web/console/styles.css',import.meta.url),'utf8');
 assert.match(css,/\.metrics\{display:grid;grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
 const start=css.indexOf('@media(max-width:1280px)');
 const block=start===-1?'':css.slice(start,css.indexOf('@media',start+1)===-1?css.length:css.indexOf('@media',start+1));
 assert.doesNotMatch(block,/\.metrics[^}]*grid-template-columns/);
 assert.match(css,/\.auth-brand\{[^}]*background:var\(--surface\)/);
 assert.match(css,/\.auth-form\{[^}]*background:var\(--bg\)/);
});
test('Layout A: decorative SVG cannot incorporate caller-supplied markup',()=>{
 const svg=icon('<script>synthetic</script>');
 assert.doesNotMatch(svg,/<script|<image|https?:\/\//);
 assert.match(svg,/aria-hidden="true"/);
});
