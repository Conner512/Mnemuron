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
import {pages,pageCode} from './routes.mjs';
export {pages,pageCode};
export const routeTitle=route=>route==='/app' || route==='/app/'?'overview':pages.find(p=>route===`/app/${p}`)??null;
export const label=(key,tag='span')=>`<${tag} data-i18n="${key}">${escapeHtml(text(key))}</${tag}>`;

// Navigation keeps the original three groups and twelve destinations.
const navGroups=[['workspace',[['overview','home'],['memories','library'],['summaries','summaries'],['jobs','jobs']]],
  ['settings',[['connections','connections'],['models','models'],['security','security'],['audit','audit'],['storage','storage'],['appearance','appearance']]],
  ['settingsGroupPlatform',[['invitations','invitations'],['accounts','accounts']]]];

// Native controls remain usable with a keyboard. Disabled until the local handler is ready.
export const appearanceControls=()=>`<div class="appearance-controls" role="group" data-i18n-aria-label="displayPrefs" aria-label="${escapeHtml(text('displayPrefs'))}">
  <div class="preference-select"><label class="sr-only" for="theme" data-i18n="theme">${text('theme')}</label><select id="theme" data-pref="theme" disabled><option value="a" data-i18n="themeName_a">${text('themeName_a')}</option><option value="b" data-i18n="themeName_b">${text('themeName_b')}</option><option value="c" data-i18n="themeName_c">${text('themeName_c')}</option></select></div>
  <div class="preference-select mode-select"><label class="sr-only" for="mode" data-i18n="mode">${text('mode')}</label><select id="mode" data-pref="mode" disabled><option value="light" data-i18n="light">${text('light')}</option><option value="dark" data-i18n="dark">${text('dark')}</option></select></div>
  <div class="preference-select"><label class="sr-only" for="locale" data-i18n="language">${text('language')}</label><select id="locale" data-pref="locale" disabled><option value="zh-CN">中文</option><option value="en">English</option></select></div>
</div>`;

function consoleShell({title,body,account,csrf,page}) {
  const username=escapeHtml(account?.username||'');
  const initial=escapeHtml([...(account?.username||'·')][0]);
  const nav=navGroups.map(([group,items])=>`<div class="nav-group">${label(group,'h2')}${items.map(([p,glyph])=>`<a href="/app/${p}"${p===page?' aria-current="page"':''}><span class="nav-icon">${icon(glyph)}</span>${label(p)}<span class="nav-code" aria-hidden="true">${pageCode(p).slice(3)}</span></a>`).join('')}</div>`).join('');
  const loading=`<div class="page-heading"><div>${label(title,'h1')}${label('loading','p')}</div></div><div class="loading-card" role="status">${label('loading')}</div>`;
  return `<div class="shell">
  <aside class="sidebar"><a class="brand" href="/app"><span class="brand-mark" aria-hidden="true">${icon('mark')}</span><span>Mnemuron</span></a><p class="eyebrow" data-i18n="systemLabel">${text('systemLabel')}</p>
    <nav aria-label="Mnemuron">${nav}</nav>
    <div class="account-badge"><span class="avatar" aria-hidden="true">${initial}</span><div><strong>${username}</strong>${label('workspace','small')}</div>${icon('security')}</div></aside>
  <div class="workspace">
    <header class="topbar"><div class="breadcrumb"><span class="page-code">${pageCode(page)}</span>${label('workspace')}<span aria-hidden="true">/</span><strong>${label(title)}</strong></div>
      <dl class="status-readout">
        <div><dt data-i18n="statusClock">${text('statusClock')}</dt><dd id="status-clock">--:--:--</dd></div>
        <div><dt data-i18n="statusSession">${text('statusSession')}</dt><dd data-state="ok" data-i18n="sessionVerified">${text('sessionVerified')}</dd></div>
        <div><dt data-i18n="statusLink">${text('statusLink')}</dt><dd id="status-link" data-state="pending" data-i18n="linkPending">${text('linkPending')}</dd></div>
      </dl>
      <div class="topbar-tools"><a class="top-search" href="/app/memories" data-search-shortcut>${icon('search')}${label('shortcutSearch')}<kbd aria-hidden="true">/</kbd></a>${appearanceControls()}
        <details class="account-menu"><summary data-i18n-title="accountMenu" title="${text('accountMenu')}"><span class="account-name">${username}</span><span aria-hidden="true">⌄</span></summary>
          <div class="account-menu-panel">${label('identity','small')}<strong>${username}</strong><form action="/console-api/logout" method="post"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit" class="quiet">${icon('logout')}${label('signOut')}</button></form></div></details></div></header>
    <main id="main" tabindex="-1"><div id="console-root">${body||loading}</div></main>
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
  return `<!doctype html><html lang="zh-CN" data-skin="hud" data-theme="a" data-mode="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Mnemuron · ${escapeHtml(text(title))}</title><script data-appearance-account="${escapeHtml(account?.account_id||'signed-out')}">${appearanceBootstrap}</script><link rel="stylesheet" href="/assets/styles.css"><script type="module" src="/assets/appearance.mjs"></script>${auth?'':'<script type="module" src="/assets/app.mjs"></script>'}</head><body class="${auth?'is-auth':'is-console'}" data-account="${escapeHtml(account?.account_id||'')}" data-page="${escapeHtml(page)}" data-title="${escapeHtml(title)}" data-csrf="${escapeHtml(csrf)}"><a class="skip-link" href="#main" data-i18n="continue">${text('continue')}</a>${inside}<p id="live-status" class="sr-only" role="status" aria-live="polite"></p></body></html>`;
}
const MODULES=['routes.mjs','appearance.mjs','catalog.mjs','app.mjs','session-state.mjs','visuals.mjs','icons.mjs','html.mjs','actions.mjs','connections.mjs'];
const STYLESHEETS=['styles.css','controls.css','skin-hud.css'];
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
