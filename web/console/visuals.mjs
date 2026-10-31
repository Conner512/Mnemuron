import {auditLocalValue} from './audit.mjs';
import {pagePath} from './routes.mjs';
import {retrievalReasonKey} from './catalog.mjs';
import {taskWorkflowCard} from './task-workflows.mjs';
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

// Fixed local icon paths on a 24px grid. Never markup from memories or upstream data. Drawn with round caps and joins
// (sticky board); the bold navigation set below replaces any icon it also defines.
const paths = {
  agents: '<rect x="3.5" y="5" width="17" height="14"/><path d="M7 10l3 2.5L7 15M12.5 15H17"/>',
  entities: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="9" cy="18" r="2.5"/><path d="M8.4 6.6l7.2 1M17 10.3l-6.6 5.6M6.6 8.4l1.8 7.2"/>',
  usage: '<path d="M4 20h16"/><path d="M6.5 20v-6M11 20V8M15.5 20v-9M20 20V5" transform="translate(-0.5 0)"/>',
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
  system: '<rect x="4" y="4.5" width="16" height="6" rx="1.5"/><rect x="4" y="13.5" width="16" height="6" rx="1.5"/><circle cx="8" cy="7.5" r="1" fill="currentColor"/><circle cx="8" cy="16.5" r="1" fill="currentColor"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4.5 4.5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
  folder: '<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  source: '<path d="M4 13.5v6.5h16v-6.5"/><path d="M12 4v10"/><path d="m8 10 4 4 4-4"/>',
  history: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 3.5V8H9"/><path d="M12 8v4.5l3 2"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  logout: '<path d="M14 4.5H5.5v15H14M10.5 12H20M16.5 8.5 20 12l-3.5 3.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.5" r="1.3" fill="currentColor"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.5v.01"/>',
  warning: '<path d="M10.3 4.9 3.2 17.3A2 2 0 0 0 4.9 20.3h14.2a2 2 0 0 0 1.7-3L13.7 4.9a2 2 0 0 0-3.4 0z"/><path d="M12 10v4M12 17v.01"/>',
};

