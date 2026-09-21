import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {renderPage,routeTitle} from '../../../web/console/render.mjs';
import {catalog} from '../../../web/console/catalog.mjs';
import {SessionState} from '../../../web/console/session-state.mjs';
test('UI-00 UI-01 INT-02: fixed geometry and full bilingual palette catalogue',()=>{
 const css=fs.readFileSync(new URL('../../../web/console/styles.css',import.meta.url),'utf8');
 assert.match(css,/--sidebar-width:232px/);assert.match(css,/--topbar-height:72px/);
 assert.match(css,/--radius-card:16px/);assert.match(css,/prefers-reduced-motion/);
 for(const theme of ['a','b','c'])for(const mode of ['light','dark'])assert.ok(css.includes(`[data-theme="${theme}"][data-mode="${mode}"]`));
 assert.deepEqual(Object.keys(catalog.en).sort(),Object.keys(catalog['zh-CN']).sort());
 for(const [selector,block] of [...css.matchAll(/(\[data-theme[^}]+)\{([^}]+)\}/g)].map(m=>[m[1],m[2]])) {
   assert.ok(!/radius|font-size|padding|width|height|gap/.test(block),selector);
 }
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
test('appearance controls wait for their local handlers before accepting input',()=>{
 const page=renderPage({title:'login',auth:true});
 assert.equal([...page.matchAll(/<select\b[^>]*data-pref="[^"]+"[^>]*disabled/g)].length,3);
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
test('six palettes keep small body, navigation and action text at 4.5:1 contrast',()=>{
 const css=fs.readFileSync(new URL('../../../web/console/styles.css',import.meta.url),'utf8');
 assert.match(css,/button:not\(\.primary\):not\(:disabled\),input,select\{border-color:var\(--muted\)\}/);
 const luminance=color=>{
  const v=color.match(/[0-9a-f]{2}/ig).map(x=>parseInt(x,16)/255).map(c=>c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4);
  return v[0]*0.2126+v[1]*0.7152+v[2]*0.0722;
 };
 const palettes=[...css.matchAll(/\[data-theme="([abc])"\]\[data-mode="(light|dark)"\]\{([^}]+)\}/g)];
 assert.equal(palettes.length,6);
 for(const palette of palettes){
  const colors=Object.fromEntries([...palette[3].matchAll(/--([a-z-]+):(#\w+)/g)].map(m=>[m[1],m[2]]));
  for(const [foreground,background] of [['text','surface'],['muted','surface'],['muted','bg'],['accent','soft'],['on-accent','accent']]){
   const a=luminance(colors[foreground]),b=luminance(colors[background]),ratio=(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
   assert.ok(ratio>=4.5,`${palette[1]} ${palette[2]} ${foreground}/${background}: ${ratio}`);
  }
 }
});
