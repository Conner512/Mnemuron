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
  system: '<rect x="4" y="4.5" width="16" height="6"/><rect x="4" y="13.5" width="16" height="6"/><path d="M7.5 7.5h1M7.5 16.5h1M11.5 7.5h5M11.5 16.5h5"/>',
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

/** Memory text for a list row: a short display title, then a leading file path (only with an extension or a
 * root) and the body beneath it, both verbatim. Older servers without a title keep the previous layout. */
export const memoryText = m => {
  const body = m.path && m.body ? m.body : preview(m.content || m.summary || m.memory_id);
  // A one-sentence memory whose title is the whole text is not printed twice.
  const repeats = m.title_source === 'content' && String(body).trim().replace(/[。．.!！?？;；\s]+$/u, '') === m.title;
  return html`${m.title ? html`<span class="memory-title" data-title-source="${m.title_source || ''}">${m.title}</span>` : ''}${m.path && m.body
    ? html`<span class="memory-path" title="${m.path}">${m.path}</span>` : ''}${repeats ? '' : html`<span class="memory-text">${body}</span>`}`;
};
/** The explanation comes from the original-query rank, never inferred from expanded text. */
export function entityMatch(t,m){
 const rank=m.ranking,keys={raw_query:'entityMatchExact',original_terms:'entityMatchTerms',alias:'entityMatchAlias'},key=keys[rank?.match_kind];
 return key?html`<span class="entity-match" data-match-kind="${rank.match_kind}">${i18n(t,key)}${rank.match_kind==='alias'&&rank.alias?.matched_name?html` · ${rank.alias.matched_name}`:''}</span>`:'';
}
const ORIGIN_KEYS = {imported: 'importedOrigin', console: 'originConsole', model_tool: 'originModelTool', agent: 'originAgent'};
/** An imported or namespace topic: a filterable tag, never a title or a file path. */
const tagChip = (t, tag) => tag ? html`<button type="button" class="topic-chip tag-chip" data-facet="topic" data-value="${tag}" title="${t('originalTagNote')}"><span class="chip-label">${t('originalTag')}</span>${tag}</button>` : '';
export const typeChip = (t, type = 'fact') => html`<span class="type-chip" data-type="${type}">${t(type)}</span>`;
export const statusTag = (t, status = 'active') => html`<span class="tag lifecycle-tag" data-status="${status}">${t(status)}</span>`;
export const emptyState = (t, key = 'empty') => html`<div class="empty">${svg('library')}${i18n(t, key, 'p')}</div>`;

