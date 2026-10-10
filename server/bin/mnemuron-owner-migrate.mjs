// Explicit, additive single-owner policy migration. No models, queues or record bodies are read.
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {migrateOwner} from '../lib/console/owner.mjs';
const [dbPath,configPath,user,confirm]=process.argv.slice(2);
if(confirm!=='--apply-paused'||!dbPath?.startsWith('/')||!configPath?.startsWith('/')||!user)throw new Error('Usage: node mnemuron-owner-migrate.mjs /private/core.sqlite3 /private/runtime.json user-id --apply-paused');
const c=JSON.parse(fs.readFileSync(configPath,'utf8'));
if(c.console?.worker_enabled!==false||c.jobs?.enabled!==false)throw new Error('Legacy workers must remain disabled');
if(c.console.owner_user_id&&c.console.owner_user_id!==user)throw new Error('Owner mismatch');
const db=new DatabaseSync(dbPath);db.exec('PRAGMA busy_timeout=10000; BEGIN IMMEDIATE');
try{
 if(db.prepare('PRAGMA user_version').get().user_version!==11)throw new Error('Unexpected base schema');
 if(db.prepare('SELECT COUNT(DISTINCT user_id) n FROM memories').get().n!==1||!db.prepare('SELECT 1 FROM memories WHERE user_id=?').get(user))throw new Error('Owner inventory changed');
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='owner_feature_policy'").get()&&db.prepare('SELECT 1 FROM owner_feature_policy WHERE user_id<>?').get(user))throw new Error('Different owner already bound');
 const result=migrateOwner(db,user,{memory:c.modules.memory.enabled,handoff:c.modules.handoff.enabled,capture:c.memory?.capture_extraction?.enabled,conversation:c.memory?.capture_extraction?.conversation?.enabled,
  cloud_write:c.cloud_memory?.enabled,cloud_submitted_grants:c.cloud_memory?.allow_submitted_revision_grant,connections:true,vector_search:!!db.prepare('SELECT 1 FROM memory_vector_owner_active WHERE user_id=?').get(user)});
 const policy=JSON.parse(db.prepare('SELECT flags_json FROM owner_feature_policy WHERE user_id=?').get(user).flags_json);
 if(['processing','classification','summary','entities','vector_build'].some(k=>policy[k]))throw new Error('Existing active processing policy requires separate maintenance');
 db.exec('COMMIT');console.log(JSON.stringify({...result,processing:false,legacy_workers:false}));
}catch(e){db.exec('ROLLBACK');throw e;}finally{db.close();}
