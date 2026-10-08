import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cpSync,existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {HISTORICAL_READER_FIXTURES,loadHistoricalReader,materializeHistoricalReader} from './helpers/historical-readers.mjs';

const manifest=JSON.parse(readFileSync(path.join(HISTORICAL_READER_FIXTURES,'manifest.json'),'utf8'));
const entries=Object.entries(manifest.readers),commit=entries[0][0];
const digest=(algorithm,bytes)=>createHash(algorithm).update(bytes).digest('hex');
function temp(t){const dir=mkdtempSync(path.join(os.tmpdir(),'mnemuron-reader-integrity-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function fixtureCopy(t){const dir=path.join(temp(t),'fixtures');cpSync(HISTORICAL_READER_FIXTURES,dir,{recursive:true});return dir;}
const firstBlob=()=>{const [file,entry]=Object.entries(entries[0][1].files)[0];return `${entry.sha256}${path.extname(file)}`;};

test('historical readers: every pinned source has its original Git blob hash, SHA-256 and complete import/resource closure',()=>{
  assert.deepEqual(entries.map(([,r])=>[r.name,r.schema_version,Object.keys(r.files).length]),[
    ['v7',7,44],['v8',8,46],['v9_candidate',9,46],['v9_final',9,46]]);
  const used=new Set();
  for(const [,reader] of entries){
    assert.ok(Object.hasOwn(reader.files,'package.json'),'the ConsoleFeatures resource is included');
    for(const [file,entry] of Object.entries(reader.files)){
      const blob=`${entry.sha256}${path.extname(file)}`;used.add(blob);
      const bytes=readFileSync(path.join(HISTORICAL_READER_FIXTURES,'blobs',blob));
      assert.equal(entry.mode,'100644');assert.equal(bytes.length,entry.bytes);
      assert.equal(digest('sha256',bytes),entry.sha256);
      assert.equal(digest('sha1',Buffer.concat([Buffer.from(`blob ${bytes.length}\0`),bytes])),entry.git_blob);
      // All literal relative import/re-export targets must belong to this same historical tree.
      for(const match of bytes.toString('utf8').matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](\.[^"']+)["']/g)){
        const dependency=path.posix.normalize(path.posix.join(path.posix.dirname(file),match[1]));
        assert.ok(Object.hasOwn(reader.files,dependency),`${reader.name}: ${file} -> ${dependency}`);
      }
    }
  }
  assert.equal(used.size,86);
  assert.deepEqual(readdirSync(path.join(HISTORICAL_READER_FIXTURES,'blobs')).sort(),[...used].sort(),'no unrelated or orphan source payloads');
});

test('historical readers: each exact reader creates its original schema and test cleanup removes its source tree',async t=>{
  for(const [revision,reader] of entries){
    const readers=await Promise.all([loadHistoricalReader(t,revision),loadHistoricalReader(t,revision)]);
    assert.notEqual(readers[0].MnemuronStore,readers[1].MnemuronStore,'concurrent loads own independent source trees');
    for(const {MnemuronStore:Old} of readers){
      const old=new Old(path.join(temp(t),'core.sqlite3'));
      try{assert.equal(old.db.prepare('PRAGMA user_version').get().user_version,reader.schema_version,reader.name);}finally{old.close();}
    }
  }
  let source;
  await t.test('materialized tree lifetime',child=>{source=materializeHistoricalReader(child,commit);assert.ok(existsSync(path.join(source,manifest.entry)));});
  assert.equal(existsSync(source),false,'source is removed after its owning test');
});

test('historical readers: unknown commits and changed manifests fail closed',t=>{
  for(const revision of ['0'.repeat(40),'../../outside','constructor'])assert.throws(()=>materializeHistoricalReader(t,revision),/unknown pinned commit/);
  const fixtureRoot=fixtureCopy(t),file=path.join(fixtureRoot,'manifest.json');
  const altered=structuredClone(manifest);altered.readers[commit].files['../../outside.mjs']=Object.values(altered.readers[commit].files)[0];
  writeFileSync(file,JSON.stringify(altered));
  assert.throws(()=>materializeHistoricalReader(t,commit,{fixtureRoot}),/manifest checksum mismatch/);
});

test('historical readers: missing, corrupt and symlinked source payloads fail before importing',t=>{
  const fixtureRoot=fixtureCopy(t),file=path.join(fixtureRoot,'blobs',firstBlob()),original=readFileSync(file);
  writeFileSync(file,Buffer.concat([original,Buffer.from('\n// changed\n')]));
  assert.throws(()=>materializeHistoricalReader(t,commit,{fixtureRoot}),/source checksum mismatch/);
  rmSync(file);assert.throws(()=>materializeHistoricalReader(t,commit,{fixtureRoot}),{code:'ENOENT'});
  const target=path.join(temp(t),'source.json');writeFileSync(target,original);symlinkSync(target,file);
  assert.throws(()=>materializeHistoricalReader(t,commit,{fixtureRoot}),/expected a regular source file/);
});
