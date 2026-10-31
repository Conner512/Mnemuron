import test from 'node:test';
import assert from 'node:assert/strict';
import {summariesView, summaryDetailView, summaryDetailTitle} from '../../../web/console/visuals.mjs';
import {text} from '../../../web/console/catalog.mjs';

const t = key => text(key, 'zh-CN');
const window = {period: 'daily', local_start: '2026-10-01', timezone: 'Asia/Shanghai'};
const scope = {kind: 'workstream', project_id: 'synthetic-project', project_name: 'Synthetic reading project',
  task_id: 'synthetic-task', task_title: 'Synthetic task', workstream_id: 'synthetic-branch', workstream_name: 'Synthetic branch'};
const item = {summary_id: 'synthetic-summary', category: 'all', status: 'current', revision: 2, coverage: 3, omitted: 1, scope, window};
const quote = '合成原文：尚未部署，不能记为已完成。\n\n下一步：验证失败恢复。 <script>not markup</script> 🙂';
const claim = {memory_id: 'synthetic-memory-one', revision: 4, start: 3, end: 90, quote};
const data = extra => ({results: [{...item, selected_source_count: 2, dependency_count: 3, omitted_source_count: 1,
  claim_offset: 0, claims: [claim], content_complete: true}], context: {scope, window, coverage: 3, omitted: 1}, complete: true, ...extra});

test('SUMMARY-READER-01: list preserves excerpt boundaries and leads with readable scope and time', () => {
  const html = summariesView(t, {data: {summaries: [{...item, preview: {text: 'legacy concatenation must not win', more: true,
    excerpts: [{quote: '第一条原文\n仍属同一来源。', quote_complete: true}, {quote: '第二条原文。', quote_complete: false}]}}]}});
  assert.match(html, /Synthetic reading project/);
  assert.equal((html.match(/class="summary-preview-quote"/g) || []).length, 2);
  assert.match(html, /第一条原文\n仍属同一来源。/);
  assert.doesNotMatch(html, /legacy concatenation must not win/);
  assert.match(html, /引用来源<\/span> <b>2<\/b> \/ 3/);
  assert.match(html, /1 <span data-i18n="summaryReaderNotCited">条来源未引用/);
  assert.match(html, /summaryReaderOpenFull/);
  assert.ok(html.indexOf('summary-preview-lines') < html.indexOf('<details class="summary-technical">'));
  assert.ok(html.indexOf('<details class="summary-technical">') < html.indexOf('synthetic-project</code>') || html.includes('synthetic-project / synthetic-task'));
  assert.doesNotMatch(html, /<select|<input|<form/, 'no fake filtering of only the loaded result page');
});

