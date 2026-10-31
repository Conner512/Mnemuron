#!/usr/bin/env node
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {runBackupMaintenance} from '../lib/memory/backup-status.mjs';
import {loadMemoryRuntimeFile} from '../lib/memory-runtime.mjs';
import {storageDoctor,SOURCE_ROOT} from '../lib/storage-policy.mjs';

// Invoking this existing operator command performs one snapshot and one verification. Importing it, reading the
// Console, or configuring a directory never installs/enables a timer. No old backups are removed or overwritten.
export async function scheduledBackup(env=process.env){
  const runtime=env.MNEMURON_MEMORY_CONFIG?loadMemoryRuntimeFile(env.MNEMURON_MEMORY_CONFIG):{};
  const databasePath=path.resolve(env.MNEMURON_DATABASE_PATH||runtime.storage?.sqlite_path||'/var/lib/mnemuron/mnemuron.sqlite3');
  const backupDir=path.resolve(env.MNEMURON_BACKUP_DIR||path.join(runtime.storage?.backup_dir||'/var/lib/mnemuron/backups','scheduled'));
  storageDoctor({database:databasePath,scheduled_backup_dir:backupDir},{sourceRoots:[SOURCE_ROOT]});
  mkdirSync(backupDir,{recursive:true,mode:0o700});
  const timestamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z'),target=path.join(backupDir,`mnemuron-${timestamp}.sqlite3`);
  // Evidence is opt-in through the same private runtime storage.backup_dir used by Core, not a browser-supplied
  // or separately guessed path. The legacy env-only command still backs up and verifies, but says unregistered.
  const config={...runtime,storage:{...runtime.storage,sqlite_path:databasePath}};
  const created=await runBackupMaintenance(config,{operation:'backup',destination:target});
  const verified=await runBackupMaintenance(config,{operation:'verify',backupFile:target});
  // Preserve the legacy operator CLI counters, read from the frozen verified snapshot, never the live DB and
  // never forwarded in the Console evidence view. Older partial schemas may have no comparable counters.
  const snapshot=new DatabaseSync(target,{readOnly:true});let counts=null;try{
    const has=name=>!!snapshot.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if(['events','memories','tasks','resumes','credentials'].every(has)){
      counts=snapshot.prepare(`SELECT (SELECT count(*) FROM events) AS events,(SELECT count(*) FROM memories) AS memories,
        (SELECT count(*) FROM tasks) AS tasks,(SELECT count(*) FROM resumes) AS resumes,(SELECT count(*) FROM credentials) AS credentials`).get();
      counts.checkpoints=has('checkpoints')?snapshot.prepare('SELECT count(*) AS count FROM checkpoints').get().count:0;
    }
  }finally{snapshot.close();}
  return {status:'completed',backup_file:target,integrity_check:'ok',counts,table_count:created.table_count,artifact_sha256:verified.artifact_sha256,
    size_bytes:verified.size_bytes,evidence_status:verified.evidence_status,retention:'no_automatic_deletion',service_started:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{console.log(JSON.stringify(await scheduledBackup()));}
  catch(error){console.error(JSON.stringify({status:'failed',error_code:error.code||error.errorCode||'BACKUP_OPERATION_FAILED'}));process.exitCode=1;}
}
