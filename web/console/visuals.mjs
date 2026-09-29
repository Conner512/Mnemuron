// Shared, dependency-free presentation. No API calls, account selection or authorization here.
// Icons are fixed local paths, never markup from a memory or an upstream response.
const paths = {
  brand: '<path d="M5 18.5V6.5l7 6.2 7-6.2v12"/><circle cx="5" cy="5" r="1.7"/><circle cx="19" cy="5" r="1.7"/><circle cx="12" cy="14.4" r="1.7"/><circle cx="5" cy="20" r="1.2"/><circle cx="19" cy="20" r="1.2"/>',
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
  pulse: '<path d="M3 12h4l2.5-6 5 12 2.5-6H21"/>',
  constellation: '<circle cx="12" cy="12" r="2.2"/><circle cx="4.5" cy="6" r="1.6"/><circle cx="19.5" cy="5.5" r="1.6"/><circle cx="18.5" cy="19" r="1.6"/><circle cx="5" cy="18.5" r="1.6"/><path d="m6 7 4.3 3.6M18.2 6.8l-4.6 3.8M17.3 17.8l-3.6-4.2M6.4 17.4l3.9-4"/>',
  layers: '<path d="M4 7h16M4 12h10M4 17h6"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
};
export const icon = name => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name] || paths.memories}</svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const label = (t, key, tag = 'span') => `<${tag} data-i18n="${key}">${esc(t(key))}</${tag}>`;

// Decorative synapse field for the sign-in story. Fixed geometry; never data.
const field=[[40,60],[120,30],[210,78],[300,40],[380,96],[70,160],[160,140],[250,176],[340,150],[420,200],[30,250],[120,236],[220,270],[310,248],[400,300],[170,320],[60,330],[280,330]];
const links=[[0,1],[1,2],[2,3],[3,4],[0,5],[1,6],[2,6],[2,7],[3,8],[4,8],[4,9],[5,6],[6,7],[7,8],[8,9],[5,10],[5,11],[6,11],[7,12],[8,13],[9,13],[9,14],[10,11],[11,12],[12,13],[13,14],[11,15],[12,15],[10,16],[15,16],[12,17],[13,17],[15,17]];
export const orbit = () => `<div class="memory-orbit synapse-field" aria-hidden="true"><svg viewBox="0 0 440 360" focusable="false">${links.map(([a,b],i)=>`<line class="syn-link${i%5===0?' is-live':''}" x1="${field[a][0]}" y1="${field[a][1]}" x2="${field[b][0]}" y2="${field[b][1]}"/>`).join('')}${field.map(([x,y],i)=>`<circle class="syn-node${i%4===0?' is-hot':''}" cx="${x}" cy="${y}" r="${i%4===0?4.5:2.6}"/>`).join('')}</svg><span class="orbit-caption">MEMORY · CONTEXT · CONNECTION</span></div>`;

const safeCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const rowsOf = rows => Array.isArray(rows) ? rows.map(r => ({value:String(r?.value ?? ''), count:safeCount(r?.count)})).filter(r => r.value && r.count !== null && r.count > 0) : [];
const pct = (part, total) => total > 0 ? Math.max(0, Math.min(100, part / total * 100)) : 0;
const fixed = n => Number(n.toFixed(2));