test('SUMMARY-READER-02: old revisions are folded, never actionable and never show stale preview text', () => {
  const html = summariesView(t, {data: {summaries: [item, {...item, summary_id: 'synthetic-stale', status: 'superseded',
    preview: {text: 'stale quote must not render', excerpts: [{quote: 'stale excerpt must not render'}]}}]}});
  assert.match(html, /<details class="summary-history"><summary>/);
  assert.doesNotMatch(html, /stale quote|stale excerpt|data-summary="synthetic-stale"/);
  assert.match(html, /summaryNotCurrent/);
  assert.equal((html.match(/class="summary-row"/g) || []).length, 2, 'history remains available without pretending it is current');
  assert.equal((html.match(/data-summary="/g) || []).length, 1);
});

test('SUMMARY-READER-03: page counts are explicit and source-scope names remain escaped', () => {
  const html = summariesView(t, {data: {summaries: [{...item, scope: {...scope, project_name: '<img src=x onerror=alert(1)>'}}],
    offset: 25, next_offset: 50}, pagination: '<nav class="synthetic-pagination">More</nav>'});
  assert.match(html, /1 <span data-i18n="summaryReaderOnPage">/);
  assert.match(html, /summaryReaderPageNote/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /synthetic-pagination/);
  const fallback = summariesView(t, {data: {summaries: [{...item, preview: {text: 'Older validated preview'}}]}});
  assert.match(fallback, /Older validated preview/);
});

test('SUMMARY-READER-04: exact source quotes keep paragraphs and evidence; different sources/revisions never merge', () => {
  const claims = [claim, {...claim}, {...claim, start: 100, end: 190}, {...claim, memory_id: 'synthetic-memory-two'},
    {...claim, revision: 5}, {...claim, start: 191, end: 220, quote: '同一来源中的第二段：尚未完成。'}];
  const html = summaryDetailView(t, data({results: [{...item, claims}]}));
  assert.equal((html.match(/class="detail-source summary-source-group"/g) || []).length, 3);
  assert.equal((html.match(/class="summary-excerpt"/g) || []).length, 5, 'only same source, revision, range and exact text deduplicates');
  assert.match(html, /合成原文：尚未部署，不能记为已完成。\n\n下一步：验证失败恢复。 &lt;script&gt;not markup&lt;\/script&gt; 🙂/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /data-memory="synthetic-memory-one" data-revision="4"/);
  assert.match(html, /data-memory="synthetic-memory-one" data-revision="5"/);
  assert.match(html, /summaryReaderDuplicate/);
  assert.match(html, /100–190/);
  assert.match(html, /191–220/);
  assert.equal((html.match(/data-memory=/g) || []).length, 3, 'one revision-bound source action per group');
});

test('SUMMARY-READER-05: fragments and next-page boundaries are never presented as a complete quotation', () => {
  const partial = {...claim, quote: '延续原文片段', quote_offset: 120, quote_length: 400, quote_complete: false};
  const html = summaryDetailView(t, data({results: [{...item, claims: [partial], claim_offset: 3, content_complete: false}],
    complete: false, next_request: {summary_id: item.summary_id, revision: item.revision, cursor: 'synthetic-cursor'}}), {canGoBack: true});
  assert.match(html, /summaryReaderContinuedQuote/);
  assert.match(html, /summaryReaderExcerptPartial/);
  assert.match(html, /summaryReaderContinued/);
  assert.match(html, /data-detail-next/);
  assert.match(html, /data-detail-back/);
  assert.match(html, /120 \/ 400/);
  assert.doesNotMatch(html, /data-i18n="summaryReaderEnd"/);
});

test('SUMMARY-READER-06: excerpt completion and source coverage are separate, with quality secondary', () => {
  const html = summaryDetailView(t, data(), {tools: '<button data-review-open="summary">Quality</button>'});
  assert.match(html, /summaryReaderOmittedNote/);
  assert.match(html, /summaryReaderEnd/);
  assert.ok(html.indexOf('summary-reader-tools') > html.indexOf('class="claim-list'));
  assert.ok(html.indexOf('data-review-open') > html.indexOf('data-close'));
  assert.match(html, /<details class="summary-reader-tools"><summary>/);
  assert.match(html, /引用来源<\/span> <b>2<\/b> \/ 3/);
  const batch = summaryDetailView(t, data({results: [{...item, coverage_basis: 'authorized_batch', claims: [claim]}]}));
  assert.match(batch, /summaryReaderBatchNote/);
});

test('SUMMARY-READER-07: titles are contextual plain text; missing metadata is never guessed', () => {
  assert.equal(summaryDetailTitle(t, data()), 'Synthetic reading project › Synthetic task › Synthetic branch · 2026-10-01 · 日摘要');
  assert.equal(summaryDetailTitle(t, {}), '范围未知 · 时间窗口未知');
  assert.equal(summaryDetailTitle(t, {context: {scope: {kind: 'user'}}}), '个人范围 · 时间窗口未知');
  const html = summaryDetailView(t, {results: [{claims: []}], complete: false});
  assert.match(html, /summaryWindowUnknown/);
  assert.match(html, /summaryScope_unknown/);
  assert.match(html, /summaryReaderIncomplete/);
  assert.doesNotMatch(html, /undefined|NaN/);
});

test('SUMMARY-READER-08: a stale detail response is defensive and cannot expose its quotes or navigation', () => {
  const html = summaryDetailView(t, data({results: [{...item, status: 'superseded', claims: [claim]}],
    next_request: {cursor: 'synthetic-cursor'}}));
  assert.doesNotMatch(html, /合成原文|data-memory=|data-detail-next|data-i18n="summaryReaderMore"/);
  assert.match(html, /summaryNotCurrent/);
});

test('SUMMARY-READER-09: mixed time zones remain distinguishable without opening technical details', () => {
  const html = summariesView(t, {data: {summaries: [item, {...item, summary_id: 'synthetic-utc-summary', window: {...window, timezone: 'UTC'}}]}});
  assert.match(html, /<span class="summary-tz">\(Asia\/Shanghai\)<\/span>/);
  assert.match(html, /<span class="summary-tz">\(UTC\)<\/span>/);
  const single = summariesView(t, {data: {summaries: [item]}});
  assert.doesNotMatch(single, /<span class="summary-tz">\(Asia\/Shanghai\)<\/span>/, 'one time zone can remain secondary');
});