const svg = name => trusted(icon(name));
// Navigation glyphs for the sticky board: 2px round strokes with one solid accent each, drawn to sit inside an outlined
// tile (styles in controls.css). Other icons keep the thin set above.
const navPaths = {
  home: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5" fill="currentColor"/>',
  library: '<path d="M8 4h10a2 2 0 0 1 2 2v10"/><rect x="4" y="8" width="12" height="12" rx="2"/><path d="M7.5 12.5h5M7.5 16h3"/>',
  summaries: '<path d="M6 3.5h8l4.5 4.5v11a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 6 3.5z"/><path d="M14 3.5V8h4.5"/><path d="M8 12.5h7M8 16h5"/>',
  entities: '<path d="M12 12 6 6.5M12 12l6.5-3M12 12l-3 6.5"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/><circle cx="5.5" cy="6" r="2.2"/><circle cx="19" cy="8.5" r="2.2"/><circle cx="8.5" cy="19" r="2.2"/>',
  jobs: '<path d="M4.5 19.5 14 10"/><path d="m12.5 8.5 3 3"/><path d="M17.5 3.5v3M16 5h3M19.5 10.5v2.5M18.25 11.75h2.5M8.5 3.5v2.5M7.25 4.75h2.5"/>',
  connections: '<path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5z"/><path d="M8 10.5h8M8 13.5h5"/>',
  agents: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="m7.5 10 2.5 2-2.5 2M12.5 14.5H16"/>',
  tasks: '<rect x="5" y="4.5" width="14" height="16" rx="2"/><path d="M9.5 3.5h5v2.5h-5z" fill="currentColor"/><path d="m8 11.5 1.5 1.5 2.5-2.5M14 12h2.5M8 16.5l1.5 1.5 2.5-2.5M14 17h2.5"/>',
  models: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1" fill="currentColor"/><path d="M10 6.5v-3M14 6.5v-3M10 20.5v-3M14 20.5v-3M6.5 10h-3M6.5 14h-3M20.5 10h-3M20.5 14h-3"/>',
  storage: '<path d="M12 19.5s-7.5-4.4-7.5-10A4.2 4.2 0 0 1 12 7a4.2 4.2 0 0 1 7.5 2.5c0 5.6-7.5 10-7.5 10z"/><path d="M7 12.5h2.5l1.5-2.5 2 4 1.5-1.5H17"/>',
  usage: '<path d="M4 20h16"/><rect x="5.5" y="12" width="3" height="5" rx="1"/><rect x="10.5" y="7" width="3" height="10" rx="1" fill="currentColor"/><rect x="15.5" y="10" width="3" height="7" rx="1"/>',
  audit: '<path d="M5 5h9M5 9h6M5 13h4"/><circle cx="15" cy="15" r="4"/><path d="m18 18 2.5 2.5"/>',
  security: '<path d="M12 3.5 5 6v5.5c0 4.2 3 7.4 7 9 4-1.6 7-4.8 7-9V6z"/><circle cx="12" cy="11" r="1.8" fill="currentColor"/><path d="M12 12.8v2.7"/>',
};
const glyph = (name, cls) => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${navPaths[name] || paths[name] || paths.library}</svg>`;
export const icon = name => glyph(name, 'icon');
export const navIcon = name => glyph(name, 'icon nav-glyph');
const i18n = (t, key, tag = 'span') => html`<${trusted(tag)} data-i18n="${key}">${t(key)}</${trusted(tag)}>`;
const safeCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const rowsOf = rows => Array.isArray(rows)
  ? rows.map(r => ({value: String(r?.value ?? ''), count: safeCount(r?.count)})).filter(r => r.value && r.count !== null && r.count > 0)
  : [];
const fixed = n => Number(n.toFixed(2));
const preview = value => [...String(value ?? '')].slice(0, 160).join('');
/** "14 小时前" style time for lists; the exact local time stays in the title. */
export const relativeTime = value => {
  if (!value) return '—';
  const at = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value).getTime(), lang = globalThis.document?.documentElement?.lang || 'zh-CN';
  if (!Number.isFinite(at)) return '—';
  const s = Math.round((at - Date.now()) / 1000), rtf = new Intl.RelativeTimeFormat(lang, {numeric: 'auto'});
  for (const [unit, size] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]) if (Math.abs(s) >= size) return rtf.format(Math.round(s / size), unit);
  return rtf.format(s, 'second');
};
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

// Kind mix of active memories: at most six kinds plus 'none', so every record keeps its own colour.
const distributionCategories = insights => rowsOf(insights?.kinds);

/** Category mix: one stacked bar, each block a real category share of active memories in its category colour,
 * blocks separated by ink lines; the total sits beside it. Drawn in SVG (the page CSP allows no inline styles). */
function distribution(insights, t, labels = {}) {
  const cats = distributionCategories(insights), total = cats.reduce((n, c) => n + c.count, 0), W = 1000, H = 44;
  let x = 0;
  const segs = cats.map(c => { const w = c.count / total * W, seg = html`<rect class="mix-seg" data-group="${kindGroup(c.value)}" x="${fixed(x)}" y="0" width="${fixed(w)}" height="${H}"><title>${t(kindKey(c.value))} · ${c.count}</title></rect>`; x += w; return seg; });
  const cuts = cats.slice(1).map((c, i) => html`<line class="mix-cut" x1="${fixed(cats.slice(0, i + 1).reduce((n, d) => n + d.count / total * W, 0))}" x2="${fixed(cats.slice(0, i + 1).reduce((n, d) => n + d.count / total * W, 0))}" y1="0" y2="${H}"/>`);
  return html`<figure class="distribution${cats.length ? '' : ' is-empty'}"><div class="mix-head"><strong class="mix-total">${total}</strong><span data-i18n="activeMemories">${t('activeMemories')}</span></div>
    <svg class="mix-bar" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" data-i18n-aria-label="radarTitle" aria-label="${t('radarTitle')}" focusable="false">${segs}${cuts}</svg>
    ${cats.length ? '' : html`<figcaption class="radar-empty">${i18n(t, 'radarEmpty')}</figcaption>`}</figure>`;
}
function distributionLegend(insights, t, labels = {}) {
  const cats = distributionCategories(insights), total = cats.reduce((n, c) => n + c.count, 0);
  if (!cats.length) return '';
  return html`<ol class="radar-legend">${cats.map(c => html`<li class="mix-key" data-group="${kindGroup(c.value)}"><div class="legend-category"><i aria-hidden="true"></i><a href="/app/memories?kind=${KINDS.includes(c.value) ? c.value : 'none'}">${i18n(t, kindKey(c.value))}</a></div>
    <dl class="legend-stats"><div><dt>${i18n(t, 'distributionCount')}</dt><dd>${c.count}</dd></div><div><dt>${i18n(t, 'distributionShare')}</dt><dd>${Math.round(c.count / total * 100)}%</dd></div></dl></li>`)}</ol>`;
}

/** Secondary overview tools. The graph and live activity are rendered first by overviewStatus. */
export function overviewView(data, {t, memoryRows: rows = list => memoryRows(list, t), labels = {}, taxonomy = [], descriptions = {}}) {
  const count = key => safeCount(data.counts?.[key]) === null ? '—' : data.counts[key].toLocaleString();
  const metric = (key, title, href) => html`<a class="metric" href="${href}" data-metric="${key}">${i18n(t, title)}<strong>${count(key)}</strong></a>`;
  const stage = (href, glyphName, title, note, key) => html`<a class="processing-stage" href="${href}"><span class="stage-icon">${svg(glyphName)}</span><span class="stage-text">${i18n(t, title)}<small data-i18n="${note}">${t(note)}</small></span><strong>${count(key)}</strong></a>`;
  return String(html`<details class="overview-secondary" data-overview-library><summary>${i18n(t, 'overviewLibraryDetails')}<span class="overview-secondary-note">${i18n(t, 'overviewLibraryNote')}</span></summary><div class="overview-secondary-body"><section class="card radar-panel"><div class="radar-copy"><p class="eyebrow">${i18n(t, 'radarLabel')}</p>${i18n(t, 'radarTitle', 'h2')}${i18n(t, 'radarNote', 'p')}
      <form class="ask" action="/app/memories" method="get" role="search"><label class="sr-only" for="home-query" data-i18n="query">${t('query')}</label>${svg('search')}
        <input id="home-query" name="query" maxlength="2000" autocomplete="off" data-search-input data-i18n-placeholder="askPlaceholder" placeholder="${t('askPlaceholder')}"><kbd aria-hidden="true">/</kbd><button class="primary" type="submit" data-i18n="search">${t('search')}</button></form>
      </div>${distribution(data.insights, t, labels)}${distributionLegend(data.insights, t, labels)}</section>
  <div class="metrics">${metric('memories', 'memoryCount', '/app/memories')}${metric('sources', 'sourceCount', '/app/memories?focus=sources')}${metric('summaries', 'summaryCount', '/app/summaries')}${metric('jobs', 'jobCount', '/app/processing')}</div>
  <div class="home-grid">
    <section class="card stream"><header class="section-head">${i18n(t, 'recentStream', 'h2')}<a href="/app/memories">${i18n(t, 'openLibrary')}${svg('arrow')}</a></header>
      ${trusted(rows(data.recent || []))}${i18n(t, 'inspectMemoryNote', 'p')}</section>
    <aside class="pulse" data-i18n-aria-label="pulseTitle" aria-label="${t('pulseTitle')}">
      ${activityStrip(data.insights, t)}${typeBreakdown(data.insights, t)}
      <section class="pulse-block processing-card">${i18n(t, 'pipelineTitle', 'h3')}<div class="pipeline">
        ${stage('/app/memories', 'library', 'memoryCount', 'atomicNote', 'memories')}${stage('/app/summaries', 'summaries', 'summaryCount', 'derivedNote', 'summaries')}${stage('/app/processing', 'jobs', 'jobCount', 'jobStatusNote', 'jobs')}</div>
        <p class="privacy-note">${svg('security')}<span data-i18n="summaryBoundary">${t('summaryBoundary')}</span></p></section>
    </aside></div></div></details>`);
}

/** Category display name (older summaries only): an account-defined name, otherwise the translated built-in ID. */
export const categoryName = (t, labels, id) => (labels && typeof labels[id] === 'string' && labels[id]) || t(id);
// Writer-chosen kinds (agentmemory style). Each has its own colour group; records without a kind are 'none'.
export const KINDS = ['fact', 'preference', 'workflow', 'architecture', 'bug', 'pattern'];
const KIND_GROUP = {fact: 'fact', preference: 'pref', workflow: 'flow', architecture: 'proj', bug: 'bug', pattern: 'pat'};
export const KIND_OF_GROUP = Object.fromEntries(Object.entries(KIND_GROUP).map(([k, g]) => [g, k]));
export const kindGroup = kind => KIND_GROUP[kind] || 'none';
const kindKey = kind => KINDS.includes(kind) ? 'kind_' + kind : 'kind_none';
export const kindPill = (t, kind) => html`<span class="kind-pill" data-group="${kindGroup(kind)}">${i18n(t, kindKey(kind))}</span>`;
/** Strength 1–10 as a ten-step bar plus the figure; '—' when the writer gave none. Drawn in SVG (no inline styles). */
export const strengthMeter = (t, value) => Number.isInteger(value) ? html`<span class="strength" title="${t('strength')} ${value}/10"><svg viewBox="0 0 50 8" aria-hidden="true" focusable="false"><rect class="track" width="50" height="8" rx="2"/><rect class="fill" width="${value * 5}" height="8" rx="2"/></svg><b>${value}</b></span>` : html`<span class="muted">—</span>`;
export const SELECTION_LIMIT = 100;

/** Library: facets, filters, a four-column table, one organize toolbar and a pager. The detail opens in the side pane. */
export function libraryView(t, {data, query = '', searchMode = 'lexical', kind = '', concept = '', status = '', topic = '', origin = '', review = '', categories = [], labels = {}, facets, selected = [], selectAll = false, focusSources = false, readOnly = false, allowedActions = [], pagination = '', failure = null}) {
  const option = (value, key, current) => html`<option value="${value}"${value === current ? trusted(' selected') : ''} data-i18n="${key}">${t(key)}</option>`;
  const rows = failure ? [] : data.results || [];
  const chosen = new Set(selected);
  // Explicit selection never expands to a filter-wide model grant; completed steps are skipped by the preview.
  const batchActions = [['memory.batch_retract', 'batchRetract']].filter(([action]) => allowedActions.includes(action));
  const repair=allowedActions.includes('processing.preview');
  const selectable = (batchActions.length > 0||repair) && rows.some(m => m.status === 'active');
  const count = selectAll ? null : chosen.size;
  const selection = !failure && (selectable || selectAll) ? html`<div class="memory-selection" data-memory-selection${selectAll ? trusted(' data-select-all-active') : ''}>
    <p role="status" aria-live="polite">${selectAll ? i18n(t, 'allMatchingSelected') : html`${i18n(t, 'selectedMemories')} <strong data-selection-count>${count}</strong> / 50`}</p>
    <div class="actions">${batchActions.map(([action, label]) => html`<button type="button" data-console-action="${action}"${selectAll || !count ? trusted(' disabled') : ''}>${i18n(t, label)}</button>`)}${repair?['traits','summary','vector'].map(kind=>html`<button type="button" data-console-action="processing.preview" data-selection="true" data-kind="${kind}"${selectAll||!count?trusted(' disabled'):''}>${i18n(t,'processingRepair_'+kind)}</button>`):''}<button type="button" class="quiet" data-clear-selection${!count && !selectAll ? trusted(' disabled') : ''}>${i18n(t, 'clearSelection')}</button></div></div>` : '';
  // A topic already shown as the title is not repeated; an imported namespace topic is a labelled tag.
  const topicChip = m => m.title_source === 'topic' ? '' : m.tag ? tagChip(t, m.tag) : m.topic && !m.title ? html`<button type="button" class="topic-chip" data-facet="topic" data-value="${m.topic}">${m.topic}</button>` : '';
  // Tag row: the project, then the writer's concepts, then the task hand-off type when it is not the default fact.
  const projectChip = m => m.project_id ? html`<span class="project-chip" title="${m.project_id}">${svg('folder')}${m.project_name || m.project_id}</span>` : '';
  // A keyword filters the library to every memory carrying it (agentmemory-style concepts); the active one is marked.
  const conceptChips = m => (m.concepts || []).map(c => html`<button type="button" class="concept-chip" data-facet="concept" data-value="${c}"${c.toLowerCase() === concept.toLowerCase() ? trusted(' aria-pressed="true"') : ''}>${c}</button>`);
  const taskType = m => m.memory_type && m.memory_type !== 'fact' ? html`<span class="type-chip" data-type="${m.memory_type}"><span class="chip-label">${t('taskTypeTag')}</span>${t(m.memory_type)}</span>` : '';
  // Cleanup review (server memory/review.mjs): why a memory is listed.
  const reviewNote = m => m.review ? html`<small class="review-note">${m.review.strength !== null && m.review.strength <= 3 ? html`${i18n(t, 'strength')} ${m.review.strength} · ` : ''}${i18n(t, 'reviewCreated')} ${m.review.age_days} ${i18n(t, 'reviewDaysAgo')} · ${m.review.last_read_days === null ? i18n(t, 'reviewNeverRead') : html`${i18n(t, 'reviewLastRead')} ${m.review.last_read_days} ${i18n(t, 'reviewDaysAgo')}`}</small>` : '';
  const meta = m => html`${reviewNote(m)}${projectChip(m)}${conceptChips(m)}${taskType(m)}${topicChip(m)}${m.status && m.status !== 'active' ? statusTag(t, m.status) : ''}${m.imported ? html`<small class="import-note">${i18n(t, 'importedOrigin')}${m.original_created_at ? html` · ${i18n(t, 'originalDate')} <time>${formatDate(m.original_created_at)}</time>` : ''}</small>` : ''}`;
  const table = failure ? html`<div role="alert" data-search-failure>${i18n(t,'searchUnavailableTitle','h2')}${i18n(t,retrievalReasonKey(failure.degradation_code),'p')}${i18n(t,'searchFailureRetained','p')}<button type="button" data-retry>${i18n(t,'retry')}</button></div>`
    : rows.length ? html`<div class="table-scroll"><table class="memory-table"><colgroup><col class="col-content"><col class="col-category"><col class="col-state"><col class="col-date"></colgroup>
    <thead><tr><th>${i18n(t, 'memories')}</th><th>${i18n(t, 'kind')}</th><th>${i18n(t, 'strength')}</th><th>${i18n(t, 'updated')}</th></tr></thead>
    <tbody>${rows.map(m => html`<tr data-group="${kindGroup(m.kind)}"${chosen.has(m.memory_id) || (selectAll && m.status === 'active') ? trusted(' data-batch-selected') : ''}><td><div class="memory-content-cell">${selectable&&m.status==='active'?html`<input class="memory-select" type="checkbox" data-batch-memory="${m.memory_id}"${chosen.has(m.memory_id) || selectAll ? trusted(' checked') : ''}${selectAll ? trusted(' disabled') : ''} data-i18n-aria-label="selectMemory" aria-label="${t('selectMemory')}">`:''}<button type="button" class="memory-link" data-memory="${m.memory_id}">${memoryText(m)}${entityMatch(t,m)}</button></div><div class="memory-extra">${meta(m)}</div></td>
      <td>${kindPill(t, m.kind)}</td><td>${strengthMeter(t, m.strength)}</td><td class="memory-date"><time datetime="${m.updated_at || m.created_at || ''}" title="${formatDate(m.updated_at || m.created_at)}">${relativeTime(m.updated_at || m.created_at)}</time></td></tr>`)}</tbody></table></div>`
    : emptyState(t, query || kind || concept || topic || origin || (status && status !== 'all') ? 'emptyFiltered' : 'empty');
  const chips = [['review', review, review ? t('reviewChip') : ''], ['concept', concept, concept ? `${t('concepts')}：${concept}` : ''], ['topic', topic, topic], ['origin', origin, origin ? t(origin === 'imported' ? 'importedOrigin' : 'otherOrigin') : '']].filter(([, value]) => value);
  return String(html`<div class="library-layout"><div class="library-main"><p class="library-intro">${i18n(t, 'libraryIntro')}</p><form class="toolbar memory-filters" id="search-form" role="search">
    <label class="query-field"><span class="sr-only" data-i18n="query">${t('query')}</span><span class="query-input">${svg('search')}<input name="query" value="${query}" maxlength="2000" autocomplete="off" data-search-input data-i18n-placeholder="askPlaceholder" placeholder="${t('askPlaceholder')}"></span></label>
    <label class="filter-mode">${i18n(t, 'searchMode')}<select name="search_mode">${['lexical', 'hybrid', 'semantic'].map(v => option(v, v, searchMode))}</select></label>
    <label class="filter-category">${i18n(t, 'kind')}<select name="kind">${option('', 'allKinds', kind)}${[...KINDS, 'none'].map(v => option(v, kindKey(v), kind))}</select></label>
    <label class="filter-status">${i18n(t, 'status')}<select name="status">${['active', 'superseded', 'retracted'].map(v => option(v, v, status || 'active'))}${option('all', 'allStatuses', status)}</select></label>
    ${facets?.origins?.imported || origin ? html`<label class="filter-origin">${i18n(t, 'originFacet')}<select name="origin">${option('', 'allOrigins', origin)}${option('imported', 'importedOrigin', origin)}${option('other', 'otherOrigin', origin)}</select></label>` : ''}
    <div class="filter-actions"><button type="button" class="review-toggle" data-review-toggle aria-pressed="${review ? 'true' : 'false'}">${i18n(t, 'reviewToggle')}</button><button class="primary filter-submit" type="submit">${svg('search')}${i18n(t, 'search')}</button><button type="button" class="filter-reset quiet" data-reset-filters>${i18n(t, 'resetFilters')}</button></div></form>
  ${chips.length ? html`<div class="filter-chips">${chips.map(([facet, , label]) => html`<span class="filter-chip">${label}<button type="button" class="quiet" data-clear-facet="${facet}" data-i18n-aria-label="clearFilter" aria-label="${t('clearFilter')}">×</button></span>`)}</div>` : ''}
  <section class="card memory-library">${focusSources ? html`<p class="library-note">${i18n(t, 'inspectSourcesNote')}</p>` : ''}${review ? html`<p class="policy-box library-note">${i18n(t, 'reviewNote')}</p>` : ''}
    ${data.truncated || data.retrieval?.window_limited ? html`<p class="policy-box library-note">${i18n(t, 'boundedSearchNote')} (${data.retrieval?.candidate_limit})</p>` : ''}
    ${data.retrieval?.degraded?html`<p class="policy-box library-note" data-search-degraded>${i18n(t,'searchDegradedNote')} ${i18n(t,retrievalReasonKey(data.retrieval.degradation_code))}</p>`:''}
    ${data.retrieval?.alias_ambiguous?html`<p class="policy-box library-note">${i18n(t,'searchAliasAmbiguous')}</p>`:''}
    ${data.retrieval?.aliases?.truncated?html`<p class="policy-box library-note">${i18n(t,'entitySearchTruncated')}</p>`:''}
    ${data.retrieval?.aliases?.ambiguous?html`<p class="policy-box library-note">${i18n(t,'entitySearchAmbiguous')}</p>`:''}
    ${selection}<div id="memory-rows">${table}</div>
    ${failure?'':html`<div class="library-footer"><p>${rows.length} ${i18n(t, 'resultCount')}${readOnly ? html` · ${i18n(t, 'readOnly')}` : ''}</p>${trusted(pagination)}</div>`}</section>
