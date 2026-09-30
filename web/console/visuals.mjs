// Pure console views for the memory workbench. No API calls, account selection or
// authorization here: controllers pass owner-scoped data in and get markup strings out.
// The escaping template tag and the icon set live here too: browsers may load only the
// asset paths allowed by the console ingress (docs/console-ingress.example.yml).

// Escaping template tag for console markup. Every interpolated value is HTML-escaped
// unless it is itself an html`` fragment or explicitly wrapped with trusted().
// Arrays are joined; null, undefined and false render as nothing.
const ENTITIES = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
class Markup {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}
const render = value => value === null || value === undefined || value === false ? ''
  : Array.isArray(value) ? value.map(render).join('')
  : value instanceof Markup ? value.value
  : String(value).replace(/[&<>"']/g, c => ENTITIES[c]);
export const html = (strings, ...values) => new Markup(strings.reduce((out, part, i) => out + part + (i < values.length ? render(values[i]) : ''), ''));
/** Mark fixed, locally generated markup (icons, other fragments) as already safe. Never pass user data. */
export const trusted = value => new Markup(String(value));

// Fixed local icon paths: 24px grid, 1.5 stroke, square caps and mitred joins to match the
// console's 2px corners. Never markup from memories or upstream data.
const paths = {
  home: '<rect x="4" y="4" width="6.5" height="6.5"/><rect x="13.5" y="4" width="6.5" height="6.5"/><rect x="4" y="13.5" width="6.5" height="6.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5"/>',
  library: '<rect x="4" y="8" width="12.5" height="12"/><path d="M7.5 8V4.5H20V16h-3.5"/><path d="M7 12.5h6.5M7 16h4"/>',
  summaries: '<path d="M6 3.5h8.5l4 4v13H6z"/><path d="M14.5 3.5v4h4"/><path d="M9 11h6.5M9 14h6.5M9 17h4"/>',
  jobs: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 3.5V8H15"/>',
  connections: '<path d="M10 14l4-4"/><path d="M8.3 11.2l-1.9 1.9a3.6 3.6 0 0 0 5.1 5.1l1.9-1.9"/><path d="M15.7 12.8l1.9-1.9a3.6 3.6 0 0 0-5.1-5.1l-1.9 1.9"/>',
  models: '<rect x="7" y="7" width="10" height="10"/><path d="M10 7V3.5M14 7V3.5M10 20.5V17M14 20.5V17M3.5 10H7M3.5 14H7M17 10h3.5M17 14h3.5"/>',
  security: '<path d="M12 3.5 5 6.2v5.3c0 4.1 2.9 7.2 7 9 4.1-1.8 7-4.9 7-9V6.2z"/><path d="m9 12 2.2 2.2 3.8-3.8"/>',
  audit: '<path d="M5.5 3.5h13v17h-13z"/><path d="M8.5 3.5v17"/><path d="M11.5 8h4M11.5 11.5h4"/>',
  storage: '<path d="M3.5 4.5h17V9h-17z"/><path d="M5 9v10.5h14V9"/><path d="M10 13h4"/>',
  tasks: '<path d="M3.5 6h6.5l2 2.5h8.5v11h-17z"/><path d="M8 13h8M8 16h5"/>',
  resume: '<path d="M4 8.5h14.5M15 5l3.5 3.5L15 12"/><path d="M20 15.5H5.5M9 12l-3.5 3.5L9 19"/>',
  privacy: '<path d="M3 12s3.2-5.5 9-5.5S21 12 21 12s-3.2 5.5-9 5.5S3 12 3 12z"/><circle cx="12" cy="12" r="2.5"/><path d="M4.5 19.5 19.5 4.5"/>',
  system: '<rect x="4" y="4.5" width="16" height="6"/><rect x="4" y="13.5" width="16" height="6"/><path d="M7.5 7.5h1M7.5 16.5h1M11.5 7.5h5M11.5 16.5h5"/>',
  invitations: '<path d="M3.5 6.5h17v3.7a1.8 1.8 0 0 0 0 3.6v3.7h-17v-3.7a1.8 1.8 0 0 0 0-3.6z"/><path d="M14.5 8.5v1M14.5 11.5v1M14.5 14.5v1"/>',
  accounts: '<circle cx="9" cy="8.5" r="3.5"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M15.5 5.2a3.5 3.5 0 0 1 0 6.6"/><path d="M17.5 14.6A6 6 0 0 1 21 20"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4.5 4.5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  source: '<path d="M4 13.5v6.5h16v-6.5"/><path d="M12 4v10"/><path d="m8 10 4 4 4-4"/>',
  history: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 3.5V8H9"/><path d="M12 8v4.5l3 2"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  logout: '<path d="M14 4.5H5.5v15H14M10.5 12H20M16.5 8.5 20 12l-3.5 3.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11"/><path d="M15.5 8.5V4.5h-11v11h4"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.5v.5"/>',
  warning: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17v.5"/>',
};
export const icon = name => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true" focusable="false">${paths[name] || paths.library}</svg>`;

const svg = name => trusted(icon(name));
const i18n = (t, key, tag = 'span') => html`<${trusted(tag)} data-i18n="${key}">${t(key)}</${trusted(tag)}>`;
const safeCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const rowsOf = rows => Array.isArray(rows)
  ? rows.map(r => ({value: String(r?.value ?? ''), count: safeCount(r?.count)})).filter(r => r.value && r.count !== null && r.count > 0)
  : [];
const fixed = n => Number(n.toFixed(2));
const preview = value => [...String(value ?? '')].slice(0, 160).join('');
export const formatDate = value => value ? new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value).toLocaleString(globalThis.document?.documentElement?.lang || 'zh-CN') : '—';

export const typeChip = (t, type = 'fact') => html`<span class="type-chip" data-type="${type}">${t(type)}</span>`;
export const statusTag = (t, status = 'active') => html`<span class="tag lifecycle-tag" data-status="${status}">${t(status)}</span>`;
export const emptyState = (t, key = 'empty') => html`<div class="empty">${svg('library')}${i18n(t, key, 'p')}</div>`;

/** A memory in a stream: the whole row opens the detail pane. */
export function memoryRows(rows = [], t) {
  if (!rows?.length) return String(emptyState(t));
  return String(html`<ol class="stream-list">${rows.map(m => html`<li class="memory-row">
    <button type="button" class="memory-link" data-memory="${m.memory_id}"><span class="memory-text">${preview(m.content || m.summary || m.memory_id)}</span>
    <span class="memory-meta">${typeChip(t, m.memory_type || 'fact')}<time>${formatDate(m.created_at)}</time></span></button>${statusTag(t, m.status || 'active')}</li>`)}</ol>`);
}

/** Page heading used by every console page. Exactly one H1 per page. */
export function pageHeading(t, {title, note, actions = ''}) {
  return String(html`<div class="page-heading"><div>${i18n(t, title, 'h1')}${note ? i18n(t, note, 'p') : ''}</div>${actions ? html`<div class="page-heading-actions">${trusted(actions)}</div>` : ''}</div>`);
}

function activityStrip(insights, t) {
  const days = Array.isArray(insights?.activity) ? insights.activity.filter(d => typeof d?.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.day) && safeCount(d.count) !== null).slice(-30) : [];
  if (!days.length) return '';
  const total = days.reduce((n, d) => n + d.count, 0), max = Math.max(1, ...days.map(d => d.count)), H = 44, step = 10;
  const bars = days.map((d, i) => { const h = d.count ? Math.max(6, d.count / max * H) : 4;
    return html`<rect class="bar${d.count ? '' : ' is-zero'}" x="${i * step}" y="${fixed(H - h)}" width="6" height="${fixed(h)}" rx="3"><title>${d.day} · ${d.count}</title></rect>`; });
  return html`<section class="pulse-block"><div class="pulse-head">${i18n(t, 'activityStrip', 'h3')}<span class="pulse-figure">${total}</span></div>
    <svg class="activity-bars" viewBox="0 0 ${days.length * step - 4} ${H}" preserveAspectRatio="none" role="img" data-i18n-aria-label="activityStrip" aria-label="${t('activityStrip')}" focusable="false">${bars}</svg>
    <div class="strip-axis"><span>${days[0].day.slice(5)}</span><span>${days.at(-1).day.slice(5)}</span></div></section>`;
}

