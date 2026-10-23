import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync,readFileSync,readdirSync,existsSync,statSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {checkPublication,scanPublicationFile} from '../../scripts/check-publication.mjs';
import {checkSecrets,GITLEAKS_VERSION} from '../../scripts/check-secrets.mjs';
import {runSuites} from '../../scripts/test-all.mjs';
import {precommitCheck} from '../../scripts/publication-pre-commit.mjs';

test('P-09..11: synthetic credentials and runtime exports fail, without echoing evidence',()=>{
  const secret='x'.repeat(40);
  for (const content of [JSON.stringify({client_secret:secret}),JSON.stringify({totp_secret:secret}),JSON.stringify({recovery_code:secret}),
    JSON.stringify({mfa:{secret}}),'Bearer '+secret,['eyJ'+'x'.repeat(12),'y'.repeat(20),'z'.repeat(20)].join('.')]) {
    const findings=scanPublicationFile('config/empty.example.json',content);
    assert.ok(findings.length);assert.ok(!JSON.stringify(findings).includes(secret));
  }
  for (const file of ['data/test.db-wal','data/test.sqlite3-shm','vectors/test.snapshot','exports/memories.json','logs/trace.dump','config/identity-map.json']) {
    assert.ok(scanPublicationFile(file,'{}').length,file);
  }
  assert.ok(scanPublicationFile('normal.json',JSON.stringify({memories:[{content:'Synthetic only.'}]})).length);
  assert.deepEqual(scanPublicationFile('config/runtime.example.json',JSON.stringify({api_key:null,client_secret:null,api_key_env:'EXAMPLE_KEY',endpoint:null})),[]);
  assert.ok(scanPublicationFile('opaque.bin',Buffer.from([255,254,253])).some(f=>f.rule==='binary-content'));
});
test('P-16: optional pre-commit gate reports only categories and requires both scanners',()=>{
  let scanned=false;
  const result=precommitCheck({publication:()=>({status:'failed',findings:[{file:'PRIVATE-SYNTHETIC-NAME',rule:'private-artifact'}]}),secrets:()=>{scanned=true;return {status:'passed'};}});
  assert.equal(scanned,true);assert.equal(result.status,'failed');assert.ok(!JSON.stringify(result).includes('PRIVATE-SYNTHETIC'));
  assert.equal(precommitCheck({publication:()=>({status:'passed',findings:[]}),secrets:()=>({status:'blocked'})}).status,'failed');
});
test('P-03 P-05 P-06 P-15: all local refs include orphan branch and tag metadata, ignored tracked files and binaries',t=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'mnemuron-privacy-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  git(['init','-q','-b','main']);
  const commit=message=>git(['-c','user.name=Public Author','-c','user.email=example@users.noreply.github.com','-c','commit.gpgsign=false','commit','-qm',message]);
  writeFileSync(root+'/README.md','Public project attribution\n');git(['add','.']);commit('Public baseline');
  git(['checkout','--orphan','review-fixture']);
  writeFileSync(root+'/.gitignore','exports/\n');mkdirSync(root+'/exports');writeFileSync(root+'/exports/memories.json','{}');writeFileSync(root+'/asset.bin',Buffer.from([0,1,2]));
  git(['add','.']);git(['add','-f','exports/memories.json']);
  commit('Synthetic marker '+ 'mnm_'+'x'.repeat(43));
  git(['-c','user.name=Example','-c','user.email=private@example.invalid','-c','tag.gpgsign=false','tag','-am','Synthetic tag','fixture-tag']);
  git(['checkout','main']);
  const result=checkPublication(['--all-refs'],root);
  assert.equal(result.status,'failed');assert.equal(result.coverage.commits,2);assert.equal(result.coverage.tags,1);
  for (const rule of ['project-or-model-key','private-artifact','binary-content','tag-email-review']) assert.ok(result.findings.some(f=>f.rule===rule),rule);
  assert.ok(!JSON.stringify(result).includes('x'.repeat(43)));assert.ok(!JSON.stringify(result).includes('private@example.invalid'));
  assert.ok(result.findings.some(f=>f.rule==='private-payload-not-inspected'));
  assert.equal(result.coverage.releases,'not_inspected');assert.equal(checkPublication(['--ref','main'],root).status,'passed');
});
test('P-02 P-08: known private and oversized payloads are blocked without opening their contents',t=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'mnemuron-private-artifact-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  execFileSync('git',['init','-q'],{cwd:root});mkdirSync(root+'/exports');
  writeFileSync(root+'/exports/runtime.json',JSON.stringify({api_key:'mnm_'+'x'.repeat(43)}));
  writeFileSync(root+'/oversized.txt','x'.repeat(4*1024*1024+1));
  const result=checkPublication(['--worktree'],root);
  assert.equal(result.coverage.payloads_not_inspected,2);assert.ok(!result.findings.some(f=>f.rule==='project-or-model-key'));
});
test('P-02 P-08: worktree scan does not follow a symbolic link to out-of-tree content',t=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'mnemuron-privacy-link-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  execFileSync('git',['init','-q'],{cwd:root});symlinkSync('/nonexistent-private-source',root+'/link.txt');
  const result=checkPublication(['--worktree'],root);
  assert.ok(result.findings.some(f=>f.rule==='symlink-not-followed'));
});
test('P-16: fixed scanner fails closed when unavailable, mismatched or finding a secret; logs never forwarded',t=>{
  assert.equal(checkSecrets(['--history'],{run:()=>({error:{code:'ENOENT'}})}).status,'blocked');
  assert.equal(checkSecrets(['--history'],{run:()=>({status:0,stdout:'0.0.0'})}).error_code,'SCANNER_VERSION_MISMATCH');
  const {root,git,commit}=secretFixture(t);git(['add','.']);commit('Synthetic baseline');
  const calls=[],captured=[],scanner=captureScanner(captured,[{RuleID:'synthetic-rule'}]);
  const result=checkSecrets(['--history'],{cwd:root,run:(command,args,options)=>{calls.push(args);return scanner(command,args,options);}});
  assert.equal(result.status,'failed');assert.ok(!JSON.stringify(result).includes('DO-NOT-LOG'));assert.ok(calls[1].includes('--redact=100'));
  assert.equal(result.coverage.local_history,'all_local_reachable_commit_snapshots');
  const workflow=readFileSync(new URL('../../.github/workflows/verify.yml',import.meta.url),'utf8');
  assert.match(workflow,/fetch-depth: 0/);assert.match(workflow,/check-publication.mjs --all-refs/);assert.doesNotMatch(workflow,/upload-artifact|pull_request_target/);
});
test('Q-01 Q-02: aggregate test runner continues after missing dependencies and keeps separate exit codes',()=>{
  let count=0;
  const result=runSuites(['first','second'].map(name=>({name,command:'synthetic',args:[]})),{run:()=>++count===1?{status:null,error:{code:'ENOENT'}}:{status:0,stdout:'# tests 2\n# pass 2\n# fail 0\n# skipped 0'}});
  assert.equal(count,2);assert.equal(result.status,'failed');assert.equal(result.results[0].status,'blocked');assert.equal(result.results[1].passed,2);
});

