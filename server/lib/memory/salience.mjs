// Memory salience: how much a memory should be preferred among results that match a query equally well.
// Two signals, both bounded so they only reorder near-ties and never outrank a better match kind:
// - strength (1-10, set by the writer or the keyword fill; unset counts as the midpoint 5);
// - recent assistant reads: `memory.read` audit events in the last READ_WINDOW_DAYS, each weighted by age with a
//   READ_HALF_LIFE_DAYS half-life (reinforcement that fades, as in a forgetting curve). Reads by the owner's own
//   console browsing are not usage by an assistant and are not counted.
export const READ_WINDOW_DAYS = 90, READ_HALF_LIFE_DAYS = 21, READS_FOR_FULL_WEIGHT = 15;
// Weights from the synthetic retrieval evaluation (60 queries over 200 memories): adjacent fused ranks differ by about
// 1.6%, so larger weights let strength or a few popular memories displace the best match (0.04 strength cost top-1
// hits; 0.06 reads let 20 popular unrelated memories take three top-1 places). At these values neither did.
export const STRENGTH_WEIGHT = 0.015, READ_WEIGHT = 0.03;
const CONSOLE_AGENT = 'mnemuron-console', DAY = 86_400_000, BATCH = 400;

/** strength term in [-0.8, 1]: 0 at the default strength 5. */
export const strengthTerm = strength => Number.isInteger(strength) ? (Math.min(10, Math.max(1, strength)) - 5) / 5 : 0;
/** read term in [0, 1]: log-scaled decayed read count, full at READS_FOR_FULL_WEIGHT fresh reads. */
export const readTerm = reads => reads > 0 ? Math.min(1, Math.log2(1 + reads) / Math.log2(1 + READS_FOR_FULL_WEIGHT)) : 0;

export class MemorySalience {
  constructor(db) {
    this.db = db;
    // Reads are looked up per candidate memory; the audit log is otherwise indexed only by time.
    db.exec(`CREATE INDEX IF NOT EXISTS audit_memory_read_targets ON audit_events(target_id, created_at) WHERE action='memory.read'`);
  }
  /** Map memory_id -> {strength, reads, strength_term, read_term, factor}; factor multiplies a within-tier score. */
  of(userId, memoryIds, now = Date.now()) {
    const ids = [...new Set(memoryIds)], out = new Map(), since = new Date(now - READ_WINDOW_DAYS * DAY).toISOString();
    const strength = new Map(), reads = new Map();
    for (let i = 0; i < ids.length; i += BATCH) {
      const part = ids.slice(i, i + BATCH), marks = part.map(() => '?').join(',');
      for (const row of this.db.prepare(`SELECT memory_id, strength FROM memory_traits WHERE user_id=? AND memory_id IN (${marks})`).all(userId, ...part))
        strength.set(row.memory_id, row.strength);
      for (const row of this.db.prepare(`SELECT a.target_id id, a.created_at at FROM audit_events a JOIN credentials c ON c.credential_id=a.credential_id
          WHERE a.action='memory.read' AND a.target_type='memory' AND a.user_id=? AND a.target_id IN (${marks}) AND a.created_at>? AND c.agent_id<>?`)
        .all(userId, ...part, since, CONSOLE_AGENT)) {
        const age = Math.max(0, (now - Date.parse(row.at)) / DAY);
        reads.set(row.id, (reads.get(row.id) || 0) + 0.5 ** (age / READ_HALF_LIFE_DAYS));
      }
    }
    for (const id of ids) {
      const s = strengthTerm(strength.get(id)), r = readTerm(reads.get(id) || 0);
      out.set(id, { strength: strength.get(id) ?? null, reads: Number((reads.get(id) || 0).toFixed(3)), strength_term: s, read_term: Number(r.toFixed(4)),
        factor: 1 + STRENGTH_WEIGHT * s + READ_WEIGHT * r });
    }
    return out;
  }
}