function typeBreakdown(insights, t) {
  const types = rowsOf(insights?.types).slice(0, 6);
  if (!types.length) return '';
  const max = Math.max(...types.map(r => r.count));
  return html`<section class="pulse-block">${i18n(t, 'typesLegend', 'h3')}<ul class="breakdown">${types.map(r => html`<li><span class="breakdown-label">${typeChip(t, r.value)}</span>
    <svg viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect class="track" width="100" height="4" rx="2"/><rect class="fill" data-type="${r.value}" width="${fixed(Math.max(3, r.count / max * 100))}" height="4" rx="2"/></svg>
    <span class="breakdown-count">${r.count}</span></li>`)}</ul></section>`;
}

function distributionCategories(insights) {
  const categories = rowsOf(insights?.categories);
  if (categories.length <= 6) return categories;
  // Keep six colours without losing records or renormalizing a top-N subset to 100%.
  return [...categories.slice(0, 5), {value: 'otherCategories', count: categories.slice(5).reduce((sum, c) => sum + c.count, 0)}];
}

/** Distribution ring: each arc is a real category share of active memories; the centre is the total. */
function distribution(insights, t) {
  const cats = distributionCategories(insights), total = cats.reduce((n, c) => n + c.count, 0);
  const R = 84, C = 2 * Math.PI * R, gap = cats.length > 1 ? 3 : 0; // square ends: a hairline of paper between arcs
  let offset = 0;
  const arcs = cats.map((c, i) => { const len = Math.max(0.1, c.count / total * C - gap), arc = html`<circle class="arc hue-${i}" cx="110" cy="110" r="${R}" stroke-dasharray="${fixed(len)} ${fixed(C - len)}" stroke-dashoffset="${fixed(-offset)}"><title>${t(c.value)} · ${c.count}</title></circle>`; offset += c.count / total * C; return arc; });
  return html`<figure class="distribution${cats.length ? '' : ' is-empty'}"><svg viewBox="0 0 220 220" role="img" data-i18n-aria-label="radarTitle" aria-label="${t('radarTitle')}" focusable="false">
    <circle class="ring-track" cx="110" cy="110" r="${R}"/><g class="arcs" transform="rotate(-90 110 110)">${arcs}</g>
    <text class="ring-total" x="110" y="108" text-anchor="middle">${total}</text><text class="ring-caption" x="110" y="132" text-anchor="middle" data-i18n="activeMemories">${t('activeMemories')}</text></svg>
    ${cats.length ? '' : html`<figcaption class="radar-empty">${i18n(t, 'radarEmpty')}</figcaption>`}</figure>`;
}
function distributionLegend(insights, t) {
  const cats = distributionCategories(insights), total = cats.reduce((n, c) => n + c.count, 0);
  if (!cats.length) return '';
  return html`<ol class="radar-legend">${cats.map((c, i) => html`<li class="hue-${i}"><i aria-hidden="true"></i>${i18n(t, c.value)}<strong>${c.count}</strong><small>${Math.round(c.count / total * 100)}%</small></li>`)}</ol>`;
}

