import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {text} from './catalog.mjs';
import {icon} from './icons.mjs';
// Modules run after parsing: restore only validated, account-scoped colors before
// the stylesheet can paint. Keep executable text fixed for a narrow CSP hash.
const appearanceBootstrap=`(()=>{try{const root=document.documentElement,account=document.currentScript.dataset.appearanceAccount;
const saved=JSON.parse(localStorage.getItem('mnemuron.appearance.v1.'+account)||'{}');
for(const [key,values] of Object.entries({theme:['a','b','c'],mode:['light','dark']}))if(values.includes(saved?.[key]))root.dataset[key]=saved[key];
if(['zh-CN','en'].includes(saved?.locale))root.lang=saved.locale;}catch{}})();`;
const appearanceBootstrapHash=createHash('sha256').update(appearanceBootstrap).digest('base64');
export const escapeHtml=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const pages=['overview','memories','summaries','jobs','connections','models','security','audit','storage','appearance','invitations','accounts'];
export const routeTitle=route=>route==='/app' || route==='/app/'?'overview':pages.find(p=>route===`/app/${p}`)??null;
export const label=(key,tag='span')=>`<${tag} data-i18n="${key}">${escapeHtml(text(key))}</${tag}>`;

// Information architecture: four work areas in the rail; everything else lives in Settings.
const primary=[['overview','navHome','home'],['memories','navLibrary','library'],['summaries','navSummaries','summaries'],['jobs','navJobs','jobs']];
const settingsGroups=[['settingsGroupAccount',['connections','security']],['settingsGroupSystem',['models','storage','audit','appearance']],['settingsGroupPlatform',['invitations','accounts']]];
const settingsPages=settingsGroups.flatMap(([,items])=>items);
export const isSettingsPage=page=>settingsPages.includes(page);

// Native controls remain usable with a keyboard. Disabled until the local handler is ready.
export const appearanceControls=()=>`<div class="appearance-controls" role="group" data-i18n-aria-label="displayPrefs" aria-label="${escapeHtml(text('displayPrefs'))}">
  <div class="preference-select"><label class="sr-only" for="theme" data-i18n="theme">${text('theme')}</label><select id="theme" data-pref="theme" disabled><option value="a" data-i18n="themeName_a">${text('themeName_a')}</option><option value="b" data-i18n="themeName_b">${text('themeName_b')}</option><option value="c" data-i18n="themeName_c">${text('themeName_c')}</option></select></div>
  <div class="preference-select mode-select"><label class="sr-only" for="mode" data-i18n="mode">${text('mode')}</label><select id="mode" data-pref="mode" disabled><option value="light" data-i18n="light">${text('light')}</option><option value="dark" data-i18n="dark">${text('dark')}</option></select></div>
  <div class="preference-select"><label class="sr-only" for="locale" data-i18n="language">${text('language')}</label><select id="locale" data-pref="locale" disabled><option value="zh-CN">中文</option><option value="en">English</option></select></div>
</div>`;

const navLink=(page,current,key,glyph,className)=>`<a class="${className}" href="/app/${page}"${page===current?' aria-current="page"':''}>${icon(glyph)}${label(key)}</a>`;
const settingsLinks=(current,className,withCurrent)=>settingsGroups.map(([group,items])=>`<div class="nav-group">${label(group,'h2')}${items.map(p=>navLink(p,withCurrent?current:null,p,p,className)).join('')}</div>`).join('');

function consoleShell({title,body,account,csrf,page}) {
  const username=escapeHtml(account?.username||'');
  const initial=escapeHtml([...(account?.username||'·')][0]);
  const inSettings=isSettingsPage(page);
  const rail=`<nav class="rail" aria-label="Mnemuron">
    <a class="brand" href="/app"><span class="brand-mark" aria-hidden="true">${icon('mark')}</span><span class="sr-only">Mnemuron</span></a>
    <div class="rail-primary">${primary.map(([p,key,glyph])=>navLink(p,page,key,glyph,'rail-link')).join('')}</div>
    <div class="rail-end">
      <details class="rail-menu"${inSettings?' data-active':''}><summary class="rail-link">${icon('settings')}${label('navSettings')}</summary>
        <div class="rail-flyout">${label('settingsTitle','p')}${settingsLinks(page,'flyout-link',false)}</div></details>
      <details class="account-menu"><summary data-i18n-title="accountMenu" title="${text('accountMenu')}"><span class="avatar" aria-hidden="true">${initial}</span><span class="account-name sr-only">${username}</span></summary>
        <div class="account-menu-panel"><p class="eyebrow" data-i18n="systemLabel">${text('systemLabel')}</p>${label('identity','small')}<strong>${username}</strong>
        <form action="/console-api/logout" method="post"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit" class="quiet">${icon('logout')}${label('signOut')}</button></form></div></details>
    </div></nav>`;
  const settingsNav=inSettings?`<nav class="settings-nav" data-i18n-aria-label="settingsTitle" aria-label="${escapeHtml(text('settingsTitle'))}">${label('settingsTitle','p')}${settingsLinks(page,'settings-link',true)}</nav>`:'';
  const loading=`<div class="page-heading"><div>${label(title,'h1')}${label('loading','p')}</div></div><div class="loading-card" role="status">${label('loading')}</div>`;
  return `<div class="shell">${rail}
  <div class="workspace${inSettings?' has-settings':''}">
    <header class="topbar"><div class="breadcrumb">${label(inSettings?'settingsTitle':'workspace')}<span aria-hidden="true">/</span><strong>${label(title)}</strong></div>
      <div class="topbar-tools"><a class="top-search" href="/app/memories" data-search-shortcut>${icon('search')}${label('shortcutSearch')}<kbd aria-hidden="true">/</kbd></a>${appearanceControls()}</div></header>
    <div class="workspace-body">${settingsNav}<main id="main" tabindex="-1"><div id="console-root">${body||loading}</div></main></div>
    <footer><span class="footer-mark">Mnemuron</span></footer>
  </div></div>
  <dialog id="memory-dialog" class="pane" aria-labelledby="detail-title"><div class="dialog-header"><h2 id="detail-title" data-i18n="detail">${text('detail')}</h2><button type="button" class="close-button" data-close data-i18n-aria-label="closePane" aria-label="${text('closePane')}">${icon('close')}</button></div><div id="memory-content"></div></dialog>`;
}