</div></div>`);
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
  return html`<span class="summary-scope">${levels.map(([level, name, id], index) => html`${index ? ' › ' : ''}${i18n(t, `summaryScope_${level}`)} ${name && scope[name] ? html`<span class="summary-name">${scope[name]}</span>` : html`<code title="${scope[id]}">${String(scope[id]).length > 16 ? String(scope[id]).slice(0, 8) + '…' : scope[id]}</code>`}`)}</span>`;
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

// Plain text only: the controller assigns this to textContent, never innerHTML. Keep a readable
// scope and date in the pane title so opening an original and returning does not lose orientation.
export function summaryDetailTitle(t, data) {
  const {scope, window} = data.context || {};
  const names = SCOPE_LEVELS.filter(([, , id]) => scope?.[id]).map(([level, name, id]) =>
    name && scope[name] ? String(scope[name]) : `${t(`summaryScope_${level}`)} ${String(scope[id]).slice(0, 8)}…`);
  const label = names.length ? names.join(' › ') : t(`summaryScope_${scope?.kind === 'user' ? 'user' : 'unknown'}`);
  return [label, window?.local_start, t(window ? `summaryPeriod_${window.period}` : 'summaryWindowUnknown')].filter(Boolean).join(' · ');
}

const summarySourceCounts = s => {
  const total = safeCount(s.dependency_count ?? s.coverage), omitted = safeCount(s.omitted_source_count ?? s.omitted);
  return {total, omitted, selected: safeCount(s.selected_source_count) ?? (total !== null && omitted !== null ? Math.max(0, total - omitted) : null)};
};
function summaryCoverage(t, s) {
  const {total, selected, omitted} = summarySourceCounts(s);
  return html`<span>${i18n(t, 'summaryReaderCitedSources')} <b>${selected ?? '—'}</b>${total !== null ? html` / ${total}` : ''}</span>${omitted ? html`<span class="summary-coverage-warning">${omitted} ${i18n(t, 'summaryReaderNotCited')}</span>` : ''}`;
}

// A preview is never a generated narrative: keep source boundaries returned by the validated
// read path. Older servers' single preview is still readable, but is labelled as a preview only.
function summaryListPreview(t, s) {
  if (s.status !== 'current') return '';
  const excerpts = Array.isArray(s.preview?.excerpts) ? s.preview.excerpts.filter(c => typeof c?.quote === 'string' && c.quote).slice(0, 3) : [];
  if (excerpts.length) return html`<span class="summary-preview-label">${i18n(t, 'summaryReaderPreview')}</span><span class="summary-preview-lines">${excerpts.map(c => html`<span class="summary-preview-quote">${c.quote}${c.quote_complete === false ? html`<span class="summary-preview-ellipsis" aria-label="${t('summaryReaderPreviewTruncated')}">…</span>` : ''}</span>`)}</span>`;
  return s.preview?.text ? html`<span class="summary-preview-label">${i18n(t, 'summaryReaderPreview')}</span><span class="summary-preview">${s.preview.text}</span>`
    : html`<span class="summary-preview is-empty">${i18n(t, 'summaryPreviewOpen')}</span>`;
}

/** Summaries (agentmemory "crystals"-style): grouped by what they cover — a project, task, session or all memories —
 * and within a group one row per period (daily / weekly), newest first. Summaries written before types keep a small
 * note of the category they were split by. Internal IDs fold into the row's technical details. */
const scopeGroup = scope => scope?.kind === 'session' ? 'flow' : ['project', 'task', 'workstream'].includes(scope?.kind) ? 'proj' : 'none';
export function summariesView(t, {data, pagination = '', labels = {}}) {
  const summaries = data.summaries || [];
  const row = (s, showTimezone = false) => {
    const ids = scopeIds(s.scope), omitted = safeCount(s.omitted), legacy = s.category && s.category !== 'all';
    const facts = html`<span class="summary-facts">${summaryCoverage(t, s)}${legacy ? html`<span class="summary-legacy">${i18n(t, 'summaryLegacyCategory')} ${categoryName(t, labels, s.category)}</span>` : ''}</span>`;
    const body = html`<span class="summary-title"><span class="period-pill" data-period="${s.window?.period || 'unknown'}">${s.window ? i18n(t, `summaryPeriod_${s.window.period}`) : i18n(t, 'summaryWindowUnknown')}</span>${s.window ? html`<span class="summary-window">${s.window.period === 'weekly' ? html`${i18n(t, 'summaryWeekFrom')} ` : ''}<time>${s.window.local_start || '—'}</time>${showTimezone ? html` <span class="summary-tz">(${s.window.timezone || '—'})</span>` : ''}</span>` : ''}</span>${summaryListPreview(t, s)}${facts}${s.status === 'current' ? html`<span class="summary-read-link">${i18n(t, s.preview?.more ? 'summaryReaderOpenFull' : 'summaryReaderRead')}${svg('arrow')}</span>` : ''}`;
    const technical = html`<details class="summary-technical"><summary>${i18n(t, 'summaryReaderInformation')}</summary><div class="summary-technical-body"><span>${i18n(t, 'revisions')} ${s.revision}</span>${s.window?.timezone ? html`<span class="summary-tz">${i18n(t, 'summaryReaderTimezone')} ${s.window.timezone}</span>` : ''}${omitted ? html`<span>${i18n(t, 'summaryOmitted')} ${omitted}</span>` : ''}<small class="summary-id">${ids.length ? html`${i18n(t, 'summaryScopeIds')} <code>${ids.join(' / ')}</code><br>` : ''}${i18n(t, 'summaryId')} <code>${s.summary_id}</code></small></div></details>`;
    return html`<li class="summary-row" data-group="${scopeGroup(s.scope)}" data-summary-state="${s.status}">${s.status === 'current'
      ? html`<div class="summary-main"><button type="button" class="memory-link" data-summary="${s.summary_id}" data-revision="${s.revision}">${body}</button>${technical}</div>`
      : html`<div class="summary-main"><div class="memory-link">${body}<small>${i18n(t, 'summaryNotCurrent')} · <a href="/app/memories">${i18n(t, 'browseMemories')}</a></small></div>${technical}</div>`}<span class="tag lifecycle-tag" data-status="${s.status === 'current' ? 'active' : 'superseded'}">${t(s.status)}</span></li>`;
  };
  // Groups keep the order in which their newest summary appears on this page.
  const groups = new Map();
  for (const s of summaries) { const key = JSON.stringify([s.scope?.kind || 'unknown', ...scopeIds(s.scope)]); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(s); }
  const section = list => {
    const current = list.filter(s => s.status === 'current'), history = list.filter(s => s.status !== 'current');
    const mixedTimezones = new Set(list.map(s => s.window?.timezone || '')).size > 1;
    return html`<section class="summary-group" data-group="${scopeGroup(list[0].scope)}"><header class="summary-group-head"><h2 class="summary-group-title">${summaryScope(t, list[0].scope)}</h2><small>${list.length} ${i18n(t, 'summaryGroupCount')}</small></header>${current.length ? html`<ol class="summary-list">${current.map(s => row(s, mixedTimezones))}</ol>` : ''}${history.length ? html`<details class="summary-history"><summary>${i18n(t, 'summaryReaderHistory')} <span>${history.length}</span></summary><p>${i18n(t, 'summaryReaderHistoryNote')}</p><ol class="summary-list">${history.map(s => row(s, mixedTimezones))}</ol></details>` : ''}</section>`;
  };
  return String(html`<div class="summary-library"><section class="list-panel">${summaries.length ? html`<div class="summary-page-heading"><span>${summaries.length} ${i18n(t, 'summaryReaderOnPage')}</span>${data.next_offset != null || Number(data.offset) > 0 ? i18n(t, 'summaryReaderPageNote', 'small') : ''}</div><div class="summary-groups">${[...groups.values()].map(section)}</div>` : emptyState(t)}${trusted(pagination)}</section></div>`);
}

// Audit (AUD-01/02, Console item 7). One stream at a time with its own paging. Event details show one labelled row
// per object by name; every recorded ID (target, query results, connection, credential, event) is listed once, labelled,
// under the folded technical details. Titles, labels and connection state are current (explained once above the timeline).
const auditMemory = (t, id, memories) => {
  const m = Object.hasOwn(memories,id)?memories[id]:null;
  return m ? html`<button type="button" class="audit-memory" data-memory="${id}">${m.title || i18n(t,'auditMemoryUnavailable')}</button>` : html`<span class="audit-memory unavailable">${i18n(t, 'auditMemoryUnavailable')}</span>`;
};
const auditId = (t, id) => html`<span class="audit-id"><code>${id}</code><button type="button" data-audit-copy="${id}" aria-label="${t('copy')}: ${id}">${i18n(t,'copy')}</button></span>`;
const auditRow = (t, key, value) => html`<div class="audit-row"><dt>${i18n(t, key)}</dt><dd>${value}</dd></div>`;
const muted = (t, key) => html`<span class="muted">${i18n(t, key)}</span>`;
const connectionKinds = {chatgpt_oauth:'connChatGPT', generic_mcp:'connGeneric', agent_placeholder:'connAgent'};
function auditConnection(t, conn) {
  if (conn.type === 'system') return i18n(t, conn.purpose === 'web' ? 'auditSystemWeb' : conn.purpose==='console'?'auditSystemConsole':'unknown');
  if (conn.type !== 'personal') return muted(t, 'auditConnectionUnmapped');
  if (conn.missing) return muted(t, 'auditConnectionMissing');
  const kind = connectionKinds[conn.kind] ? i18n(t, connectionKinds[conn.kind]) : conn.kind;
  return html`<strong>${conn.label}</strong> · ${kind} · ${t(conn.state)} · ${i18n(t, 'auditCredentialVersion')} ${conn.credential_version}`;
}
// technical: [labelKey, value, copyable] rows; IDs are copyable, issuance identifiers are not.
const auditDetail = (t, rows, technical) => html`<dl class="audit-facts">${rows}</dl>${technical.length ? html`<details class="audit-technical"><summary>${i18n(t, 'auditTechnical')}</summary><dl class="audit-facts">${technical.map(([key, value, copy]) =>
  auditRow(t, key, Array.isArray(value) ? html`<span class="audit-id-list">${value.map(id => auditId(t, id))}</span>` : copy ? auditId(t, value) : html`<code>${value}</code>`))}</dl></details>` : ''}`;
function auditCoreDetail(t, e, data) {
  const memories = data.memories || {}, q = e.query, credentials = data.credentials || {};
  const c = e.credential_id && Object.hasOwn(credentials, e.credential_id) ? credentials[e.credential_id] : null, conn = c?.connection;
  const memoryTarget = e.target_type === 'memory' && e.target_id;
  const rows = [auditRow(t, 'auditActionLabel', html`<code>${e.action}</code>`)];
  if (memoryTarget) rows.push(auditRow(t, 'auditMemoryLabel', auditMemory(t, e.target_id, memories)));
  else if (e.target_id) rows.push(auditRow(t, 'auditTarget', e.target_type || t('unknown')));
  if (conn) rows.push(auditRow(t, 'auditConnectionLabel', auditConnection(t, conn)));
  rows.push(auditRow(t, 'auditCredential', !e.credential_id ? muted(t, 'auditActorUnknown')
    : c ? html`${c.label}${c.revoked ? html` <span class="tag">${i18n(t, 'auditRevokedNow')}</span>` : ''}` : muted(t, 'auditCredentialGone')));
  // Search result titles are listed above the details; their IDs follow in the same order. The instance is omitted
  // when it only repeats the connection ID.
  const instance = c?.agent_instance_id && !(conn?.connection_id && c.agent_instance_id === 'connection-' + conn.connection_id) ? c.agent_instance_id : null;
  const technical = [[memoryTarget ? 'auditMemoryId' : 'auditTargetId', e.target_id, true], ['auditResultIds', q?.result_refs?.length ? q.result_refs : null],
    ['auditConnectionId', conn?.type === 'personal' ? conn.connection_id : null, true], ['auditCredentialId', e.credential_id, true], ['auditEventId', e.audit_id, true],
    ['agentId', c?.agent_id], ['agentInstance', instance], ['deviceId', c?.device_id]].filter(([, v]) => v);
  return auditDetail(t, rows, technical);
}
export function auditView(t, {data = {}, source = 'core', group='memory', pagination = '', filters = {}}) {
  const entries=data.entries||[],active=Object.values(filters).filter(Boolean).length;
  const tab=(key)=>html`<button type="button" data-audit-group="${key}" aria-pressed="${String(group===key)}">${i18n(t,'auditGroup_'+key)}</button>`;
  const tabs=html`<div class="view-switch audit-sources" role="group" aria-label="${t('auditSource')}">${['system','memory','connections','security','config'].map(tab)}</div>`;
  // Configuration changes have their own table (actions.mjs configHistoryCard); only the tabs are drawn here.
  if(group==='config')return String(html`<div class="audit-toolbar">${tabs}</div>`);
  // One toolbar row: the tabs, and the filter toggle on the right. The toggle stays where it is; its form is the next
  // element and shows as a full row below while the toggle is open. The scope note sits under the timeline title.
  return String(html`<div class="audit-toolbar">${tabs}
    <details class="audit-filter-panel" ${active?trusted('open'):''}><summary>${i18n(t,'filterAudit')}${active?html` <small>(${active})</small>`:''}</summary></details>
    <form id="audit-filter" class="audit-filters">${[['action','auditAction'],['outcome','auditOutcome']].map(([key,label])=>html`<label>${i18n(t,label)}<input name="${key}" type="text" value="${filters[key]||''}" maxlength="100"></label>`)}
    ${[['from','auditFrom'],['to','auditTo']].map(([key,label])=>html`<label>${i18n(t,label)}<span class="audit-date-field"><input id="audit-${key}" name="${key}" type="text" autocomplete="off" placeholder="YYYY-MM-DD HH:mm" value="${auditLocalValue(filters[key])}" aria-describedby="audit-zone"><button type="button" data-audit-date="audit-${key}" aria-label="${t(label)} · ${t('auditCalendar')}" aria-haspopup="dialog" aria-expanded="false"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4m8-4v4m-9 8h3m4 0h3"/></svg></button></span></label>`)}
    <button type="submit">${i18n(t,'applyFilters')}</button><small id="audit-zone" class="audit-filter-zone">${i18n(t,'auditLocalTime')} ${Intl.DateTimeFormat().resolvedOptions().timeZone}</small></form></div>
    <section class="card"><header class="section-head">${i18n(t,'auditTimeline','h2')}<button type="button" class="refresh-button" data-retry>${i18n(t,'refresh')}</button></header>
    <p class="muted audit-scope">${i18n(t,'auditGroupNote')} ${i18n(t,'auditCurrentNote')}</p>${!entries.length?emptyState(t):''}
    ${data.memory_titles_truncated?html`<p class="muted">${i18n(t,'auditTitlesTruncated')}</p>`:''}
    <ol class="timeline audit-timeline">${entries.map(e=>{
      const core=(e.source||source)==='core',date=core?e.created_at:e.created,stamp=new Date(typeof date==='number'?date*1000:date);
      const target=core&&e.target_type==='memory'&&e.target_id,label=e.action==='memory.query'?'auditMemorySearch':e.kind==='read'?'auditMemoryRead':'auditMemoryWrite';
      return html`<li class="timeline-item" data-outcome="${e.outcome||''}" data-kind="${e.kind||'other'}"><span class="timeline-dot" aria-hidden="true"></span><div>
      <div class="audit-event-title"><strong>${target||e.action==='memory.query'?i18n(t,label):e.action}</strong>${target?auditMemory(t,e.target_id,data.memories||{}):''}</div>
      <span class="memory-meta"><span class="tag">${i18n(t,'auditKind_'+(['read','write','auth','credential'].includes(e.kind)?e.kind:'other'))}</span><span class="tag outcome-tag" data-outcome="${e.outcome||''}">${e.outcome?t(e.outcome):'—'}</span><time datetime="${Number.isFinite(stamp.getTime())?stamp.toISOString():''}">${formatDate(date)}</time>${e.unclassified?html`<span class="tag">${i18n(t,'auditUnclassified')}</span>`:''}</span>
      ${core&&e.query?html`<p class="audit-query-note">${!Array.isArray(e.query.result_refs)?i18n(t,'auditRefsNotRecorded'):html`${i18n(t,'auditLexicalRefs')} ${e.query.result_refs.length?e.query.result_refs.map(id=>auditMemory(t,id,data.memories||{})):i18n(t,'auditRefsEmpty')} ${e.query.result_refs_truncated?i18n(t,'auditRefsTruncated'):''}`}</p>`:''}
      <details class="audit-event-details"><summary>${i18n(t,'auditDetails')}</summary><div class="audit-details-content">${core?auditCoreDetail(t,e,data):auditDetail(t,[auditRow(t,'auditActionLabel',html`<code>${e.action}</code>`),auditRow(t,'auditActor',muted(t,'auditIdentityActor'))],e.audit_id?[['auditEventId',e.audit_id,true]]:[])}</div></details>
      </div></li>`;
    })}</ol>${trusted(pagination)}</section>`);
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
    ['taskTypeTag', typeChip(t, m.memory_type || 'fact')],
    ['kind', kindPill(t, m.kind)],
    ['strength', strengthMeter(t, m.strength)],
    ...(m.concepts?.length ? [['concepts', html`<span class="concept-row">${m.concepts.map(c => html`<a class="concept-chip" href="/app/memories?concept=${encodeURIComponent(c)}">${c}</a>`)}</span>`]] : []),
    ['status', statusTag(t, m.status || 'active')],
    ['revisions', html`<span class="figure">${data.revision}</span>`],
    ...(origin ? [['originFacet', html`${i18n(t, ORIGIN_KEYS[origin.kind] || 'originAgent')}${origin.original_created_at ? html` · ${i18n(t, 'originalDate')} <time>${formatDate(origin.original_created_at)}</time>` : ''}`]] : []),
    ...(meta?.tag ? [['originalTag', html`<code class="tag-value">${meta.tag}</code><small class="muted">${i18n(t, 'originalTagNote')}</small>`]] : []),
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
  <section class="policy-box" data-memory-processing>${i18n(t,'processingEvidenceTitle','h3')}${i18n(t,'loading','p')}</section>
  <section class="version-chain" data-version-chain="${m.memory_id}">${i18n(t, 'versionChain', 'h3')}${links.length ? html`<p class="muted" role="status">${i18n(t, 'versionChainLoading')}</p>` : html`<p class="muted">${i18n(t, 'versionChainSingle')}</p>`}</section>
  ${links.length ? html`<div class="lifecycle-links">${links.map(([id, key]) => html`<button type="button" class="quiet" data-memory="${id}">${i18n(t, key)}</button>`)}</div>` : ''}
  <section class="detail-sources">${i18n(t, 'sources', 'h3')}${sources.length ? html`<ol class="source-list">${sources.map(s => html`<li class="detail-source"><strong>${s.source_kind || s.source_id}</strong><code>${s.source_id}</code>
    <details><summary>${i18n(t, 'sourceMetadata')}</summary><pre>${JSON.stringify(s, null, 2)}</pre></details></li>`)}</ol>` : emptyState(t)}
    ${data.next_source_request ? html`<button type="button" data-source-next>${i18n(t, 'nextSources')}</button>` : ''}</section>`);
}

