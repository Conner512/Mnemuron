import { ConflictError } from './errors.mjs';

export class HandoffPolicy {
  constructor(db, runtime) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS handoff_module_state (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS handoff_drain_resumes (user_id TEXT NOT NULL, resume_id TEXT NOT NULL, preview_version INTEGER NOT NULL,
        PRIMARY KEY(user_id,resume_id));`);
    if (!runtime.legacy) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const prior = db.prepare('SELECT enabled FROM handoff_module_state WHERE id=1').get();
        if (!runtime.handoff && prior?.enabled !== 0) {
          db.exec(`DELETE FROM handoff_drain_resumes;
            INSERT INTO handoff_drain_resumes SELECT user_id,resume_id,preview_version FROM resumes WHERE status='confirmed';`);
        }
        db.prepare('INSERT INTO handoff_module_state VALUES (1,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled').run(Number(runtime.handoff));
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  }
  enabled() { return this.db.prepare('SELECT enabled FROM handoff_module_state WHERE id=1').get()?.enabled !== 0; }
  requireNew() { if (!this.enabled()) throw new ConflictError('New handoff operations are disabled; existing deliveries may drain.', 'HANDOFF_DISABLED'); }
  allowReceipt(auth, resumeId, payload, kind) {
    if (this.enabled()) return;
    const member = this.db.prepare('SELECT 1 FROM handoff_drain_resumes WHERE user_id=? AND resume_id=? AND preview_version=?')
      .get(auth.user_id,resumeId,payload?.preview_version ?? null);
    if (!member) throw new ConflictError('Delivery is not part of the existing handoff drain.', 'HANDOFF_DISABLED');
    const [table, id, initial] = kind === 'receipt' ? ['resume_delivery_receipts','receipt_id','delivered'] : ['resume_injection_events','attempt_id','injected'];
    const attempts = this.db.prepare(`SELECT ${id} AS id,phase FROM ${table} WHERE user_id=? AND resume_id=?`).all(auth.user_id,resumeId);
    // Existing attempts retain all original ownership/provenance checks in Store.
    // A confirmed but never delivered packet can make its first delivery, not a new retry.
    if (payload.phase === initial && attempts.length && !attempts.some(row=>row.id === payload[id])) {
      throw new ConflictError('Drain does not create another delivery attempt.', 'HANDOFF_DRAIN_RETRY_DENIED');
    }
  }
  status(userId) {
    if (this.enabled()) return {state:'ready',enabled:true,new_operations_allowed:true,pending_existing:0};
    const count = this.db.prepare(`SELECT COUNT(*) AS n FROM handoff_drain_resumes d
      JOIN resumes r ON r.user_id=d.user_id AND r.resume_id=d.resume_id
      WHERE d.user_id=? AND r.status='confirmed'
        AND (
          (NOT EXISTS (SELECT 1 FROM resume_delivery_receipts e WHERE e.user_id=d.user_id AND e.resume_id=d.resume_id)
            AND NOT EXISTS (SELECT 1 FROM resume_injection_events e WHERE e.user_id=d.user_id AND e.resume_id=d.resume_id))
          OR EXISTS (SELECT 1 FROM resume_delivery_receipts e WHERE e.user_id=d.user_id AND e.resume_id=d.resume_id AND e.phase='delivered'
            AND NOT EXISTS (SELECT 1 FROM resume_delivery_receipts t WHERE t.user_id=e.user_id AND t.resume_id=e.resume_id AND t.receipt_id=e.receipt_id AND t.phase IN ('acknowledged','failed')))
          OR EXISTS (SELECT 1 FROM resume_injection_events e WHERE e.user_id=d.user_id AND e.resume_id=d.resume_id AND e.phase='injected'
            AND NOT EXISTS (SELECT 1 FROM resume_injection_events t WHERE t.user_id=e.user_id AND t.resume_id=e.resume_id AND t.attempt_id=e.attempt_id AND t.phase IN ('acknowledged','failed')))
        )`).get(userId).n;
    return {state:count?'draining':'disabled',enabled:false,new_operations_allowed:false,pending_existing:count,
      preserved_history:true,existing_terminal_retries_allowed:true};
  }
}