// Memory constellation: categories on the outer ring, types on the inner ring. Only real aggregates.
function constellation(insights, t) {
  const categories = rowsOf(insights?.categories).slice(0, 8), types = rowsOf(insights?.types).slice(0, 6);
  const cx = 260, cy = 180, max = Math.max(1, ...categories.map(r => r.count), ...types.map(r => r.count));
  const size = (count, base, span) => fixed(base + Math.sqrt(count / max) * span);
  const place = (rows, rx, ry, offset) => rows.map((row, i) => { const a = offset + i / rows.length * Math.PI * 2; return {...row, x:fixed(cx + Math.cos(a) * rx), y:fixed(cy + Math.sin(a) * ry)}; });
  const outer = place(categories, 205, 128, -Math.PI / 2), inner = place(types, 104, 64, -Math.PI / 2 + Math.PI / Math.max(2, types.length));
  const curve = (p, bend) => `M${cx} ${cy}Q${fixed((cx + p.x) / 2 + (p.y - cy) * bend)} ${fixed((cy + p.y) / 2 - (p.x - cx) * bend)} ${p.x} ${p.y}`;
  const node = (p, i, kind) => { const r = kind === 'category' ? size(p.count, 5, 13) : size(p.count, 3.5, 8); const right = p.x >= cx;
    return `<g class="cn-node cn-${kind} hue-${i % 6}"><title>${esc(t(p.value))} · ${p.count}</title><circle class="cn-halo" cx="${p.x}" cy="${p.y}" r="${fixed(r + 7)}"/><circle class="cn-core" cx="${p.x}" cy="${p.y}" r="${r}"/>${kind === 'category' ? `<text x="${fixed(p.x + (right ? r + 9 : -r - 9))}" y="${fixed(p.y + 4)}" text-anchor="${right ? 'start' : 'end'}"><tspan class="cn-name">${esc(t(p.value))}</tspan><tspan class="cn-count" dx="6">${p.count}</tspan></text>` : `<text class="cn-type-label" x="${p.x}" y="${fixed(p.y + r + 13)}" text-anchor="middle">${esc(t(p.value))}</text>`}</g>`; };
  const empty = !outer.length && !inner.length;
  const ring = (rx, ry, extra = '') => `<ellipse class="cn-ring${extra}" cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"/>`;
  return `<figure class="constellation${empty ? ' is-empty' : ''}"><svg viewBox="0 0 520 360" role="img" data-i18n-aria-label="constellationTitle" aria-label="${esc(t('constellationTitle'))}" focusable="false">
  <defs><pattern id="cn-dots" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" class="cn-dot"/></pattern>
  <radialGradient id="cn-glow"><stop offset="0" class="cn-glow-a"/><stop offset="1" class="cn-glow-b"/></radialGradient></defs>
  <rect class="cn-grid" x="0" y="0" width="520" height="360" fill="url(#cn-dots)"/><circle cx="${cx}" cy="${cy}" r="150" fill="url(#cn-glow)"/>
  ${ring(205, 128)}${ring(104, 64, ' inner')}${ring(150, 94, ' faint')}
  ${outer.map((p, i) => `<path class="cn-edge${i % 3 === 0 ? ' is-live' : ''}" d="${curve(p, .18)}"/>`).join('')}
  ${inner.map((p, i) => `<path class="cn-edge inner${i % 2 ? ' is-live' : ''}" d="${curve(p, -.22)}"/>`).join('')}
  ${outer.map((p, i) => { const n = outer[(i + 1) % outer.length]; return outer.length > 2 ? `<line class="cn-mesh" x1="${p.x}" y1="${p.y}" x2="${n.x}" y2="${n.y}"/>` : ''; }).join('')}
  ${inner.map((p, i) => node(p, i + 2, 'type')).join('')}${outer.map((p, i) => node(p, i, 'category')).join('')}
  <g class="cn-center"><circle class="cn-pulse" cx="${cx}" cy="${cy}" r="22"/><circle class="cn-hub" cx="${cx}" cy="${cy}" r="17"/><path class="cn-mark" transform="translate(${cx - 12} ${cy - 12})" d="M5 18.5V6.5l7 6.2 7-6.2v12"/></g>
  </svg>${empty ? `<figcaption>${label(t, 'constellationEmpty')}</figcaption>` : `<figcaption class="cn-legend"><span class="cn-key category">${label(t, 'categoriesLegend')}</span><span class="cn-key type">${label(t, 'typesLegend')}</span></figcaption>`}</figure>`;
}