/** Overview: distribution and search first, then counts, recent stream and pipeline. Never invents trends. */
export function overviewView(data, {t, memoryRows: rows = list => memoryRows(list, t)}) {
  const count = key => safeCount(data.counts?.[key]) === null ? '—' : data.counts[key].toLocaleString();
  const metric = (key, title, href) => html`<a class="metric" href="${href}" data-metric="${key}">${i18n(t, title)}<strong>${count(key)}</strong></a>`;
  const stage = (href, glyphName, title, note, key) => html`<a class="processing-stage" href="${href}"><span class="stage-icon">${svg(glyphName)}</span><span class="stage-text">${i18n(t, title)}<small data-i18n="${note}">${t(note)}</small></span><strong>${count(key)}</strong></a>`;
  return String(html`<section class="card radar-panel"><div class="radar-copy"><p class="eyebrow">${i18n(t, 'radarLabel')}</p>${i18n(t, 'radarTitle', 'h2')}${i18n(t, 'radarNote', 'p')}
      <form class="ask" action="/app/memories" method="get" role="search"><label class="sr-only" for="home-query" data-i18n="query">${t('query')}</label>${svg('search')}
        <input id="home-query" name="query" maxlength="2000" autocomplete="off" data-search-input data-i18n-placeholder="askPlaceholder" placeholder="${t('askPlaceholder')}"><kbd aria-hidden="true">/</kbd><button class="primary" type="submit" data-i18n="search">${t('search')}</button></form>
      ${distributionLegend(data.insights, t)}</div>${distribution(data.insights, t)}</section>
  <div class="metrics">${metric('memories', 'memoryCount', '/app/memories')}${metric('sources', 'sourceCount', '/app/memories?focus=sources')}${metric('summaries', 'summaryCount', '/app/summaries')}${metric('jobs', 'jobCount', '/app/jobs')}</div>
  <div class="home-grid">
    <section class="card stream"><header class="section-head">${i18n(t, 'recentStream', 'h2')}<a href="/app/memories">${i18n(t, 'openLibrary')}${svg('arrow')}</a></header>
      ${trusted(rows(data.recent || []))}${i18n(t, 'inspectMemoryNote', 'p')}</section>
    <aside class="pulse" data-i18n-aria-label="pulseTitle" aria-label="${t('pulseTitle')}">
      ${activityStrip(data.insights, t)}${typeBreakdown(data.insights, t)}
      <section class="pulse-block processing-card">${i18n(t, 'pipelineTitle', 'h3')}<div class="pipeline">
        ${stage('/app/memories', 'library', 'memoryCount', 'atomicNote', 'memories')}${stage('/app/summaries', 'summaries', 'summaryCount', 'derivedNote', 'summaries')}${stage('/app/jobs', 'jobs', 'jobCount', 'jobStatusNote', 'jobs')}</div>
        <p class="privacy-note">${svg('security')}<span data-i18n="summaryBoundary">${t('summaryBoundary')}</span></p></section>
    </aside></div>`);
}

/** Library: filters, a four-column table, and a pager. The detail opens in the side pane. */
export function libraryView(t, {data, query = '', searchMode = 'lexical', category = '', status = '', categories = [], focusSources = false, readOnly = false, pagination = ''}) {
  const option = (value, key, current) => html`<option value="${value}"${value === current ? trusted(' selected') : ''} data-i18n="${key}">${t(key)}</option>`;
  const rows = data.results || [];
  const table = rows.length ? html`<div class="table-scroll"><table class="memory-table"><colgroup><col class="col-content"><col class="col-category"><col class="col-state"><col class="col-date"></colgroup>
    <thead><tr><th>${i18n(t, 'memories')}</th><th>${i18n(t, 'category')}</th><th>${i18n(t, 'status')}</th><th>${i18n(t, 'created')}</th></tr></thead>
    <tbody>${rows.map(m => html`<tr><td><button type="button" class="memory-link" data-memory="${m.memory_id}"><span class="memory-text">${preview(m.content || m.summary || m.memory_id)}</span>${typeChip(t, m.memory_type || 'fact')}</button></td>
      <td><span class="category-pill" data-category="${m.category || 'uncategorized'}">${t(m.category || 'uncategorized')}</span></td><td>${statusTag(t, m.status || 'active')}</td><td class="memory-date"><time>${formatDate(m.created_at)}</time></td></tr>`)}</tbody></table></div>`
    : emptyState(t);
  return String(html`<form class="toolbar memory-filters" id="search-form" role="search">
    <label class="query-field"><span class="sr-only" data-i18n="query">${t('query')}</span><span class="query-input">${svg('search')}<input name="query" value="${query}" maxlength="2000" autocomplete="off" data-search-input data-i18n-placeholder="askPlaceholder" placeholder="${t('askPlaceholder')}"></span></label>
    <label class="filter-mode">${i18n(t, 'searchMode')}<select name="search_mode">${['lexical', 'hybrid', 'semantic'].map(v => option(v, v, searchMode))}</select></label>
    <label class="filter-category">${i18n(t, 'category')}<select name="category">${option('', 'allCategories', category)}${categories.map(v => option(v, v, category))}</select></label>
    <label class="filter-status">${i18n(t, 'status')}<select name="status">${option('', 'allStatuses', status)}${['active', 'superseded', 'retracted'].map(v => option(v, v, status))}</select></label>
    <div class="filter-actions"><button class="primary filter-submit" type="submit">${svg('search')}${i18n(t, 'search')}</button><button type="button" class="filter-reset quiet" data-reset-filters>${i18n(t, 'resetFilters')}</button></div></form>
  <section class="card memory-library">${focusSources ? html`<p class="library-note">${i18n(t, 'inspectSourcesNote')}</p>` : ''}
    ${data.truncated || data.retrieval?.window_limited ? html`<p class="policy-box library-note">${i18n(t, 'boundedSearchNote')} (${data.retrieval?.candidate_limit})</p>` : ''}
    <div id="memory-rows">${table}</div>
    <div class="library-footer"><p>${rows.length} ${i18n(t, 'resultCount')}${readOnly ? html` · ${i18n(t, 'readOnly')}` : ''}</p>${trusted(pagination)}</div></section>`);
}

