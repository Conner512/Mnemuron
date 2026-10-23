import {statSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {storageDoctor,SOURCE_ROOT} from '../storage-policy.mjs';
import {fail} from '../model-providers/contracts.mjs';

export function requireMemoryDatabase(filename){
  if(typeof filename!=='string')fail('MEMORY_DATABASE_REQUIRED');
  storageDoctor({database:filename},{sourceRoots:[SOURCE_ROOT]});
  let info;try{info=statSync(filename);}catch(error){if(error.code==='ENOENT')fail('MEMORY_DATABASE_REQUIRED');throw error;}
  if(!info.isFile() || !info.size)fail('MEMORY_DATABASE_REQUIRED');
}

export function readMemoryStatus(filename,{vectorEnabled=false}={}){
  requireMemoryDatabase(filename);
  const db=new DatabaseSync(filename,{readOnly:true});
  try{
    db.exec('PRAGMA query_only=ON;BEGIN');
    const has=name=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    const jobs=has('memory_jobs')?{
      states:db.prepare('SELECT state,COUNT(*) AS count,SUM(total-processed) AS remaining FROM memory_jobs GROUP BY state').all(),
      oldest_pending_age_ms:Math.max(0,Date.now()-(db.prepare("SELECT MIN(created_at) AS n FROM memory_jobs WHERE state IN ('pending','retry_wait','leased')").get().n ?? Date.now())),
    }:{state:'not_initialized'};
    const vector=!vectorEnabled?{state:'disabled'}:has('memory_vector_generations') && has('memory_vector_active')?{
      generations:db.prepare('SELECT state,COUNT(*) AS count FROM memory_vector_generations GROUP BY state').all(),
      active:!!db.prepare('SELECT 1 FROM memory_vector_active').get(),
    }:{state:'not_initialized'};
    return {read_only:true,production_ready:false,migration_applied:false,jobs,vector};
  }finally{db.close();}
}