function activity(insights) {
  const days = Array.isArray(insights?.activity) ? insights.activity.filter(d => typeof d?.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.day) && safeCount(d.count) !== null).slice(-30) : [];
  return days;
}
function sparkline(days) {
  if (days.length < 2) return '';
  const max = Math.max(1, ...days.map(d => d.count)), w = 120, h = 30, step = w / (days.length - 1);
  const pts = days.map((d, i) => [fixed(i * step), fixed(h - 2 - d.count / max * (h - 6))]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join('');
  return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path class="spark-area" d="${line}L${w} ${h}L0 ${h}Z"/><path class="spark-line" d="${line}"/></svg>`;
}
function activityChart(days, t) {
  const l = (key, tag) => label(t, key, tag);
  if (!days.length) return '';
  const total = days.reduce((n, d) => n + d.count, 0), peak = Math.max(0, ...days.map(d => d.count)), max = Math.max(1, peak);
  const W = 600, H = 170, top = 14, base = 140, slot = W / days.length, bw = fixed(slot * .62);
  const bars = days.map((d, i) => { const hgt = d.count ? Math.max(3, d.count / max * (base - top)) : 2; return `<rect class="bar${d.count ? '' : ' is-zero'}${d.count === peak && peak ? ' is-peak' : ''}" x="${fixed(i * slot + (slot - bw) / 2)}" y="${fixed(base - hgt)}" width="${bw}" height="${fixed(hgt)}" rx="2"><title>${esc(d.day)} · ${d.count}</title></rect>`; }).join('');
  const tick = i => `<text class="axis" x="${fixed(i === 0 ? 0 : i === days.length - 1 ? W : i * slot + slot / 2)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}">${esc(days[i].day.slice(5))}</text>`;
  const grid = [0, .5, 1].map(f => `<line class="grid-line" x1="0" x2="${W}" y1="${fixed(base - f * (base - top))}" y2="${fixed(base - f * (base - top))}"/>`).join('');
  return `<section class="card activity-card"><div class="card-heading"><div><p class="eyebrow">${l('activityLabel')}</p>${l('activityTitle', 'h2')}</div><dl class="stat-pair"><div><dt>${l('activityTotal')}</dt><dd>${total}</dd></div><div><dt>${l('peakDay')}</dt><dd>${peak}</dd></div></dl></div>
  ${total ? '' : `<p class="chart-empty">${l('noActivity')}</p>`}<svg class="activity-chart" viewBox="0 0 ${W} ${H}" role="img" data-i18n-aria-label="activityTitle" aria-label="${esc(t('activityTitle'))}" focusable="false">${grid}${bars}${tick(0)}${tick(Math.floor(days.length / 2))}${tick(days.length - 1)}</svg></section>`;
}
function composition(insights, t) {
  const l = (key, tag) => label(t, key, tag);
  const types = rowsOf(insights?.types).slice(0, 6), statuses = rowsOf(insights?.statuses);
  if (!types.length && !statuses.length) return '';
  const typeMax = Math.max(1, ...types.map(r => r.count)), statusTotal = statuses.reduce((n, r) => n + r.count, 0);
  let x = 0;
  const stack = statuses.map(r => { const w = pct(r.count, statusTotal), seg = `<rect class="seg status-${esc(r.value)}" x="${fixed(x)}" y="0" width="${fixed(w)}" height="8"><title>${esc(t(r.value))} · ${r.count}</title></rect>`; x += w; return seg; }).join('');
  return `<section class="card composition-card"><div class="card-heading"><div><p class="eyebrow">${l('compositionLabel')}</p>${l('compositionTitle', 'h2')}</div><span class="metric-icon">${icon('layers')}</span></div>
  <h3 class="mini-heading">${l('typesLegend')}</h3><ul class="type-bars">${types.map((r, i) => `<li class="hue-${i % 6}"><span class="type-name">${esc(t(r.value))}</span><svg viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect class="track" width="100" height="6" rx="3"/><rect class="fill" width="${fixed(Math.max(2, pct(r.count, typeMax)))}" height="6" rx="3"/></svg><span class="type-count">${r.count}</span></li>`).join('')}</ul>
  ${statuses.length ? `<h3 class="mini-heading">${l('lifecycle')}</h3><svg class="status-stack" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" data-i18n-aria-label="lifecycle" aria-label="${esc(t('lifecycle'))}" focusable="false">${stack}</svg><ul class="status-legend">${statuses.map(r => `<li class="status-${esc(r.value)}"><i aria-hidden="true"></i>${esc(t(r.value))}<span>${r.count}</span></li>`).join('')}</ul>` : ''}</section>`;
}

export function overviewView(data, {t, memoryRows}) {
  const l = (key, tag) => label(t, key, tag);
  // The reference's trends and connected/completed badges were demo data. Never invent them.
  const count = key => Number.isSafeInteger(data.counts?.[key]) && data.counts[key] >= 0 ? data.counts[key].toLocaleString() : '—';
  const days = activity(data.insights), charts = activityChart(days, t) + composition(data.insights, t);
  return `<section class="hero neural-hero"><div class="hero-copy"><p class="eyebrow">${l('constellationLabel')}</p><h2>${l('constellationTitle')}</h2>${l('constellationNote','p')}
  <div class="hero-actions"><a class="button primary" href="/app/memories">${icon('search')}${l('browseMemories')}</a><a class="button ghost" href="/app/connections">${icon('connections')}${l('manageConnections')}</a></div>
  <p class="hero-footnote">${icon('security')}${l('connectionDescription')}</p></div>${constellation(data.insights, t)}</section>
  <div class="metrics">${[['memories','memoryCount','memories'],['sources','sourceCount','audit'],['summaries','summaryCount','summaries'],['jobs','jobCount','jobs']].map(([key,title,glyph]) => `<a class="card metric" href="/app/${key==='sources'?'memories?focus=sources':key}" data-metric="${key}"><div class="metric-heading">${l(title)}<span class="metric-icon">${icon(glyph)}</span></div><strong>${count(key)}</strong>${key === 'memories' ? sparkline(days) : ''}${l('ownedRecords','small')}</a>`).join('')}</div>
  ${charts ? `<div class="columns overview-columns insight-columns">${charts}</div>` : ''}
  <div class="columns overview-columns"><section class="card recent-card"><div class="card-heading"><div><p class="eyebrow">${l('recentLabel')}</p>${l('recent','h2')}</div><a href="/app/memories">${l('viewAll')} ${icon('arrow')}</a></div><div class="timeline">${memoryRows(data.recent)}</div>${l('inspectMemoryNote','p')}</section>
  <section class="card processing-card"><div class="card-heading"><div><p class="eyebrow">${l('flowLabel')}</p>${l('memoryProcessing','h2')}</div><span class="metric-icon">${icon('pulse')}</span></div>
  <div class="pipeline">
  <a class="processing-stage" href="/app/memories"><span class="stage-icon">${icon('memories')}</span><div>${l('memoryCount')}<small>${l('atomicNote')}</small></div><strong>${count('memories')}</strong></a>
  <a class="processing-stage" href="/app/summaries"><span class="stage-icon">${icon('summaries')}</span><div>${l('summaryCount')}<small>${l('derivedNote')}</small></div><strong>${count('summaries')}</strong></a>
  <a class="processing-stage" href="/app/jobs"><span class="stage-icon">${icon('jobs')}</span><div>${l('jobCount')}<small>${l('jobStatusNote')}</small></div><strong>${count('jobs')}</strong></a>
  </div><div class="privacy-note">${icon('security')}${l('summaryBoundary','p')}</div><a class="text-link" href="/app/jobs">${l('viewJobs')} ${icon('arrow')}</a></section></div>`;
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
