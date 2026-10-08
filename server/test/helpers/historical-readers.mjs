// Test-only, byte-exact historical readers. No required Git history, network or current-source fallback.
import {createHash} from 'node:crypto';
import {lstatSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const HISTORICAL_READER_FIXTURES=path.resolve(import.meta.dirname,'../fixtures/historical-readers');
const MANIFEST_SHA256='f03fdf20ca33e6f327f4446072e853a66c2dd1c3b3dc38728d554a41d8466c66';
const hash=(algorithm,bytes)=>createHash(algorithm).update(bytes).digest('hex');
const fail=message=>{throw new Error(`Historical reader fixture: ${message}`);};
const regular=file=>{
  if(!lstatSync(file).isFile())fail('expected a regular source file');
  return readFileSync(file);
};

export function materializeHistoricalReader(t,commit,{fixtureRoot=HISTORICAL_READER_FIXTURES}={}){
  if(!lstatSync(fixtureRoot).isDirectory() || !lstatSync(path.join(fixtureRoot,'blobs')).isDirectory())fail('expected fixture directories');
  const manifestBytes=regular(path.join(fixtureRoot,'manifest.json'));
  if(hash('sha256',manifestBytes)!==MANIFEST_SHA256)fail('manifest checksum mismatch');
  const manifest=JSON.parse(manifestBytes);
  if(manifest.format!==1 || manifest.entry!=='server/lib/store.mjs')fail('unsupported manifest');
  if(typeof commit!=='string' || !/^[a-f0-9]{40}$/.test(commit) || !Object.hasOwn(manifest.readers,commit))fail('unknown pinned commit');
  const reader=manifest.readers[commit],sources=[];
  if(!Object.hasOwn(reader.files,manifest.entry))fail('missing entry point');
  for(const [file,entry] of Object.entries(reader.files)){
    if((file!=='package.json' && !/^(?:server\/lib|shared)\/[a-zA-Z0-9_./-]+\.mjs$/.test(file)) || file.split('/').some(part=>!part || part==='.' || part==='..'))fail('unsafe source path');
    if(entry.mode!=='100644' || !/^[a-f0-9]{40}$/.test(entry.git_blob) || !/^[a-f0-9]{64}$/.test(entry.sha256))fail('invalid source metadata');
    const bytes=regular(path.join(fixtureRoot,'blobs',`${entry.sha256}${path.extname(file)}`));
    const gitBlob=hash('sha1',Buffer.concat([Buffer.from(`blob ${bytes.length}\0`),bytes]));
    if(bytes.length!==entry.bytes || hash('sha256',bytes)!==entry.sha256 || gitBlob!==entry.git_blob)fail(`source checksum mismatch: ${file}`);
    sources.push([file,bytes]);
  }
  // Validate every source before writing or executing any of it. Each test owns its own tree;
  // no cached module can outlive its source files if a later dynamic import is needed.
  const dir=mkdtempSync(path.join(os.tmpdir(),'mnemuron-historical-reader-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  try{
    for(const [file,bytes] of sources){
      const target=path.join(dir,file);mkdirSync(path.dirname(target),{recursive:true});
      writeFileSync(target,bytes,{flag:'wx',mode:0o600});
    }
    return dir;
  }catch(error){rmSync(dir,{recursive:true,force:true});throw error;}
}

export async function loadHistoricalReader(t,commit,options){
  const dir=materializeHistoricalReader(t,commit,options);
  return import(pathToFileURL(path.join(dir,'server/lib/store.mjs')).href);
}
