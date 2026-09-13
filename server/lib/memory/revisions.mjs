import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const FINGERPRINT_VERSION = 'structured-memory-exact-v2';
export const exactText = value => String(value ?? '').trim();
export function fingerprint(context, content, topic = null) {
  return hash(JSON.stringify([FINGERPRINT_VERSION, context.user_id, context.scope, context.project_id || null,
    context.task_id || null, context.workstream_id || null, context.scope === 'session' ? context.session_id : null,
    context.memory_type, exactText(topic), exactText(content)]));
}
const json = value => JSON.stringify(value);
const parse = (value, fallback) => value ? JSON.parse(value) : fallback;

export class MemoryRevisions {
  constructor(db) { this.db = db; }
  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_revisions (
        user_id TEXT NOT NULL, memory_id TEXT NOT NULL, revision INTEGER NOT NULL, content TEXT NOT NULL,
        content_hash TEXT NOT NULL, state_hash TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL,
        evidence_kind TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(user_id,memory_id,revision));
      CREATE TABLE IF NOT EXISTS memory_sources (
        user_id TEXT NOT NULL, source_id TEXT NOT NULL, source_kind TEXT NOT NULL, source_event_id TEXT,
        content_hash TEXT, content_length INTEGER, source_status TEXT NOT NULL, role TEXT,
        captured_at TEXT, content_ref TEXT NOT NULL, PRIMARY KEY(user_id,source_id));
      CREATE TABLE IF NOT EXISTS memory_source_links (
        user_id TEXT NOT NULL, memory_id TEXT NOT NULL, revision INTEGER NOT NULL, source_id TEXT NOT NULL,
        span_start INTEGER NOT NULL DEFAULT -1, span_end INTEGER NOT NULL DEFAULT -1, extraction_version TEXT NOT NULL,
        text_selector TEXT, span_unit TEXT NOT NULL DEFAULT 'unknown',
        PRIMARY KEY(user_id,memory_id,revision,source_id,span_start,span_end,extraction_version));
      CREATE TABLE IF NOT EXISTS memory_fingerprints (
        user_id TEXT NOT NULL, fingerprint_version TEXT NOT NULL, fingerprint TEXT NOT NULL, memory_id TEXT NOT NULL,
        PRIMARY KEY(user_id,fingerprint_version,fingerprint));
      CREATE TABLE IF NOT EXISTS memory_processing_outbox (
        user_id TEXT NOT NULL, memory_id TEXT NOT NULL, revision INTEGER NOT NULL, job_type TEXT NOT NULL,
        state TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(user_id,memory_id,revision,job_type));
      CREATE TABLE IF NOT EXISTS memory_index_outbox (
        user_id TEXT NOT NULL, memory_id TEXT NOT NULL, revision INTEGER NOT NULL, action TEXT NOT NULL,
        content_hash TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(user_id,memory_id,revision));
    `);
    const columns = new Set(this.db.prepare('PRAGMA table_info(memory_source_links)').all().map(column=>column.name));
    if (!columns.has('text_selector')) this.db.exec('ALTER TABLE memory_source_links ADD COLUMN text_selector TEXT');
    if (!columns.has('span_unit')) this.db.exec("ALTER TABLE memory_source_links ADD COLUMN span_unit TEXT NOT NULL DEFAULT 'unknown'");
    let after = 0;
    for (;;) {
      const rows = this.db.prepare('SELECT rowid AS cursor_id,* FROM memories WHERE rowid>? ORDER BY rowid LIMIT 100').all(after);
      if (!rows.length) break;
      for (const row of rows) {
        const current = this.latest(row.user_id,row.memory_id);
        if (!current) {
          const revision = this.record(row, 'migration_baseline', { enqueue:false });
          const ids = parse(row.source_event_ids_json, []);
          if (ids.length) for (const eventId of ids) this.linkEvent(row, revision, eventId, {version:'legacy-unknown-span'});
          else if (row.source === 'explicit' || row.generation_method?.startsWith('explicit-')) this.linkExplicit(row,revision);
          if (row.content_fingerprint) this.db.prepare('INSERT OR IGNORE INTO memory_fingerprints VALUES (?,?,?,?)')
            .run(row.user_id,'legacy-v1',row.content_fingerprint,row.memory_id);
        }
      }
      after = rows.at(-1).cursor_id;
    }
  }
  latest(userId, memoryId) { return this.db.prepare('SELECT * FROM memory_revisions WHERE user_id=? AND memory_id=? ORDER BY revision DESC LIMIT 1').get(userId,memoryId); }
  record(row, reason, {enqueue = true} = {}) {
    const stateHash = hash(json([row.content,row.status,row.scope,row.project_id,row.task_id,row.workstream_id,row.session_id,
      row.memory_type,row.topic,row.supersedes_memory_id,row.superseded_by_memory_id,row.lifecycle_reason]));
    const previous = this.latest(row.user_id,row.memory_id);
    if (previous?.state_hash === stateHash) return previous.revision;
    const revision = (previous?.revision || 0) + 1, contentHash = hash(row.content);
    const events = parse(row.source_event_ids_json, []).map(id=>this.db.prepare('SELECT event_type FROM events WHERE user_id=? AND event_id=?').get(row.user_id,id));
    const evidence = row.generation_method?.startsWith('explicit-') ? 'explicit_user_assertion'
      : events.length && events.every(event=>event?.event_type==='user_message') ? 'observed_user_statement'
      : events.length && events.every(event=>event?.event_type==='assistant_message') ? 'assistant_suggestion' : 'unverified_inference';
    this.db.prepare('INSERT INTO memory_revisions VALUES (?,?,?,?,?,?,?,?,?,?)').run(row.user_id,row.memory_id,revision,row.content,
      contentHash,stateHash,row.status,reason,evidence,row.updated_at || row.created_at);
    if (previous) this.db.prepare(`INSERT INTO memory_source_links SELECT user_id,memory_id,?,source_id,span_start,span_end,extraction_version,text_selector,span_unit
      FROM memory_source_links WHERE user_id=? AND memory_id=? AND revision=?`).run(revision,row.user_id,row.memory_id,previous.revision);
    if (enqueue) {
      for (const job of ['classification','summary']) this.db.prepare('INSERT INTO memory_processing_outbox VALUES (?,?,?,?,?,?,?)')
        .run(row.user_id,row.memory_id,revision,job,'blocked_config',contentHash,new Date().toISOString());
      this.db.prepare('INSERT INTO memory_index_outbox VALUES (?,?,?,?,?,?)').run(row.user_id,row.memory_id,revision,row.status==='active'?'upsert':'hide',contentHash,'disabled');
    }
    return revision;
  }
  linkExplicit(row, revision) {
    const sourceId = 'explicit:' + row.memory_id;
    this.db.prepare('INSERT OR IGNORE INTO memory_sources VALUES (?,?,?,?,?,?,?,?,?,?)').run(row.user_id,sourceId,'explicit_memory',null,
      hash(row.content),Array.from(row.content).length,'available','caller_submitted',row.created_at,'memory:' + row.memory_id + ':1');
    this.db.prepare('INSERT OR IGNORE INTO memory_source_links VALUES (?,?,?,?,?,?,?,?,?)').run(row.user_id,row.memory_id,revision,sourceId,0,row.content.length,'explicit-v1','$','utf16_code_units');
  }
  linkEvent(row, revision, eventId, {start = -1, end = -1, version = FINGERPRINT_VERSION, selector = null} = {}) {
    const event = this.db.prepare('SELECT * FROM events WHERE user_id=? AND event_id=?').get(row.user_id,eventId);
    const sourceId = 'event:' + eventId;
    this.db.prepare('INSERT OR IGNORE INTO memory_sources VALUES (?,?,?,?,?,?,?,?,?,?)').run(row.user_id,sourceId,'captured_event',eventId,
      event?.content == null ? null : hash(event.content),event?.content == null ? null : Buffer.byteLength(event.content),
      event?.content == null ? 'unavailable' : 'available',event?.event_type || 'unknown',event?.captured_at || null,'event:' + eventId);
    this.db.prepare('INSERT OR IGNORE INTO memory_source_links VALUES (?,?,?,?,?,?,?,?,?)').run(row.user_id,row.memory_id,revision,sourceId,start,end,version,selector,selector===null?'unknown':'utf16_code_units');
  }
  detail(userId, memoryId, {offset = 0, limit = 100} = {}) {
    const current = this.latest(userId,memoryId);
    if (!current) return null;
    const rows = this.db.prepare(`SELECT s.*,l.span_start,l.span_end,l.extraction_version,l.text_selector,l.span_unit FROM memory_source_links l JOIN memory_sources s
      ON s.user_id=l.user_id AND s.source_id=l.source_id WHERE l.user_id=? AND l.memory_id=? AND l.revision=?
      ORDER BY l.source_id,l.span_start LIMIT ? OFFSET ?`).all(userId,memoryId,current.revision,limit+1,offset);
    const sources = rows.slice(0,limit).map(row => {
      let availability = row.source_status;
      if (row.source_event_id) {
        const event = this.db.prepare('SELECT content,expires_at,expired_at FROM events WHERE user_id=? AND event_id=?').get(userId,row.source_event_id);
        const pinned=this.db.prepare('SELECT 1 FROM memory_source_pins WHERE user_id=? AND event_id=?').get(userId,row.source_event_id);
        availability = !event?.content ? 'unavailable' : event.expired_at || !pinned && event.expires_at && Date.parse(event.expires_at)<=Date.now() ? 'expired' : 'available';
        if (availability==='available' && row.content_hash !== hash(event.content)) availability='hash_mismatch';
      }
      return {...row, user_id:undefined,source_status:availability,source_revision:1,
        span_available:row.span_start>=0 && row.text_selector!==null && row.span_unit!=='unknown',
        content_length_unit:row.source_kind==='captured_event'?'utf8_json_bytes':'unicode_code_points'};
    });
    return {revision:current.revision,content_hash:current.content_hash,evidence_kind:current.evidence_kind,
      independently_fact_checked:false, sources,next_source_offset:rows.length>limit?offset+limit:null};
  }
}