/** Version chain in the detail pane: the correction lineage, newest first (each correction is a replacement record).
 * Every version except the first can show what it changed; any other version opens as its own record. */
export function versionChainView(t, chain = [], {truncated = false, current = ''} = {}) {
  if (!chain.length) return String(html`${i18n(t, 'versionChain', 'h3')}<p class="muted">${i18n(t, 'versionChainEmpty')}</p>`);
  const total = chain.length;
  return String(html`${i18n(t, 'versionChain', 'h3')}<ol class="version-chain-list">${chain.map((v, i) => html`<li class="version-step${i ? '' : ' is-current'}${v.memory_id === current ? ' is-open' : ''}"><span class="version-dot" aria-hidden="true"></span><div>
    <p class="version-head">${i18n(t, 'versionNumber')} ${truncated ? '…' : ''}${total - i} ${i18n(t, 'versionNumberSuffix')} · <time>${formatDate(v.created_at)}</time> · ${t(v.status)}</p>${v.reason ? html`<p class="version-reason">${v.reason}</p>` : ''}
    <div class="version-actions">${i < total - 1 ? html`<button type="button" class="quiet" data-version-change="${i}" data-before="${chain[i + 1].memory_id}" data-before-revision="${chain[i + 1].revision}" data-after="${v.memory_id}" data-after-revision="${v.revision}" aria-expanded="false">${i18n(t, 'versionShowChange')}</button>` : ''}${v.memory_id !== current ? html`<button type="button" class="quiet" data-memory="${v.memory_id}">${i18n(t, 'versionOpen')}</button>` : ''}</div>
    ${i < total - 1 ? html`<div class="version-diff" data-version-diff="${i}" hidden></div>` : ''}</div></li>`)}</ol>${truncated ? i18n(t, 'latestTenVersions', 'p') : ''}`);
}

