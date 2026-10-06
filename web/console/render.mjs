import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {text} from './catalog.mjs';
import {icon} from './visuals.mjs';
// Modules run after parsing: restore the validated, account-scoped interface language before
// the stylesheet can paint. Keep executable text fixed for a narrow CSP hash.
const appearanceBootstrap=`(()=>{try{const root=document.documentElement,account=document.currentScript.dataset.appearanceAccount;
const saved=JSON.parse(localStorage.getItem('mnemuron.appearance.v1.'+account)||'{}');
if(['zh-CN','en'].includes(saved?.locale))root.lang=saved.locale;}catch{}})();`;
const appearanceBootstrapHash=createHash('sha256').update(appearanceBootstrap).digest('base64');
export const escapeHtml=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
import {pages,pageCode} from './routes.mjs';
export {pages,pageCode};
export const routeTitle=route=>route==='/app' || route==='/app/'?'overview':pages.find(p=>route===`/app/${p}`)??null;
export const label=(key,tag='span')=>`<${tag} data-i18n="${key}">${escapeHtml(text(key))}</${tag}>`;

// Navigation: three groups and fifteen destinations, each an icon + label, no route codes.
// What each destination offers or will offer is listed in the feature map (visuals.mjs).
const navGroups=[['workspace',[['overview','home'],['memories','library'],['summaries','summaries'],['tasks','tasks'],['resume','resume'],['jobs','jobs']]],
  ['settings',[['connections','connections'],['models','models'],['privacy','privacy'],['security','security'],['audit','audit'],['storage','storage']]],
  ['settingsGroupPlatform',[['invitations','invitations'],['accounts','accounts'],['system','system']]]];
const groupOf=page=>navGroups.find(([,items])=>items.some(([p])=>p===page))?.[0]||'workspace';
// Logo: a seal inside corner quotes. The quotes cite the source; the seal is the memory kept on record.
// Quotes follow the text colour, the seal the accent (styles.css). Geometry: docs/console-design.md.
const logo='<svg class="logo" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path class="logo-quotes" d="M5 19V5h14M43 29v14H29" fill="none" stroke="currentColor" stroke-width="4.5" stroke-linecap="square"/><rect class="logo-seal" x="15" y="15" width="18" height="18"/></svg>';
const brandMark=`<span class="brand-mark" aria-hidden="true">${logo}</span><span class="brand-name">Mnemuron</span>`;

// One palette, so the only display preference is the interface language. The native select stays
// usable with a keyboard and is disabled until the local handler is ready.
const languageControl=()=>`<div class="language-control"><label class="sr-only" for="locale" data-i18n="language">${text('language')}</label><select id="locale" data-pref="locale" disabled><option value="zh-CN">中文</option><option value="en">English</option></select></div>`;

function consoleShell({title,body,account,csrf,page}) {
  const username=escapeHtml(account?.username||'');
  const initial=escapeHtml([...(account?.username||'·')][0]);
  const nav=navGroups.map(([group,items])=>`<div class="nav-group">${label(group,'h2')}${items.map(([p,glyph])=>`<a href="/app/${p}"${p===page?' aria-current="page"':''}><span class="nav-icon">${icon(glyph)}</span>${label(p)}</a>`).join('')}</div>`).join('');
  const loading=`<div class="page-heading"><div>${label(title,'h1')}${label('loading','p')}</div></div><div class="loading-card" role="status">${label('loading')}</div>`;
  return `<div class="shell">
  <aside class="sidebar"><a class="brand" href="/app">${brandMark}</a><p class="eyebrow" data-i18n="systemLabel">${text('systemLabel')}</p>
    <nav aria-label="Mnemuron">${nav}</nav>
    <div class="account-badge"><span class="avatar" aria-hidden="true">${initial}</span><div><strong>${username}</strong>${label('sessionSecure','small')}</div>${icon('security')}</div></aside>
  <div class="workspace">
    <header class="topbar"><div class="breadcrumb">${label(groupOf(page))}<span aria-hidden="true">/</span><strong>${label(title)}</strong></div>
      <div class="topbar-tools"><a class="top-search" href="/app/memories" data-search-shortcut>${icon('search')}${label('shortcutSearch')}<kbd aria-hidden="true">/</kbd></a>${languageControl()}
        <details class="account-menu"><summary data-i18n-title="accountMenu" title="${text('accountMenu')}"><span class="account-name">${username}</span><span class="account-chevron" aria-hidden="true"></span></summary>
          <div class="account-menu-panel">${label('identity','small')}<strong>${username}</strong><form action="/console-api/logout" method="post"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit" class="quiet">${icon('logout')}${label('signOut')}</button></form></div></details></div></header>
    <main id="main" tabindex="-1"><div id="console-root">${body||loading}</div></main>
    <footer><span class="footer-mark">Mnemuron</span></footer>
  </div></div>
  <dialog id="memory-dialog" class="pane" aria-labelledby="detail-title"><div class="dialog-header"><h2 id="detail-title" data-i18n="detail">${text('detail')}</h2><button type="button" class="close-button" data-close data-i18n-aria-label="closePane" aria-label="${text('closePane')}">${icon('close')}</button></div><div id="memory-content"></div></dialog>`;
}

