import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,lstatSync,openSync,closeSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {storageDoctor,realDestination,SOURCE_ROOT} from '../storage-policy.mjs';
import {requireMemoryDatabase} from './maintenance.mjs';
import {createMemoryBackup,verifyMemoryBackup,restoreIsolatedBackup} from './backup.mjs';
import {fail} from '../model-providers/contracts.mjs';

const APPLICATION_ID=0x4d4e4253,SCHEMA=1;
const KINDS=['backup','verify','restore_isolated'];
const CODES=new Set(['BACKUP_TARGET_EXISTS','RESTORE_TARGET_EXISTS','BACKUP_HASH_MISMATCH','BACKUP_MANIFEST_MISMATCH','BACKUP_INTEGRITY_FAILED',
  'RESTORE_MANIFEST_MISMATCH','RESTORE_SEARCH_UNAVAILABLE','PRIVATE_PATH_IN_SOURCE','INVALID_STORAGE_PATH','MEMORY_DATABASE_REQUIRED',
  'BACKUP_EVIDENCE_UNSAFE','BACKUP_EVIDENCE_INVALID','BACKUP_DATABASE_CHANGED']);
const hash=value=>createHash('sha256').update(value).digest('hex');
const safeInteger=value=>Number.isSafeInteger(value)&&value>=0;
const safeHash=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const code=error=>CODES.has(error?.code||error?.errorCode)?error.code||error.errorCode:'BACKUP_OPERATION_FAILED';
const fileInfo=filename=>{try{return lstatSync(filename);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
// A path alone is not a database identity: replacing a DB at the old path must not inherit green evidence.
// Device/inode remain stable over ordinary writes, WAL checkpoints, migrations and service restarts. Moving or
// replacing the database deliberately requires a new backup. No path/device/inode is returned to the browser.
export function backupDatabaseIdentity(filename){
  if(typeof filename!=='string')return null;
  storageDoctor({database:filename},{sourceRoots:[SOURCE_ROOT]});
  const resolved=realDestination(filename),info=fileInfo(resolved);if(!info||!info.isFile())return null;
  const identity=lstatSync(resolved,{bigint:true});
  return hash(JSON.stringify([resolved,String(identity.dev),String(identity.ino),String(identity.birthtimeNs)]));
}

function evidencePath(config,{create=false}={}){
  const supplied=config.storage?.backup_dir;if(!supplied)return null;
  storageDoctor({backup_evidence_dir:supplied},{sourceRoots:[SOURCE_ROOT]});
  const directory=realDestination(supplied),filename=path.join(directory,'backup-evidence.sqlite3');
  storageDoctor(Object.fromEntries(['','-wal','-shm','-journal'].map((suffix,n)=>['backup_evidence_'+n,filename+suffix])),{sourceRoots:[SOURCE_ROOT]});
  if(create)mkdirSync(directory,{recursive:true,mode:0o700});
  const parent=fileInfo(directory);if(!parent)return {filename,missing:true};
  if(!parent.isDirectory()||(parent.mode&0o077)!==0||typeof process.getuid==='function'&&parent.uid!==process.getuid())fail('BACKUP_EVIDENCE_UNSAFE');
  for(const suffix of ['','-wal','-shm','-journal']){const info=fileInfo(filename+suffix);if(!info)continue;
    if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0||typeof process.getuid==='function'&&info.uid!==process.getuid())fail('BACKUP_EVIDENCE_UNSAFE');}
  return {filename,missing:!fileInfo(filename)};
}
function openEvidence(config,{write=false}={}){
  const target=evidencePath(config,{create:write});if(!target||!write&&target.missing)return null;
  let created=false;if(write&&target.missing){try{const fd=openSync(target.filename,'wx',0o600);closeSync(fd);created=true;}catch(error){if(error.code!=='EEXIST')throw error;evidencePath(config);}}
  const before=fileInfo(target.filename),db=new DatabaseSync(target.filename,{readOnly:!write});
  try{
    const after=fileInfo(target.filename);if(!before||!after||before.dev!==after.dev||before.ino!==after.ino)fail('BACKUP_EVIDENCE_UNSAFE');
    db.exec('PRAGMA trusted_schema=OFF;PRAGMA busy_timeout=5000;');
    if(created){db.exec(`PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA application_id=${APPLICATION_ID};PRAGMA user_version=${SCHEMA};
      CREATE TABLE backup_operations(operation_id TEXT PRIMARY KEY,database_id TEXT NOT NULL,kind TEXT NOT NULL,
        artifact_sha256 TEXT,artifact_path_hash TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,state TEXT NOT NULL,
        size_bytes INTEGER,error_code TEXT);
      CREATE INDEX backup_operations_database ON backup_operations(database_id,started_at DESC,operation_id);
      CREATE TABLE backup_artifacts(database_id TEXT NOT NULL,artifact_path_hash TEXT NOT NULL,artifact_sha256 TEXT NOT NULL,size_bytes INTEGER NOT NULL,
        PRIMARY KEY(database_id,artifact_path_hash));
      CREATE INDEX backup_artifacts_digest ON backup_artifacts(database_id,artifact_sha256);`);}
    if(db.prepare('PRAGMA application_id').get().application_id!==APPLICATION_ID||db.prepare('PRAGMA user_version').get().user_version!==SCHEMA)fail('BACKUP_EVIDENCE_INVALID');
    if(!write)db.exec('PRAGMA query_only=ON;');return db;
  }catch(error){db.close();throw error;}
}
const artifactPath=filename=>hash(realDestination(filename));

/** Only this local operator command executor creates evidence. There is no HTTP action that accepts a status,
 * path, manifest or caller-provided success flag. The source DB is never migrated or opened writable here. */
export async function runBackupMaintenance(config,{operation,backupFile,destination}={}) {
  if(!KINDS.includes(operation))fail('INVALID_COMMAND');
  const database=config.storage?.sqlite_path;
  // The old verify/isolated-restore commands must also work when the live DB is unavailable. Such a run is
  // useful to the operator but cannot be linked to a currently running DB and is not painted green in its UI.
  const databaseId=backupDatabaseIdentity(database),evidence=databaseId?openEvidence(config,{write:true}):null;
  let started,artifactKey,known=null;
  try{
    if(evidence){artifactKey=artifactPath(operation==='backup'?destination:backupFile);
      known=evidence.prepare('SELECT artifact_sha256,size_bytes FROM backup_artifacts WHERE database_id=? AND artifact_path_hash=?').get(databaseId,artifactKey);
      started={id:randomUUID(),at:Date.now()};evidence.prepare(`INSERT INTO backup_operations VALUES(?,?,?,?,?,?,NULL,'pending',?,NULL)`)
        .run(started.id,databaseId,operation,known?.artifact_sha256||null,artifactKey,started.at,known?.size_bytes??null);}
    let result;
    if(operation==='backup'){
      requireMemoryDatabase(database);const source=new DatabaseSync(database,{readOnly:true});
      try{result=await createMemoryBackup({db:source},destination);}finally{source.close();}
    }else if(operation==='verify')result=verifyMemoryBackup(backupFile);
    else result=await restoreIsolatedBackup(backupFile,destination);
    if(!evidence)return {...result,evidence_status:databaseId?'not_configured':'database_unavailable'};
    if(backupDatabaseIdentity(database)!==databaseId)fail('BACKUP_DATABASE_CHANGED');
    if(!safeHash(result.artifact_sha256)||!safeInteger(result.size_bytes))fail('BACKUP_EVIDENCE_INVALID');
    // Only a successfully created snapshot establishes provenance for this database. A valid arbitrary SQLite
    // file (even with a self-consistent manifest) cannot certify that this database has been backed up/restored.
    const linked=operation==='backup'||!!evidence.prepare('SELECT 1 FROM backup_artifacts WHERE database_id=? AND artifact_sha256=?').get(databaseId,result.artifact_sha256);
    evidence.exec('BEGIN IMMEDIATE');try{
      // A completed check of a registered digest also proves this input path is a trusted alias. Keep that
      // binding so a later corrupt/missing alias is associated with its last verified artifact, rather than
      // dropping its failure from the latest-snapshot status. Unlinked or failed checks cannot register aliases.
      if(linked)evidence.prepare('INSERT INTO backup_artifacts VALUES(?,?,?,?) ON CONFLICT(database_id,artifact_path_hash) DO UPDATE SET artifact_sha256=excluded.artifact_sha256,size_bytes=excluded.size_bytes')
        .run(databaseId,artifactKey,result.artifact_sha256,result.size_bytes);
      evidence.prepare("UPDATE backup_operations SET artifact_sha256=?,size_bytes=?,finished_at=?,state=?,error_code=NULL WHERE operation_id=? AND state='pending'")
        .run(linked?result.artifact_sha256:null,result.size_bytes,Math.max(started.at,Date.now()),linked?'succeeded':'unlinked',started.id);evidence.exec('COMMIT');
    }catch(error){evidence.exec('ROLLBACK');throw error;}
    return {...result,evidence_status:linked?'recorded':'unlinked',evidence_operation_id:started.id};
  }catch(error){
    if(evidence&&started)try{evidence.prepare("UPDATE backup_operations SET finished_at=?,state='failed',error_code=? WHERE operation_id=? AND state='pending'")
      .run(Math.max(started.at,Date.now()),code(error),started.id);}catch{fail('BACKUP_EVIDENCE_INVALID');}
    throw error;
  }finally{evidence?.close();}
}

function entry(row,now,kind){
  if(!row)return {operation:kind,status:'missing',observed_at:null,artifact_sha256:null,size_bytes:null,error_code:null};
  if(!KINDS.includes(row.kind)||!['pending','succeeded','failed','unlinked'].includes(row.state)||!safeInteger(row.started_at)||row.finished_at!==null&&(!safeInteger(row.finished_at)||row.finished_at<row.started_at)||row.artifact_sha256!==null&&!safeHash(row.artifact_sha256)||row.size_bytes!==null&&!safeInteger(row.size_bytes))fail('BACKUP_EVIDENCE_INVALID');
  const at=row.finished_at??row.started_at,age=now-at,maxAge=kind==='restore_isolated'?30*86400000:7*86400000;
  const status=age<0?'unknown':row.state==='failed'?'failed':row.state==='unlinked'?'unlinked':row.state==='pending'?(age>10*60000?'incomplete':'running'):
    age>maxAge?'stale':kind==='backup'?'created':'verified';
  return {operation:kind,status,observed_at:at,artifact_sha256:row.artifact_sha256,size_bytes:row.size_bytes,error_code:row.state==='failed'?code({code:row.error_code}):null,
    freshness_limit_days:kind==='restore_isolated'?30:7,previously_succeeded:row.state==='succeeded'};
}

/** Fixed configured sidecar, read-only. File existence is never verification, and missing records are not failures.
 * Caller is the existing operator-gated Console view. This does not expose paths, DB content or owner counts. */
export function readBackupStatus(config,databasePath,{now=Date.now(),expectedIdentity}={}) {
  const base={entries:[],verified:false,automatic_backup_changed:false,read_only:true,operations_enabled:false,source:'local_operator_evidence',
    backup:entry(null,now,'backup'),verification:entry(null,now,'verify'),restore:entry(null,now,'restore_isolated')};
  if(!config.storage?.backup_dir)return {...base,status:'not_configured'};
  let db;try{
    const identity=backupDatabaseIdentity(databasePath);if(!identity)return {...base,status:'database_unavailable'};
    if(expectedIdentity&&expectedIdentity!==identity)return {...base,status:'unavailable',error_code:'BACKUP_DATABASE_CHANGED'};
    db=openEvidence(config);if(!db)return {...base,status:'missing'};
    db.exec('BEGIN');const latest=(kind,artifact)=>db.prepare(`SELECT * FROM backup_operations WHERE database_id=? AND kind=?${artifact?' AND artifact_sha256=?':''} ORDER BY started_at DESC,rowid DESC LIMIT 1`)
      .get(identity,kind,...(artifact?[artifact]:[]));
    const backupRow=latest('backup'),lastCreated=db.prepare("SELECT artifact_sha256 FROM backup_operations WHERE database_id=? AND kind='backup' AND state='succeeded' ORDER BY started_at DESC,rowid DESC LIMIT 1").get(identity);
    const backup=entry(backupRow,now,'backup'),verification=lastCreated?entry(latest('verify',lastCreated.artifact_sha256),now,'verify'):base.verification,
      // A newer failed or unlinked drill must not leave the previous successful drill painted green.
      restoreRow=latest('restore_isolated'),
      restore=entry(restoreRow,now,'restore_isolated');
    restore.matches_latest_backup=!!restore.artifact_sha256&&restore.artifact_sha256===lastCreated?.artifact_sha256;
    const entries=db.prepare('SELECT * FROM backup_operations WHERE database_id=? ORDER BY started_at DESC,rowid DESC LIMIT 20').all(identity).map(r=>entry(r,now,r.kind));
    const status=backup.status!=='created'?backup.status:verification.status==='verified'?'verified':verification.status==='missing'?'created':verification.status;
    return {...base,status,verified:backup.status==='created'&&verification.status==='verified',backup,verification,restore,entries,entry_limit:20,
      verification_for_latest_created_backup:true,isolated_restore_does_not_activate_vectors:true};
  }catch(error){return {...base,status:'unavailable',error_code:code(error)};}finally{db?.close();}
}
