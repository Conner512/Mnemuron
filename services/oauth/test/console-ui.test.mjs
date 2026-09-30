import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {renderPage,routeTitle,pages} from '../../../web/console/render.mjs';
import {catalog} from '../../../web/console/catalog.mjs';
import {SessionState} from '../../../web/console/session-state.mjs';
import {declarations,rules,hasMedia} from './helpers/css.mjs';
test('UI-00 UI-01 INT-02: fixed geometry, one palette and a full bilingual catalogue',()=>{
 const css=fs.readFileSync(new URL('../../../web/console/styles.css',import.meta.url),'utf8');
 const root=declarations(css,':root');
 for(const token of ['--sidebar','--topbar','--radius'])assert.match(root[token]||'',/^\d+px$/,token);
 assert.ok(hasMedia(css,'prefers-reduced-motion:reduce'));
 assert.equal(declarations(css,'*',{media:'prefers-reduced-motion:reduce'}).animation,'none!important');
 assert.equal(root['--accent'],'#AE3F2C','vermilion is the only accent');
 assert.doesNotMatch(css,/\[data-theme|\[data-mode|\[data-skin/,'one palette, no theme or skin layers');
 assert.deepEqual(Object.keys(catalog.en).sort(),Object.keys(catalog['zh-CN']).sort());
});
test('ISO-10 INT-05: delayed A responses are discarded after account exit',()=>{
 const a=new SessionState('synthetic-account-A'),ticket=a.ticket();assert.ok(a.accepts(ticket));
 a.clear();a.account='synthetic-account-B';assert.equal(a.accepts(ticket),false);assert.ok(ticket.controller.signal.aborted);
 const b=a.ticket();assert.ok(a.accepts(b));a.finish(b);
});
test('UI-01 INT-04: auth shell loads local assets and keeps transaction form intact',()=>{
 const body='<form action="/interaction/synthetic-uid/login"><input name="csrf" value="synthetic-csrf"></form>';
 const page=renderPage({title:'login',body,auth:true});
 assert.ok(page.includes(body));assert.match(page,/\/assets\/appearance.mjs/);assert.ok(!/https?:\/\//.test(page));
 assert.equal(routeTitle('/app/memories'),'memories');assert.equal(routeTitle('/authorize'),null);
});
test('the language switch waits for its local handler before accepting input',()=>{
 const page=renderPage({title:'login',auth:true});
 assert.equal([...page.matchAll(/<select\b[^>]*data-pref="[^"]+"[^>]*disabled/g)].length,1);
 assert.match(page,/<select id="locale" data-pref="locale" disabled>/);
 const script=fs.readFileSync(new URL('../../../web/console/appearance.mjs',import.meta.url),'utf8');
 assert.match(script,/node\.disabled=false/);
});
test('UI-01 UI-04: shell chrome is translatable and the skip link has a target',()=>{
 for(const auth of [true,false]) {
  const page=renderPage({title:'login',auth});
  assert.match(page,/data-i18n="systemLabel"/);assert.match(page,/id="main"/);
  assert.match(page,/class="skip-link"[^>]*data-i18n="continue"/);
 }
});
test('console chrome omits retired status notices without removing navigation or logout',()=>{
 for(const page of pages){
  const html=renderPage({title:page,page,csrf:'synthetic-csrf',account:{account_id:'synthetic-account',username:'Synthetic'}});
  assert.doesNotMatch(html,/class="handoff"|data-i18n="(?:handoff|capabilityBoundary|notProduction)"/);
  assert.equal(html.match(/<footer>(.*?)<\/footer>/s)?.[1],'<span class="footer-mark">Mnemuron</span>');
  assert.match(html,/action="\/console-api\/logout" method="post"/);
  assert.match(html,/name="csrf" value="synthetic-csrf"/);
  for(const target of pages)assert.ok(html.includes(`href="/app/${target}"`));
 }
 for(const locale of ['zh-CN','en'])for(const key of ['handoff','capabilityBoundary','notProduction'])assert.equal(Object.hasOwn(catalog[locale],key),false);
 const css=fs.readFileSync(new URL('../../../web/console/styles.css',import.meta.url),'utf8');
 assert.doesNotMatch(css,/\.handoff\b/);
});
test('the palette keeps small body, navigation and action text at 4.5:1 contrast',()=>{
 const css=fs.readFileSync(new URL('../../../web/console/styles.css',import.meta.url),'utf8');
 assert.ok(rules(css).some(r=>['input','select'].every(s=>r.selectors.includes(s))&&r.declarations['border-color']==='var(--muted)'),'form controls keep a 3:1 muted border');
 const luminance=color=>{
  const v=color.match(/[0-9a-f]{2}/ig).map(x=>parseInt(x,16)/255).map(c=>c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4);
  return v[0]*0.2126+v[1]*0.7152+v[2]*0.0722;
 };
 const colors=declarations(css,':root');
 for(const [foreground,background] of [['text','surface'],['muted','surface'],['muted','bg'],['accent','soft'],['on-accent','accent']]){
  const a=luminance(colors[`--${foreground}`]),b=luminance(colors[`--${background}`]),ratio=(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
  assert.ok(ratio>=4.5,`${foreground}/${background}: ${ratio}`);
 }
});
