import { ValidationError } from './errors.mjs';
import { memoryScopeSql } from './memory-scope.mjs';

export const INDEX_VERSION = 'memory-search-v1';
export const normalizeSearch = value => String(value ?? '').normalize('NFKC').toLowerCase();
export function searchTokens(value) {
  const text = normalizeSearch(value), tokens = new Set();
  for (const word of text.match(/[\p{L}\p{N}]+(?:[._:/-][\p{L}\p{N}]+)*/gu) || []) {
    if (/\p{Script=Han}/u.test(word)) {
      const chars = Array.from(word);
      chars.forEach((char, i) => { tokens.add(char); if (chars[i+1]) tokens.add(char + chars[i+1]); });
    } else tokens.add(word);
  }
  for (const symbol of text.match(/\p{S}/gu) || []) tokens.add(symbol);
  return [...tokens];
}
const encode = token => 't' + Buffer.from(token).toString('hex');
const indexText = text => searchTokens(text).map(encode).join(' ');
export function lexicalScore(query, memory) {
  const text = normalizeSearch(`${memory.content}\n${memory.topic || ''}`), normalized = normalizeSearch(query.trim());
  if (text.includes(normalized)) return 1;
  const tokens = searchTokens(query), present = new Set(searchTokens(text));
  return tokens.length ? tokens.filter(token => present.has(token)).length / tokens.length * 0.8 : 0;
}
export const searchUnavailable = () => Object.assign(new Error('Memory search index is unavailable; rebuild or enable it before querying.'), {statusCode:503,errorCode:'SEARCH_UNAVAILABLE'});

