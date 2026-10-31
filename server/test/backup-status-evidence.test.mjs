import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,readFileSync,writeFileSync,statSync,chmodSync,mkdirSync,symlinkSync,renameSync,copyFileSync} from 'node:fs';
import {fixture} from './helpers/memory-models.mjs';
import {createMemoryBackup} from '../lib/memory/backup.mjs';
import {backupDatabaseIdentity,runBackupMaintenance,readBackupStatus} from '../lib/memory/backup-status.mjs';
import {memoryCommand} from '../bin/mnemuron-memory.mjs';
import {scheduledBackup} from '../bin/mnemuron-scheduled-backup.mjs';

function setup(t){const f=fixture(t),directory=f.root+'/private-backups',file=directory+'/synthetic-snapshot.sqlite3',config={...f.s.memoryConfig,storage:{sqlite_path:f.s.databasePath,backup_dir:directory}};
  f.s.memoryConfig={...f.s.memoryConfig,storage:config.storage};f.save('Synthetic private backup source sentinel');
  const read=(options={})=>readBackupStatus(config,f.s.databasePath,options),run=(operation,overrides={})=>runBackupMaintenance(config,{operation,backupFile:file,destination:operation==='backup'?file:f.root+'/isolated.sqlite3',...overrides});
  return {...f,directory,file,config,read,run};}

test('backup status reads create nothing and do not infer verification from a file or a configured directory',t=>{
  const f=setup(t);assert.equal(f.read().status,'missing');assert.equal(existsSync(f.directory),false);
  mkdirSync(f.directory,{mode:0o700});writeFileSync(f.file,'Synthetic not-a-backup',{mode:0o600});const before=statSync(f.directory).mtimeMs;
  assert.equal(f.read().verified,false);assert.equal(f.read().status,'missing');assert.equal(statSync(f.directory).mtimeMs,before);assert.equal(existsSync(f.directory+'/backup-evidence.sqlite3'),false);
  assert.equal(readBackupStatus({},f.s.databasePath).status,'not_configured');
});

