// Pure console views for the memory workbench. No API calls, account selection or
// authorization here: controllers pass owner-scoped data in and get markup strings out.
import {html,trusted} from './html.mjs';
import {icon as glyph} from './icons.mjs';

export const icon = glyph;
const svg = name => trusted(glyph(name));
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
  const total = days.reduce((n, d) => n + d.count, 0), max = Math.max(1, ...days.map(d => d.count));
  const level = n => n === 0 ? 0 : Math.min(4, Math.ceil(n / max * 4));
  const cells = days.map((d, i) => html`<rect class="cell q${level(d.count)}" x="${i * 10}" y="0" width="8" height="22" rx="2"><title>${d.day} · ${d.count}</title></rect>`);
  return html`<section class="pulse-block"><div class="pulse-head">${i18n(t, 'activityStrip', 'h3')}<span class="pulse-figure">${total}</span></div>
    <svg class="activity-strip" viewBox="0 0 ${days.length * 10 - 2} 22" preserveAspectRatio="none" role="img" data-i18n-aria-label="activityStrip" aria-label="${t('activityStrip')}" focusable="false">${cells}</svg>
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

/** Home: search first, then the recent stream; counts are secondary. Never invents trends. */
export function overviewView(data, {t, memoryRows: rows = list => memoryRows(list, t)}) {
  const count = key => safeCount(data.counts?.[key]) === null ? '—' : data.counts[key].toLocaleString();
  const metric = (key, title, href) => html`<a class="metric" href="${href}" data-metric="${key}"><strong>${count(key)}</strong>${i18n(t, title)}</a>`;
  const stage = (href, glyphName, title, note, key) => html`<a class="processing-stage" href="${href}"><span class="stage-icon">${svg(glyphName)}</span><span class="stage-text">${i18n(t, title)}<small data-i18n="${note}">${t(note)}</small></span><strong>${count(key)}</strong></a>`;
  return String(html`<form class="ask" action="/app/memories" method="get" role="search">
    <label class="sr-only" for="home-query" data-i18n="query">${t('query')}</label>${svg('search')}
    <input id="home-query" name="query" maxlength="2000" autocomplete="off" data-search-input data-i18n-placeholder="askPlaceholder" placeholder="${t('askPlaceholder')}">
    <kbd aria-hidden="true">/</kbd><button class="primary" type="submit" data-i18n="search">${t('search')}</button></form>
  <div class="home-grid">
    <section class="stream"><header class="section-head">${i18n(t, 'recentStream', 'h2')}<a href="/app/memories">${i18n(t, 'openLibrary')}${svg('arrow')}</a></header>
      ${trusted(rows(data.recent || []))}${i18n(t, 'inspectMemoryNote', 'p')}</section>
    <aside class="pulse" data-i18n-aria-label="pulseTitle" aria-label="${t('pulseTitle')}">
      <div class="metrics">${metric('memories', 'memoryCount', '/app/memories')}${metric('sources', 'sourceCount', '/app/memories?focus=sources')}${metric('summaries', 'summaryCount', '/app/summaries')}${metric('jobs', 'jobCount', '/app/jobs')}</div>
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
  ${i18n(t, data.complete ? 'endOfSummary' : 'next', 'p')}
  <div class="pagination">${canGoBack ? html`<button type="button" data-detail-back>${svg('back')}${i18n(t, 'previous')}</button>` : ''}${data.next_request ? html`<button type="button" data-detail-next>${i18n(t, 'next')}${svg('arrow')}</button>` : ''}</div>`);
}

/** Appearance: real preference controls, colour only. */
export function appearanceView(t) {
  const pick = (property, value, content, className) => html`<button class="${className}" type="button" data-pref="${property}" data-pref-value="${value}" aria-pressed="false" disabled>${content}</button>`;
  const swatch = html`<span class="swatch" aria-hidden="true"><i></i><i></i><i></i></span>`;
  return String(html`<section class="card appearance-card">${i18n(t, 'theme', 'h2')}${i18n(t, 'appearanceNote', 'p')}
    <div class="theme-options" role="group" data-i18n-aria-label="theme" aria-label="${t('theme')}">${['a', 'b', 'c'].map(theme => pick('theme', theme, html`${swatch}<span class="theme-option-info"><strong data-i18n="themeName_${theme}">${t(`themeName_${theme}`)}</strong><small data-i18n="themeNote_${theme}">${t(`themeNote_${theme}`)}</small></span><span class="selection-check">${svg('check')}</span>`, 'theme-option'))}</div></section>
  <div class="columns preference-columns"><section class="card">${i18n(t, 'mode', 'h2')}${i18n(t, 'modeNote', 'p')}<div class="segmented" role="group" data-i18n-aria-label="mode" aria-label="${t('mode')}">${['light', 'dark'].map(mode => pick('mode', mode, html`${svg(mode === 'light' ? 'sun' : 'moon')}${i18n(t, mode)}`, 'segment'))}</div></section>
  <section class="card">${i18n(t, 'language', 'h2')}${i18n(t, 'languageNote', 'p')}<div class="segmented" role="group" data-i18n-aria-label="language" aria-label="${t('language')}">${pick('locale', 'zh-CN', '简体中文', 'segment')}${pick('locale', 'en', 'English', 'segment')}</div></section></div>
  <p class="privacy-note">${svg('security')}<span data-i18n="appearanceScopeNote">${t('appearanceScopeNote')}</span></p>`);
}