// Groups are local to the returned page, not a claim of whole-summary coverage. Never merge
// quotations from different sources or revisions. Only byte-exact duplicates with the same
// validated source range and pagination coordinates may share a displayed paragraph.
function summarySourceGroups(claims) {
  const groups = new Map();
  for (const [index, claim] of claims.entries()) {
    const key = JSON.stringify([claim.memory_id, claim.revision]);
    if (!groups.has(key)) groups.set(key, {memory_id: claim.memory_id, revision: claim.revision, entries: [], seen: new Map(), duplicates: 0});
    const group = groups.get(key), validRange = typeof claim.memory_id === 'string' && Number.isSafeInteger(claim.revision) && claim.revision > 0
      && Number.isSafeInteger(claim.start) && claim.start >= 0 && Number.isSafeInteger(claim.end) && claim.end >= claim.start;
    const signature = validRange ? JSON.stringify([claim.start, claim.end, claim.quote, claim.quote_offset ?? 0, claim.quote_length ?? null, claim.quote_complete ?? true]) : null;
    if (signature !== null && group.seen.has(signature)) {
      group.seen.get(signature).duplicates++;group.duplicates++;continue;
    }
    const entry = {claim, index, duplicates: 0};group.entries.push(entry);
    if (signature !== null) group.seen.set(signature, entry);
  }
  return [...groups.values()];
}