function authShell({title,body,authPurpose}) {
  // An OAuth interaction is not an ordinary console sign-in. Do not add bypass/navigation links.
  const brand=authPurpose==='oauth'?`<span class="brand">${brandMark}</span>`:`<a class="brand" href="/login">${brandMark}</a>`;
  const points=[['history','authPoint_source'],['eye','authPoint_readonly'],['security','authPoint_isolation']];
  // The OAuth sign-in form carries its own "not your ChatGPT password" note; the shell adds no notes.
  const cards='<div class="auth-cards" aria-hidden="true"><span class="auth-card"></span><span class="auth-card"></span><span class="auth-card"><i></i><i></i><i></i><b></b></span></div>';
  return `<main id="main" tabindex="-1" class="auth-layout">
  <section class="auth-brand"><div class="auth-brand-top">${brand}<p class="eyebrow" data-i18n="systemLabel">${text('systemLabel')}</p></div>
    <div class="auth-hero"><div class="auth-story"><h2>${label('authHeadlineFirst')}${label('authHeadlineSecond')}</h2>${label('authDescription','p')}
      <ul class="auth-points">${points.map(([glyph,key])=>`<li>${icon(glyph)}${label(key)}</li>`).join('')}</ul></div>${cards}</div>
    <div class="auth-brand-bottom">${label('authFooter','small')}</div></section>
  <section class="auth-form"><header>${languageControl()}</header><div class="form-content"><p class="eyebrow">${label('authEyebrow')}</p>${label(title,'h1')}${body}</div><div class="auth-footer">${label('brandNote','small')}</div></section>
  </main>`;
}

export function renderPage({title,body='',auth=false,authPurpose='console',account=null,csrf='',page='overview'}) {
  const inside=auth?authShell({title,body,authPurpose}):consoleShell({title,body,account,csrf,page});
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Mnemuron · ${escapeHtml(text(title))}</title><script data-appearance-account="${escapeHtml(account?.account_id||'signed-out')}">${appearanceBootstrap}</script><link rel="stylesheet" href="/assets/styles.css?v=${stylesheetVersion}"><link rel="icon" href="/assets/favicon.svg" type="image/svg+xml"><script type="module" src="/assets/appearance.mjs"></script>${auth?'':'<script type="module" src="/assets/app.mjs"></script>'}</head><body class="${auth?'is-auth':'is-console'}" data-account="${escapeHtml(account?.account_id||'')}" data-page="${escapeHtml(page)}" data-title="${escapeHtml(title)}" data-csrf="${escapeHtml(csrf)}"><a class="skip-link" href="#main" data-i18n="continue">${text('continue')}</a>${inside}<p id="live-status" class="sr-only" role="status" aria-live="polite"></p></body></html>`;
}
// Browser modules. The public ingress allows exactly these paths (docs/console-ingress.example.yml);
// add a module only together with its ingress route, or fold it into an existing one.
const MODULES=['appearance.mjs','catalog.mjs','app.mjs','session-state.mjs','visuals.mjs','actions.mjs','connections.mjs'];
const STYLESHEETS=['styles.css','controls.css'];
const stylesheetContent=()=>Buffer.concat(STYLESHEETS.flatMap(name=>[fs.readFileSync(new URL(name,import.meta.url)),Buffer.from('\n')]));
// New markup must not reuse a prior release's cached palette; keep the allowlisted path unchanged.
const stylesheetVersion=createHash('sha256').update(stylesheetContent()).digest('hex').slice(0,16);
const TYPES={css:'text/css; charset=utf-8',mjs:'text/javascript; charset=utf-8',svg:'image/svg+xml'};
export function serveAsset(request,response,pathname) {
  const file=pathname.match(/^\/assets\/([a-z-]+\.(?:mjs|css|svg))$/)?.[1];
  if(!file||request.method!=='GET'||!(MODULES.includes(file)||file==='styles.css'||file==='favicon.svg'))return false;
  // Keep one public stylesheet URL: existing ingress rules and CSP remain valid.
  const content=file==='styles.css'?stylesheetContent():fs.readFileSync(new URL(file,import.meta.url));
  response.writeHead(200,{'content-type':TYPES[file.split('.').pop()],'cache-control':'no-cache','x-content-type-options':'nosniff'});response.end(content);return true;
}
export function sendPage(response,options,{status=200,redirectUri=''}={}) {
  response.writeHead(status,{'content-type':'text/html; charset=utf-8','cache-control':'no-store',
    'content-security-policy':`default-src 'none'; style-src 'self'; script-src 'self' 'sha256-${appearanceBootstrapHash}'; connect-src 'self'; img-src 'self'; form-action 'self' ${redirectUri}; frame-ancestors 'none'; base-uri 'none'`,
    'x-frame-options':'DENY','referrer-policy':'same-origin','x-content-type-options':'nosniff'});
  response.end(renderPage(options));
}