export function summariesView(t, {data, pagination = ''}) {
  const cats = (data.categories || []).filter(c => safeCount(c.count) !== null);
  const max = Math.max(1, ...cats.map(c => c.count));
  const summaries = data.summaries || [];
  return String(html`<div class="split">
  <section class="index-panel">${i18n(t, 'summaryIndex', 'h2')}${cats.length ? html`<ul class="category-index">${cats.map(c => html`<li><a class="category-link" href="/app/memories?category=${encodeURIComponent(c.category)}&amp;status=active"><span>${t(c.category)}</span>
    <svg viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect class="track" width="100" height="4" rx="2"/><rect class="fill" width="${fixed(Math.max(3, c.count / max * 100))}" height="4" rx="2"/></svg><strong>${c.count}</strong></a></li>`)}</ul>` : emptyState(t)}</section>
  <section class="list-panel">${i18n(t, 'summaryList', 'h2')}${summaries.length ? html`<ol class="summary-list">${summaries.map(s => {
    const body = html`<span class="summary-title">${t(s.category)}</span><span class="memory-meta"><span>${i18n(t, 'revisions')} ${s.revision}</span><span>${i18n(t, 'sourceCount')} ${s.coverage}</span><code>${s.summary_id}</code></span>`;
    return html`<li class="summary-row">${s.status === 'current'
      ? html`<button type="button" class="memory-link" data-summary="${s.summary_id}" data-revision="${s.revision}">${body}</button>`
      : html`<div class="memory-link">${body}<small>${i18n(t, 'summaryNotCurrent')} · <a href="/app/memories?category=${encodeURIComponent(s.category)}">${i18n(t, 'browseMemories')}</a></small></div>`}${html`<span class="tag">${t(s.status)}</span>`}</li>`;
  })}</ol>` : emptyState(t)}${trusted(pagination)}</section></div>`);
}

export function auditView(t, {entries = [], pagination = ''}) {
  if (!entries.length) return String(emptyState(t));
  return String(html`<section class="card"><header class="section-head">${i18n(t, 'auditTimeline', 'h2')}<button type="button" data-retry>${i18n(t, 'refresh')}</button></header>
    <ol class="timeline">${entries.map(e => html`<li class="timeline-item" data-outcome="${e.outcome || ''}"><span class="timeline-dot" aria-hidden="true"></span>
      <div><strong>${e.action}</strong><span class="memory-meta"><span class="tag">${e.outcome || '—'}</span><time>${formatDate(e.created)}</time>${e.audit_id ? html`<code>${e.audit_id}</code>` : ''}</span></div></li>`)}</ol>${trusted(pagination)}</section>`);
}

/** Memory detail for the side pane. `actions` is markup built from fixed action buttons. */
export function memoryDetailView(t, data, {actions = '', canGoBack = false}) {
  const m = data.memory || {}, content = String(m.content ?? ''), length = [...content].length;
  const sources = data.source_manifest?.sources || [];
  const lifecycle = m.lifecycle || {};
  const links = [[lifecycle.supersedes_memory_id, 'previousRecord'], [lifecycle.superseded_by_memory_id, 'replacementRecord']].filter(([id]) => id);
  return String(html`<div class="detail-meta">${typeChip(t, m.memory_type || 'fact')}<span class="tag">${i18n(t, 'revisions')} ${data.revision}</span>${statusTag(t, m.status || 'active')}</div>
  ${m.status === 'active' && actions ? html`<div class="actions detail-actions">${trusted(actions)}</div>` : ''}
  <div class="body-content">${content}</div>
  <p class="detail-range">${i18n(t, 'contentRange')} ${data.content_offset + 1}–${data.content_offset + length} / ${data.content_length} ${data.content_complete ? i18n(t, 'endOfContent') : ''}</p>
  <div class="pagination">${canGoBack ? html`<button type="button" data-detail-back>${svg('back')}${i18n(t, 'previous')}</button>` : ''}${data.next_request ? html`<button type="button" data-detail-next>${i18n(t, 'next')}${svg('arrow')}</button>` : ''}</div>
  ${links.length ? html`<div class="lifecycle-links">${links.map(([id, key]) => html`<button type="button" class="quiet" data-memory="${id}">${i18n(t, key)}</button>`)}</div>` : ''}
  <section class="detail-sources">${i18n(t, 'sources', 'h3')}${sources.length ? html`<ol class="source-list">${sources.map(s => html`<li class="detail-source"><strong>${s.source_kind || s.source_id}</strong><code>${s.source_id}</code>
    <details><summary>${i18n(t, 'sourceMetadata')}</summary><pre>${JSON.stringify(s, null, 2)}</pre></details></li>`)}</ol>` : emptyState(t)}
    ${data.next_source_request ? html`<button type="button" data-source-next>${i18n(t, 'nextSources')}</button>` : ''}</section>`);
}

