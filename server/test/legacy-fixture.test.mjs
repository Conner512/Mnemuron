import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {copyLegacyFixture} from './helpers/legacy-fixture.mjs';

test('frozen migration fixtures are complete, verified source snapshots without Git history',t=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'mnemuron-legacy-fixture-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const base=new URL('./fixtures/legacy/',import.meta.url);
  const manifest=JSON.parse(readFileSync(new URL('manifest.json',base),'utf8'));
  assert.deepEqual(Object.keys(manifest).sort(),['core-v0.1','pre-memory-first']);
  for(const [name,entry] of Object.entries(manifest)) {
    assert.equal(entry.files.length,name==='core-v0.1'?3:10);
    const destination=copyLegacyFixture(name,path.join(root,name));
    const names=entry.files.map(file=>file.name).sort();
    assert.deepEqual(readdirSync(destination).sort(),names);
    assert.deepEqual(readdirSync(new URL(name+'/',base)).sort(),names);
    for(const file of names)assert.deepEqual(readFileSync(path.join(destination,file)),readFileSync(new URL(name+'/'+file,base)));
    assert.equal(existsSync(path.join(destination,'.git')),false);
  }
});

test('legacy fixture copies reject unknown names and never overwrite an occupied destination',t=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'mnemuron-legacy-reject-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  for(const name of ['missing','../core-v0.1','__proto__']) {
    assert.throws(()=>copyLegacyFixture(name,path.join(root,'absent')),/Unknown legacy fixture/);
  }
  assert.equal(existsSync(path.join(root,'absent')),false);
  writeFileSync(path.join(root,'keep.txt'),'keep');
  assert.throws(()=>copyLegacyFixture('core-v0.1',root),{code:'EEXIST'});
  assert.deepEqual(readdirSync(root),['keep.txt']);
  assert.equal(readFileSync(path.join(root,'keep.txt'),'utf8'),'keep');
});