test('actual snapshot, hash/manifest verification and isolated restore produce independent, path-free evidence',async t=>{
  const f=setup(t),before=f.s.db.prepare('SELECT * FROM memories').all();
  const backup=await f.run('backup');assert.equal(backup.evidence_status,'recorded');assert.equal(f.read().status,'created');assert.equal(f.read().verification.status,'missing');
  assert.equal(statSync(f.directory+'/backup-evidence.sqlite3').mode&0o777,0o600);assert.equal(statSync(f.file).mode&0o777,0o600);
  assert.equal((await f.run('verify')).evidence_status,'recorded');let state=f.read();assert.equal(state.verified,true);assert.equal(state.restore.status,'missing');
  const result=await f.run('restore_isolated');assert.equal(result.service_started,false);assert.equal(result.vector_index,'requires_rebuild');
  state=f.read();assert.equal(state.restore.status,'verified');assert.equal(state.restore.matches_latest_backup,true);assert.equal(state.backup.artifact_sha256,state.verification.artifact_sha256);assert.equal(state.restore.artifact_sha256,state.backup.artifact_sha256);
  assert.equal(state.operations_enabled,false);assert.equal(state.automatic_backup_changed,false);assert.ok(state.backup.size_bytes>0);
  assert.doesNotMatch(JSON.stringify(state),/source sentinel|sqlite3|private-backups|synthetic-user|credential|token|\/var\//);
  assert.deepEqual(f.s.db.prepare('SELECT * FROM memories').all(),before);
  const sourceBefore=readFileSync(f.s.databasePath);assert.equal(f.s.consoleService.features.read(f.auth,'backups',{}).verified,true);assert.deepEqual(readFileSync(f.s.databasePath),sourceBefore);
});

test('latest failed verification supersedes earlier green evidence and missing evidence is not failure',async t=>{
  const f=setup(t);await f.run('backup');await f.run('verify');assert.equal(f.read().verified,true);
  const manifest=JSON.parse(readFileSync(f.file+'.manifest.json','utf8'));manifest.tables[0].sha256='synthetic-invalid-hash';writeFileSync(f.file+'.manifest.json',JSON.stringify(manifest));
  await assert.rejects(f.run('verify'),e=>e.code==='BACKUP_MANIFEST_MISMATCH');const state=f.read();
  assert.equal(state.status,'failed');assert.equal(state.verified,false);assert.equal(state.backup.status,'created');assert.equal(state.verification.error_code,'BACKUP_MANIFEST_MISMATCH');assert.equal(state.restore.status,'missing');
});

test('a newer failed restore attempt without a known artifact replaces the previous green drill',async t=>{
  const f=setup(t);await f.run('backup');await f.run('verify');await f.run('restore_isolated');assert.equal(f.read().restore.status,'verified');
  await assert.rejects(f.run('restore_isolated',{backupFile:f.root+'/missing-artifact.sqlite3',destination:f.root+'/new-isolated.sqlite3'}));
  const state=f.read();assert.equal(state.restore.status,'failed');assert.equal(state.restore.artifact_sha256,null);assert.equal(state.restore.error_code,'BACKUP_OPERATION_FAILED');
  assert.equal(state.verified,true,'a failed recovery drill does not invalidate independent backup verification');
});

for(const operation of ['verify','restore_isolated'])test(`a successfully linked ${operation} alias retains later failures instead of leaving stale green status`,async t=>{
  const f=setup(t);await f.run('backup');await f.run('verify');const original=f.read().backup.artifact_sha256,alias=f.directory+'/verified-copy.sqlite3';
  copyFileSync(f.file,alias);copyFileSync(f.file+'.manifest.json',alias+'.manifest.json');
  assert.equal((await f.run(operation,{backupFile:alias,destination:f.root+'/alias-restored.sqlite3'})).evidence_status,'recorded');
  const manifest=JSON.parse(readFileSync(alias+'.manifest.json','utf8'));manifest.tables[0].sha256='synthetic-invalid-alias';writeFileSync(alias+'.manifest.json',JSON.stringify(manifest));
  await assert.rejects(f.run('verify',{backupFile:alias}),e=>e.code==='BACKUP_MANIFEST_MISMATCH');
  let state=f.read();assert.equal(state.verified,false);assert.equal(state.status,'failed');assert.equal(state.verification.artifact_sha256,original);assert.equal(state.verification.error_code,'BACKUP_MANIFEST_MISMATCH');
  await assert.rejects(f.run('restore_isolated',{backupFile:alias,destination:f.root+'/alias-retry.sqlite3'}),e=>e.code==='BACKUP_MANIFEST_MISMATCH');
  state=f.read();assert.equal(state.restore.status,'failed');assert.equal(state.restore.artifact_sha256,original);assert.equal(state.restore.matches_latest_backup,true);
  assert.equal(readFileSync(f.file+'.manifest.json','utf8').includes('synthetic-invalid-alias'),false,'the original snapshot was not altered');
});

test('unknown and unlinked files never gain provenance or overwrite the latest registered verification',async t=>{
  const f=setup(t);await f.run('backup');await f.run('verify');const known=f.read().verification.artifact_sha256;
  const copy=f.directory+'/never-verified-copy.sqlite3';copyFileSync(f.file,copy);copyFileSync(f.file+'.manifest.json',copy+'.manifest.json');
  writeFileSync(copy+'.manifest.json','{}');await assert.rejects(f.run('verify',{backupFile:copy}));
  assert.equal(f.read().verified,true);assert.equal(f.read().entries[0].artifact_sha256,null,'a failed first check cannot claim the file matches a known digest');
  f.save('Synthetic unregistered snapshot has different content');const unknown=f.directory+'/unregistered-copy.sqlite3';await createMemoryBackup(f.s,unknown);
  assert.equal((await f.run('verify',{backupFile:unknown})).evidence_status,'unlinked');
  assert.equal((await f.run('restore_isolated',{backupFile:unknown,destination:f.root+'/unlinked-restore.sqlite3'})).evidence_status,'unlinked');
  const db=new DatabaseSync(f.directory+'/backup-evidence.sqlite3',{readOnly:true});try{assert.equal(db.prepare('SELECT COUNT(*) n FROM backup_artifacts').get().n,1);}finally{db.close();}
  writeFileSync(unknown+'.manifest.json','{}');await assert.rejects(f.run('verify',{backupFile:unknown}));
  const state=f.read();assert.equal(state.verified,true);assert.equal(state.verification.artifact_sha256,known);assert.equal(state.entries[0].artifact_sha256,null);
});

test('a failed restore of a valid copy cannot establish a trusted path alias',async t=>{
  const f=setup(t);await f.run('backup');await f.run('verify');const alias=f.directory+'/failed-restore-copy.sqlite3';
  copyFileSync(f.file,alias);copyFileSync(f.file+'.manifest.json',alias+'.manifest.json');const occupied=f.root+'/occupied-alias-target.sqlite3';writeFileSync(occupied,'Synthetic occupied destination',{mode:0o600});
  await assert.rejects(f.run('restore_isolated',{backupFile:alias,destination:occupied}),e=>e.code==='RESTORE_TARGET_EXISTS');
  const db=new DatabaseSync(f.directory+'/backup-evidence.sqlite3',{readOnly:true});try{assert.equal(db.prepare('SELECT COUNT(*) n FROM backup_artifacts').get().n,1);}finally{db.close();}
  assert.equal(f.read().restore.artifact_sha256,null);assert.equal(readFileSync(occupied,'utf8'),'Synthetic occupied destination');
  writeFileSync(alias+'.manifest.json','{}');await assert.rejects(f.run('verify',{backupFile:alias}));assert.equal(f.read().verified,true);
});

test('unrelated and copied evidence cannot verify another database; unregistered but valid backups are explicitly unlinked',async t=>{
  const f=setup(t);await f.run('backup');await f.run('verify');
  const other=f.root+'/other.sqlite3',otherDb=new DatabaseSync(other);otherDb.exec('CREATE TABLE synthetic_data(value TEXT);INSERT INTO synthetic_data VALUES(\'Synthetic unrelated\')');otherDb.close();
  const config={...f.config,storage:{...f.config.storage,sqlite_path:other}};
  assert.equal(readBackupStatus(config,other).status,'missing');
  const result=await runBackupMaintenance(config,{operation:'verify',backupFile:f.file});assert.equal(result.verified,true);assert.equal(result.evidence_status,'unlinked');
  assert.equal(readBackupStatus(config,other).verified,false);assert.equal(readBackupStatus(config,other).verification.status,'missing');assert.equal(f.read().verified,true);
  const external=f.root+'/unregistered.sqlite3';await createMemoryBackup(f.s,external);assert.equal((await f.run('verify',{backupFile:external})).evidence_status,'recorded','an identical artifact digest is already registered to this DB');
  f.save('Synthetic new source makes an unregistered digest distinct');const newer=f.root+'/unregistered-newer.sqlite3';await createMemoryBackup(f.s,newer);
  assert.equal((await f.run('verify',{backupFile:newer})).evidence_status,'unlinked');assert.equal(f.read().verification.artifact_sha256,result.artifact_sha256);
});

test('database identity survives writes/reopen but replacement at the same path cannot inherit verification',async t=>{
  const f=setup(t),database=f.root+'/identity.sqlite3',db=new DatabaseSync(database);db.exec('CREATE TABLE sample(value TEXT)');db.close();
  const id=backupDatabaseIdentity(database),config={storage:{sqlite_path:database,backup_dir:f.directory}};
  await runBackupMaintenance(config,{operation:'backup',destination:f.file});await runBackupMaintenance(config,{operation:'verify',backupFile:f.file});assert.equal(readBackupStatus(config,database).verified,true);
  const reopened=new DatabaseSync(database);reopened.exec("INSERT INTO sample VALUES('Synthetic new content')");reopened.close();assert.equal(backupDatabaseIdentity(database),id);
  renameSync(database,f.root+'/old-identity.sqlite3');const replacement=new DatabaseSync(database);replacement.exec('CREATE TABLE replacement(value TEXT)');replacement.close();
  assert.notEqual(backupDatabaseIdentity(database),id);assert.equal(readBackupStatus(config,database).status,'missing');assert.equal(readBackupStatus(config,database,{expectedIdentity:id}).error_code,'BACKUP_DATABASE_CHANGED');
});

test('stale and interrupted evidence remain distinct from failed, and restore of an earlier snapshot is labelled',async t=>{
  const f=setup(t);await f.run('backup');await f.run('verify');await f.run('restore_isolated');
  let state=f.read({now:Date.now()+8*86400000});assert.equal(state.status,'stale');assert.equal(state.verified,false);assert.equal(state.restore.status,'verified');
  f.save('Synthetic changed database');await f.run('backup',{destination:f.directory+'/newer.sqlite3'});state=f.read();assert.equal(state.verification.status,'missing');assert.equal(state.restore.matches_latest_backup,false);
  const evidence=new DatabaseSync(f.directory+'/backup-evidence.sqlite3');try{evidence.prepare("UPDATE backup_operations SET state='pending',finished_at=NULL WHERE kind='backup' AND artifact_sha256=?").run(state.backup.artifact_sha256);}finally{evidence.close();}
  state=f.read({now:Date.now()+11*60000});assert.equal(state.backup.status,'incomplete');assert.equal(state.verified,false);
});

test('unsafe or forged evidence fails closed; it is neither repaired nor turned into verified by reading',async t=>{
  const f=setup(t);await f.run('backup');await f.run('verify');const ledger=f.directory+'/backup-evidence.sqlite3';
  chmodSync(ledger,0o644);assert.equal(f.read().status,'unavailable');assert.equal(f.read().error_code,'BACKUP_EVIDENCE_UNSAFE');assert.equal(statSync(ledger).mode&0o777,0o644);chmodSync(ledger,0o600);
  const db=new DatabaseSync(ledger);db.exec('PRAGMA application_id=1');db.close();assert.equal(f.read().error_code,'BACKUP_EVIDENCE_INVALID');
  const otherDir=f.root+'/linked-evidence';mkdirSync(otherDir,{mode:0o700});symlinkSync(ledger,otherDir+'/backup-evidence.sqlite3');assert.equal(readBackupStatus({storage:{backup_dir:otherDir}},f.s.databasePath).error_code,'BACKUP_EVIDENCE_UNSAFE');
  const publicDir=f.root+'/public-evidence';mkdirSync(publicDir,{mode:0o755});assert.equal(readBackupStatus({storage:{backup_dir:publicDir}},f.s.databasePath).error_code,'BACKUP_EVIDENCE_UNSAFE');
});

test('operator CLI records evidence without migrating or opening the source writable; restore refuses overwrites',async t=>{
  const f=setup(t),configuration=f.root+'/private-runtime.json';writeFileSync(configuration,JSON.stringify(f.config),{mode:0o600});
  f.s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');const before=readFileSync(f.s.databasePath);
  assert.equal((await memoryCommand(['backup','--config',configuration,'--destination',f.file])).evidence_status,'recorded');
  assert.equal((await memoryCommand(['backup-verify','--config',configuration,'--backup',f.file])).evidence_status,'recorded');
  assert.deepEqual(readFileSync(f.s.databasePath),before);const occupied=f.root+'/occupied.sqlite3';writeFileSync(occupied,'Synthetic reserved destination',{mode:0o600});
  await assert.rejects(memoryCommand(['restore-isolated','--config',configuration,'--backup',f.file,'--destination',occupied]),e=>e.code==='RESTORE_TARGET_EXISTS');
  assert.equal(readFileSync(occupied,'utf8'),'Synthetic reserved destination');assert.equal(f.read().restore.status,'failed');
});

test('legacy/unavailable-source verification remains useful but cannot manufacture live-DB evidence',async t=>{
  const f=setup(t);await createMemoryBackup(f.s,f.root+'/legacy.sqlite3');
  const noEvidence=await runBackupMaintenance({storage:{sqlite_path:f.s.databasePath}},{operation:'verify',backupFile:f.root+'/legacy.sqlite3'});assert.equal(noEvidence.verified,true);assert.equal(noEvidence.evidence_status,'not_configured');assert.equal(existsSync(f.directory),false);
  const missing={...f.config,storage:{...f.config.storage,sqlite_path:f.root+'/missing.sqlite3'}};
  const recovered=await runBackupMaintenance(missing,{operation:'restore_isolated',backupFile:f.root+'/legacy.sqlite3',destination:f.root+'/recovery.sqlite3'});assert.equal(recovered.verified,true);assert.equal(recovered.evidence_status,'database_unavailable');assert.equal(existsSync(missing.storage.sqlite_path),false);
});

test('existing scheduled command can register a consistent verified snapshot but does not enable a timer or delete old data',async t=>{
  const f=setup(t),configuration=f.root+'/scheduled-runtime.json';writeFileSync(configuration,JSON.stringify(f.config),{mode:0o600});
  const result=await scheduledBackup({MNEMURON_MEMORY_CONFIG:configuration,MNEMURON_DATABASE_PATH:f.s.databasePath,MNEMURON_BACKUP_DIR:f.directory+'/scheduled'});
  assert.equal(result.status,'completed');assert.equal(result.evidence_status,'recorded');assert.equal(result.retention,'no_automatic_deletion');assert.equal(result.counts.memories,1);assert.equal(f.read().verified,true);assert.equal(f.read().restore.status,'missing');
  assert.ok(existsSync(result.backup_file+'.manifest.json'));assert.equal(f.read().automatic_backup_changed,false);
});
