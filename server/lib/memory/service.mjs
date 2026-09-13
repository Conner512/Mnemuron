import { randomUUID } from 'node:crypto';
import { resolveMemoryScope } from '../memory-scope.mjs';
import { exactText, fingerprint, FINGERPRINT_VERSION } from './revisions.mjs';
import { labeledStatements, legacyFingerprint, EXTRACTION_VERSION } from './rules.mjs';

export class MemoryService {
  constructor({db, revisions, transaction, project, audit}) { Object.assign(this,{db,revisions,transaction,project,audit}); }
  derive(auth, events, origin = null) {
    const candidates = labeledStatements(events), created=[], existing=[];
    return this.transaction(() => {
      for (const c of candidates) {
        const event = c.event;
        const context = {user_id:auth.user_id,memory_type:c.memory_type,project_id:event.project_id || origin?.project_id || null,
          task_id:event.task_id || origin?.task_id || null,workstream_id:event.workstream_id || origin?.workstream_id || null,
          session_id:event.session_id || origin?.session_id || null};
        context.scope = context.workstream_id?'workstream':context.task_id?'task':context.project_id?'project':context.session_id?'session':'user';
        Object.assign(context,resolveMemoryScope(this.db,auth.user_id,context,{write:true}));
        const fp = fingerprint(context,c.content,c.topic);
        let row = this.db.prepare(`SELECT m.* FROM memory_fingerprints f JOIN memories m ON m.user_id=f.user_id AND m.memory_id=f.memory_id
          WHERE f.user_id=? AND f.fingerprint_version=? AND f.fingerprint=?`).get(auth.user_id,FINGERPRINT_VERSION,fp);
        if (!row) {
          const legacy = this.db.prepare('SELECT * FROM memories WHERE user_id=? AND content_fingerprint=?').get(auth.user_id,legacyFingerprint(context,c.content,c.topic));
          if (legacy && exactText(legacy.content)===c.content && exactText(legacy.topic)===exactText(c.topic)
            && JSON.parse(legacy.source_event_ids_json || '[]').includes(event.event_id)) row=legacy;
        }
        const fresh = !row;
        if (fresh) {
          const id = randomUUID(), timestamp = new Date().toISOString(), user = event.event_type==='user_message';
          const warnings = user?[]:['Assistant-authored memory has not been promoted to canonical Task state.'];
          this.db.prepare(`INSERT INTO memories (memory_id,user_id,credential_id,device_id,agent_id,agent_instance_id,content,
            scope,project_id,task_id,workstream_id,session_id,source,memory_type,status,source_event_ids_json,source_checkpoint_id,
            generation_method,confidence,confidence_label,warnings_json,content_fingerprint,topic,topic_key,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?,?,?,?,?,?,?,?)`).run(id,auth.user_id,event.credential_id || auth.credential_id,
            event.device_id,event.agent_id,event.agent_instance_id,c.content,context.scope,context.project_id,context.task_id,
            context.workstream_id,context.session_id,origin?'checkpoint_derived':'capture_derived',c.memory_type,JSON.stringify([event.event_id]),
            origin?.checkpoint_id || null,EXTRACTION_VERSION,user?0.95:0.75,user?'high':'medium',JSON.stringify(warnings),fp,c.topic,
            c.topic ? c.topic.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu,' ').trim() : null,timestamp,timestamp);
          row=this.db.prepare('SELECT * FROM memories WHERE memory_id=?').get(id);
          this.audit({auth,action:'memory.derive',targetType:'memory',targetId:id,metadata:{source_event_ids:[event.event_id],generation_method:EXTRACTION_VERSION}});
        }
        this.db.prepare('INSERT OR IGNORE INTO memory_fingerprints VALUES (?,?,?,?)').run(auth.user_id,FINGERPRINT_VERSION,fp,row.memory_id);
        const revision=this.revisions.record(row,fresh?'source_extraction':'source_replay');
        this.revisions.linkEvent(row,revision,event.event_id,{start:c.start,end:c.end,version:EXTRACTION_VERSION,selector:c.selector});
        (fresh?created:existing).push(this.project(row));
      }
      return {schema_version:'automatic-structured-memory-v0.1',fingerprint_version:FINGERPRINT_VERSION,
        extracted:candidates.length,created:created.length,existing:existing.length,memories:created,
        canonical_task_state_overwritten:false,automatic_merge_performed:false};
    });
  }
}
