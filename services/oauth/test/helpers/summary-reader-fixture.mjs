import {calendarWindow} from '../../../../server/lib/memory-jobs/windows.mjs';

// All content is deliberately synthetic. No provider calls, deployment data, or personal memories.
export const READER_FIRST_QUOTE = '合成发布演练：先验证，再上线。\n\n已完成：备份校验通过，演练环境可以恢复。';
export const READER_SECOND_QUOTE = '待处理：回滚演练尚未完成，不能记为已完成。\n\n下一步：保留失败日志，重新验证恢复流程。';
export const READER_OTHER_QUOTE = 'Synthetic release rehearsal: the rollback check is still pending.\n\nDo not treat a successful backup as proof that rollback has been tested.';
const CONTINUED_TEXT = '合成分页原文：这是一个跨页的连续摘录，尚未完成的验证必须保持原意。 🙂\n';
export const READER_LONG_QUOTE = CONTINUED_TEXT.repeat(90).trimEnd();
export const READER_PAGE_QUOTES = Array.from({length: 12}, (_, i) => `合成分页来源 ${i + 1}\n${CONTINUED_TEXT.repeat(60)}`.trimEnd());

export function seedSummaryReader(store, auth, ownerIndex) {
  const user = auth.user_id, suffix = String(ownerIndex), version = store.consoleService.taxonomy(user).version;
  const project = `synthetic-reader-project-${suffix}`, task = `synthetic-reader-task-${suffix}`;
  store.upsertTask(auth, {project_id: project, project_name: '合成发布演练 / Synthetic release rehearsal', task_id: task,
    title: 'Synthetic reader acceptance', goal: 'Validate the summary reader with synthetic data only.', status: 'active', workstreams: []});
  const source = (content, selection = {scope: 'project', project_id: project}) => {
    const memory = store.saveMemory(auth, {...selection, content}).memory;
    return store.derivedMemory.currentSource(user, memory.memory_id);
  };
  const one = source(`${READER_FIRST_QUOTE}\n\n${READER_SECOND_QUOTE}`), two = source(READER_OTHER_QUOTE),
    omitted = source('合成未引用来源：保持可追溯，但不把这条信息冒充为已包含在摘要内。');
  const span = (source, start, quote) => {
    const end = start + [...quote].length;
    if ([...source.content].slice(start, end).join('') !== quote) throw new Error('Synthetic quote must exactly match its stored source span');
    return {memory_id: source.memory_id, revision: source.revision, start, end, quote};
  };
  const first = span(one, 0, READER_FIRST_QUOTE), second = span(one, [...READER_FIRST_QUOTE].length + 2, READER_SECOND_QUOTE);
  const at = Date.UTC(2026, 9, 3, 3, 0);
  const publish = (key, items, claims, when) => {
    const job = {job_id: `synthetic-reader-${key}-${suffix}`, group_key: `synthetic-reader-group-${key}-${suffix}`, user_id: user,
      scope_key: items[0].scope_key, profile: 'synthetic-reader', metadata: {category: 'all',
        window: calendarWindow(when, {timezone: 'Asia/Shanghai', period: 'daily'}), taxonomy: {version}}};
    return store.memoryTransaction(() => store.derivedMemory.publishSummary(job,
      items.map(({user_id, memory_id, revision, state_hash, scope_key}) => ({user_id, memory_id, revision, state_hash, scope_key})), claims, when));
  };
  // Interleaved source A, B, A, duplicate A: source grouping must remain exact and keep both sources.
  const normal = publish('normal', [one, two, omitted], [first, span(two, 0, READER_OTHER_QUOTE), second, {...first}], at);
  const long = source(READER_LONG_QUOTE, {scope: 'session', session_id: `synthetic-reader-fragment-${suffix}`});
  const longId = publish('long', [long], [span(long, 0, READER_LONG_QUOTE)], at - 86400000);
  const many = READER_PAGE_QUOTES.map(quote => source(quote));
  const manyId = publish('multiple-pages', many, many.map(item => span(item, 0, item.content)), at - 2 * 86400000);
  // Public writes cap a memory at 4096 UTF-16 units. Keep real, exact source text instead of forging
  // a giant quote for a shorter memory. Only this synthetic session uses a reduced detail budget to
  // exercise legacy quote-fragment reading. The 12-source case still uses the normal 48 KiB budget.
  const pager = store.derivedMemory.pagination, originalPage = pager.page.bind(pager);
  pager.page = (owner, scope, options = {}) => originalPage(owner, scope,
    scope === long.scope_key && options.budget === 48 * 1024 ? {...options, budget: 8192} : options);
  return {normal_id: normal, long_id: longId, multipage_id: manyId, source_id: one.memory_id, source_revision: one.revision, project_id: project};
}