test('Q-08: zero discovered tests and unapproved skips cannot produce green acceptance',()=>{
  const run=output=>()=>({status:0,stdout:output});
  assert.equal(runSuites([{name:'empty',command:'fixture',args:[]}],{run:run('# tests 0\n# pass 0')}).status,'failed');
  const output='# tests 2\n# pass 1\n# skipped 1';
  assert.equal(runSuites([{name:'skipped',command:'fixture',args:[]}],{run:run(output)}).status,'failed');
  const result=runSuites([{name:'optional',command:'fixture',args:[],allowSkipped:true,skipReason:'Explicit synthetic runner contract'}],{run:run(output)});
  assert.equal(result.status,'passed');assert.equal(result.results[0].passed,1);assert.equal(result.results[0].skipped,1);
  assert.equal(runSuites([{name:'nested',command:'fixture',args:[]}],{run:run('# # tests 0\n# tests 2\n# pass 2\n# skipped 0')}).results[0].tests,2);
});

function secretFixture(t) {
  const root=mkdtempSync(path.join(os.tmpdir(),'mnemuron-secret-scope-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  git(['init','-q','-b','main']);
  writeFileSync(path.join(root,'.gitleaks.toml'),'[extend]\nuseDefault = true\n');
  const commit=message=>git(['-c','user.name=Example','-c','user.email=example@example.org','-c','commit.gpgsign=false','commit','-qm',message]);
  return {root,git,commit};
}
function captureScanner(captured, report=[]) {
  return (command,args,options)=>{
    if(args[0]==='version') return {status:0,stdout:GITLEAKS_VERSION};
    assert.equal(command,'gitleaks');assert.equal(args[0],'dir');
    assert.equal(path.dirname(args[1]),options.cwd);
    assert.equal(statSync(options.cwd).mode & 0o777,0o700);
    const walk=directory=>{for(const item of readdirSync(directory,{withFileTypes:true})) {
      const filename=path.join(directory,item.name);
      if(item.isDirectory()) walk(filename);else {
        assert.equal(statSync(filename).mode & 0o777,0o600);
        captured.push({file:path.relative(args[1],filename),body:readFileSync(filename,'utf8')});
      }
    }};
    walk(args[1]);
    const ignored=args[args.indexOf('--gitleaks-ignore-path')+1];
    assert.equal(readFileSync(ignored,'utf8'),'');
    assert.ok(args.includes('--ignore-gitleaks-allow'));assert.ok(args.includes('--redact=100'));
    writeFileSync(args[args.indexOf('--report-path')+1],JSON.stringify(report));
    return {status:report.length?1:0,stdout:'SYNTHETIC-DO-NOT-LOG',stderr:'SYNTHETIC-DO-NOT-LOG'};
  };
}
test('P-16: secret worktree snapshot excludes ignored runtime payloads but includes ignored tracked files',t=>{
  const {root,git,commit}=secretFixture(t);
  writeFileSync(root+'/.gitignore','ignored.txt\ntracked.txt\n');
  writeFileSync(root+'/tracked.txt','TRACKED-SYNTHETIC');git(['add','-f','tracked.txt']);commit('Synthetic baseline');
  writeFileSync(root+'/ignored.txt','IGNORED-SYNTHETIC');writeFileSync(root+'/new.txt','UNTRACKED-SYNTHETIC');
  const captured=[];const result=checkSecrets(['--worktree'],{cwd:root,run:captureScanner(captured)});
  assert.equal(result.status,'passed');assert.ok(captured.some(f=>f.body==='TRACKED-SYNTHETIC'));
  assert.ok(captured.some(f=>f.body==='UNTRACKED-SYNTHETIC'));assert.ok(!captured.some(f=>f.body==='IGNORED-SYNTHETIC'));
  assert.equal(result.coverage.ignored_untracked,'not_inspected');
});
test('P-16: secret index scan includes unchanged indexed content, not unstaged replacement or only the diff',t=>{
  const {root,git,commit}=secretFixture(t);
  writeFileSync(root+'/indexed.txt','INDEXED-SYNTHETIC');git(['add','.']);commit('Synthetic baseline');
  writeFileSync(root+'/indexed.txt','UNSTAGED-SYNTHETIC');writeFileSync(root+'/untracked.txt','UNTRACKED-SYNTHETIC');
  const captured=[];const result=checkSecrets(['--staged'],{cwd:root,run:captureScanner(captured)});
  assert.equal(result.status,'passed');assert.equal(result.coverage.index,'complete_snapshot');
  assert.ok(captured.some(f=>f.body==='INDEXED-SYNTHETIC'));assert.ok(!captured.some(f=>/UNSTAGED|UNTRACKED/.test(f.body)));
});
test('P-16: history secret snapshot includes removed blobs, orphan history and commit/tag metadata',t=>{
  const {root,git,commit}=secretFixture(t);
  writeFileSync(root+'/source.txt','DELETED-SYNTHETIC');git(['add','.']);commit('FIRST-COMMIT-SYNTHETIC');
  writeFileSync(root+'/source.txt','CURRENT-SYNTHETIC');git(['add','.']);commit('Second synthetic commit');
  git(['checkout','--orphan','other']);writeFileSync(root+'/orphan.txt','ORPHAN-SYNTHETIC');git(['add','.']);commit('Orphan synthetic commit');
  git(['-c','user.name=Example','-c','user.email=example@example.org','-c','tag.gpgsign=false','tag','-am','TAG-SYNTHETIC','synthetic-tag']);
  git(['update-ref','refs/tags/synthetic-alias',git(['rev-parse','synthetic-tag']).trim()]);
  git(['checkout','main']);
  git(['update-ref','refs/synthetic/tree',git(['write-tree']).trim()]);
  const captured=[];const result=checkSecrets(['--history'],{cwd:root,run:captureScanner(captured)});
  assert.equal(result.status,'passed');assert.equal(result.coverage.commits,3);assert.equal(result.coverage.tags,1);
  assert.equal(result.coverage.tree_refs,1);
  for(const marker of ['DELETED-SYNTHETIC','CURRENT-SYNTHETIC','ORPHAN-SYNTHETIC','FIRST-COMMIT-SYNTHETIC','TAG-SYNTHETIC']) {
    assert.ok(captured.some(f=>f.body.includes(marker)),marker);
  }
  assert.equal(result.coverage.remote_inventory,'not_inspected');
});
test('P-16: known private paths and indexed symlinks block before invoking the secret scanner',t=>{
  const {root,git}=secretFixture(t);mkdirSync(root+'/exports');writeFileSync(root+'/exports/memories.json','SYNTHETIC-PRIVATE');
  const captured=[];const run=captureScanner(captured);
  assert.equal(checkSecrets(['--worktree'],{cwd:root,run}).status,'blocked');assert.equal(captured.length,0);
  rmSync(root+'/exports',{recursive:true});symlinkSync('/nonexistent-private-source',root+'/link.txt');git(['add','link.txt']);
  assert.equal(checkSecrets(['--staged'],{cwd:root,run}).status,'blocked');assert.equal(captured.length,0);
});
test('P-16: secret report returns counts only, removes its private snapshot and never forwards scanner content',t=>{
  const {root}=secretFixture(t);const captured=[];let scratch;
  const run=captureScanner(captured,[{RuleID:'synthetic-rule',Secret:'SYNTHETIC-DO-NOT-LOG',Match:'SYNTHETIC-DO-NOT-LOG',File:'PRIVATE-SYNTHETIC-NAME'}]);
  const result=checkSecrets(['--worktree'],{cwd:root,run:(command,args,options)=>{
    if(args[0]!=='version') scratch=path.dirname(args[1]);return run(command,args,options);
  }});
  assert.equal(result.status,'failed');assert.equal(result.findings_count,1);
  assert.deepEqual(result.findings_by_rule,{'synthetic-rule':1});assert.equal(existsSync(scratch),false);
  assert.ok(!JSON.stringify(result).includes('DO-NOT-LOG'));assert.ok(!JSON.stringify(result).includes('PRIVATE-SYNTHETIC'));
});
test('P-16: symlink parents, oversized, binary and LFS source payloads cannot be silently skipped',t=>{
  const {root,git,commit}=secretFixture(t),captured=[],run=captureScanner(captured);
  mkdirSync(root+'/src');writeFileSync(root+'/src/file.txt','SYNTHETIC');git(['add','.']);commit('Synthetic baseline');
  rmSync(root+'/src',{recursive:true});symlinkSync('/nonexistent-private-directory',root+'/src');
  assert.equal(checkSecrets(['--worktree'],{cwd:root,run}).error_code,'SYMLINK_NOT_INSPECTED');rmSync(root+'/src');
  for(const [content,code] of [['x'.repeat(4*1024*1024+1),'OVERSIZED_PAYLOAD_NOT_INSPECTED'],
    [Buffer.from([0,1,2]),'BINARY_PAYLOAD_NOT_INSPECTED'],['version https://git-lfs.github.com/spec/v1\noid sha256:synthetic\n','LFS_PAYLOAD_NOT_INSPECTED']]) {
    writeFileSync(root+'/payload.txt',content);assert.equal(checkSecrets(['--worktree'],{cwd:root,run}).error_code,code);
  }
  assert.equal(captured.length,0);
});
test('P-16: incomplete history and malformed scanner reports fail closed',t=>{
  const {root,git,commit}=secretFixture(t);git(['add','.']);commit('Synthetic baseline');
  writeFileSync(root+'/.git/shallow',git(['rev-parse','HEAD']).trim()+'\n');
  const captured=[];assert.equal(checkSecrets(['--history'],{cwd:root,run:captureScanner(captured)}).error_code,'INCOMPLETE_SHALLOW_HISTORY');
  assert.equal(captured.length,0);
  const result=checkSecrets(['--worktree'],{cwd:root,run:(command,args)=>args[0]==='version'?{status:0,stdout:GITLEAKS_VERSION}:{status:0}});
  assert.equal(result.status,'blocked');assert.equal(result.error_code,'SCANNER_REPORT_INVALID');
});