export function summaryDetailView(t, data, {canGoBack = false, tools = ''} = {}) {
  const summary = data.results?.[0] || {claims: []}, current = !summary.status || summary.status === 'current';
  const claims = current && Array.isArray(summary.claims) ? summary.claims : [], groups = summarySourceGroups(claims);
  const counts = {...data.context, ...summary}, omitted = summarySourceCounts(counts).omitted;
  const continued = safeCount(summary.claim_offset) > 0 || claims.some(c => safeCount(c.quote_offset) > 0);
  const sourceGroup = (group, index) => html`<li class="detail-source summary-source-group">
    <header class="summary-source-head"><h3>${i18n(t, 'summaryReaderSource')} ${index + 1}</h3><small>${group.entries.length} ${i18n(t, 'summaryReaderQuotes')}</small></header>
    <ol class="summary-excerpts">${group.entries.map(({claim, duplicates}) => html`<li>${safeCount(claim.quote_offset) > 0 ? i18n(t, 'summaryReaderContinuedQuote', 'p') : ''}<blockquote class="summary-excerpt"><p class="body-content">${claim.quote}</p></blockquote>${claim.quote_complete === false ? html`<p class="summary-quote-boundary">${i18n(t, 'summaryReaderExcerptPartial')}</p>` : ''}${duplicates ? html`<small class="summary-duplicate-note">${i18n(t, 'summaryReaderDuplicate')} ${duplicates}</small>` : ''}</li>`)}</ol>
    <button type="button" class="quiet summary-source-open" data-memory="${group.memory_id}" data-revision="${group.revision}" aria-label="${t('summaryOpenSource')} · ${t('summaryReaderSource')} ${index + 1}">${svg('source')}${i18n(t, 'summaryOpenSource')}</button>
  </li>`;
  return String(html`<article class="summary-reader">
    <header class="summary-detail-facts"><div class="summary-reader-scope">${summaryScope(t, data.context?.scope)}</div>${summaryWindow(t, data.context?.window)}<div class="summary-reader-coverage">${summaryCoverage(t, counts)}</div></header>
    ${current ? html`<p class="summary-reader-boundary">${i18n(t, 'summaryReaderBoundary')}</p>${omitted ? html`<p class="summary-reader-warning">${i18n(t, 'summaryReaderOmittedNote')}</p>` : ''}${summary.coverage_basis === 'authorized_batch' ? html`<p class="summary-reader-warning">${i18n(t, 'summaryReaderBatchNote')}</p>` : ''}` : html`<p class="summary-reader-warning" role="status">${i18n(t, 'summaryNotCurrent')}</p>`}
    ${claims.length ? html`<div class="summary-reading-progress">${continued ? i18n(t, 'summaryReaderContinued') : i18n(t, 'summaryReaderPageContent')}<span>${groups.reduce((n, group) => n + group.entries.length, 0)} ${i18n(t, 'summaryReaderQuotes')} · ${groups.length} ${i18n(t, 'summaryReaderSourceCount')}</span></div><ol class="claim-list summary-source-groups">${groups.map(sourceGroup)}</ol>` : emptyState(t)}
    <p class="summary-reader-completion" role="status">${i18n(t, data.next_request && current ? 'summaryReaderMore' : data.complete && current ? 'summaryReaderEnd' : 'summaryReaderIncomplete')}</p>
    <nav class="pagination summary-reader-navigation" aria-label="${t('summaryReaderNavigation')}">${canGoBack ? html`<button type="button" data-detail-back>${svg('back')}${i18n(t, 'previous')}</button>` : html`<button type="button" data-close>${svg('back')}${i18n(t, 'backToList')}</button>`}${data.next_request && current ? html`<button type="button" data-detail-next>${i18n(t, 'summaryReaderNext')}${svg('arrow')}</button>` : ''}</nav>
    <details class="summary-reader-tools"><summary>${i18n(t, 'summaryReaderTools')}</summary><div class="summary-reader-tools-body"><div class="summary-facts"><span>${i18n(t, 'revisions')} ${summary.revision ?? '—'}</span>${summary.category && summary.category !== 'all' ? html`<span>${i18n(t, 'summaryLegacyCategory')} ${t(summary.category)}</span>` : ''}</div><small class="summary-id">${i18n(t, 'summaryId')} <code>${summary.summary_id || '—'}</code>${scopeIds(data.context?.scope).length ? html`<br>${i18n(t, 'summaryScopeIds')} <code>${scopeIds(data.context.scope).join(' / ')}</code>` : ''}</small>
      ${groups.length ? html`<ol class="summary-provenance">${groups.map((group, index) => html`<li><strong>${i18n(t, 'summaryReaderSource')} ${index + 1}</strong><code>${group.memory_id}</code><span>${i18n(t, 'revisions')} ${group.revision}</span><ul>${group.entries.map(({claim, duplicates}) => html`<li>${i18n(t, 'summaryReaderRange')} <code>${claim.start ?? '—'}–${claim.end ?? '—'}</code>${safeCount(claim.quote_offset) > 0 || claim.quote_complete === false ? html` · ${i18n(t, 'summaryReaderFragment')} <code>${claim.quote_offset ?? 0} / ${claim.quote_length ?? '—'}</code>` : ''}${duplicates ? html` · ${i18n(t, 'summaryReaderDuplicate')} ${duplicates}` : ''}</li>`)}</ul></li>`)}</ol>` : ''}${tools ? html`<div class="summary-quality-tools">${trusted(tools)}</div>` : ''}</div></details>
  </article>`);
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
    {id: 'OVW-04', status: 'live', read: ['attention', 'projects']},
  ],
  memories: [
    {id: 'MEM-01', status: 'live', read: ['memories']},
    {id: 'MEM-02', status: 'live', read: ['memory', 'memory-meta']},
    {id: 'MEM-03', status: 'live', write: ['memory.create']},
    {id: 'MEM-04', status: 'live', write: ['memory.correct', 'memory.retract']},
    {id: 'MEM-05', status: 'live', read: ['memories'], write: ['memory.correct']},
    {id: 'MEM-06', status: 'live', read: ['memories'], write: ['memory.batch_retract']},
    {id: 'MEM-07', status: 'live', read: ['memory-versions']},
    {id: 'MEM-08', status: 'live', read: ['memories']},
    {id: 'MEM-09', status: 'live', read: ['review-candidates'], write: ['review.extract', 'review.candidate'], reauth: true},
    {id: 'MEM-10', status: 'live', read: ['memory-review'], write: ['review.verify', 'review.resolve'], reauth: true},
    {id: 'MEM-11', status: 'live', read: ['memory-processing'], write: ['processing.preview', 'processing.start']},
    {id: 'MEM-12', status: 'live', read: ['search-feedback'], write: ['search.feedback']},
  ],
  summaries: [
    {id: 'SUM-01', status: 'live', read: ['summaries', 'summary']},
    {id: 'SUM-02', status: 'live', write: ['jobs.schedule']},
    {id: 'SUM-03', status: 'live', read: ['summaries']},
    {id: 'SUM-04', status: 'live', read: ['summary-quality'], write: ['review.summary']},
  ],
  jobs: [
    {id: 'JOB-01', status: 'live', read: ['jobs', 'job']},
    {id: 'JOB-02', status: 'live', write: ['jobs.schedule']},
    {id: 'JOB-03', status: 'live', write: ['jobs.cancel', 'jobs.retry']},
    {id: 'JOB-04', status: 'live', read: ['system-health', 'models'], write: ['features.save']},
    {id: 'JOB-05', status: 'live', read: ['system-health'], write: ['processing.preview', 'processing.start', 'processing.pause', 'processing.resume', 'processing.cancel']},
    {id: 'JOB-06', status: 'live', read: ['system-health'], write: ['schedule.save']},
  ],
  connections: [
    {id: 'CON-01', status: 'live', read: ['connections'], write: ['oauth.revoke']},
    {id: 'CON-02', status: 'live', read: ['connections'],
      write: ['connections.create', 'connections.update', 'connections.rotate', 'connections.disable', 'connections.enable', 'connections.revoke']},
    {id: 'CON-03', status: 'live', read: ['system-health'], write: ['features.save']},
    {id: 'AGT-01', status: 'live', read: ['connections'], write: ['devices.revoke'], reauth: true},
    {id: 'AGT-02', status: 'live', read: ['capture-status'], core: ['GET /v1/status'], scope: ['memory:read']},
    {id: 'AGT-03', status: 'live', write: ['devices.register', 'devices.rotate'], core: ['POST /v1/agent-instances/register', 'POST /v1/agent-instances/{id}/rotate-key'],
      scope: ['admin:devices'], reauth: true},
    {id: 'AGT-04', status: 'live', read: ['system-health'], write: ['features.save']},
  ],
  tasks: [
    {id: 'TSK-01', status: 'live', read: ['projects', 'metadata-values', 'project-context'], write: ['projects.update', 'projects.archive', 'projects.restore', 'projects.lifecycle_preview', 'projects.lifecycle_delete', 'projects.lifecycle_restore', 'projects.merge']},
    {id: 'TSK-02', status: 'live', read: ['task-branches', 'task-detail', 'project-profile', 'metadata-values'], write: ['tasks.update'], core: ['POST /v1/task-branches/preview'], scope: ['resume:read'],
      ui: {table: ['taskTitle', 'sourceBranch', 'lastCheckpoint', 'state']}},
    {id: 'TSK-03', status: 'live', read: ['project-context'], core: ['POST /v1/project-context/preview'], scope: ['resume:read'],
      ui: {form: ['select:project'], submit: 'generatePreview'}},
    {id: 'TSK-04', status: 'live', read: ['task-checkpoints'], core: ['GET /v1/tasks/{task_id}/checkpoints', 'GET /v1/tasks/{task_id}/canonical-revisions'],
      scope: ['memory:read', 'task:reconcile:read'], ui: {table: ['checkpoint', 'sources', 'created']}},
    {id: 'TSK-05', status: 'live', read: ['task-workflow-preview'], write: ['projects.bootstrap_preview', 'projects.bootstrap_confirm', 'tasks.bootstrap_preview', 'tasks.bootstrap_confirm'], core: ['POST /v1/console/action', 'GET /v1/console/task-workflow-preview'], reauth: true,
      scope: ['console:write'], ui: {actions: ['newProject', 'newTask']}},
    {id: 'TSK-06', status: 'live', read: ['task-reconciliation', 'task-workflow-preview'], write: ['tasks.reconciliation_preview', 'tasks.reconciliation_resolve'], reauth: true,
      core: ['POST /v1/console/action', 'GET /v1/console/task-workflow-preview'], scope: ['console:write'],
      ui: {table: ['taskTitle', 'proposal', 'state'], actions: ['runReconciliation']}},
    {id: 'TSK-07', status: 'live', read: ['resume-targets', 'task-branches', 'resume-status'], write: ['resume.preview'], core: ['POST /v1/console/action', 'GET /v1/console/resume-targets'], scope: ['console:write'],
      ui: {form: ['select:project', 'select:task', 'select:sourceBranch'], submit: 'previewResume'}},
    {id: 'TSK-08', status: 'live', read: ['resume-status', 'resume-history'], write: ['resume.confirm'], core: ['POST /v1/console/action'], scope: ['console:write'], reauth: true,
      ui: {actions: ['confirmResume']}},
    {id: 'TSK-09', status: 'live', read: ['resume-status', 'resume-history'], core: ['GET /v1/console/resume-status'],
      scope: ['console:read', 'resume:read'], ui: {table: ['resumeId', 'targetAgent', 'deliveryState', 'completionAck']}},
    {id: 'TSK-10', status: 'live', read: ['resume-history'], scope: ['console:read', 'resume:read'], ui: {table: ['created', 'taskTitle', 'state']}},
  ],
  models: [
    {id: 'MOD-01', status: 'live', read: ['models'], write: ['models.save', 'models.disable']},
    {id: 'MOD-02', status: 'live', write: ['models.test']},
    {id: 'MOD-03', status: 'live', write: ['vector.schedule']},
    // Moved from the retired usage page: call history and quota use sit next to the call limits.
    {id: 'USE-01', status: 'live', read: ['model-usage']},
    {id: 'USE-02', status: 'live', read: ['model-usage']},
    {id: 'MOD-04', status: 'live', read: ['model-usage'], write: ['models.quota']},
  ],
  storage: [
    {id: 'STO-01', status: 'live', read: ['export'], write: ['storage.export']},
    {id: 'STO-02', status: 'live', write: ['storage.import']},
    {id: 'STO-03', status: 'live', read: ['storage']},
    {id: 'STO-04', status: 'policy'},
    {id: 'STO-05', status: 'live', read: ['capabilities'], operator: true},
    {id: 'STO-06', status: 'live', read: ['system-health'], core: ['GET /v1/status', 'GET /readyz'], operator: true,
      ui: {stats: ['svcCore', 'svcWeb', 'svcAuth', 'svcWorker', 'svcVector']}},
    {id: 'STO-07', status: 'live', read: ['system-version'], operator: true, ui: {stats: ['releaseVersion', 'schemaVersion', 'runtimeVersion']}},
    {id: 'STO-08', status: 'live', read: ['backups'], operator: true, ui: {table: ['backupTime', 'backupSize', 'backupVerified']}},
  ],
  audit: [
    {id: 'AUD-01', status: 'live', read: ['audit']},
    {id: 'AUD-02', status: 'live', read: ['audit']},
  ],
  security: [
    {id: 'SEC-01', status: 'live', write: ['security.password'], reauth: true},
    {id: 'SEC-02', status: 'live', write: ['security.totp.begin', 'security.totp.complete'], reauth: true},
    {id: 'SEC-03', status: 'live', write: ['security.recovery_codes'], reauth: true},
    {id: 'SEC-04', status: 'live', read: ['security'], write: ['security.session.revoke', 'security.sessions.revoke_others']},
    {id: 'SEC-05', status: 'live', read: ['login-history']},
  ],
};
/** Catalog keys for a feature: OVW-01 → featOVW01 (title) and featOVW01Note (description). */
export const featureKey = id => `feat${id.replace('-', '')}`;
/** Menu destinations whose content is composed from the feature map. */
export const prototypePages = ['tasks'];
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

