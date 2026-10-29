import { staleSql } from './review.mjs';

// Internal-only options: JSON requests cannot opt out of the public lexical term budget or
// supply SQL. Console filters are validated by ConsoleOrganizer.filter before they reach here.
export const MEMORY_SEARCH_CONTEXT = Symbol('mnemuron.memory.search.context');

/** A current-row filter, shared by lexical candidates, entity members and vector hydration.
 * memoryTypes is the public type selection after Store validation, separate from writer-chosen kind. */
export function memorySearchFilterSql(filter = {}, {memoryTypes} = {}) {
  const clauses = [], params = [];
  if (memoryTypes) {
    clauses.push(`m.memory_type IN (${memoryTypes.map(()=>'?').join(',')})`);
    params.push(...memoryTypes);
  }
  if (filter.topic) { clauses.push('m.topic=?'); params.push(filter.topic); }
  if (filter.kind) {
    clauses.push("COALESCE((SELECT t.kind FROM memory_traits t WHERE t.user_id=m.user_id AND t.memory_id=m.memory_id),'none')=?");
    params.push(filter.kind);
  }
  if (filter.concept) {
    clauses.push('EXISTS (SELECT 1 FROM memory_traits t, json_each(t.concepts_json) c WHERE t.user_id=m.user_id AND t.memory_id=m.memory_id AND lower(c.value)=lower(?))');
    params.push(filter.concept);
  }
  if (filter.origin) { clauses.push("(m.source LIKE 'user_import:%')=(?='imported')"); params.push(filter.origin); }
  if (filter.review === 'stale') {
    const stale = staleSql();
    clauses.push(`EXISTS (SELECT 1 FROM memories mf LEFT JOIN memory_traits t ON t.user_id=mf.user_id AND t.memory_id=mf.memory_id
      WHERE mf.user_id=m.user_id AND mf.memory_id=m.memory_id AND ${stale.sql})`);
    params.push(...stale.params);
  }
  return { sql: clauses.length ? clauses.join(' AND ') : '1', params, active: clauses.length > 0 };
}
