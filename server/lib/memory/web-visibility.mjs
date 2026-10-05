import {createHash} from 'node:crypto';
import {consoleMemoryWritable} from '../../../shared/console-contract.mjs';
import {ConflictError,NotFoundError,ValidationError} from '../errors.mjs';

export const WEB_READ_POLICY = 'web-memory-visibility-v1';
// Activated only by the runtime config key memory.agent_read_policy (see memory-runtime.mjs).
export const WEB_READ_POLICY_ACTIVE_UNIFORM = 'web-memory-active-uniform-v1';
export const AGENT_READ_POLICIES = Object.freeze({chatgpt_per_memory_v1:WEB_READ_POLICY,active_uniform_v1:WEB_READ_POLICY_ACTIVE_UNIFORM});
export const isWebReader = auth => auth?.agent_id === 'chatgpt-web';
/** The read policy bound to a ChatGPT credential at authentication. Anything else keeps the per-memory filter. */
export const webReadPolicy = auth => auth?.read_policy === WEB_READ_POLICY_ACTIVE_UNIFORM ? WEB_READ_POLICY_ACTIVE_UNIFORM : WEB_READ_POLICY;

const currentGrantSql=alias=>`EXISTS (SELECT 1 FROM memory_web_grants wg JOIN memory_revisions wr
  ON wr.user_id=wg.user_id AND wr.memory_id=wg.memory_id AND wr.revision=wg.revision AND wr.state_hash=wg.state_hash
  WHERE wg.user_id=${alias}.user_id AND wg.memory_id=${alias}.memory_id
  AND wg.sensitivity=COALESCE((SELECT sensitivity FROM memory_privacy wp WHERE wp.user_id=${alias}.user_id AND wp.memory_id=${alias}.memory_id),'sensitive')
  AND wr.content=${alias}.content AND wr.status=${alias}.status
  AND wr.revision=(SELECT MAX(revision) FROM memory_revisions WHERE user_id=wg.user_id AND memory_id=wg.memory_id))`;

// Destination comes from the authenticated credential, never from a tool argument or header.
// Internal/sensitive records need a grant for their current revision, unless the owner switched
// ChatGPT reads to all records (memory_web_policy.read_all). Explicit denials always win.
// A denial retains its reviewed version as evidence, but never expires on a version change.
//
// Active-uniform policy: an ACTIVE, non-secret record is readable like it is for every other agent of the
// account. Superseded/retracted history and every secret record keep the per-memory rules below, so legacy
// denials and secret exclusions still hide them (including include_history-style status filters).
export function webMemorySql(auth, alias='m') {
  if (!isWebReader(auth)) return '1=1';
  const legacy = legacyWebMemorySql(alias);
  if (webReadPolicy(auth) !== WEB_READ_POLICY_ACTIVE_UNIFORM) return legacy;
  return `((${alias}.status='active' AND COALESCE((SELECT sensitivity FROM memory_privacy wp WHERE wp.user_id=${alias}.user_id AND wp.memory_id=${alias}.memory_id),'sensitive')<>'secret') OR ${legacy})`;
}
function legacyWebMemorySql(alias) {
  return `(NOT EXISTS (SELECT 1 FROM memory_web_denials wd WHERE wd.user_id=${alias}.user_id AND wd.memory_id=${alias}.memory_id)
    AND (EXISTS (SELECT 1 FROM memory_privacy wp WHERE wp.user_id=${alias}.user_id AND wp.memory_id=${alias}.memory_id AND wp.sensitivity='public')
    OR (COALESCE((SELECT sensitivity FROM memory_privacy wp WHERE wp.user_id=${alias}.user_id AND wp.memory_id=${alias}.memory_id),'sensitive') IN ('internal','sensitive')
      AND (EXISTS (SELECT 1 FROM memory_web_policy wpol WHERE wpol.user_id=${alias}.user_id AND wpol.read_all=1)
      OR ${currentGrantSql(alias)}))))`;
}

