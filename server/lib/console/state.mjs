import fs from 'node:fs';
import {randomBytes,createCipheriv,createDecipheriv,createHash} from 'node:crypto';
import {storageDoctor} from '../storage-policy.mjs';
import {ValidationError,ConflictError,NotFoundError} from '../errors.mjs';
export const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function canonical(v,depth=0) {if(depth>16)throw new ValidationError('Console input is too deeply nested.','INVALID_CONSOLE_INPUT');return Array.isArray(v)?v.map(x=>canonical(x,depth+1)):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k],depth+1)])):v;}
export const object = (value,keys) => {if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw new ValidationError('Invalid console payload.','INVALID_CONSOLE_INPUT');};
export const id = value => {if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value))throw new ValidationError('Invalid identifier.','INVALID_IDENTIFIER');return value;};
export const number = (value,min,max) => {if(!Number.isSafeInteger(value)||value<min||value>max)throw new ValidationError('Invalid number.','INVALID_CONSOLE_INPUT');return value;};
export class ConsoleState {
  constructor(store) {
    this.store=store;this.db=store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS console_operations(user_id TEXT NOT NULL,operation_id TEXT NOT NULL,action TEXT NOT NULL,request_hash TEXT NOT NULL,
      state TEXT NOT NULL,result_json TEXT,error_code TEXT,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,operation_id));
      CREATE TABLE IF NOT EXISTS console_models(user_id TEXT NOT NULL,kind TEXT NOT NULL,revision INTEGER NOT NULL,config_json TEXT NOT NULL,secret_cipher TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,kind));
      CREATE TABLE IF NOT EXISTS console_imports(user_id TEXT NOT NULL,source_key TEXT NOT NULL,memory_id TEXT NOT NULL,content_hash TEXT NOT NULL,PRIMARY KEY(user_id,source_key));
      CREATE TABLE IF NOT EXISTS console_vector_requests(user_id TEXT PRIMARY KEY,generation TEXT,profile TEXT NOT NULL,state TEXT NOT NULL,error_code TEXT,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_vector_owners(generation TEXT PRIMARY KEY,user_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_vector_owner_active(user_id TEXT PRIMARY KEY,generation TEXT NOT NULL,profile TEXT NOT NULL,collection_name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS console_settings(user_id TEXT PRIMARY KEY,settings_json TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL);`);
  }
  key() {
    const file=this.store.memoryConfig.console?.key_file;
    if(!file)throw new ConflictError('Console secret storage is not configured.','CONSOLE_KEY_REQUIRED');
    storageDoctor({console_key:file});
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.size>1024)throw new ConflictError('Console secret storage is unavailable.','CONSOLE_KEY_REQUIRED');
    const key=Buffer.from(fs.readFileSync(file,'utf8').trim(),'base64url');
    if(key.length!==32)throw new ConflictError('Console secret storage is unavailable.','CONSOLE_KEY_REQUIRED');return key;
  }
  seal(user,purpose,value) {
    const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key(),iv);c.setAAD(Buffer.from(`console-v1|${user}|${purpose}`));
    const ciphertext=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return JSON.stringify({v:1,iv:iv.toString('base64url'),tag:c.getAuthTag().toString('base64url'),ciphertext:ciphertext.toString('base64url')});
  }
  unseal(user,purpose,value) {
    const data=JSON.parse(value);if(data.v!==1)throw new Error('Invalid secret envelope');const c=createDecipheriv('aes-256-gcm',this.key(),Buffer.from(data.iv,'base64url'));
    c.setAAD(Buffer.from(`console-v1|${user}|${purpose}`));c.setAuthTag(Buffer.from(data.tag,'base64url'));return JSON.parse(Buffer.concat([c.update(Buffer.from(data.ciphertext,'base64url')),c.final()]).toString());
  }
  existing(user,operation,action,payload) {
    id(operation);const row=this.db.prepare('SELECT * FROM console_operations WHERE user_id=? AND operation_id=?').get(user,operation);
    if(!row)return null;
    if(row.action!==action||row.request_hash!==fingerprint(payload))throw new ConflictError('Operation ID belongs to another request.','IDEMPOTENCY_CONFLICT');
    if(row.state==='running')throw new ConflictError('Operation is pending; do not resubmit under a new ID.','OPERATION_PENDING');
    if(row.state==='failed')throw new ConflictError('Previous operation failed. Inspect its result before retrying.','OPERATION_FAILED');
    const stored=JSON.parse(row.result_json),result=stored.sealed?(Date.now()-row.created_at<=600000?this.unseal(user,operation,stored.sealed):{status:'completed',secret_expired:true}):stored;
    const current=result.memory_id?this.db.prepare('SELECT status FROM memories WHERE user_id=? AND memory_id=?').get(user,result.memory_id):null;
    return {...result,...(result.memory_id?{current_status:current?.status||'unavailable'}:{}),operation_id:operation,replayed:true};
  }
  sync(auth,action,payload,operation,callback,{secret=false}={}) {
    return this.store.memoryTransaction(()=>{
      const previous=this.existing(auth.user_id,operation,action,payload);if(previous)return previous;
      if(secret)this.key();
      const result=callback();if(result?.then)throw new Error('Async work inside SQLite transaction is forbidden');
      const stored=secret?{sealed:this.seal(auth.user_id,operation,result)}:result;
      this.db.prepare("INSERT INTO console_operations VALUES(?,?,?,?,'completed',?,NULL,?)").run(auth.user_id,operation,action,fingerprint(payload),JSON.stringify(stored),Date.now());
      this.store.audit({auth,action:`console.${action}`,targetType:'console_operation',targetId:operation});return {...result,operation_id:operation,replayed:false};
    });
  }
  inspect(user,operation) {
    id(operation);const row=this.db.prepare('SELECT operation_id,action,state,error_code,created_at FROM console_operations WHERE user_id=? AND operation_id=?').get(user,operation);
    if(!row)throw new NotFoundError('Operation not found.');return row;
  }
}