export function summaryDetailView(t, data, {canGoBack = false}) {
  const summary = data.results?.[0] || {claims: []};
  return String(html`<div class="detail-meta"><span class="tag">${t(summary.category)}</span><span class="tag">${i18n(t, 'revisions')} ${summary.revision}</span></div>
  ${summary.claims?.length ? html`<ol class="claim-list">${summary.claims.map(c => html`<li class="detail-source"><p class="body-content">${c.quote}</p>
    <button type="button" class="quiet" data-memory="${c.memory_id}" data-revision="${c.revision}">${svg('source')}${i18n(t, 'sources')} · <code>${c.memory_id}</code></button></li>`)}</ol>` : emptyState(t)}
  ${i18n(t, data.complete ? 'endOfContent' : 'next', 'p')}
  <div class="pagination">${canGoBack ? html`<button type="button" data-detail-back>${svg('back')}${i18n(t, 'previous')}</button>` : ''}${data.next_request ? html`<button type="button" data-detail-next>${i18n(t, 'next')}${svg('arrow')}</button>` : ''}</div>`);
}

/* Feature map: every menu page lists what it offers today and what is still planned, so the
 * placeholders, the progress table, the docs and the tests all come from one list.
 * Field rules and the path from planned to live: docs/console-feature-standard.md.
 *   status  live: backed by a real endpoint · planned: placeholder only · policy: deliberately not on the web
 *   read    console-api views it reads · write: console actions it performs
 *   core    existing Core API a planned feature will wrap · scope: the Core scopes those APIs check
 *   reauth  a write needs the current password and an unused TOTP · operator: platform operators only
 *   ui      wireframe of a planned feature: table columns, form fields (type:key), buttons, stat tiles
 * Titles and notes are catalog keys derived from the ID (featureKey). IDs are never reused. */