export class WebMemoryVisibility {
  constructor(store) {
    this.store=store;this.db=store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS memory_web_grants (user_id TEXT NOT NULL,memory_id TEXT NOT NULL,
      revision INTEGER NOT NULL,state_hash TEXT NOT NULL,sensitivity TEXT NOT NULL,PRIMARY KEY(user_id,memory_id));
      CREATE TABLE IF NOT EXISTS memory_web_policy (user_id TEXT PRIMARY KEY,read_all INTEGER NOT NULL CHECK(read_all IN (0,1)),
        revision INTEGER NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_web_denials (user_id TEXT NOT NULL,memory_id TEXT NOT NULL,
        revision INTEGER NOT NULL,state_hash TEXT NOT NULL,PRIMARY KEY(user_id,memory_id));
      CREATE TRIGGER IF NOT EXISTS memory_web_revoke_privacy_insert AFTER INSERT ON memory_privacy BEGIN
        DELETE FROM memory_web_grants WHERE user_id=NEW.user_id AND memory_id=NEW.memory_id; END;
      CREATE TRIGGER IF NOT EXISTS memory_web_revoke_privacy_update AFTER UPDATE ON memory_privacy BEGIN
        DELETE FROM memory_web_grants WHERE user_id=NEW.user_id AND memory_id=NEW.memory_id; END;
      CREATE TRIGGER IF NOT EXISTS memory_web_revoke_revision AFTER INSERT ON memory_revisions BEGIN
        DELETE FROM memory_web_grants WHERE user_id=NEW.user_id AND memory_id=NEW.memory_id; END;
      CREATE TRIGGER IF NOT EXISTS memory_web_revoke_change AFTER UPDATE ON memories BEGIN
        DELETE FROM memory_web_grants WHERE user_id=NEW.user_id AND memory_id=NEW.memory_id; END;`);
  }
  denied(user,id){return !!this.db.prepare('SELECT 1 FROM memory_web_denials WHERE user_id=? AND memory_id=?').get(user,id);}
  // Called inside the owning memory transaction; grants and denials cannot disagree at commit.
  keepPrivate(user,id,revision){
    this.db.prepare('INSERT OR REPLACE INTO memory_web_denials VALUES(?,?,?,?)').run(user,id,revision.revision,revision.state_hash);
    this.db.prepare('DELETE FROM memory_web_grants WHERE user_id=? AND memory_id=?').run(user,id);
  }
  inheritPrivate(user,from,to){
    if(this.denied(user,from))this.keepPrivate(user,to,this.store.revisions.latest(user,to));
  }
  migrateCloudPrivateChoices({markEmpty=false}={}){
    this.store.memoryTransaction(()=>{
      if(this.db.prepare("SELECT 1 FROM settings WHERE key='cloud_private_denials_v1'").get())return;
      // Untouched pre-cloud databases retain their original settings byte-for-byte.
      if(!markEmpty&&!this.db.prepare('SELECT 1 FROM cloud_memory_operations LIMIT 1').get())return;
      // Receipts are immutable commit snapshots. Restore their explicit choice, including local
      // replacements, without revoking a later exact-version grant or rewriting any receipt.
      this.db.exec(`WITH RECURSIVE private_memories(user_id,memory_id) AS (
        SELECT m.user_id,m.memory_id FROM cloud_memory_operations op JOIN memories m
          ON m.user_id=op.user_id AND m.memory_id=json_extract(op.receipt_json,'$.memory_id')
        WHERE op.action IN ('memory.save','memory.supersede')
          AND json_extract(op.receipt_json,'$.cloud_read_choice')='keep_private'
          AND json_extract(op.receipt_json,'$.status')='committed'
        UNION
        SELECT m.user_id,m.memory_id FROM memories m JOIN private_memories p
          ON m.user_id=p.user_id AND m.supersedes_memory_id=p.memory_id
      ) INSERT OR IGNORE INTO memory_web_denials
        SELECT p.user_id,p.memory_id,r.revision,r.state_hash FROM private_memories p JOIN memory_revisions r
          ON r.user_id=p.user_id AND r.memory_id=p.memory_id
        JOIN memories m ON m.user_id=p.user_id AND m.memory_id=p.memory_id
        WHERE r.revision=(SELECT MAX(revision) FROM memory_revisions WHERE user_id=p.user_id AND memory_id=p.memory_id)
          AND NOT ${currentGrantSql('m')}`);
      this.db.prepare('INSERT INTO settings(key,value_json,updated_at) VALUES(?,?,?)').run('cloud_private_denials_v1','true',new Date().toISOString());
    });
  }
  /** Account-level ChatGPT read scope. Off: explicit per-revision grants only. */
  policy(auth) {
    const row=this.db.prepare('SELECT read_all,revision FROM memory_web_policy WHERE user_id=?').get(auth.user_id);
    return {read_all:row?.read_all===1,revision:row?.revision||0,policy:WEB_READ_POLICY};
  }
  setPolicy(auth,{read_all,expected_revision}={}) {
    if(!consoleMemoryWritable(auth))this.store.requireScope(auth,'admin:tasks');
    if(typeof read_all!=='boolean'||!Number.isSafeInteger(expected_revision)||expected_revision<0)
      throw new ValidationError('An explicit read_all choice and the reviewed policy revision are required.');
    return this.store.memoryTransaction(()=>{
      const current=this.policy(auth);
      if(current.revision!==expected_revision)throw new ConflictError('The ChatGPT read policy changed; review it again.','SETTINGS_VERSION_CHANGED');
      const revision=current.revision+1;
      this.db.prepare(`INSERT INTO memory_web_policy VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET
        read_all=excluded.read_all,revision=excluded.revision,updated_at=excluded.updated_at`).run(auth.user_id,read_all?1:0,revision,new Date().toISOString());
      this.store.audit({auth,action:'memory.web_policy',targetType:'user',targetId:auth.user_id,metadata:{read_all,revision}});
      return {read_all,revision,policy:WEB_READ_POLICY};
    });
  }
  visible(auth,id) {
    return !!this.db.prepare(`SELECT 1 FROM memories m WHERE m.user_id=? AND m.memory_id=? AND ${webMemorySql(auth)}`).get(auth.user_id,id);
  }
  project(auth,memory) {
    const revision=this.db.prepare('SELECT MAX(revision) revision FROM memory_revisions WHERE user_id=? AND memory_id=?').get(auth.user_id,memory.memory_id)?.revision;
    return webMemoryProjection({...memory,revision:revision ?? null});
  }
  list(auth,{limit=20,after}={}) {
    if(!consoleMemoryWritable(auth))this.store.requireScope(auth,'admin:tasks');
    if(!Number.isSafeInteger(limit) || limit<1 || limit>100 || (after!==undefined && (typeof after!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(after))))throw new ValidationError('Invalid grant inventory page.');
    const rows=this.db.prepare('SELECT memory_id FROM memory_web_grants WHERE user_id=? AND memory_id>? ORDER BY memory_id LIMIT ?').all(auth.user_id,after || '',limit+1);
    const grants=rows.slice(0,limit).map(row=>this.inspect(auth,row.memory_id));
    return {grants,selection:'explicit_grants_only',public_records_not_listed:true,content_returned:false,
      next_request:rows.length>limit?{limit,after:grants.at(-1).memory_id}:null};
  }
  inspect(auth,id) {
    if(!consoleMemoryWritable(auth))this.store.requireScope(auth,'admin:tasks');
    const current=this.store.revisions.latest(auth.user_id,id);
    if(!current)throw new NotFoundError('Memory not found.','MEMORY_NOT_FOUND');
    const sensitivity=this.db.prepare('SELECT sensitivity FROM memory_privacy WHERE user_id=? AND memory_id=?').get(auth.user_id,id)?.sensitivity || 'sensitive';
    return {memory_id:id,revision:current.revision,state_hash:current.state_hash,sensitivity,
      allowed:this.visible({...auth,agent_id:'chatgpt-web'},id),content_returned:false,policy:WEB_READ_POLICY};
  }
  set(auth,id,{allow,revision,state_hash}={}) {
    if(!consoleMemoryWritable(auth))this.store.requireScope(auth,'admin:tasks');
    if(typeof allow!=='boolean')throw new ValidationError('Explicit allow or deny is required.');
    return this.store.memoryTransaction(()=>{
      const current=this.store.revisions.latest(auth.user_id,id);
      if(!current)throw new NotFoundError('Memory not found.','MEMORY_NOT_FOUND');
      if(!Number.isSafeInteger(revision) || current.revision!==revision || current.state_hash!==state_hash)
        throw new ConflictError('Approval must match the reviewed revision and state hash.','MEMORY_VERSION_CHANGED');
      const sensitivity=this.db.prepare('SELECT sensitivity FROM memory_privacy WHERE user_id=? AND memory_id=?').get(auth.user_id,id)?.sensitivity || 'sensitive';
      if(sensitivity==='public' && !(allow && this.denied(auth.user_id,id)))throw new ValidationError('Public classification is already visible; change its classification locally to restrict it.','WEB_VISIBILITY_DENIED');
      if(allow && !['internal','sensitive','public'].includes(sensitivity))throw new ValidationError('Only internal/sensitive records need grants; secret is never eligible.','WEB_VISIBILITY_DENIED');
      if(allow){
        this.db.prepare('DELETE FROM memory_web_denials WHERE user_id=? AND memory_id=?').run(auth.user_id,id);
        if(sensitivity!=='public')this.db.prepare('INSERT OR REPLACE INTO memory_web_grants VALUES (?,?,?,?,?)').run(auth.user_id,id,revision,state_hash,sensitivity);
      }else this.keepPrivate(auth.user_id,id,current);
      this.store.audit({auth,action:'memory.web_visibility',targetType:'memory',targetId:id,metadata:{allow,revision}});
      return {memory_id:id,revision,allowed:allow,policy:WEB_READ_POLICY};
    });
  }
}

export function webMemoryProjection(memory) {
  const fields=['memory_id','revision','content','status','memory_type','created_at','updated_at','content_truncated','content_length','content_length_unit','detail_available','ranking'];
  return {...Object.fromEntries(fields.filter(key=>memory[key]!==undefined).map(key=>[key,memory[key]])),
    provenance:{source_preserved:true,details_omitted:true},independently_fact_checked:false};
}
export function webSourceProjection(source) {
  return {source_id:createHash('sha256').update(String(source.source_id)).digest('hex'),source_kind:source.source_kind,
    source_status:source.source_status,source_revision:source.source_revision,span_available:source.span_available};
}