/** A memory in a stream: the whole row opens the detail pane. */
export function memoryRows(rows = [], t) {
  if (!rows?.length) return String(emptyState(t));
  return String(html`<ol class="stream-list">${rows.map(m => html`<li class="memory-row">
    <button type="button" class="memory-link" data-memory="${m.memory_id}">${memoryText(m)}
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
function distribution(insights, t, labels = {}) {
  const cats = distributionCategories(insights), total = cats.reduce((n, c) => n + c.count, 0);
  const R = 84, C = 2 * Math.PI * R, gap = cats.length > 1 ? 3 : 0; // square ends: a hairline of paper between arcs
  let offset = 0;
  const arcs = cats.map((c, i) => { const len = Math.max(0.1, c.count / total * C - gap), arc = html`<circle class="arc hue-${i}" cx="110" cy="110" r="${R}" stroke-dasharray="${fixed(len)} ${fixed(C - len)}" stroke-dashoffset="${fixed(-offset)}"><title>${categoryName(t, labels, c.value)} · ${c.count}</title></circle>`; offset += c.count / total * C; return arc; });
  return html`<figure class="distribution${cats.length ? '' : ' is-empty'}"><svg viewBox="0 0 220 220" role="img" data-i18n-aria-label="radarTitle" aria-label="${t('radarTitle')}" focusable="false">
    <circle class="ring-track" cx="110" cy="110" r="${R}"/><g class="arcs" transform="rotate(-90 110 110)">${arcs}</g>
    <text class="ring-total" x="110" y="108" text-anchor="middle">${total}</text><text class="ring-caption" x="110" y="132" text-anchor="middle" data-i18n="activeMemories">${t('activeMemories')}</text></svg>
    ${cats.length ? '' : html`<figcaption class="radar-empty">${i18n(t, 'radarEmpty')}</figcaption>`}</figure>`;
}
function distributionLegend(insights, t, labels = {}) {
  const cats = distributionCategories(insights), total = cats.reduce((n, c) => n + c.count, 0);
  if (!cats.length) return '';
  return html`<ol class="radar-legend">${cats.map((c, i) => html`<li class="hue-${i}"><i aria-hidden="true"></i>${categoryText(t, labels, c.value)}<strong>${c.count}</strong><small>${Math.round(c.count / total * 100)}%</small></li>`)}</ol>`;
}

/** Overview: distribution and search first, then counts, recent stream and pipeline. Never invents trends. */
export function overviewView(data, {t, memoryRows: rows = list => memoryRows(list, t), labels = {}}) {
  const count = key => safeCount(data.counts?.[key]) === null ? '—' : data.counts[key].toLocaleString();
  const metric = (key, title, href) => html`<a class="metric" href="${href}" data-metric="${key}">${i18n(t, title)}<strong>${count(key)}</strong></a>`;
  const stage = (href, glyphName, title, note, key) => html`<a class="processing-stage" href="${href}"><span class="stage-icon">${svg(glyphName)}</span><span class="stage-text">${i18n(t, title)}<small data-i18n="${note}">${t(note)}</small></span><strong>${count(key)}</strong></a>`;
  return String(html`<section class="card radar-panel"><div class="radar-copy"><p class="eyebrow">${i18n(t, 'radarLabel')}</p>${i18n(t, 'radarTitle', 'h2')}${i18n(t, 'radarNote', 'p')}
      <form class="ask" action="/app/memories" method="get" role="search"><label class="sr-only" for="home-query" data-i18n="query">${t('query')}</label>${svg('search')}
        <input id="home-query" name="query" maxlength="2000" autocomplete="off" data-search-input data-i18n-placeholder="askPlaceholder" placeholder="${t('askPlaceholder')}"><kbd aria-hidden="true">/</kbd><button class="primary" type="submit" data-i18n="search">${t('search')}</button></form>
      ${distributionLegend(data.insights, t, labels)}</div>${distribution(data.insights, t, labels)}</section>
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

/** Category display name: an account-defined name, otherwise the translated built-in ID. */
export const categoryName = (t, labels, id) => (labels && typeof labels[id] === 'string' && labels[id]) || t(id);
// Built-in IDs translate with the interface language; account-defined names are user text and never do.
const categoryText = (t, labels, id) => labels?.[id] ? html`<span>${labels[id]}</span>` : i18n(t, id);
export const SELECTION_LIMIT = 100;

function libraryFacets(t, {facets, labels, category, topic, origin, canManage, canUndo}) {
  if (!facets) return html`<aside class="library-facets" data-i18n-aria-label="categoriesFacet" aria-label="${t('categoriesFacet')}"><p class="muted" role="status">${i18n(t, 'facetsUnavailable')}</p></aside>`;
  const item = (facet, value, label, count, current) => html`<li><button type="button" class="facet-item" data-facet="${facet}" data-value="${value}" aria-pressed="${String(current === value)}"><span class="facet-label">${label}</span><span class="facet-count">${count}</span></button></li>`;
  const total = facets.statuses?.active ?? 0;
  const batches = (facets.recent_batches || []).slice(0, 5);
  return html`<aside class="library-facets" data-i18n-aria-label="categoriesFacet" aria-label="${t('categoriesFacet')}">
    <section class="facet-group"><header class="facet-head">${i18n(t, 'categoriesFacet', 'h2')}${canManage ? html`<button type="button" class="quiet facet-manage" data-console-action="category.manage">${i18n(t, 'manageCategories')}</button>` : ''}</header>
      <ul class="facet-list">${item('category', '', i18n(t, 'allCategories'), total, category)}${(facets.categories || []).map(c => item('category', c.category, categoryText(t, labels, c.category), c.count, category))}</ul></section>
    ${facets.topics?.length ? html`<section class="facet-group">${i18n(t, 'topicsFacet', 'h2')}<ul class="facet-list">${facets.topics.slice(0, 12).map(x => item('topic', x.topic, html`<span>${x.topic}</span>`, x.count, topic))}</ul></section>` : ''}
    ${facets.origins?.imported ? html`<section class="facet-group">${i18n(t, 'originFacet', 'h2')}<ul class="facet-list">${item('origin', 'imported', i18n(t, 'importedOrigin'), facets.origins.imported, origin)}${item('origin', 'other', i18n(t, 'otherOrigin'), facets.origins.other, origin)}</ul></section>` : ''}
    <section class="facet-group recent-changes">${i18n(t, 'recentChanges', 'h2')}${batches.length ? html`<ol class="batch-list">${batches.map(b => html`<li data-batch="${b.batch_id}">
      <span>${i18n(t, 'batchKind_' + b.kind)} · ${b.changed} → ${b.deleted_category ? html`<s>${b.deleted_label || t(b.deleted_category)}</s> → ` : ''}${categoryText(t, labels, b.category)}</span>
      <small><time>${formatDate(b.created_at)}</time>${b.undone_at ? html` · ${i18n(t, 'undone')}` : ''}</small>
      ${b.undoable && canUndo ? html`<button type="button" class="quiet" data-console-action="memory.organize_undo" data-id="${b.batch_id}">${i18n(t, 'undo')}</button>` : ''}</li>`)}</ol>` : i18n(t, 'noRecentChanges', 'p')}</section>
  </aside>`;
}

/** Why memories are uncategorized and what to do next. Never offers a retry that cannot work. */
function classificationStatus(t, c, {canSchedule, uncategorized}) {
  if (!c || !c.active) return '';
  const manualPath = html`<p>${i18n(t, 'classifyManualPath')}</p>`;
  const browse = uncategorized ? html`<a class="button" href="/app/memories?category=uncategorized">${i18n(t, 'classifyBrowseUncategorized')} (${uncategorized})</a>` : '';
  const models = html`<a class="button" href="/app/models">${i18n(t, 'classifyOpenModels')}</a>`;
  const counts = html`<p class="muted">${i18n(t, 'classifyCounts')}: ${i18n(t, 'classifyManual')} ${c.manual} · ${i18n(t, 'classifyModel')} ${c.model} · ${i18n(t, 'uncategorized')} ${uncategorized}</p>`;
  const body = {
    unconfigured: html`<p><strong>${i18n(t, 'classifyUnconfigured')}</strong></p>${manualPath}<p>${i18n(t, 'classifySetupModel')}</p>${!c.key_storage || !c.worker_enabled ? html`<p class="muted">${i18n(t, 'classifyOperatorNeeds')}: ${[!c.key_storage && t('classifyNeedKeyStorage'), !c.worker_enabled && t('classifyNeedWorker')].filter(Boolean).join(' · ')}</p>` : ''}`,
    blocked: html`<p><strong>${i18n(t, 'classifyBlocked')}</strong></p><ul>${(c.blockers || []).map(code => html`<li>${t(code)}</li>`)}</ul>${manualPath}`,
    unscheduled: html`<p><strong>${i18n(t, 'classifyUnscheduled')}</strong></p>${!c.worker_enabled ? i18n(t, 'workerDisabledNote', 'p') : ''}${manualPath}`,
    running: html`<p><strong>${i18n(t, 'classifyRunning')}</strong> ${c.jobs.running}</p>${!c.worker_enabled ? i18n(t, 'workerDisabledNote', 'p') : ''}`,
    failed: html`<p><strong>${i18n(t, 'classifyFailed')}</strong> ${c.last_job?.error_code ? t(c.last_job.error_code) : ''}</p>${manualPath}`,
    completed: html`<p><strong>${i18n(t, 'classifyCompleted')}</strong> <time>${formatDate(c.last_job?.updated_at)}</time></p>${uncategorized ? html`<p>${i18n(t, 'classifyCompletedRemaining')}</p>` : ''}`,
  }[c.state];
  const actions = [browse, c.state === 'unscheduled' && canSchedule ? html`<button type="button" data-console-action="jobs.schedule" data-type="classification">${i18n(t, 'classifyStart')}</button>` : '',
    ['unconfigured', 'blocked'].includes(c.state) ? models : '', ['running', 'failed'].includes(c.state) ? html`<a class="button" href="/app/jobs">${i18n(t, 'viewJobs')}</a>` : ''];
  if (c.state === 'completed' && !uncategorized) return '';
  return html`<section class="classification-status" data-classification-state="${c.state}" role="status">${body}${counts}<div class="actions">${actions}</div></section>`;
}

/** Library: facets, filters, a four-column table, one organize toolbar and a pager. The detail opens in the side pane. */
export function libraryView(t, {data, query = '', searchMode = 'lexical', category = '', status = '', topic = '', origin = '', categories = [], labels = {}, facets, selected = [], selectAll = false, focusSources = false, readOnly = false, allowedActions = [], pagination = ''}) {
  const option = (value, key, current) => html`<option value="${value}"${value === current ? trusted(' selected') : ''} data-i18n="${key}">${t(key)}</option>`;
  const categoryOption = value => labels?.[value] ? html`<option value="${value}"${value === category ? trusted(' selected') : ''}>${labels[value]}</option>` : option(value, value, category);
  const rows = data.results || [];
  const chosen = new Set(selected);
  const organize = allowedActions.includes('memory.organize');
  // One way to file memories: Move to category (preview → confirm → undo). Older credentials keep batch classify.
  const batchActions = [organize ? ['memory.organize', 'moveToCategory'] : ['memory.batch_classify', 'batchClassify'], ['memory.batch_retract', 'batchRetract']].filter(([action]) => allowedActions.includes(action));
  const selectable = batchActions.length > 0 && rows.some(m => m.status === 'active');
  const count = selectAll ? null : chosen.size;
  const canSelectAll = organize && searchMode === 'lexical' && (status === 'active' || !status);
  const selection = selectable || selectAll ? html`<div class="memory-selection" data-memory-selection${selectAll ? trusted(' data-select-all-active') : ''}>
    <p role="status" aria-live="polite">${selectAll ? i18n(t, 'allMatchingSelected') : html`${i18n(t, 'selectedMemories')} <strong data-selection-count>${count}</strong> / ${organize ? SELECTION_LIMIT : 50}`}</p>
    <div class="actions">${batchActions.map(([action, label]) => html`<button type="button" data-console-action="${action}"${(selectAll ? action !== 'memory.organize' : !count) ? trusted(' disabled') : ''}>${i18n(t, label)}</button>`)}${canSelectAll && !selectAll ? html`<button type="button" class="quiet" data-select-all>${i18n(t, 'selectAllMatching')}</button>` : ''}<button type="button" class="quiet" data-clear-selection${!count && !selectAll ? trusted(' disabled') : ''}>${i18n(t, 'clearSelection')}</button></div></div>` : '';
  // A topic already shown as the title is not repeated; an imported namespace topic is a labelled tag.
  const topicChip = m => m.title_source === 'topic' ? '' : m.tag ? tagChip(t, m.tag) : m.topic && !m.title ? html`<button type="button" class="topic-chip" data-facet="topic" data-value="${m.topic}">${m.topic}</button>` : '';
  const meta = m => html`${topicChip(m)}${m.imported ? html`<small class="import-note">${i18n(t, 'importedOrigin')}${m.original_created_at ? html` · ${i18n(t, 'originalDate')} <time>${formatDate(m.original_created_at)}</time>` : ''}</small>` : ''}`;
  const table = rows.length ? html`<div class="table-scroll"><table class="memory-table"><colgroup><col class="col-content"><col class="col-category"><col class="col-state"><col class="col-date"></colgroup>
    <thead><tr><th>${i18n(t, 'memories')}</th><th>${i18n(t, 'category')}</th><th>${i18n(t, 'status')}</th><th>${i18n(t, 'created')}</th></tr></thead>
    <tbody>${rows.map(m => html`<tr${chosen.has(m.memory_id) || (selectAll && m.status === 'active') ? trusted(' data-batch-selected') : ''}><td><div class="memory-content-cell">${selectable&&m.status==='active'?html`<input class="memory-select" type="checkbox" data-batch-memory="${m.memory_id}"${chosen.has(m.memory_id) || selectAll ? trusted(' checked') : ''}${selectAll ? trusted(' disabled') : ''} data-i18n-aria-label="selectMemory" aria-label="${t('selectMemory')}">`:''}<button type="button" class="memory-link" data-memory="${m.memory_id}">${memoryText(m)}${typeChip(t, m.memory_type || 'fact')}${entityMatch(t,m)}</button></div>${(m.topic && m.title_source !== 'topic') || m.imported ? html`<div class="memory-extra">${meta(m)}</div>` : ''}</td>
      <td><span class="category-pill" data-category="${m.category || 'uncategorized'}">${categoryName(t, labels, m.category || 'uncategorized')}</span></td><td>${statusTag(t, m.status || 'active')}</td><td class="memory-date"><time>${formatDate(m.created_at)}</time></td></tr>`)}</tbody></table></div>`
    : emptyState(t, query || category || topic || origin || (status && status !== 'all') ? 'emptyFiltered' : 'empty');
  const chips = [['topic', topic, topic], ['origin', origin, origin ? t(origin === 'imported' ? 'importedOrigin' : 'otherOrigin') : '']].filter(([, value]) => value);
  return String(html`<div class="library-layout">${facets !== undefined ? libraryFacets(t, {facets, labels, category, topic, origin, canManage: allowedActions.includes('category.create'), canUndo: allowedActions.includes('memory.organize_undo')}) : ''}<div class="library-main"><form class="toolbar memory-filters" id="search-form" role="search">
    <label class="query-field"><span class="sr-only" data-i18n="query">${t('query')}</span><span class="query-input">${svg('search')}<input name="query" value="${query}" maxlength="2000" autocomplete="off" data-search-input data-i18n-placeholder="askPlaceholder" placeholder="${t('askPlaceholder')}"></span></label>
    <label class="filter-mode">${i18n(t, 'searchMode')}<select name="search_mode">${['lexical', 'hybrid', 'semantic'].map(v => option(v, v, searchMode))}</select></label>
    <label class="filter-category">${i18n(t, 'category')}<select name="category">${option('', 'allCategories', category)}${categories.map(categoryOption)}</select></label>
    <label class="filter-status">${i18n(t, 'status')}<select name="status">${['active', 'superseded', 'retracted'].map(v => option(v, v, status || 'active'))}${option('all', 'allStatuses', status)}</select></label>
    <div class="filter-actions"><button class="primary filter-submit" type="submit">${svg('search')}${i18n(t, 'search')}</button><button type="button" class="filter-reset quiet" data-reset-filters>${i18n(t, 'resetFilters')}</button></div></form>
  ${facets ? classificationStatus(t, facets.classification, {canSchedule: allowedActions.includes('jobs.schedule'), uncategorized: (facets.categories || []).find(c => c.category === 'uncategorized')?.count || 0}) : ''}
  ${chips.length ? html`<div class="filter-chips">${chips.map(([facet, , label]) => html`<span class="filter-chip">${label}<button type="button" class="quiet" data-clear-facet="${facet}" data-i18n-aria-label="clearFilter" aria-label="${t('clearFilter')}">×</button></span>`)}</div>` : ''}
  <section class="card memory-library">${focusSources ? html`<p class="library-note">${i18n(t, 'inspectSourcesNote')}</p>` : ''}
    ${data.truncated || data.retrieval?.window_limited ? html`<p class="policy-box library-note">${i18n(t, 'boundedSearchNote')} (${data.retrieval?.candidate_limit})</p>` : ''}
    ${data.retrieval?.aliases?.truncated?html`<p class="policy-box library-note">${i18n(t,'entitySearchTruncated')}</p>`:''}
    ${data.retrieval?.aliases?.ambiguous?html`<p class="policy-box library-note">${i18n(t,'entitySearchAmbiguous')}</p>`:''}
    ${selection}<div id="memory-rows">${table}</div>
    <div class="library-footer"><p>${rows.length} ${i18n(t, 'resultCount')}${readOnly ? html` · ${i18n(t, 'readOnly')}` : ''}</p>${trusted(pagination)}</div></section></div></div>`);
}

/** The facts that tell same-category summaries apart: window, time zone, scope, sources and version.
 * Names lead; internal IDs follow as secondary text. Missing facts say "unknown", never a guess. */
// Readable chain from the outermost known level (project → task → workstream, or session). Names are
// current names, not history; when one is missing its ID stands in. The IDs themselves follow on the
// secondary line, so same-named tasks in different projects never read identically.
const SCOPE_LEVELS = [['project', 'project_name', 'project_id'], ['task', 'task_title', 'task_id'], ['workstream', 'workstream_name', 'workstream_id'], ['session', null, 'session_id']];
function summaryScope(t, scope) {
  const kind = scope?.kind || 'unknown';
  if (kind === 'unknown') return html`<span class="summary-scope">${i18n(t, 'summaryScope_unknown')}</span>`;
  if (kind === 'user') return html`<span class="summary-scope">${i18n(t, 'summaryScope_user')}</span>`;
  const levels = SCOPE_LEVELS.filter(([, , id]) => scope[id]);
  return html`<span class="summary-scope">${levels.map(([level, name, id], index) => html`${index ? ' › ' : ''}${i18n(t, `summaryScope_${level}`)} ${name && scope[name] ? html`<span class="summary-name">${scope[name]}</span>` : html`<code>${scope[id]}</code>`}`)}</span>`;
}
const scopeIds = scope => SCOPE_LEVELS.map(([, , id]) => scope?.[id]).filter(Boolean);
function summaryWindow(t, window) {
  if (!window) return i18n(t, 'summaryWindowUnknown');
  return html`<span class="summary-window">${i18n(t, `summaryPeriod_${window.period}`)}${window.period === 'weekly' ? html` · ${i18n(t, 'summaryWeekFrom')}` : ''} <time>${window.local_start || '—'}</time> <span class="summary-tz">(${window.timezone || '—'})</span></span>`;
}
export function summaryFacts(t, s) {
  const omitted = safeCount(s.omitted);
  return html`<span class="summary-facts">${summaryWindow(t, s.window)}${summaryScope(t, s.scope)}<span>${i18n(t, 'sourceCount')} ${s.coverage}</span>${omitted ? html`<span>${i18n(t, 'summaryOmitted')} ${omitted}</span>` : ''}<span>${i18n(t, 'revisions')} ${s.revision}</span></span>`;
}

export function summariesView(t, {data, pagination = '', labels = {}}) {
  const cats = (data.categories || []).filter(c => safeCount(c.count) !== null);
  const max = Math.max(1, ...cats.map(c => c.count));
  const summaries = data.summaries || [];
  return String(html`<div class="split">
  <section class="index-panel">${i18n(t, 'summaryIndex', 'h2')}${cats.length ? html`<ul class="category-index">${cats.map(c => html`<li><a class="category-link" href="/app/memories?category=${encodeURIComponent(c.category)}&amp;status=active"><span>${categoryName(t, labels, c.category)}</span>
    <svg viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect class="track" width="100" height="4" rx="2"/><rect class="fill" width="${fixed(Math.max(3, c.count / max * 100))}" height="4" rx="2"/></svg><strong>${c.count}</strong></a></li>`)}</ul>` : emptyState(t)}</section>
  <section class="list-panel">${i18n(t, 'summaryList', 'h2')}${summaries.length ? html`<ol class="summary-list">${summaries.map(s => {
    const ids = scopeIds(s.scope);
    const body = html`<span class="summary-title">${categoryName(t, labels, s.category)}</span>${summaryFacts(t, s)}<small class="summary-id">${ids.length ? html`${i18n(t, 'summaryScopeIds')} <code>${ids.join(' / ')}</code><br>` : ''}${i18n(t, 'summaryId')} <code>${s.summary_id}</code></small>`;
    return html`<li class="summary-row">${s.status === 'current'
      ? html`<button type="button" class="memory-link" data-summary="${s.summary_id}" data-revision="${s.revision}">${body}</button>`
      : html`<div class="memory-link">${body}<small>${i18n(t, 'summaryNotCurrent')} · <a href="/app/memories?category=${encodeURIComponent(s.category)}">${i18n(t, 'browseMemories')}</a></small></div>`}${html`<span class="tag">${t(s.status)}</span>`}</li>`;
  })}</ol>` : emptyState(t)}${trusted(pagination)}</section></div>`);
}

// Audit (AUD-01/02, Console item 7). One stream at a time with its own paging. Recorded references (credential,
// target and query result IDs) are shown as recorded; labels, connection state and memory titles are marked current.
const auditCredential = (t, id, c) => {
  if (!id) return html`<span class="muted">${i18n(t, 'auditActorUnknown')}</span>`;
  const conn = c?.connection, revoked = c?.revoked ? html` <span class="tag">${i18n(t, 'auditRevokedNow')}</span>` : '';
  const connection = !conn ? '' : conn.type === 'personal' ? html`<span>${i18n(t, 'auditConnectionCurrent')}: ${conn.missing ? i18n(t, 'auditConnectionMissing') : html`<strong>${conn.label}</strong> · ${conn.kind} · ${t(conn.state)}`} <code>${conn.connection_id}</code> · ${i18n(t, 'auditCredentialVersion')} ${conn.credential_version}</span>`
    : conn.type === 'system' ? html`<span>${i18n(t, 'auditConnectionCurrent')}: ${i18n(t, conn.purpose === 'web' ? 'auditSystemWeb' : conn.purpose==='console'?'auditSystemConsole':'unknown')}</span>`
    : html`<span class="muted">${i18n(t, 'auditConnectionUnmapped')}</span>`;
  return html`<span>${i18n(t, 'auditCredential')} <code>${id}</code>${revoked}</span>${c ? html`<span>${c.label} · ${i18n(t, 'agentId')} <code>${c.agent_id||t('unknown')}</code> · ${i18n(t, 'agentInstance')} <code>${c.agent_instance_id||t('unknown')}</code> · ${i18n(t, 'deviceId')} <code>${c.device_id||t('unknown')}</code></span>${connection}` : html`<span class="muted">${i18n(t, 'auditCredentialGone')}</span>`}`;
};
const auditMemory = (t, id, memories) => {
  const m = Object.hasOwn(memories,id)?memories[id]:null;
  return m ? html`<button type="button" class="audit-memory" data-memory="${id}">${m.title || id} <small><code>${id}</code></small></button>` : html`<span class="audit-memory unavailable"><code>${id}</code> <small>${i18n(t, 'auditMemoryUnavailable')}</small></span>`;
};
function auditCoreDetail(t, e, data) {
  const memories = data.memories || {}, q = e.query, credentials=data.credentials||{};
  const target = e.target_type === 'memory' && e.target_id ? html`<span>${i18n(t, 'auditTarget')}: ${auditMemory(t, e.target_id, memories)}</span>`
    : e.target_id ? html`<span>${i18n(t, 'auditTarget')}: ${e.target_type} <code>${e.target_id}</code></span>` : '';
  const query = !q ? '' : !Array.isArray(q.result_refs) ? html`<span class="muted">${i18n(t, 'auditRefsNotRecorded')}</span>`
    : html`<span>${i18n(t, 'auditLexicalRefs')} ${q.result_refs.length ? q.result_refs.map(id => auditMemory(t, id, memories)) : i18n(t, 'auditRefsEmpty')}${q.result_refs_truncated ? html` <small>${i18n(t, 'auditRefsTruncated')}</small>` : ''}</span>`;
  return html`<span class="audit-facts">${auditCredential(t, e.credential_id, Object.hasOwn(credentials,e.credential_id)?credentials[e.credential_id]:null)}${target}${query}</span>`;
}
export function auditView(t, {data = {}, source = 'core', pagination = '', filters = {}}) {
  const entries = data.entries || [], core = source === 'core', active=Object.values(filters).filter(Boolean).length;
  const tab = (key, label) => html`<button type="button" data-audit-source="${key}" aria-pressed="${String(source === key)}">${i18n(t, label)}</button>`;
  return String(html`<div class="view-switch audit-sources" role="group" data-i18n-aria-label="auditSource" aria-label="${t('auditSource')}">${tab('core', 'auditSourceCore')}${tab('identity', 'auditSourceIdentity')}</div>
    <p class="muted audit-scope">${i18n(t, core ? 'auditScopeCore' : 'auditScopeIdentity')}</p>
    <details class="audit-filter-panel" ${active?trusted('open'):''}><summary>${i18n(t,'filterAudit')}${active?html` <small>(${active})</small>`:''}</summary>
    <form id="audit-filter" class="audit-filters">${[['action','auditAction','text'],['outcome','auditOutcome','text'],['from','auditFrom','datetime-local'],['to','auditTo','datetime-local']].map(([key,label,type])=>html`<label>${i18n(t,label)}<input name="${key}" type="${type}" value="${filters[key]||''}" ${type==='text'?trusted('maxlength="100"'):''}></label>`)}<button type="submit">${i18n(t,'applyFilters')}</button><small class="audit-filter-zone">${i18n(t,'auditLocalTime')}</small></form></details>
    <section class="card"><header class="section-head">${i18n(t, 'auditTimeline', 'h2')}<button type="button" data-retry>${i18n(t, 'refresh')}</button></header>${!entries.length?emptyState(t):''}
    ${core && data.memory_titles_truncated ? html`<p class="muted">${i18n(t, 'auditTitlesTruncated')}</p>` : ''}
    <ol class="timeline audit-timeline">${entries.map(e => {const date=core?e.created_at:e.created;const stamp=new Date(typeof date==='number'?date*1000:date);return html`<li class="timeline-item" data-outcome="${e.outcome || ''}" data-kind="${e.kind || 'other'}"><span class="timeline-dot" aria-hidden="true"></span>
      <div><strong>${e.action}</strong><span class="memory-meta"><span class="tag">${i18n(t, `auditKind_${['read','write','auth','credential'].includes(e.kind) ? e.kind : 'other'}`)}</span><span class="tag">${e.outcome || '—'}</span><time datetime="${Number.isFinite(stamp.getTime())?stamp.toISOString():''}">${formatDate(date)}</time>${e.audit_id ? html`<code>${e.audit_id}</code>` : ''}</span>
      ${core ? auditCoreDetail(t, e, data) : html`<span class="audit-facts"><span class="muted">${i18n(t, 'auditIdentityActor')}</span></span>`}</div></li>`;})}</ol>${trusted(pagination)}</section>`);
}

/** Memory detail for the side pane. `actions` is markup built from fixed action buttons. */
export function revisionDifference(left,right){
  const a=[...left],b=[...right];let start=0,end=0;
  while(start<Math.min(a.length,b.length)&&a[start]===b[start])start++;
  while(end<Math.min(a.length,b.length)-start&&a[a.length-1-end]===b[b.length-1-end])end++;
  return [a,b].map(chars=>({prefix:chars.slice(0,start).join(''),changed:chars.slice(start,chars.length-end).join(''),suffix:chars.slice(chars.length-end).join('')}));
}

/** Labelled facts for the detail pane: type, classification, lifecycle, version and provenance, each on its own row. */
function detailFacts(t, m, data, meta, labels) {
  const origin = meta?.origin;
  const rows = [
    ['memoryType', typeChip(t, m.memory_type || 'fact')],
    ...(meta?.category ? [['category', html`<span class="category-pill" data-category="${meta.category}">${categoryName(t, labels, meta.category)}</span>`]] : []),
    ['status', statusTag(t, m.status || 'active')],
    ['revisions', html`<span class="figure">${data.revision}</span>`],
    ...(origin ? [['originFacet', html`${i18n(t, ORIGIN_KEYS[origin.kind] || 'originAgent')}${origin.original_created_at ? html` · ${i18n(t, 'originalDate')} <time>${formatDate(origin.original_created_at)}</time>` : ''}`]] : []),
    ...(meta?.tag ? [['originalTag', html`<code class="tag-value">${meta.tag}</code><small class="muted">${i18n(t, 'originalTagNote')}</small>`]] : []),
    ...(meta?.sensitivity ? [['sensitivity', html`${t(meta.sensitivity)}`]] : []),
  ];
  return html`<dl class="detail-facts">${rows.map(([key, value]) => html`<dt>${i18n(t, key)}</dt><dd>${value}</dd>`)}</dl>`;
}

export function memoryDetailView(t, data, {actions = '', canGoBack = false, meta = null, labels = {}}) {
  const m = data.memory || {}, content = String(m.content ?? ''), length = [...content].length;
  const sources = data.source_manifest?.sources || [];
  const lifecycle = m.lifecycle || {};
  const links = [[lifecycle.supersedes_memory_id, 'previousRecord'], [lifecycle.superseded_by_memory_id, 'replacementRecord']].filter(([id]) => id);
  return String(html`${detailFacts(t, m, data, meta, labels)}
  ${m.status === 'active' && actions ? html`<div class="actions detail-actions">${trusted(actions)}</div>` : ''}
  <button type="button" data-compare-memory="${m.memory_id}" data-previous-memory="${lifecycle.supersedes_memory_id||''}">${i18n(t,'compareVersions')}</button>
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
  ${data.context ? html`<p class="summary-detail-facts">${summaryFacts(t, {...data.context, revision: summary.revision})}${scopeIds(data.context.scope).length ? html`<small class="summary-id">${i18n(t, 'summaryScopeIds')} <code>${scopeIds(data.context.scope).join(' / ')}</code></small>` : ''}</p>` : ''}
  ${summary.claims?.length ? html`<ol class="claim-list">${summary.claims.map(c => html`<li class="detail-source"><p class="body-content">${c.quote}</p>
    <button type="button" class="quiet" data-memory="${c.memory_id}" data-revision="${c.revision}">${svg('source')}${i18n(t, 'sources')} · <code>${c.memory_id}</code></button></li>`)}</ol>` : emptyState(t)}
  ${i18n(t, data.complete ? 'endOfContent' : 'next', 'p')}
  <div class="pagination">${canGoBack ? html`<button type="button" data-detail-back>${svg('back')}${i18n(t, 'previous')}</button>` : html`<button type="button" data-close>${svg('back')}${i18n(t, 'backToList')}</button>`}${data.next_request ? html`<button type="button" data-detail-next>${i18n(t, 'next')}${svg('arrow')}</button>` : ''}</div>`);
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
    {id: 'OVW-03', status: 'live', read: ['attention']},
  ],
  memories: [
    {id: 'MEM-01', status: 'live', read: ['memories']},
    {id: 'MEM-02', status: 'live', read: ['memory', 'memory-meta']},
    {id: 'MEM-03', status: 'live', write: ['memory.create']},
    {id: 'MEM-04', status: 'live', write: ['memory.correct', 'memory.retract']},
    {id: 'MEM-05', status: 'live', write: ['memory.classify', 'memory.sensitivity']},
    {id: 'MEM-06', status: 'live', read: ['memories'], write: ['memory.organize', 'memory.organize_undo', 'memory.batch_classify', 'memory.batch_retract']},
    {id: 'MEM-07', status: 'live', read: ['memory-versions']},
    {id: 'MEM-08', status: 'live', read: ['entities'], write: ['entity.create','entity.alias','entity.alias_correct','entity.alias_remove','entity.link','entity.unlink','entity.resolve']},
  ],
  summaries: [
    {id: 'SUM-01', status: 'live', read: ['summaries', 'summary']},
    {id: 'SUM-02', status: 'live', write: ['jobs.schedule']},
    {id: 'SUM-03', status: 'live', read: ['taxonomy'], write: ['category.create', 'category.rename', 'category.delete', 'taxonomy.save']},
  ],
  tasks: [
    {id: 'TSK-01', status: 'live', read: ['projects', 'metadata-values', 'project-context'], write: ['projects.update', 'projects.archive', 'projects.restore', 'projects.lifecycle_preview', 'projects.lifecycle_delete', 'projects.lifecycle_restore', 'projects.merge']},
    {id: 'TSK-02', status: 'live', read: ['task-branches', 'task-detail', 'metadata-values'], write: ['tasks.update'], core: ['POST /v1/task-branches/preview'], scope: ['resume:read'],
      ui: {table: ['taskTitle', 'sourceBranch', 'lastCheckpoint', 'state']}},
    {id: 'TSK-03', status: 'live', read: ['project-context'], core: ['POST /v1/project-context/preview'], scope: ['resume:read'],
      ui: {form: ['select:project'], submit: 'generatePreview'}},
    {id: 'TSK-04', status: 'live', read: ['task-checkpoints'], core: ['GET /v1/tasks/{task_id}/checkpoints', 'GET /v1/tasks/{task_id}/canonical-revisions'],
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
    {id: 'CON-04', status: 'live', read: ['capture-status'], core: ['GET /v1/status'], scope: ['memory:read']},
    {id: 'CON-05', status: 'live', write: ['devices.register', 'devices.rotate'], core: ['POST /v1/agent-instances/register', 'POST /v1/agent-instances/{id}/rotate-key'],
      scope: ['admin:devices'], reauth: true},
  ],
  models: [
    {id: 'MOD-01', status: 'live', read: ['models'], write: ['models.save', 'models.disable']},
    {id: 'MOD-02', status: 'live', write: ['models.test']},
    {id: 'MOD-03', status: 'live', write: ['vector.schedule']},
    {id: 'MOD-04', status: 'live', read: ['model-usage'], write: ['models.quota']},
  ],
  security: [
    {id: 'SEC-01', status: 'live', write: ['security.password'], reauth: true},
    {id: 'SEC-02', status: 'live', write: ['security.totp.begin', 'security.totp.complete'], reauth: true},
    {id: 'SEC-03', status: 'live', write: ['security.recovery_codes'], reauth: true},
    {id: 'SEC-04', status: 'live', read: ['security'], write: ['security.session.revoke', 'security.sessions.revoke_others']},
    {id: 'SEC-05', status: 'live', read: ['login-history']},
  ],
  audit: [
    {id: 'AUD-01', status: 'live', read: ['audit']},
    {id: 'AUD-02', status: 'live', read: ['audit']},
  ],
  storage: [
    {id: 'STO-01', status: 'live', read: ['export'], write: ['storage.export']},
    {id: 'STO-02', status: 'live', write: ['storage.import']},
    {id: 'STO-03', status: 'live', read: ['storage']},
    {id: 'STO-04', status: 'policy'},
  ],
  system: [
    {id: 'SYS-01', status: 'live', read: ['capabilities'], operator: true},
    {id: 'SYS-02', status: 'live', read: ['system-health'], core: ['GET /v1/status', 'GET /readyz'], operator: true,
      ui: {stats: ['svcCore', 'svcWeb', 'svcAuth', 'svcWorker', 'svcVector']}},
    {id: 'SYS-03', status: 'live', read: ['system-version'], operator: true, ui: {stats: ['releaseVersion', 'schemaVersion', 'runtimeVersion']}},
    {id: 'SYS-04', status: 'live', read: ['backups'], operator: true, ui: {table: ['backupTime', 'backupSize', 'backupVerified']}},
  ],
};
/** Catalog keys for a feature: OVW-01 → featOVW01 (title) and featOVW01Note (description). */
export const featureKey = id => `feat${id.replace('-', '')}`;
/** Menu destinations whose content is composed from the feature map. */
export const prototypePages = ['tasks', 'resume', 'system'];
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

/** Previous/next buttons carrying the target offset in a fixed data attribute. */
const pageButtons = (t, attribute, data) => html`<div class="pagination">${data.offset ? html`<button type="button" ${trusted(attribute)}="${Math.max(0, data.offset - (data.limit || 25))}">${i18n(t, 'previous')}</button>` : ''}${data.next_offset != null ? html`<button type="button" ${trusted(attribute)}="${data.next_offset}">${i18n(t, 'next')}</button>` : ''}</div>`;
/** TSK-01: the account's projects. Names wrap, IDs are secondary; each row expands its own read-only
 * context in place. Console archive only hides a project here; edits need full Console write. */
function projectList(t, data, caps = {}) {
  if (data.unavailable) return sectionNote(t, 'unavailable');
  const rows = Array.isArray(data.projects) ? data.projects : [], archivedView = data.view === 'archived', deletedView = data.view === 'deleted';
  const can = action => caps.allowed_actions?.includes(action);
  // Three server-side views with their own counts and paging: active projects, those hidden in the Console, and the
  // owner's recoverably deleted projects (retained history, restored only through a re-authenticated restore).
  const current = deletedView ? 'deleted' : archivedView ? 'true' : 'false';
  // The Deleted view exists only for credentials the server gives a deleted count (full Console write: owner-only truth).
  const views = html`<div class="view-switch" role="group" aria-label="${t('projectViews')}">${[['false', 'activeProjects', data.active_count], ['true', 'archivedProjects', data.archived_count], ...(data.deleted_count === undefined ? [] : [['deleted', 'deletedProjects', data.deleted_count]])]
    .map(([value, key, count]) => html`<button type="button" data-project-view="${value}" aria-pressed="${String(current === value)}">${i18n(t, key)}${count === undefined ? '' : html` <span class="figure">${count}</span>`}</button>`)}</div>`;
  const note = deletedView ? sectionNote(t, 'deletedProjectsNote') : archivedView ? sectionNote(t, 'consoleArchiveNote') : '';
  // An emptied later page (its last row archived or restored) keeps Previous.
  if (!rows.length) return html`${views}${note}${emptyState(t, deletedView ? 'noDeletedProjects' : archivedView ? 'noArchivedProjects' : 'noProjects')}${pageButtons(t, 'data-project-offset', data)}`;
  if (deletedView) return html`${views}${note}<ul class="project-list">${rows.map(p => html`<li class="project-row" data-deleted data-project-row="${p.project_id}">
      <div class="project-main"><strong class="project-name">${p.name || '—'}</strong> <span class="tag" data-state="deleted">${i18n(t, 'projectDeletedTag')}</span>${p.archived ? html` <span class="tag" data-state="archived">${i18n(t, 'consoleArchived')}</span>` : ''}
        ${p.merged_project_ids?.length ? html`<p class="project-members muted">${i18n(t, 'mergedMembers')}: ${p.merged_project_ids.map(id => html`<code>${id}</code> `)}</p>` : ''}
        <small class="project-meta"><code>${p.project_id}</code> · ${i18n(t, 'taskCount')} ${p.task_count ?? 0}${p.deleted_at ? html` · ${i18n(t, 'deletedAt')} <time>${formatDate(p.deleted_at)}</time>` : ''}</small></div>
      <div class="actions project-actions">${can('projects.lifecycle_restore') ? html`<button type="button" data-console-action="projects.lifecycle_restore" data-id="${p.project_id}">${i18n(t, 'restoreDeletedProject')}</button>` : ''}</div></li>`)}</ul>${pageButtons(t, 'data-project-offset', data)}`;
  return html`${views}${note}<ul class="project-list">${rows.map((p, i) => {
    const region = `project-context-${i}`, aliases = Array.isArray(p.alias_preview) ? p.alias_preview : [], more = (p.counts?.aliases ?? aliases.length) - aliases.length;
    return html`<li class="project-row"${p.archived ? html` data-archived` : ''} data-project-row="${p.project_id}">
      <div class="project-main"><strong class="project-name">${p.name || '—'}</strong>${p.archived ? html` <span class="tag" data-state="archived">${i18n(t, 'consoleArchived')}</span>` : ''}
        ${aliases.length ? html`<p class="project-aliases">${aliases.map(a => html`<span class="tag">${a.text}${a.complete === false ? '…' : ''}</span>`)}${more > 0 ? html`<span class="muted">+${more}</span>` : ''}</p>` : ''}
        ${p.merged_project_ids?.length ? html`<p class="project-members muted">${i18n(t, 'mergedMembers')}: ${p.merged_project_ids.map(id => html`<code>${id}</code> `)}</p>` : ''}
        <small class="project-meta"><code>${p.project_id}</code>${p.task_count !== undefined ? html` · ${i18n(t, 'taskCount')} ${p.task_count}` : ''}${p.updated_at ? html` · ${i18n(t, 'updated')} <time>${formatDate(p.updated_at)}</time>` : ''}</small></div>
      <div class="actions project-actions">
        <button type="button" data-project-context="${p.project_id}" aria-expanded="false" aria-controls="${region}">${i18n(t, 'projectContext')}</button>
        ${can('projects.update') ? html`<button type="button" data-console-action="projects.update" data-id="${p.project_id}">${i18n(t, 'editProject')}</button>` : ''}
        ${can(p.archived ? 'projects.restore' : 'projects.archive') ? html`<button type="button" data-console-action="${p.archived ? 'projects.restore' : 'projects.archive'}" data-id="${p.project_id}">${i18n(t, p.archived ? 'restoreProject' : 'archiveProject')}</button>` : ''}
        ${can('projects.merge') ? html`<button type="button" data-console-action="projects.merge" data-id="${p.project_id}">${i18n(t, 'mergeProject')}</button>` : ''}
        ${can('projects.lifecycle_delete') ? html`<button type="button" class="danger" data-console-action="projects.lifecycle_delete" data-id="${p.project_id}">${i18n(t, 'deleteProject')}</button>` : ''}
      </div>
      <div class="project-context" id="${region}" role="region" aria-label="${t('projectContext')}" hidden></div></li>`;
  })}</ul>${pageButtons(t, 'data-project-offset', data)}`;
}
/** Inline project context: the read-only preview exactly as the Core assembled and bounded it. Task fields,
 * checkpoints, recent activity and the recorded agent/device identities stay visible in compact sections;
 * nothing is invented, expanded past the Core's limits or editable here. */
const contextText = value => typeof value === 'string' ? value : typeof value?.text === 'string' ? value.text : JSON.stringify(value);
const recorded = source => source ? [source.agent_id, source.agent_instance_id && `${source.agent_instance_id}${source.device_id ? `@${source.device_id}` : ''}`].filter(Boolean).join(' · ') : '';
// The Core caps each task field (field_availability says how many are stored and whether all were returned),
// so a capped list reads "4 / 20 · partial", never as if it were complete.
const shownCount = (t, values, availability) => availability?.returned === 'partial' && Number.isInteger(availability.item_count)
  ? html`${values.length} / ${availability.item_count} · ${i18n(t, 'contextPartial')}` : html`${values.length}`;
function contextItems(t, key, values, availability) {
  return Array.isArray(values) && values.length ? html`<details class="context-section"><summary>${i18n(t, key)} <small>${shownCount(t, values, availability)}</small></summary><ul>${values.map(v => html`<li>${contextText(v)}</li>`)}</ul></details>` : '';
}
function contextCheckpoint(t, c) {
  return html`<li><p><time>${formatDate(c.created_at)}</time> <span class="tag">${t(c.status || 'unknown')}</span>${c.workstream_id ? html` <code>${c.workstream_id}</code>` : ''}</p>
    ${c.latest_outcome ? html`<p>${i18n(t, 'contextOutcome')}: ${contextText(c.latest_outcome)}</p>` : ''}
    ${[['contextCompleted', c.completed_items], ['decisions', c.decisions], ['blockers', c.blockers], ['contextNextSteps', c.recommended_next_steps]].map(([key, values]) => values?.length ? html`<p class="muted">${i18n(t, key)}: ${values.map(contextText).join(' · ')}</p>` : '')}
    <small>${i18n(t, 'contextRecordedBy')} ${recorded(c.provenance) || '—'}${c.generation?.method ? html` · ${c.generation.method}${c.generation.confidence_label ? html` (${c.generation.confidence_label})` : ''}` : ''}</small></li>`;
}
export function projectContextView(t, data) {
  if (data.status && data.status !== 'project_context_preview') return String(html`<p class="policy-box">${i18n(t, 'contextUnavailable')}</p>`);
  const s = data.source_summary || {}, p = data.projection || {}, tasks = data.tasks || [], memories = data.structured_memories || [], activity = data.recent_activity || [];
  const limited = [p.tasks_truncated && 'contextTasksLimited', p.checkpoints_truncated && 'contextCheckpointsLimited', p.fallback_compaction_applied && 'contextCompacted'].filter(Boolean);
  return String(html`<p class="context-provenance">${i18n(t, 'contextProvenance')} · <time>${formatDate(data.created_at)}</time></p>
    <dl class="metadata-grid context-counts">${[['taskCount', `${s.included_task_count ?? 0} / ${s.task_count ?? 0}`], ['contextMemories', s.structured_memory_count ?? 0], ['contextCheckpoints', `${s.included_latest_checkpoint_count ?? 0} / ${s.latest_checkpoint_count ?? 0}`], ['contextActivity', s.recent_activity_count ?? 0]]
      .map(([key, value]) => html`<dt>${i18n(t, key)}</dt><dd>${value}</dd>`)}</dl>
    ${limited.map(key => html`<p class="muted">${i18n(t, key)}</p>`)}
    ${s.identities?.length ? html`<p class="context-identities">${i18n(t, 'contextIdentities')}: ${s.identities.map(id => html`<code>${id}</code>`)}</p>` : ''}
    ${tasks.length ? html`<ul class="context-tasks">${tasks.map(task => html`<li><details class="context-task"><summary><strong>${task.title}</strong> <span class="tag">${t(task.status)}</span> <small>${i18n(t, 'revisions')} ${task.canonical_version}</small></summary>
      ${task.goal ? html`<p>${task.goal}</p>` : ''}
      ${[['contextProgress', 'progress'], ['decisions', 'decisions'], ['blockers', 'blockers'], ['contextNextSteps', 'next_steps'], ['contextResources', 'resources'], ['contextConflicts', 'conflicts']]
        .map(([key, field]) => contextItems(t, key, task[field], task.field_availability?.[field]))}
      ${task.workstreams?.length ? html`<details class="context-section"><summary>${i18n(t, 'contextWorkstreams')} <small>${shownCount(t, task.workstreams, task.field_availability?.workstreams)}</small></summary><ul>${task.workstreams.map(w => html`<li><strong>${w.name || w.workstream_id}</strong>${w.status ? html` <span class="tag">${t(w.status)}</span>` : ''} <code>${w.workstream_id}</code>${w.description ? html`<p>${w.description}</p>` : ''}${recorded(w) ? html`<small>${i18n(t, 'contextRecordedBy')} ${recorded(w)}</small>` : ''}</li>`)}</ul></details>` : ''}
      ${task.latest_checkpoints?.length ? html`<details class="context-section"><summary>${i18n(t, 'contextCheckpoints')} <small>${task.latest_checkpoints.length}</small></summary><ul>${task.latest_checkpoints.map(c => contextCheckpoint(t, c))}</ul></details>` : ''}
    </details></li>`)}</ul>` : emptyState(t, 'contextNoTasks')}
    ${memories.length ? html`<details class="context-section"><summary>${i18n(t, 'contextMemories')} <small>${memories.length}</small></summary><ol class="context-memories">${memories.map(m => html`<li>${m.content}${m.content_truncated ? '…' : ''} <small><time>${formatDate(m.created_at)}</time>${recorded(m.provenance) ? html` · ${i18n(t, 'contextRecordedBy')} ${recorded(m.provenance)}` : ''}</small></li>`)}</ol></details>` : ''}
    ${activity.length ? html`<details class="context-section"><summary>${i18n(t, 'contextActivity')} <small>${activity.length}</small></summary><ol>${activity.map(a => html`<li><time>${formatDate(a.captured_at)}</time> <code>${a.event_type}</code> ${a.source_status === 'raw_expired' ? i18n(t, 'contextRawExpired') : a.content ?? '—'}${a.content_truncated ? '…' : ''} <small>${i18n(t, 'contextRecordedBy')} ${recorded(a.provenance) || '—'}</small></li>`)}</ol></details>` : ''}
    <p class="muted">${i18n(t, 'contextSafety')}</p>`);
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
  const live = {'TSK-01': () => projectList(t, data, caps), 'SYS-01': () => platformSwitches(t, caps)};
  const cards = prototypeOrder(page).map(f => featureCard(t, f, f.status === 'live' ? live[f.id]?.() ?? featureBody(t,f.id,data,caps) : ''));
  return String(html`<div class="feature-grid feature-grid--${page}">${cards}</div>${page === 'system' ? featureProgress(t) : ''}`);
}

export const completedViews={overview:['attention'],memories:['entities'],summaries:['taxonomy'],tasks:['task-branches'],connections:['capture-status'],models:['model-usage'],security:['login-history'],audit:[],system:['system-health','system-version','backups']};
const completedIds=['OVW-03','MEM-06','MEM-07','SUM-03','TSK-02','TSK-03','TSK-04','CON-04','CON-05','MOD-04','SEC-05','AUD-02','SYS-02','SYS-03','SYS-04'];
export function completedFeaturePanels(t,page,data,caps){return String(html`${(featureMap[page]||[]).filter(f=>completedIds.includes(f.id)).map(f=>featureCard(t,f,featureBody(t,f.id,data,caps)))}`);}
function featureBody(t,id,data,caps){
  const view={ 'OVW-03':'attention','SUM-03':'taxonomy','TSK-02':'task-branches','CON-04':'capture-status','MOD-04':'model-usage','SEC-05':'login-history','SYS-02':'system-health','SYS-03':'system-version','SYS-04':'backups'}[id];
  const d=data.features?.[view];
  if(view&&!d)return sectionNote(t,'unavailable');
  const act=(action,label,values={})=>caps.allowed_actions?.includes(action)?html`<button type="button" data-console-action="${action}"${Object.entries(values).map(([k,v])=>html` data-${trusted(k)}="${v}"`)}>${i18n(t,label)}</button>`:'';
  const inspect=(v,p,label)=>html`<button type="button" data-feature-read="${v}" data-feature-params="${JSON.stringify(p)}">${i18n(t,label)}</button>`;
  const table=(rows,cols)=>rows?.length?html`<div class="table-scroll"><table><thead><tr>${cols.map(([key])=>html`<th>${i18n(t,key)}</th>`)}</tr></thead><tbody>${rows.map(r=>html`<tr>${cols.map(([,get])=>html`<td>${get(r)}</td>`)}</tr>`)}</tbody></table></div>`:emptyState(t);
  if(id==='OVW-03')return html`<dl class="metadata-grid">${[['failed_jobs','failedJobs','jobs'],['stale_summaries','staleSummaries','summaries'],['pending_reconciliation','pendingReconciliation','tasks']].map(([k,label,p])=>html`<dt>${i18n(t,label)}</dt><dd><a href="/app/${p}">${d.counts[k]}</a></dd>`)}</dl>`;
  if(id==='MEM-06')return sectionNote(t,caps.allowed_actions?.includes('memory.organize')?'organizeNote':caps.allowed_actions?.some(a=>['memory.batch_classify','memory.batch_retract'].includes(a))?'batchNote':'batchUnavailable');
  if(id==='MEM-07')return sectionNote(t,'compareOpenDetail');
  if(id==='SUM-03')return html`<p>${d.categories.map(c=>html`<span class="tag">${categoryName(t,d.labels,c)}</span>`)}</p><p>${i18n(t,'revisions')} ${d.revision}</p><div class="actions">${caps.allowed_actions?.includes('category.create')?html`<button type="button" data-console-action="category.manage">${i18n(t,'manageCategories')}</button>`:''}${act('taxonomy.save','editCategoryIds')}</div>`;
  // Stacked rows rather than a fixed four-column table: titles wrap at full width on phones.
  if(id==='TSK-02')return html`${d.tasks?.length?html`<ul class="task-list">${d.tasks.map(r=>html`<li class="task-row" data-task-row="${r.task_id}">
      <div class="task-main"><strong class="task-title">${r.title}</strong><small class="project-meta"><span class="tag">${t(r.status)}</span> ${i18n(t,'revisions')} ${r.canonical_version} · <code>${r.task_id}</code></small></div>
      <div class="actions task-actions">${act('tasks.update','editTask',{id:r.task_id})}${inspect('task-branches',{task_id:r.task_id},'sourceBranch')}</div></li>`)}</ul>`:emptyState(t)}${pageButtons(t,'data-task-offset',d)}`;
  // Project context opens inside each project row (TSK-01), next to the project it belongs to.
  if(id==='TSK-03')return sectionNote(t,'projectContextInline');
  if(id==='TSK-04')return table(data.features?.['task-branches']?.tasks,[['taskTitle',r=>r.title],['actions',r=>html`${inspect('task-checkpoints',{task_id:r.task_id},'checkpoint')} ${inspect('task-reconciliation',{task_id:r.task_id},'proposal')}`]]);
  if(id==='CON-04')return html`${sectionNote(t,'captureObservationNote')}${table(d.agents,[['agentId',r=>r.agent_id],['agentInstance',r=>r.agent_instance_id],['sourceCount',r=>r.events],['lastUsed',r=>formatDate(r.last_received_at)]])}`;
  if(id==='CON-05')return html`${sectionNote(t,'agentKeyBoundary')}${act('devices.register','registerAgent')}${table((data.core_connections||[]).filter(c=>c.console_revocable),[['label',r=>r.label],['agentInstance',r=>r.agent_instance_id],['actions',r=>act('devices.rotate','rotateAgent',{id:r.credential_id})]])}`;
  if(id==='MOD-04')return html`<p>${d.day} UTC · ${i18n(t,'usageReservationNote')}</p>${table(d.models,[['modelKind',r=>t(r.kind)],['usedRequests',r=>r.used??'—'],['dailyRequests',r=>!r.configured?'—':r.limit??t('noLimit')],['remainingRequests',r=>!r.configured?'—':r.remaining??t('noLimit')],['totalCallLimit',r=>r.total?`${r.total.used} / ${r.total.limit??t('noLimit')}`:'—'],['firstRunBuildRequests',r=>r.first_run_build_calls??'—']])}`;
  if(id==='SEC-05')return html`${sectionNote(t,'loginHistoryNote')}${table(d.entries,[['created',r=>formatDate(r.created)],['state',r=>t(r.outcome)],['actions',r=>r.action]])}${d.next_offset!=null?inspect('login-history',{offset:d.next_offset},'next'):''}`;
  if(id==='AUD-02')return html`<button type="button" data-audit-export>${i18n(t,'exportAudit')}</button><p>${i18n(t,'auditExportNote')}</p><p data-audit-result role="status"></p>`;
  if(id==='SYS-02')return html`<dl class="metadata-grid">${Object.entries(d.services).map(([k,v])=>html`<dt>${k}</dt><dd>${t(v)}</dd>`)}</dl>${sectionNote(t,'healthObservationNote')}`;
  if(id==='SYS-03')return html`<dl class="metadata-grid">${[['releaseVersion',d.release],['schemaVersion',d.schema_version],['runtimeVersion',d.node]].map(([k,v])=>html`<dt>${i18n(t,k)}</dt><dd>${v}</dd>`)}</dl>${sectionNote(t,'migrationVersionNote')}`;
  if(id==='SYS-04')return sectionNote(t,'backupUnknownNote');
  return '';
}

/** Existing pages: their planned and policy features as one compact list under the live content. */
export function roadmapCard(t, page) {
  const items = (featureMap[page] || []).filter(f => f.status !== 'live');
  if (!items.length) return '';
  return String(html`<section class="card roadmap"><header class="section-head">${i18n(t, 'roadmapTitle', 'h2')}</header>${i18n(t, 'roadmapNote', 'p')}
    <ol class="roadmap-list">${items.map(f => html`<li data-status="${f.status}" data-feature="${f.id}"><div>${i18n(t, featureKey(f.id), 'strong')}${i18n(t, `${featureKey(f.id)}Note`, 'p')}</div>
      <div class="roadmap-meta">${featureStatus(t, f.status)}<span class="feature-id">${f.id}</span></div>${f.status === 'planned' ? devNote(t, f) : ''}</li>`)}</ol></section>`);
}
