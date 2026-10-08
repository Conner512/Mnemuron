import {protectGroup} from '../lifecycle/protection.mjs';
// Additive schema only. Opening a database never creates extraction jobs for old memories.
export function migrateEntities(db){db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entities(entity_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,anchor_memory_id TEXT NOT NULL,
      anchor_revision INTEGER NOT NULL,anchor_state_hash TEXT NOT NULL,scope_key TEXT NOT NULL,kind TEXT NOT NULL,label TEXT NOT NULL,origin TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS memory_entities_owner ON memory_entities(user_id,scope_key,entity_id);
    CREATE TABLE IF NOT EXISTS memory_entity_names(name_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,entity_id TEXT NOT NULL,name TEXT NOT NULL,normalized TEXT NOT NULL,
      origin TEXT NOT NULL,state TEXT NOT NULL,proof_json TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS memory_entity_names_owner ON memory_entity_names(user_id,normalized,entity_id);
    CREATE TABLE IF NOT EXISTS memory_entity_members(user_id TEXT NOT NULL,entity_id TEXT NOT NULL,memory_id TEXT NOT NULL,proof_json TEXT NOT NULL,
      origin TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(user_id,entity_id,memory_id));
    CREATE TABLE IF NOT EXISTS memory_entity_proposals(proposal_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,source_entity_id TEXT NOT NULL,target_entity_id TEXT,
      name_id TEXT,relation TEXT NOT NULL,state TEXT NOT NULL,proof_json TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS memory_entity_proposals_owner ON memory_entity_proposals(user_id,source_entity_id,state);
    CREATE TABLE IF NOT EXISTS memory_entity_tombstones(user_id TEXT NOT NULL,tombstone_key TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(user_id,tombstone_key));
    CREATE TABLE IF NOT EXISTS memory_entity_queue_cursor(user_id TEXT PRIMARY KEY,after_rowid INTEGER NOT NULL DEFAULT 0);
  `);protectGroup(db,'entities');}
