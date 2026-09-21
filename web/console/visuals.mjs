// Shared, dependency-free presentation. No API calls, account selection or authorization here.
// Icons are fixed local paths, never markup from a memory or an upstream response.
const paths = {
  brand: '<path d="M4 19V5l8 7 8-7v14"/>',
  overview: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  memories: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h5"/>',
  summaries: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  jobs: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  connections: '<path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 1 1-1a4 4 0 1 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 0)"/>',
  models: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 1v5m6-5v5M9 18v5m6-5v5M1 9h5m-5 6h5m12-6h5m-5 6h5"/>',
  security: '<path d="m12 3 8 3v6c0 4-3 7-8 9-5-2-8-5-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  audit: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h8M8 18h4"/>',
  storage: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  appearance: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18a9 9 0 0 0 0-18Z" fill="currentColor" stroke="none"/>',
  invitations: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v5m10-5v5M3 11h18M8 15h2m4 0h2"/>',
  accounts: '<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m0-17a3 3 0 0 1 0 6m3 5a5 5 0 0 1 3 4v2"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  arrow: '<path d="M4 12h16m-5-5 5 5-5 5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>',
  moon: '<path d="M20 15a9 9 0 0 1-11-11 9 9 0 1 0 11 11Z"/>',
  check: '<path d="m5 12 4 4 10-10"/>',
  logout: '<path d="M9 3H4v18h5m5-14 5 5-5 5M9 12h10"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
};
export const icon = name => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name] || paths.memories}</svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const label = (t, key, tag = 'span') => `<${tag} data-i18n="${key}">${esc(t(key))}</${tag}>`;
export const orbit = () => `<div class="memory-orbit" aria-hidden="true"><div class="orbit-ring"></div><div class="orbit-ring outer"></div><div class="orbit-node"><span class="brand-icon">${icon('brand')}</span></div><span class="orbit-dots">···</span><div class="orbit-node">${icon('connections')}</div><span class="orbit-caption">MEMORY · CONTEXT · CONNECTION</span></div>`;

export function overviewView(data, {t, memoryRows}) {
  const l = (key, tag) => label(t, key, tag);
  // The reference's trends and connected/completed badges were demo data. Never invent them.
  const count = key => Number.isSafeInteger(data.counts?.[key]) && data.counts[key] >= 0 ? data.counts[key].toLocaleString() : '—';
  return `<section class="hero"><div class="hero-copy"><p class="eyebrow">${l('heroLabel')}</p><h2>${l('connectionHeadline')}</h2>${l('connectionDescription','p')}<a class="button primary" href="/app/connections">${l('manageConnections')}${icon('arrow')}</a></div>${orbit()}</section>
  <div class="metrics">${[['memories','memoryCount','memories'],['sources','sourceCount','audit'],['summaries','summaryCount','summaries'],['jobs','jobCount','jobs']].map(([key,title,glyph]) => `<section class="card metric"><div class="metric-heading">${l(title)}<span class="metric-icon">${icon(glyph)}</span></div><strong>${count(key)}</strong>${l('ownedRecords','small')}</section>`).join('')}</div>
  <div class="columns overview-columns"><section class="card recent-card"><div class="card-heading"><div><p class="eyebrow">${l('recentLabel')}</p>${l('recent','h2')}</div><a href="/app/memories">${l('viewAll')} ${icon('arrow')}</a></div>${memoryRows(data.recent)}${l('inspectMemoryNote','p')}</section>
  <section class="card processing-card"><div class="card-heading"><div><p class="eyebrow">${l('processingLabel')}</p>${l('memoryProcessing','h2')}</div><span class="metric-icon">${icon('jobs')}</span></div>
  <div class="processing-stage"><span class="stage-icon">${icon('memories')}</span><div>${l('memoryCount')}<small>${l('atomicNote')}</small></div><strong>${count('memories')}</strong></div>
  <div class="processing-stage"><span class="stage-icon">${icon('summaries')}</span><div>${l('summaryCount')}<small>${l('derivedNote')}</small></div><strong>${count('summaries')}</strong></div>
  <div class="processing-stage"><span class="stage-icon">${icon('jobs')}</span><div>${l('jobCount')}<small>${l('jobStatusNote')}</small></div><strong>${count('jobs')}</strong></div>
  <div class="privacy-note">${icon('security')}${l('summaryBoundary','p')}</div><a class="text-link" href="/app/jobs">${l('viewJobs')} ${icon('arrow')}</a></section></div>`;
}

export function appearanceView(t) {
  const l = (key, tag) => label(t, key, tag);
  const pick = (property, value, content, className) => `<button class="${className}" type="button" data-pref="${property}" data-pref-value="${value}" aria-pressed="false" disabled>${content}</button>`;
  const mini = `<span class="mini-shell" aria-hidden="true"><span class="mini-sidebar"><i></i><i></i><i></i><i></i></span><span class="mini-main"><i class="mini-topbar"></i><i class="mini-hero"></i><span class="mini-metrics"><i></i><i></i><i></i><i></i></span><span class="mini-columns"><i></i><i></i></span></span></span>`;
  return `<section class="card appearance-card"><div class="card-heading"><div><p class="eyebrow">${l('personalizeLabel')}</p>${l('theme','h2')}</div><span class="tag">${l('fixedLayout')}</span></div>${l('appearanceNote','p')}
  <div class="theme-options" role="group" data-i18n-aria-label="theme" aria-label="${esc(t('theme'))}">${['a','b','c'].map(theme => pick('theme',theme,`${mini}<span class="theme-option-info"><span><strong>${l(`themeName_${theme}`)}</strong><small>${l(`themeNote_${theme}`)}</small></span><span class="selection-check">${icon('check')}</span></span>`,'theme-option')).join('')}</div></section>
  <div class="columns preference-columns"><section class="card"><div class="card-heading">${l('mode','h2')}${icon('sun')}</div>${l('modeNote','p')}<div class="segmented" role="group" data-i18n-aria-label="mode" aria-label="${esc(t('mode'))}">${['light','dark'].map(mode => pick('mode',mode,`${icon(mode==='light'?'sun':'moon')}${l(mode)}`,'segment')).join('')}</div></section>
  <section class="card"><div class="card-heading">${l('language','h2')}<span class="language-mark" aria-hidden="true">文 / A</span></div>${l('languageNote','p')}<div class="segmented" role="group" data-i18n-aria-label="language" aria-label="${esc(t('language'))}">${pick('locale','zh-CN','简体中文','segment')}${pick('locale','en','English','segment')}</div></section></div>
  <div class="privacy-note appearance-footnote">${icon('security')}${l('appearanceScopeNote','p')}</div>`;
}