export const featureMap = {
  overview: [
    {id: 'OVW-01', status: 'live', read: ['overview']},
    {id: 'OVW-02', status: 'live', read: ['overview']},
    {id: 'OVW-03', status: 'planned', read: ['attention']},
  ],
  memories: [
    {id: 'MEM-01', status: 'live', read: ['memories']},
    {id: 'MEM-02', status: 'live', read: ['memory', 'memory-meta']},
    {id: 'MEM-03', status: 'live', write: ['memory.create']},
    {id: 'MEM-04', status: 'live', write: ['memory.correct', 'memory.retract']},
    {id: 'MEM-05', status: 'live', write: ['memory.classify', 'memory.sensitivity', 'memory.visibility']},
    {id: 'MEM-06', status: 'planned', write: ['memory.batch_classify', 'memory.batch_retract']},
    {id: 'MEM-07', status: 'planned', read: ['memory']},
  ],
  summaries: [
    {id: 'SUM-01', status: 'live', read: ['summaries', 'summary']},
    {id: 'SUM-02', status: 'live', write: ['jobs.schedule']},
    {id: 'SUM-03', status: 'planned', read: ['taxonomy'], write: ['taxonomy.save']},
  ],
  tasks: [
    {id: 'TSK-01', status: 'live', read: ['projects']},
    {id: 'TSK-02', status: 'planned', read: ['task-branches'], core: ['POST /v1/task-branches/preview'], scope: ['resume:read'],
      ui: {table: ['taskTitle', 'sourceBranch', 'lastCheckpoint', 'state']}},
    {id: 'TSK-03', status: 'planned', read: ['project-context'], core: ['POST /v1/project-context/preview'], scope: ['resume:read'],
      ui: {form: ['select:project'], submit: 'generatePreview'}},
    {id: 'TSK-04', status: 'planned', read: ['task-checkpoints'], core: ['GET /v1/tasks/{task_id}/checkpoints', 'GET /v1/tasks/{task_id}/canonical-revisions'],
      scope: ['memory:read', 'task:reconcile:read'], ui: {table: ['checkpoint', 'sources', 'created']}},
    {id: 'TSK-05', status: 'planned', write: ['projects.bootstrap', 'tasks.bootstrap'], core: ['POST /v1/project-bootstrap/preview', 'POST /v1/task-bootstrap/preview'],
      scope: ['project:bootstrap:preview', 'project:bootstrap:confirm', 'task:bootstrap:preview', 'task:bootstrap:confirm'], ui: {actions: ['newProject', 'newTask']}},
    {id: 'TSK-06', status: 'planned', read: ['task-reconciliation'], write: ['tasks.reconcile'],
      core: ['POST /v1/tasks/{task_id}/reconciliation/run', 'POST /v1/task-reconciliations/{id}/resolve'], scope: ['task:reconcile:read', 'task:reconcile:confirm'],
      ui: {table: ['taskTitle', 'proposal', 'state'], actions: ['runReconciliation']}},
  ],
  resume: [
    {id: 'RES-01', status: 'planned', read: ['resume-preview'], core: ['POST /v1/resume/preview'], scope: ['resume:read'],
      ui: {form: ['select:project', 'select:task', 'select:sourceBranch'], submit: 'previewResume'}},
    {id: 'RES-02', status: 'planned', write: ['resume.confirm'], core: ['POST /v1/resume/{resume_id}/confirm'], scope: ['resume:confirm'],
      ui: {actions: ['confirmResume']}},
    {id: 'RES-03', status: 'planned', read: ['resume-deliveries'], core: ['GET /v1/resume/{resume_id}/injection-status', 'GET /v1/resume/{resume_id}/delivery-receipt-status'],
      scope: ['resume:read'], ui: {table: ['resumeId', 'targetAgent', 'deliveryState', 'completionAck']}},
    {id: 'RES-04', status: 'planned', read: ['resume-history'], scope: ['resume:read'], ui: {table: ['created', 'taskTitle', 'state']}},
  ],
  jobs: [
    {id: 'JOB-01', status: 'live', read: ['jobs', 'job']},
    {id: 'JOB-02', status: 'live', write: ['jobs.schedule']},
    {id: 'JOB-03', status: 'live', write: ['jobs.cancel', 'jobs.retry']},
  ],
  connections: [
    {id: 'CON-01', status: 'live', read: ['connections'], write: ['oauth.revoke']},
    {id: 'CON-02', status: 'live', read: ['connections'],
      write: ['connections.create', 'connections.update', 'connections.rotate', 'connections.disable', 'connections.enable', 'connections.revoke']},
    {id: 'CON-03', status: 'live', read: ['connections'], write: ['devices.revoke'], reauth: true},
    {id: 'CON-04', status: 'planned', read: ['capture-status'], core: ['GET /v1/status'], scope: ['memory:read']},
    {id: 'CON-05', status: 'planned', write: ['devices.register', 'devices.rotate'], core: ['POST /v1/agent-instances/register', 'POST /v1/agent-instances/{id}/rotate-key'],
      scope: ['admin:devices'], reauth: true},
  ],
  models: [
    {id: 'MOD-01', status: 'live', read: ['models'], write: ['models.save', 'models.disable']},
    {id: 'MOD-02', status: 'live', write: ['models.test']},
    {id: 'MOD-03', status: 'live', write: ['vector.schedule']},
    {id: 'MOD-04', status: 'planned', read: ['model-usage']},
  ],
  privacy: [
    {id: 'PRV-01', status: 'live', read: ['models']},
    {id: 'PRV-02', status: 'planned', read: ['privacy-defaults'], write: ['privacy.defaults'],
      ui: {form: ['select:defaultSensitivity', 'check:defaultWebVisibility'], submit: 'save'}},
    {id: 'PRV-03', status: 'planned', read: ['retention'], write: ['retention.save'], core: ['GET /v1/retention', 'PUT /v1/retention'], scope: ['admin:retention'],
      ui: {form: ['number:eventRetentionDays', 'number:checkpointRetentionDays'], submit: 'save'}},
    {id: 'PRV-04', status: 'planned', write: ['retention.prune'], core: ['POST /v1/retention/prune'], scope: ['admin:retention'], reauth: true,
      ui: {actions: ['pruneNow']}},
    {id: 'PRV-05', status: 'policy'},
    {id: 'PRV-06', status: 'live', read: ['capabilities'], write: ['memory.web_policy']},
  ],
  security: [
    {id: 'SEC-01', status: 'live', write: ['security.password'], reauth: true},
    {id: 'SEC-02', status: 'live', write: ['security.totp.begin', 'security.totp.complete'], reauth: true},
    {id: 'SEC-03', status: 'live', write: ['security.recovery_codes'], reauth: true},
    {id: 'SEC-04', status: 'live', read: ['security'], write: ['security.session.revoke', 'security.sessions.revoke_others']},
    {id: 'SEC-05', status: 'planned', read: ['login-history']},
  ],
  audit: [
    {id: 'AUD-01', status: 'live', read: ['audit']},
    {id: 'AUD-02', status: 'planned', read: ['audit']},
  ],
  storage: [
    {id: 'STO-01', status: 'live', read: ['export'], write: ['storage.export']},
    {id: 'STO-02', status: 'live', write: ['storage.import']},
    {id: 'STO-03', status: 'live', read: ['storage']},
    {id: 'STO-04', status: 'policy'},
  ],
  invitations: [
    {id: 'INV-01', status: 'live', read: ['invitations'], operator: true},
    {id: 'INV-02', status: 'live', write: ['invitations.issue'], reauth: true, operator: true},
    {id: 'INV-03', status: 'live', write: ['invitations.revoke', 'invitations.revoke_batch'], reauth: true, operator: true},
  ],
  accounts: [
    {id: 'ACC-01', status: 'live', read: ['accounts'], operator: true},
    {id: 'ACC-02', status: 'live', write: ['accounts.disable', 'accounts.enable'], reauth: true, operator: true},
    {id: 'ACC-03', status: 'live', write: ['accounts.role'], reauth: true, operator: true},
    {id: 'ACC-04', status: 'policy'},
  ],
  system: [
    {id: 'SYS-01', status: 'live', read: ['capabilities'], operator: true},
    {id: 'SYS-02', status: 'planned', read: ['system-health'], core: ['GET /v1/status', 'GET /readyz'], operator: true,
      ui: {stats: ['svcCore', 'svcWeb', 'svcAuth', 'svcWorker', 'svcVector']}},
    {id: 'SYS-03', status: 'planned', read: ['system-version'], operator: true, ui: {stats: ['releaseVersion', 'schemaVersion', 'runtimeVersion']}},
    {id: 'SYS-04', status: 'planned', read: ['backups'], operator: true, ui: {table: ['backupTime', 'backupSize', 'backupVerified']}},
  ],
};
/** Catalog keys for a feature: OVW-01 → featOVW01 (title) and featOVW01Note (description). */
export const featureKey = id => `feat${id.replace('-', '')}`;
/** Menu destinations whose content is composed from the feature map. */
export const prototypePages = ['tasks', 'resume', 'privacy', 'system'];
/** Page badge: live when nothing is planned, planned when nothing is live, partial otherwise. */
export function pageState(page) {
  const states = (featureMap[page] || []).map(f => f.status);
  return !states.includes('live') ? 'planned' : states.includes('planned') ? 'partial' : 'live';
}

