// Cleanup review: active memories that look stale, for the owner to look over and retract in the library (nothing is
// removed automatically). A memory is listed when it is
// - weak and idle: strength <= WEAK_STRENGTH, older than WEAK_AGE_DAYS, no assistant read for WEAK_IDLE_DAYS; or
// - long untouched: strength <= OLD_STRENGTH, older than OLD_AGE_DAYS, no assistant read for OLD_IDLE_DAYS.
// Unset strength counts as 5. Reads are memory.read audit events by assistants; console browsing does not count.
export const WEAK_STRENGTH = 3, WEAK_AGE_DAYS = 60, WEAK_IDLE_DAYS = 90, OLD_STRENGTH = 6, OLD_AGE_DAYS = 180, OLD_IDLE_DAYS = 180;
const CONSOLE_AGENT = 'mnemuron-console', DAY = 86_400_000;
const iso = (now, days) => new Date(now - days * DAY).toISOString();
const unread = (a, since) => `NOT EXISTS (SELECT 1 FROM audit_events a JOIN credentials c ON c.credential_id=a.credential_id
  WHERE a.action='memory.read' AND a.target_type='memory' AND a.user_id=${a}.user_id AND a.target_id=${a}.memory_id AND a.created_at>? AND c.agent_id<>'${CONSOLE_AGENT}')`;

/** SQL condition (memories alias `m`, traits alias `t`) and its parameters. */
export function staleSql(now = Date.now()) {
  return {
    sql: `m.status='active' AND ((COALESCE(t.strength,5)<=${WEAK_STRENGTH} AND m.created_at<? AND ${unread('m', '?')})
      OR (COALESCE(t.strength,5)<=${OLD_STRENGTH} AND m.created_at<? AND ${unread('m', '?')}))`,
    params: [iso(now, WEAK_AGE_DAYS), iso(now, WEAK_IDLE_DAYS), iso(now, OLD_AGE_DAYS), iso(now, OLD_IDLE_DAYS)],
  };
}

/** Map memory_id -> {strength, age_days, last_read_days|null} for rows already listed as stale. */
export function staleReasons(db, userId, rows, now = Date.now()) {
  const ids = rows.map(r => r.memory_id), out = new Map();
  const last = new Map(ids.length ? db.prepare(`SELECT a.target_id id, max(a.created_at) at FROM audit_events a JOIN credentials c ON c.credential_id=a.credential_id
      WHERE a.action='memory.read' AND a.target_type='memory' AND a.user_id=? AND c.agent_id<>? AND a.target_id IN (SELECT value FROM json_each(?)) GROUP BY a.target_id`)
    .all(userId, CONSOLE_AGENT, JSON.stringify(ids)).map(r => [r.id, r.at]) : []);
  for (const r of rows) out.set(r.memory_id, { strength: r.strength ?? null, age_days: Math.floor((now - Date.parse(r.created_at)) / DAY),
    last_read_days: last.has(r.memory_id) ? Math.floor((now - Date.parse(last.get(r.memory_id))) / DAY) : null });
  return out;
}