export class MemorySearch {
  constructor(db, { enabled = true } = {}) {
    this.db = db;
    this.enabled = enabled;
    db.function('memory_search_tokens', {deterministic:true}, indexText);
    db.function('memory_search_normalize', {deterministic:true}, normalizeSearch);
    this.state = 'unavailable';
    try { this.initialize(); } catch { this.state = 'unavailable'; }
  }
  initialize() {
    const db=this.db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_search_state (id INTEGER PRIMARY KEY CHECK(id=1), version TEXT NOT NULL, state TEXT NOT NULL);
      INSERT OR IGNORE INTO memory_search_state VALUES(1,'${INDEX_VERSION}','building');
      CREATE TABLE IF NOT EXISTS memory_search_docs (doc_id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL UNIQUE REFERENCES memories(memory_id) ON DELETE CASCADE, normalized TEXT NOT NULL, tokens TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_search_fts USING fts5(tokens, content='memory_search_docs',content_rowid='doc_id');
      CREATE TRIGGER IF NOT EXISTS memory_search_doc_insert AFTER INSERT ON memory_search_docs BEGIN
        INSERT INTO memory_search_fts(rowid,tokens) VALUES(new.doc_id,new.tokens); END;
      CREATE TRIGGER IF NOT EXISTS memory_search_doc_delete AFTER DELETE ON memory_search_docs BEGIN
        INSERT INTO memory_search_fts(memory_search_fts,rowid,tokens) VALUES('delete',old.doc_id,old.tokens); END;
      CREATE TRIGGER IF NOT EXISTS memory_search_doc_update AFTER UPDATE ON memory_search_docs BEGIN
        INSERT INTO memory_search_fts(memory_search_fts,rowid,tokens) VALUES('delete',old.doc_id,old.tokens);
        INSERT INTO memory_search_fts(rowid,tokens) VALUES(new.doc_id,new.tokens); END;
      CREATE TRIGGER IF NOT EXISTS memory_search_insert AFTER INSERT ON memories BEGIN
        INSERT INTO memory_search_docs(memory_id,normalized,tokens) VALUES(new.memory_id,memory_search_normalize(new.content || char(10) || coalesce(new.topic,'')),memory_search_tokens(new.content || char(10) || coalesce(new.topic,''))); END;
      CREATE TRIGGER IF NOT EXISTS memory_search_update AFTER UPDATE OF content,topic ON memories BEGIN
        INSERT INTO memory_search_docs(memory_id,normalized,tokens) VALUES(new.memory_id,memory_search_normalize(new.content || char(10) || coalesce(new.topic,'')),memory_search_tokens(new.content || char(10) || coalesce(new.topic,'')))
        ON CONFLICT(memory_id) DO UPDATE SET normalized=excluded.normalized,tokens=excluded.tokens; END;
      CREATE TRIGGER IF NOT EXISTS memory_search_delete AFTER DELETE ON memories BEGIN
        DELETE FROM memory_search_docs WHERE memory_id=old.memory_id; END;
    `);
    const state=db.prepare('SELECT * FROM memory_search_state WHERE id=1').get();
    if (state.state!=='ready' || state.version!==INDEX_VERSION || !this.validate()) this.rebuild();
    this.state='ready';
  }
  validate() {
    try {
      const mismatch=this.db.prepare(`SELECT 1 FROM memories m LEFT JOIN memory_search_docs d USING(memory_id)
        WHERE d.doc_id IS NULL OR d.normalized != memory_search_normalize(m.content || char(10) || coalesce(m.topic,''))
        OR d.tokens != memory_search_tokens(m.content || char(10) || coalesce(m.topic,'')) LIMIT 1`).get();
      this.db.exec("INSERT INTO memory_search_fts(memory_search_fts,rank) VALUES('integrity-check',1)");
      const orphan=this.db.prepare('SELECT 1 FROM memory_search_docs d LEFT JOIN memories m USING(memory_id) WHERE m.memory_id IS NULL LIMIT 1').get();
      return !mismatch && !orphan;
    } catch { return false; }
  }
  rebuild({afterBatch = () => {}} = {}) {
    const db=this.db;
    this.state='building';
    db.prepare("UPDATE memory_search_state SET state='building' WHERE id=1").run();
    let after='';
    try {
      // Recreate a dropped/corrupt FTS projection before update triggers delete old tokens.
      db.exec("INSERT INTO memory_search_fts(memory_search_fts) VALUES('rebuild')");
      db.exec('DELETE FROM memory_search_docs WHERE memory_id NOT IN (SELECT memory_id FROM memories)');
      for (;;) {
        const rows=db.prepare('SELECT memory_id,content,topic FROM memories WHERE memory_id>? ORDER BY memory_id LIMIT 250').all(after);
        if (!rows.length) break;
        db.exec('BEGIN IMMEDIATE');
        try {
          const insert=db.prepare(`INSERT INTO memory_search_docs(memory_id,normalized,tokens) VALUES(?,?,?) ON CONFLICT(memory_id) DO UPDATE SET normalized=excluded.normalized,tokens=excluded.tokens`);
          for (const row of rows) { const text=`${row.content}\n${row.topic || ''}`; insert.run(row.memory_id,normalizeSearch(text),indexText(text)); }
          db.exec('COMMIT');
        } catch(error) { db.exec('ROLLBACK'); throw error; }
        after=rows.at(-1).memory_id;
        afterBatch(after);
      }
      db.exec("INSERT INTO memory_search_fts(memory_search_fts) VALUES('rebuild')");
      if (!this.validate()) throw searchUnavailable();
      db.prepare("UPDATE memory_search_state SET state='ready',version=? WHERE id=1").run(INDEX_VERSION);
      this.state='ready';
    } catch(error) { this.state='unavailable'; throw error; }
  }
  status() {
    try {
      const row=this.db.prepare('SELECT * FROM memory_search_state WHERE id=1').get();
      const tables=this.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('memory_search_fts','memory_search_docs','memory_search_insert','memory_search_update','memory_search_delete','memory_search_doc_insert','memory_search_doc_update','memory_search_doc_delete')").get();
      return {index_version:INDEX_VERSION,state:this.enabled && this.state==='ready' && row?.state==='ready' && tables.n===8 ? 'ready':'unavailable',enabled:this.enabled};
    } catch { return {index_version:INDEX_VERSION,state:'unavailable',enabled:this.enabled}; }
  }
  candidates(userId, query, scope, options) {
    if (this.status().state!=='ready') throw searchUnavailable();
    const tokens=searchTokens(query);
    if(tokens.length>64) throw new ValidationError('Query exceeds the 64 search-term budget.','QUERY_TOO_COMPLEX');
    const filter=memoryScopeSql(scope,options);
    if(!tokens.length) return {rows:[],truncated:false};
    try {
      const rows=this.db.prepare(`SELECT m.* FROM memory_search_fts
        JOIN memory_search_docs d ON d.doc_id=memory_search_fts.rowid JOIN memories m USING(memory_id)
        WHERE memory_search_fts MATCH ? AND m.user_id=? AND ${filter.sql}
        AND m.status IN (${options.statuses.map(()=>'?').join(',')}) AND m.memory_type IN (${options.memoryTypes.map(()=>'?').join(',')})
        ORDER BY (instr(d.normalized,?)>0) DESC, memory_search_fts.rank, coalesce(m.updated_at,m.created_at) DESC,m.memory_id LIMIT 501`
      ).all(tokens.map(token=>'"'+encode(token)+'"').join(' OR '),userId,...filter.params,...options.statuses,...options.memoryTypes,normalizeSearch(query.trim()));
      return {rows:rows.slice(0,500),truncated:rows.length>500};
    } catch { this.state='unavailable'; throw searchUnavailable(); }
  }
}