export const featureStatus = (t, status) => html`<span class="tag status-tag" data-status="${status}">${i18n(t, `featureStatus_${status}`)}</span>`;
const stateDot = (t, state) => html`<span class="state-dot" data-state="${state}">${i18n(t, state)}</span>`;
const sectionNote = (t, key) => html`<p class="policy-box">${i18n(t, key)}</p>`;

/** Developer notes on a planned feature: the contract it needs and the standard it follows. */
function devNote(t, f) {
  const rows = [['contractRead', (f.read || []).map(view => `console-api/${view}`)], ['contractWrite', f.write || []], ['contractCore', f.core || []], ['contractScope', f.scope || []]]
    .filter(([, values]) => values.length);
  const flags = [f.reauth && 'contractReauth', f.operator && 'contractOperator'].filter(Boolean);
  return html`<details class="dev-note"><summary>${i18n(t, 'devNotes')} · ${f.id}</summary>
    <dl>${rows.map(([key, values]) => html`<dt>${i18n(t, key)}</dt><dd>${values.map(value => html`<code>${value}</code>`)}</dd>`)}</dl>
    ${flags.length ? html`<p>${flags.map((key, i) => html`${i ? ' · ' : ''}${i18n(t, key)}`)}</p>` : ''}
    <p>${i18n(t, 'featureStandard')} <code>docs/console-feature-standard.md</code></p></details>`;
}

function control(t, spec) {
  const [type, key] = spec.split(':');
  if (type === 'check') return html`<label class="check-field"><input type="checkbox" disabled>${i18n(t, key)}</label>`;
  if (type === 'select') return html`<label>${i18n(t, key)}<select disabled data-native-select><option>—</option></select></label>`;
  return html`<label>${i18n(t, key)}<input type="${type}" disabled placeholder="—"></label>`;
}
/** Wireframe of a planned feature: the tiles, table, fields and buttons it will have, all disabled. */
function wireframe(t, ui = {}) {
  const buttons = [...(ui.submit ? [html`<button type="button" class="primary" disabled>${i18n(t, ui.submit)}</button>`] : []),
    ...(ui.actions || []).map(key => html`<button type="button" disabled>${i18n(t, key)}</button>`)];
  return html`<div class="blueprint">
    ${ui.stats ? html`<div class="blueprint-stats">${ui.stats.map(key => html`<div>${i18n(t, key)}<strong>—</strong></div>`)}</div>` : ''}
    ${ui.table ? html`<div class="table-scroll"><table><thead><tr>${ui.table.map(key => html`<th>${i18n(t, key)}</th>`)}</tr></thead>
      <tbody><tr><td colspan="${ui.table.length}" class="blueprint-empty">${i18n(t, 'plannedPlaceholder')}</td></tr></tbody></table></div>` : ''}
    ${ui.form ? html`<div class="blueprint-form">${ui.form.map(spec => control(t, spec))}</div>` : ''}
    ${buttons.length ? html`<div class="actions">${buttons}</div>` : ''}</div>`;
}

function featureCard(t, f, body = '') {
  const key = featureKey(f.id);
  return html`<section class="card feature-card" data-status="${f.status}" data-feature="${f.id}">
    <header class="section-head">${i18n(t, key, 'h2')}<div>${featureStatus(t, f.status)}<span class="feature-id">${f.id}</span></div></header>
    ${i18n(t, `${key}Note`, 'p')}${f.status === 'planned' ? html`${wireframe(t, f.ui)}${devNote(t, f)}` : body}</section>`;
}

