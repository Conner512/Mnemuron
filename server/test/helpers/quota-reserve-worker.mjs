// QUOTA concurrency helper: one thread with its own SQLite connection reserving calls against a synthetic
// test database. Only the console quota code under test runs here; no model, network or real data.
import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {ConsoleQuotas} from '../../lib/console/quotas.mjs';

const {databasePath,user,kind,attempts}=workerData;
const db=new DatabaseSync(databasePath,{timeout:10000});
// The same BEGIN IMMEDIATE / savepoint discipline as the Core store's memoryTransaction.
const store={db,memoryTransaction(callback){const nested=db.isTransaction,sp='q_'+randomUUID().replaceAll('-','');
  db.exec(nested?'SAVEPOINT '+sp:'BEGIN IMMEDIATE');
  try{const result=callback();db.exec(nested?'RELEASE '+sp:'COMMIT');return result;}
  catch(error){if(nested)db.exec('ROLLBACK TO '+sp+'; RELEASE '+sp);else db.exec('ROLLBACK');throw error;}}};
const models={raw:()=>undefined,profile:()=>{throw new Error('no profile');}};
const quotas=new ConsoleQuotas(store,models);
let granted=0,refused=0;const other=[];
for(let n=0;n<attempts;n++){
  try{quotas.reserve(user,kind);granted++;}
  catch(error){if(error.code==='BUDGET_EXHAUSTED')refused++;else other.push(String(error.code||error.message));}
}
db.close();parentPort.postMessage({granted,refused,other});
