import {backup,DatabaseSync} from 'node:sqlite';
import {lstatSync,openSync,closeSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {storageDoctor,SOURCE_ROOT} from '../storage-policy.mjs';
import {digest,fail} from '../model-providers/contracts.mjs';
import {MemorySearch} from '../memory-retrieval.mjs';
const safeName=name=>'"'+name.replaceAll('"','""')+'"';
const suffixes=['','-wal','-shm','-journal','.manifest.json'];
function guardPaths(filename){
  storageDoctor(Object.fromEntries(suffixes.map((suffix,n)=>['backup_component_'+n,filename+suffix])),{sourceRoots:[SOURCE_ROOT]});
}
function reserveTarget(filename,code,manifest=false){
  guardPaths(filename);
  for(const suffix of suffixes){
    try{lstatSync(filename+suffix);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    fail(code);
  }
  const handles=[];
  try{
    // Reserve with private permissions before SQLite starts its asynchronous copy.
    handles.push(openSync(filename,'wx',0o600));
    if(manifest)handles.push(openSync(filename+'.manifest.json','wx',0o600));
    return handles;
  }catch(error){for(const fd of handles)closeSync(fd);if(error.code==='EEXIST')fail(code);throw error;}
}
export function databaseManifest(db){
  const integrity=db.prepare('PRAGMA integrity_check').all().map(r=>r.integrity_check);
  if(integrity.length!==1 || integrity[0]!=='ok' || db.prepare('PRAGMA foreign_key_check').all().length)fail('BACKUP_INTEGRITY_FAILED');
  const tables=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const result=[];
  for(const {name,sql} of tables){
    if(name.startsWith('memory_search_fts_') || name==='memory_search_fts')continue;
    const hashes=db.prepare('SELECT * FROM '+safeName(name)).all().map(row=>digest(Object.fromEntries(Object.entries(row).map(([key,v])=>[key,v instanceof Uint8Array?Buffer.from(v).toString('base64'):v])))).sort();
    result.push({table:name,count:hashes.length,sha256:digest(hashes),schema_hash:digest(sql)});
  }
  return {schema:'sqlite-manifest-v1',integrity:'ok',foreign_keys:'ok',tables:result,objects:'raw_sources_and_revisions_inline_in_sqlite',vector_projection:'external_rebuild_required'};
}
export async function createMemoryBackup(store,destination){
  const handles=reserveTarget(destination,'BACKUP_TARGET_EXISTS',true);
  try{
    await backup(store.db,destination);
    const db=new DatabaseSync(destination,{readOnly:true});let manifest;try{manifest=databaseManifest(db);}finally{db.close();}
    manifest.file_sha256=createHash('sha256').update(readFileSync(destination)).digest('hex');
    writeFileSync(handles[1],JSON.stringify(manifest,null,2));return {created:true,table_count:manifest.tables.length,integrity:manifest.integrity};
  }finally{for(const fd of handles)closeSync(fd);}
}
export function verifyMemoryBackup(filename){
  guardPaths(filename);
  const manifest=JSON.parse(readFileSync(filename+'.manifest.json','utf8')),fileHash=createHash('sha256').update(readFileSync(filename)).digest('hex');
  if(fileHash!==manifest.file_sha256)fail('BACKUP_HASH_MISMATCH');
  const db=new DatabaseSync(filename,{readOnly:true});try{const actual=databaseManifest(db);if(digest(actual.tables)!==digest(manifest.tables))fail('BACKUP_MANIFEST_MISMATCH');return {verified:true,table_count:actual.tables.length,vector_requires_rebuild:true};}finally{db.close();}
}
export async function restoreIsolatedBackup(filename,destination){
  verifyMemoryBackup(filename);const handles=reserveTarget(destination,'RESTORE_TARGET_EXISTS');
  try{
    const source=new DatabaseSync(filename,{readOnly:true});try{await backup(source,destination);}finally{source.close();}
  }finally{for(const fd of handles)closeSync(fd);}
  const db=new DatabaseSync(destination);try{
    const before=databaseManifest(db),expected=JSON.parse(readFileSync(filename+'.manifest.json','utf8'));
    if(digest(before.tables)!==digest(expected.tables))fail('RESTORE_MANIFEST_MISMATCH');
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_vector_active'").get()){
      db.exec("BEGIN IMMEDIATE;DELETE FROM memory_vector_active;UPDATE memory_vector_generations SET state='restore_invalidated',lease_owner=NULL,lease_expires=NULL,fence=fence+1;COMMIT;");
    }
    const search=new MemorySearch(db);if(search.status().state!=='ready')fail('RESTORE_SEARCH_UNAVAILABLE');
    return {verified:true,isolated:true,source_manifest_matched:true,lexical_index:'ready',vector_index:'requires_rebuild',service_started:false};
  }finally{db.close();}
}