/** TSK-01: the account's projects, name and ID only. */
function projectList(t, data) {
  if (data.unavailable) return sectionNote(t, 'unavailable');
  const rows = Array.isArray(data.projects) ? data.projects : [];
  if (!rows.length) return emptyState(t, 'noProjects');
  return html`<div class="table-scroll"><table><thead><tr><th>${i18n(t, 'projectName')}</th><th>${i18n(t, 'projectId')}</th></tr></thead>
    <tbody>${rows.map(p => html`<tr><td><strong>${p.name || '—'}</strong></td><td><code>${p.project_id}</code></td></tr>`)}</tbody></table></div>`;
}
/** PRV-01: which models may receive memory content or search queries. Changes stay on the models page. */
function egressSummary(t, data) {
  if (data.unavailable) return sectionNote(t, 'unavailable');
  const models = Array.isArray(data.models) ? data.models : [];
  const yes = value => i18n(t, value === true ? 'yes' : 'no');
  return html`<div class="table-scroll"><table><thead><tr><th>${i18n(t, 'modelKind')}</th><th>${i18n(t, 'state')}</th><th>${i18n(t, 'egressAllowed')}</th><th>${i18n(t, 'queryAllowed')}</th></tr></thead>
    <tbody>${models.map(m => html`<tr><td>${i18n(t, m.kind)}</td><td>${stateDot(t, m.config?.enabled ? 'enabled' : 'disabled')}</td><td>${yes(m.config?.egress_approved)}</td><td>${yes(m.config?.query_approved)}</td></tr>`)}</tbody></table></div>
    <div class="section-foot"><a href="/app/models">${i18n(t, 'models')} →</a></div>`;
}
/** PRV-06: whether ChatGPT reads every non-secret memory or only per-revision grants. */
function readScope(t, data, caps) {
  const policy = data.web_policy;
  if (!policy) return sectionNote(t, 'unavailable');
  const on = policy.read_all === true, can = Array.isArray(caps.allowed_actions) && caps.allowed_actions.includes('memory.web_policy');
  return html`<div class="status-line">${stateDot(t, on ? 'enabled' : 'disabled')}${i18n(t, 'webReadAll')}</div>${i18n(t, on ? 'webReadAllOn' : 'webReadAllOff', 'p')}
    ${can ? html`<div class="actions"><button type="button" data-console-action="memory.web_policy" data-enabled="${on ? 'false' : 'true'}">${i18n(t, on ? 'webPolicyDisable' : 'webPolicyEnable')}</button></div>` : sectionNote(t, 'viewWithoutWrite')}`;
}
/** SYS-01: platform switches exactly as the server reports them in its capabilities. */
function platformSwitches(t, caps) {
  const rows = [['sysConsoleOperations', caps.enabled], ['sysCoreWritable', caps.writable], ['sysInvitations', caps.management?.invitations], ['sysAccounts', caps.management?.accounts],
    ['sysRoles', caps.management?.roles], ['sysConnections', caps.connection_management?.enabled], ['sysRecovery', caps.recovery_configured], ['sysMaintenance', caps.maintenance_enabled]];
  return html`<dl class="metadata-grid">${rows.map(([key, on]) => html`<dt>${i18n(t, key)}</dt><dd>${stateDot(t, on === true ? 'enabled' : 'disabled')}</dd>`)}</dl>`;
}
/** Development progress across the whole feature map, per page. */
function featureProgress(t) {
  const statuses = ['live', 'planned', 'policy'], count = (list, status) => list.filter(f => f.status === status).length, all = Object.values(featureMap).flat();
  return html`<section class="card feature-progress"><header class="section-head">${i18n(t, 'featureProgress', 'h2')}
    <div>${statuses.map(s => html`<span class="progress-total">${featureStatus(t, s)}<strong class="figure">${count(all, s)}</strong></span>`)}</div></header>${i18n(t, 'featureProgressNote', 'p')}
    <div class="table-scroll"><table><thead><tr><th>${i18n(t, 'featurePage')}</th>${statuses.map(s => html`<th>${i18n(t, `featureStatus_${s}`)}</th>`)}</tr></thead>
    <tbody>${Object.entries(featureMap).map(([page, list]) => html`<tr><td><a href="/app/${page}">${i18n(t, page)}</a></td>${statuses.map(s => html`<td class="figure">${count(list, s) || '—'}</td>`)}</tr>`)}</tbody></table></div></section>`;
}

/** Prototype pages list live features first, then planned ones, then what is deliberately not offered. */
export const prototypeOrder = page => [...(featureMap[page] || [])].sort((a, b) => ['live', 'planned', 'policy'].indexOf(a.status) - ['live', 'planned', 'policy'].indexOf(b.status));
/** New menu destinations: one card per feature. Live cards show real data; planned ones a wireframe. */
export function prototypeView(t, page, {data = {}, caps = {}} = {}) {
  const live = {'TSK-01': () => projectList(t, data), 'PRV-01': () => egressSummary(t, data), 'PRV-06': () => readScope(t, data, caps), 'SYS-01': () => platformSwitches(t, caps)};
  const cards = prototypeOrder(page).map(f => featureCard(t, f, f.status === 'live' ? live[f.id]?.() ?? '' : ''));
  return String(html`<div class="feature-grid">${cards}</div>${page === 'system' ? featureProgress(t) : ''}`);
}

/** Existing pages: their planned and policy features as one compact list under the live content. */
export function roadmapCard(t, page) {
  const items = (featureMap[page] || []).filter(f => f.status !== 'live');
  if (!items.length) return '';
  return String(html`<section class="card roadmap"><header class="section-head">${i18n(t, 'roadmapTitle', 'h2')}</header>${i18n(t, 'roadmapNote', 'p')}
    <ol class="roadmap-list">${items.map(f => html`<li data-status="${f.status}" data-feature="${f.id}"><div>${i18n(t, featureKey(f.id), 'strong')}${i18n(t, `${featureKey(f.id)}Note`, 'p')}</div>
      <div class="roadmap-meta">${featureStatus(t, f.status)}<span class="feature-id">${f.id}</span></div>${f.status === 'planned' ? devNote(t, f) : ''}</li>`)}</ol></section>`);
}
