import fs from 'node:fs';
import path from 'node:path';
import {privateDirectory} from '../../../shared/oauth-common.mjs';

// The migration command and server must acquire the same exclusive lease.
export function acquireAuthorizationLease(file) {
 const lease=`${file}.process-lock`;
 privateDirectory(path.dirname(file),{create:true});
 for(let attempt=0;attempt<2;attempt++) {
  try {
   const fd=fs.openSync(lease,'wx',0o600);
   fs.writeFileSync(fd,String(process.pid));const inode=fs.fstatSync(fd).ino;fs.closeSync(fd);
   return ()=>{if(fs.existsSync(lease)&&fs.lstatSync(lease).ino===inode)fs.unlinkSync(lease);};
  } catch(error) {
   if(error.code!=='EEXIST')throw error;
   const stat=fs.lstatSync(lease);
   if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||process.getuid&&stat.uid!==process.getuid())throw new Error('Invalid authorization process lock');
   const pid=Number(fs.readFileSync(lease,'utf8'));
   if(!Number.isSafeInteger(pid)||pid<=0)throw new Error('Invalid authorization process lock');
   try{process.kill(pid,0);throw new Error('Only one authorization process may own this database; stop the server before migration');}
   catch(probe){if(probe.code!=='ESRCH')throw probe;}
   if(fs.lstatSync(lease).ino===stat.ino)fs.unlinkSync(lease);
  }
 }
 throw new Error('Authorization process lock unavailable');
}