function featureCard(t, f, body = '', {plain = false} = {}) {
  const key = featureKey(f.id);
  return html`<section class="card feature-card" data-status="${f.status}" data-feature="${f.id}">
    <header class="section-head">${i18n(t, key, 'h2')}${plain ? '' : html`<div>${featureStatus(t, f.status)}<span class="feature-id">${f.id}</span></div>`}</header>
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
/** Project profile (memory/profile.mjs): what the project's own memories are about. Read-only; keywords link to the
 * library filter and memories open in the detail drawer. */
export function projectProfileView(t, p) {
  if (!p || !Number.isInteger(p.memory_count)) return '';
  if (!p.memory_count) return String(html`<section class="project-profile"><h3>${i18n(t, 'projectProfile')}</h3><p class="muted">${i18n(t, 'profileEmpty')}</p></section>`);
  const list = (key, items) => items?.length ? html`<div class="profile-block"><h4>${i18n(t, key)}</h4><ul class="profile-list">${items.map(m => html`<li>${kindPill(t, m.kind)}<button type="button" class="memory-link" data-memory="${m.memory_id}">${m.title}</button>${m.strength ? html` <small class="muted">${i18n(t, 'strength')} ${m.strength}</small>` : ''}</li>`)}</ul></div>` : '';
  return String(html`<section class="project-profile"><h3>${i18n(t, 'projectProfile')}</h3>
    <p class="profile-summary">${i18n(t, 'profileMemories')} <strong>${p.memory_count}</strong>${p.last_activity ? html` · ${i18n(t, 'updated')} <time>${formatDate(p.last_activity)}</time>` : ''}</p>
    <p class="profile-kinds">${Object.entries(p.kinds || {}).filter(([k]) => k !== 'none').map(([k, n]) => html`<span class="profile-kind">${kindPill(t, k)}<b>${n}</b></span>`)}</p>
    ${p.concepts?.length ? html`<div class="profile-block"><h4>${i18n(t, 'profileConcepts')}</h4><p class="concept-row">${p.concepts.map(c => html`<a class="concept-chip" href="/app/memories?concept=${encodeURIComponent(c.concept)}">${c.concept} <small>${c.count}</small></a>`)}</p></div>` : ''}
    ${list('profileKey', p.key_memories)}${list('profileProblems', p.recent_problems)}</section>`);
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
    <tbody>${Object.entries(featureMap).map(([page, list]) => html`<tr><td><a href="${pagePath(page)}">${i18n(t, page)}</a></td>${statuses.map(s => html`<td class="figure">${count(list, s) || '—'}</td>`)}</tr>`)}</tbody></table></div></section>`;
}

/** Prototype pages list live features first, then planned ones, then what is deliberately not offered. */
export const prototypeOrder = page => [...(featureMap[page] || [])].sort((a, b) => ['live', 'planned', 'policy'].indexOf(a.status) - ['live', 'planned', 'policy'].indexOf(b.status));
/** New menu destinations: one card per feature. Live cards show real data; planned ones a wireframe. */
export function prototypeView(t, page, {data = {}, caps = {}} = {}) {
  const live = {'TSK-01': () => projectList(t, data, caps), 'STO-05': () => platformSwitches(t, caps)};
  const cards = prototypeOrder(page).map(f => featureCard(t, f, f.status === 'live' ? live[f.id]?.() ?? featureBody(t,f.id,data,caps) : ''));
  return String(html`<div class="feature-grid feature-grid--${page}">${cards}</div>${page === 'system' ? featureProgress(t) : ''}`);
}

// Extra reads per page. Owner pages also read system-health for the owner policy (switches, retrieval mode, read
// policy, background tasks); the health page (storage slug) combines service, model, version and backup reads.
export const completedViews={overview:['attention','system-health','model-usage','models'],memories:[],summaries:[],tasks:['task-branches'],
  jobs:['system-health','models'],connections:['system-health','attention','capture-status','tunnel'],models:['model-usage'],security:['login-history'],audit:[],
  storage:['system-health','system-version','models','attention','tunnel','backups']};
