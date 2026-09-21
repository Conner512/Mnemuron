import fs from 'node:fs';
import {text} from './catalog.mjs';
import {icon,orbit} from './visuals.mjs';
export const escapeHtml=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const pages=['overview','memories','summaries','jobs','connections','models','security','audit','storage','appearance','invitations','accounts'];
export const routeTitle=route=>route==='/app' || route==='/app/'?'overview':pages.find(p=>route===`/app/${p}`)??null;
export const label=(key,tag='span')=>`<${tag} data-i18n="${key}">${escapeHtml(text(key))}</${tag}>`;

// Native controls remain usable with a keyboard. Disabled until the local handler is ready.
export const appearanceControls=()=>`<div class="appearance-controls">
  <div class="preference-select"><label class="sr-only" for="theme" data-i18n="theme">${text('theme')}</label><select id="theme" data-pref="theme" disabled><option value="a" data-i18n="themeName_a">${text('themeName_a')}</option><option value="b" data-i18n="themeName_b">${text('themeName_b')}</option><option value="c" data-i18n="themeName_c">${text('themeName_c')}</option></select></div>
  <div class="preference-select mode-select">${icon('appearance')}<label class="sr-only" for="mode" data-i18n="mode">${text('mode')}</label><select id="mode" data-pref="mode" disabled><option value="light" data-i18n="light">${text('light')}</option><option value="dark" data-i18n="dark">${text('dark')}</option></select></div>
  <div class="preference-select"><label class="sr-only" for="locale" data-i18n="language">${text('language')}</label><select id="locale" data-pref="locale" disabled><option value="zh-CN">中文</option><option value="en">English</option></select></div>
</div>`;

export function renderPage({title,body='',auth=false,authPurpose='console',account=null,csrf='',page='overview'}) {
  const brandContent=`<span class="brand-icon" aria-hidden="true">${icon('brand')}</span><span>Mnemuron</span>`;
  // An OAuth interaction is not an ordinary console sign-in. Do not add bypass/navigation links.
  const brand=auth&&authPurpose==='oauth'?`<span class="brand">${brandContent}</span>`:`<a class="brand" href="${auth?'/login':'/app'}">${brandContent}</a>`;
  const nav=pages.map((p,i)=>`${i===0?label('workspace','h2'):i===4?label('settings','h2'):i===10?label('platform','h2'):''}<a href="/app/${p}" ${p===page?'aria-current="page"':''}><span class="nav-icon">${icon(p)}</span>${label(p)}${p===page?'<span class="nav-current" aria-hidden="true"></span>':''}</a>`).join('');
  const username=escapeHtml(account?.username||'');
  const inside=auth?`<main id="main" tabindex="-1" class="auth-layout"><section class="auth-brand"><div>${brand}<p class="eyebrow" data-i18n="systemLabel">${text('systemLabel')}</p></div><div class="auth-story"><h2>${label('authHeadlineFirst')}${label('authHeadlineSecond')}</h2>${label('authDescription','p')}${orbit()}</div><div class="auth-brand-bottom"><div class="privacy-note">${icon('security')}${label('authNote','p')}</div>${label('authFooter','small')}</div></section><section class="auth-form"><header>${appearanceControls()}</header><div class="form-content"><p class="eyebrow">${label('authEyebrow')}</p>${label(title,'h1')}${body}</div><div class="auth-footer">${label('brandNote','small')}</div></section></main>`:
    `<aside class="sidebar">${brand}<p class="eyebrow" data-i18n="systemLabel">${text('systemLabel')}</p><div class="account-badge"><span class="avatar" aria-hidden="true">${escapeHtml(account?.username?.slice(0,1)||'·')}</span><div><strong>${username}</strong>${label('workspace','small')}</div>${icon('security')}</div><nav aria-label="Mnemuron">${nav}</nav><p class="handoff">${icon('security')}${label('handoff')}</p></aside>
    <div class="workspace"><header class="topbar"><div class="breadcrumb">${label('workspace')} <span aria-hidden="true">/</span> <strong>${label(title)}</strong></div><div class="topbar-tools"><a class="top-search" href="/app/memories">${icon('search')}${label('search')}</a>${appearanceControls()}<details class="account-menu"><summary data-i18n-title="accountMenu" title="${text('accountMenu')}"><span class="account-name">${username}</span><span aria-hidden="true">⌄</span></summary><div class="account-menu-panel">${label('identity','small')}<strong>${username}</strong><form action="/console-api/logout" method="post"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit" class="quiet">${icon('logout')}${label('signOut')}</button></form></div></details></div></header>
    <main id="main" tabindex="-1"><div id="console-root">${body||`<div class="page-heading"><div>${label(title,'h1')}${label('loading','p')}</div></div><div class="card loading-card" role="status">${label('loading')}</div>`}</div></main><footer><span class="footer-mark">Mnemuron</span><span aria-hidden="true">·</span>${label('readOnly')}<span aria-hidden="true">·</span>${label('notProduction')}</footer></div>
    <dialog id="memory-dialog" aria-labelledby="detail-title"><div class="dialog-header">${label('detail','h2').replace('<h2','<h2 id="detail-title"')}<button type="button" class="close-button" data-close data-i18n-aria-label="close" aria-label="${text('close')}">${icon('close')}</button></div><div id="memory-content"></div></dialog>`;
  return `<!doctype html><html lang="zh-CN" data-theme="a" data-mode="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Mnemuron · ${escapeHtml(text(title))}</title><link rel="stylesheet" href="/assets/styles.css"><script type="module" src="/assets/appearance.mjs"></script>${auth?'':'<script type="module" src="/assets/app.mjs"></script>'}</head><body data-account="${escapeHtml(account?.account_id||'')}" data-page="${escapeHtml(page)}" data-title="${escapeHtml(title)}" data-csrf="${escapeHtml(csrf)}"><a class="skip-link" href="#main" data-i18n="continue">${text('continue')}</a>${inside}<p id="live-status" class="sr-only" role="status" aria-live="polite"></p></body></html>`;
}
export function serveAsset(request,response,pathname) {
  const file=pathname.match(/^\/assets\/(styles\.css|appearance\.mjs|catalog\.mjs|app\.mjs|session-state\.mjs|visuals\.mjs|actions\.mjs)$/)?.[1];
  if(!file||request.method!=='GET')return false;
  const content=fs.readFileSync(new URL(file,import.meta.url));
  response.writeHead(200,{'content-type':file.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8','cache-control':'no-cache','x-content-type-options':'nosniff'});response.end(content);return true;
}
export function sendPage(response,options,{status=200,redirectUri=''}={}) {
  response.writeHead(status,{'content-type':'text/html; charset=utf-8','cache-control':'no-store',
    'content-security-policy':`default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self' ${redirectUri}; frame-ancestors 'none'; base-uri 'none'`,
    'x-frame-options':'DENY','referrer-policy':'same-origin','x-content-type-options':'nosniff'});
  response.end(renderPage(options));
}