function authShell({title,body,authPurpose}) {
  const mark=`<span class="brand-mark" aria-hidden="true">${icon('mark')}</span><span>Mnemuron</span>`;
  // An OAuth interaction is not an ordinary console sign-in. Do not add bypass/navigation links.
  const brand=authPurpose==='oauth'?`<span class="brand">${mark}</span>`:`<a class="brand" href="/login">${mark}</a>`;
  const points=[['source','authPoint_source'],['lock','authPoint_readonly'],['security','authPoint_isolation']];
  return `<main id="main" tabindex="-1" class="auth-layout">
  <section class="auth-brand"><div>${brand}<p class="eyebrow" data-i18n="systemLabel">${text('systemLabel')}</p></div>
    <div class="auth-story"><h2>${label('authHeadlineFirst')}${label('authHeadlineSecond')}</h2>${label('authDescription','p')}
      <ul class="auth-points">${points.map(([glyph,key])=>`<li>${icon(glyph)}${label(key)}</li>`).join('')}</ul></div>
    <div class="auth-brand-bottom"><div class="privacy-note">${icon('security')}${label('authNote','p')}</div>${label('authFooter','small')}</div></section>
  <section class="auth-form"><header>${appearanceControls()}</header><div class="form-content"><p class="eyebrow">${label('authEyebrow')}</p>${label(title,'h1')}${body}</div><div class="auth-footer">${label('brandNote','small')}</div></section>
  </main>`;
}

export function renderPage({title,body='',auth=false,authPurpose='console',account=null,csrf='',page='overview'}) {
  const inside=auth?authShell({title,body,authPurpose}):consoleShell({title,body,account,csrf,page});
  return `<!doctype html><html lang="zh-CN" data-theme="a" data-mode="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Mnemuron · ${escapeHtml(text(title))}</title><script data-appearance-account="${escapeHtml(account?.account_id||'signed-out')}">${appearanceBootstrap}</script><link rel="stylesheet" href="/assets/styles.css"><script type="module" src="/assets/appearance.mjs"></script>${auth?'':'<script type="module" src="/assets/app.mjs"></script>'}</head><body class="${auth?'is-auth':'is-console'}" data-account="${escapeHtml(account?.account_id||'')}" data-page="${escapeHtml(page)}" data-title="${escapeHtml(title)}" data-csrf="${escapeHtml(csrf)}"><a class="skip-link" href="#main" data-i18n="continue">${text('continue')}</a>${inside}<p id="live-status" class="sr-only" role="status" aria-live="polite"></p></body></html>`;
}
const MODULES=['appearance.mjs','catalog.mjs','app.mjs','session-state.mjs','visuals.mjs','icons.mjs','html.mjs','actions.mjs','connections.mjs'];
const STYLESHEETS=['styles.css','controls.css'];
export function serveAsset(request,response,pathname) {
  const file=pathname.match(/^\/assets\/([a-z-]+\.(?:mjs|css))$/)?.[1];
  if(!file||request.method!=='GET'||!(MODULES.includes(file)||file==='styles.css'))return false;
  // Keep one public stylesheet URL: existing ingress rules and CSP remain valid.
  const content=file==='styles.css'?Buffer.concat(STYLESHEETS.flatMap(name=>[fs.readFileSync(new URL(name,import.meta.url)),Buffer.from('\n')])):fs.readFileSync(new URL(file,import.meta.url));
  response.writeHead(200,{'content-type':file.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8','cache-control':'no-cache','x-content-type-options':'nosniff'});response.end(content);return true;
}
export function sendPage(response,options,{status=200,redirectUri=''}={}) {
  response.writeHead(status,{'content-type':'text/html; charset=utf-8','cache-control':'no-store',
    'content-security-policy':`default-src 'none'; style-src 'self'; script-src 'self' 'sha256-${appearanceBootstrapHash}'; connect-src 'self'; img-src 'self'; form-action 'self' ${redirectUri}; frame-ancestors 'none'; base-uri 'none'`,
    'x-frame-options':'DENY','referrer-policy':'same-origin','x-content-type-options':'nosniff'});
  response.end(renderPage(options));
}