// OVW-03 (attention counts) is shown inside the overview status (actions.mjs overviewStatus), not as its own card.
// Panels that show data or an action; text-only feature descriptions (batch retract, version compare, inline project
// context) are not repeated as cards, and the panels carry no feature status or ID.
const completedIds=['TSK-02','TSK-04','AGT-02','MOD-04','SEC-05','AUD-02'];
export function completedFeaturePanels(t,page,data,caps){return String(html`${(featureMap[page]||[]).filter(f=>completedIds.includes(f.id)).map(f=>featureCard(t,f,featureBody(t,f.id,data,caps),{plain:true}))}`);}
function featureBody(t,id,data,caps){
  if(['TSK-05','TSK-06','TSK-07','TSK-08','TSK-09','TSK-10'].includes(id))return trusted(taskWorkflowCard(t,id,data,caps));
  const view={ 'OVW-03':'attention','TSK-02':'task-branches','AGT-02':'capture-status','MOD-04':'model-usage','SEC-05':'login-history','STO-06':'system-health','STO-07':'system-version','STO-08':'backups'}[id];
  const d=data.features?.[view];
  if(view&&!d)return sectionNote(t,'unavailable');
  const act=(action,label,values={})=>caps.allowed_actions?.includes(action)?html`<button type="button" data-console-action="${action}"${Object.entries(values).map(([k,v])=>html` data-${trusted(k)}="${v}"`)}>${i18n(t,label)}</button>`:'';
  const inspect=(v,p,label)=>html`<button type="button" data-feature-read="${v}" data-feature-params="${JSON.stringify(p)}">${i18n(t,label)}</button>`;
  const table=(rows,cols)=>rows?.length?html`<div class="table-scroll"><table><thead><tr>${cols.map(([key])=>html`<th>${i18n(t,key)}</th>`)}</tr></thead><tbody>${rows.map(r=>html`<tr>${cols.map(([,get])=>html`<td>${get(r)}</td>`)}</tr>`)}</tbody></table></div>`:emptyState(t);
  if(id==='OVW-03')return html`<dl class="metadata-grid">${[['failed_jobs','failedJobs','jobs'],['stale_summaries','staleSummaries','summaries'],['pending_reconciliation','pendingReconciliation','tasks']].map(([k,label,p])=>html`<dt>${i18n(t,label)}</dt><dd><a href="${pagePath(p)}">${d.counts[k]}</a></dd>`)}</dl>`;
  if(id==='MEM-06')return sectionNote(t,caps.allowed_actions?.includes('memory.batch_retract')?'batchNote':'batchUnavailable');
  if(id==='MEM-07')return sectionNote(t,'compareOpenDetail');
  // Stacked rows rather than a fixed four-column table: titles wrap at full width on phones.
  if(id==='TSK-02')return html`${d.tasks?.length?html`<ul class="task-list">${d.tasks.map(r=>html`<li class="task-row" data-task-row="${r.task_id}">
      <div class="task-main"><strong class="task-title">${r.title}</strong><small class="project-meta"><span class="tag">${t(r.status)}</span> ${i18n(t,'revisions')} ${r.canonical_version} · <code>${r.task_id}</code></small></div>
      <div class="actions task-actions">${act('tasks.update','editTask',{id:r.task_id})}${inspect('task-branches',{task_id:r.task_id},'sourceBranch')}</div></li>`)}</ul>`:emptyState(t)}${pageButtons(t,'data-task-offset',d)}`;
  // Project context opens inside each project row (TSK-01), next to the project it belongs to.
  if(id==='TSK-03')return sectionNote(t,'projectContextInline');
  if(id==='TSK-04')return table(data.features?.['task-branches']?.tasks,[['taskTitle',r=>r.title],['actions',r=>html`${inspect('task-checkpoints',{task_id:r.task_id},'checkpoint')} ${inspect('task-reconciliation',{task_id:r.task_id},'proposal')}`]]);
  if(id==='AGT-02')return html`${sectionNote(t,'captureObservationNote')}${table(d.agents,[['agentId',r=>r.agent_id],['agentInstance',r=>r.agent_instance_id],['sourceCount',r=>r.events],['lastUsed',r=>formatDate(r.last_received_at)]])}`;
  if(id==='AGT-03')return html`${sectionNote(t,'agentKeyBoundary')}${act('devices.register','registerAgent')}${table((data.core_connections||[]).filter(c=>c.console_revocable),[['label',r=>r.label],['agentInstance',r=>r.agent_instance_id],['actions',r=>act('devices.rotate','rotateAgent',{id:r.credential_id})]])}`;
  if(id==='MOD-04')return html`<p>${d.day} UTC · ${i18n(t,'usageReservationNote')}</p>${table(d.models,[['modelKind',r=>t(r.kind)],['usedRequests',r=>r.used??'—'],['dailyRequests',r=>!r.configured?'—':r.limit??t('noLimit')],['remainingRequests',r=>!r.configured?'—':r.remaining??t('noLimit')],['totalCallLimit',r=>r.total?`${r.total.used} / ${r.total.limit??t('noLimit')}`:'—'],['firstRunBuildRequests',r=>r.first_run_build_calls??'—']])}`;
  if(id==='SEC-05')return html`${sectionNote(t,'loginHistoryNote')}${table(d.entries,[['created',r=>formatDate(r.created)],['state',r=>t(r.outcome)],['actions',r=>r.action]])}${d.next_offset!=null?inspect('login-history',{offset:d.next_offset},'next'):''}`;
  if(id==='AUD-02')return html`<button type="button" data-audit-export>${i18n(t,'exportAudit')}</button><p>${i18n(t,'auditExportNote')}</p><p data-audit-result role="status"></p>`;
  if(id==='STO-06')return html`<dl class="metadata-grid">${Object.entries(d.services).map(([k,v])=>html`<dt>${k}</dt><dd>${t(v)}</dd>`)}</dl>${sectionNote(t,'healthObservationNote')}`;
  if(id==='STO-07')return html`<dl class="metadata-grid">${[['releaseVersion',d.release],['schemaVersion',d.schema_version],['runtimeVersion',d.node]].map(([k,v])=>html`<dt>${i18n(t,k)}</dt><dd>${v}</dd>`)}</dl>${sectionNote(t,'migrationVersionNote')}`;
  if(id==='STO-08')return trusted(backupStatusView(t,d));
  return '';
}

/** A read-only operational receipt view: the three checks are independent, never inferred from a file listing. */
export function backupStatusView(t,d){
  if(!d)return String(sectionNote(t,'backupReadUnavailable'));
  const rows=[['backupCreatedStage',d.backup],['backupVerifiedStage',d.verification],['backupRestoredStage',d.restore]];
  return String(html`<p class="policy-box">${i18n(t,'backupEvidenceNote')}</p><p role="status" data-backup-state="${d.status}">${i18n(t,'backupOverall')}: <strong>${i18n(t,'backupState_'+d.status)}</strong></p>
    <div class="table-scroll"><table data-backup-evidence><thead><tr>${['backupStage','state','backupTime','backupSize','backupArtifact'].map(k=>html`<th>${i18n(t,k)}</th>`)}</tr></thead><tbody>
    ${rows.map(([label,row])=>html`<tr><th scope="row">${i18n(t,label)}</th><td>${i18n(t,'backupState_'+(row?.status||'missing'))}${row?.error_code?html`<small><code>${row.error_code}</code></small>`:''}</td><td>${row?.observed_at?formatDate(row.observed_at):'—'}${row?.freshness_limit_days?html`<small>${i18n(t,'backupFreshness')}: ${row.freshness_limit_days} ${i18n(t,'backupDays')}</small>`:''}</td><td>${row?.size_bytes==null?'—':`${Number(row.size_bytes).toLocaleString()} B`}</td><td>${row?.artifact_sha256?html`<code class="digest" title="${row.artifact_sha256}">${row.artifact_sha256.slice(0,12)}…</code>`:'—'}${label==='backupRestoredStage'&&row?.artifact_sha256?html`<small>${i18n(t,row.matches_latest_backup?'backupRestoreLatest':'backupRestoreEarlier')}</small>`:''}</td></tr>`)}</tbody></table></div>
    ${d.error_code?html`<p role="alert"><code>${d.error_code}</code></p>`:''}<p class="muted">${i18n(t,'backupOperatorCommands')}</p>`);
}

/** Existing pages: their planned and policy features as one compact list under the live content. */
export function roadmapCard(t, page) {
  const items = (featureMap[page] || []).filter(f => f.status !== 'live');
  if (!items.length) return '';
  return String(html`<section class="card roadmap"><header class="section-head">${i18n(t, 'roadmapTitle', 'h2')}</header>${i18n(t, 'roadmapNote', 'p')}
    <ol class="roadmap-list">${items.map(f => html`<li data-status="${f.status}" data-feature="${f.id}"><div>${i18n(t, featureKey(f.id), 'strong')}${i18n(t, `${featureKey(f.id)}Note`, 'p')}</div>
      <div class="roadmap-meta">${featureStatus(t, f.status)}<span class="feature-id">${f.id}</span></div>${f.status === 'planned' ? devNote(t, f) : ''}</li>`)}</ol></section>`);
}
