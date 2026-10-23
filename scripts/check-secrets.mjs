import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { scanPublicationFile } from './check-publication.mjs';
import { storageDoctor } from '../server/lib/storage-policy.mjs';

export const GITLEAKS_VERSION = '8.24.3';
const FILE_LIMIT = 4 * 1024 * 1024;
const SNAPSHOT_LIMIT = 256 * 1024 * 1024;
const fail = code => { throw Object.assign(new Error('Secret scan could not safely cover the requested scope.'), {scanCode:code}); };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const inside = (root, target) => { const relative=path.relative(root,target);return relative==='' || (!relative.startsWith('..'+path.sep) && relative!=='..' && !path.isAbsolute(relative)); };

function sourceFile(root, file) {
  let filename=root, info;
  for (const component of file.split('/')) {
    filename=path.join(filename,component);info=lstatSync(filename);
    if(info.isSymbolicLink()) fail('SYMLINK_NOT_INSPECTED');
  }
  if(!info.isFile() || !inside(root,realpathSync(filename))) fail('NON_REGULAR_SOURCE');
  return {size:info.size,read:()=>{
    const fd=openSync(filename,constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const current=fstatSync(fd);
      if(!current.isFile() || current.dev!==info.dev || current.ino!==info.ino || current.size!==info.size || current.mtimeMs!==info.mtimeMs) fail('SOURCE_CHANGED');
      const content=readFileSync(fd),after=fstatSync(fd);
      if(content.length!==info.size || after.size!==info.size || after.mtimeMs!==info.mtimeMs) fail('SOURCE_CHANGED');
      return content;
    } finally { closeSync(fd); }
  }};
}

function selectSources(scope, cwd) {
  const git=args=>execFileSync('git',args,{cwd,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'},maxBuffer:64*1024*1024,
    timeout:15000,stdio:['ignore','pipe','pipe']});
  const text=args=>git(args).toString('utf8');
  const root=realpathSync(text(['rev-parse','--show-toplevel']).trim());
  if(realpathSync(cwd)!==root) fail('REPOSITORY_ROOT_REQUIRED');
  const coverage={files:0,bytes:0,commits:0,tags:0,tree_refs:0,metadata_records:0,shallow:text(['rev-parse','--is-shallow-repository']).trim()==='true',
    index:scope==='--staged'?'complete_snapshot':'not_inspected',ignored_untracked:'not_inspected',remote_inventory:'not_inspected',
    local_history:scope==='--history'?'all_local_reachable_commit_snapshots':'not_inspected',payloads_not_inspected:0};
  const entries=[];
  const add=(file,mode,source,prefix='source',metadata=false)=>{
    if(!file || path.isAbsolute(file) || file.split('/').some(part=>!part || part==='.' || part==='..' || part==='.git') || /[\x00-\x1f\\]/.test(file)) fail('UNSAFE_SOURCE_PATH');
    if(!['100644','100755'].includes(mode)) fail(mode==='120000'?'SYMLINK_NOT_INSPECTED':'NON_REGULAR_SOURCE');
    if(scanPublicationFile(file,'').some(f=>f.rule==='private-artifact')) fail('PRIVATE_PAYLOAD_NOT_INSPECTED');
    if(!Number.isSafeInteger(source.size) || source.size<0 || source.size>FILE_LIMIT) fail('OVERSIZED_PAYLOAD_NOT_INSPECTED');
    coverage.bytes+=source.size;
    if(coverage.bytes>SNAPSHOT_LIMIT || entries.length>=50000) fail('SNAPSHOT_LIMIT_EXCEEDED');
    entries.push({file:`${prefix}/${file}`,...source});
    if(metadata) coverage.metadata_records++;else coverage.files++;
  };
  const blob=oid=>({size:Number(text(['cat-file','-s',oid]).trim()),read:()=>git(['cat-file','blob',oid])});
  if(scope==='--worktree') {
    const files=[...new Set(text(['ls-files','-z','-c','-o','--exclude-standard']).split('\0').filter(Boolean))];
    for(const file of files) {
      // Check private names before even resolving a potential runtime-data link.
      if(scanPublicationFile(file,'').some(f=>f.rule==='private-artifact')) fail('PRIVATE_PAYLOAD_NOT_INSPECTED');
      let source;
      try { source=sourceFile(root,file); } catch(error) { if(error.code==='ENOENT') continue;throw error; }
      add(file,'100644',source);
    }
  } else if(scope==='--staged') {
    for(const entry of text(['ls-files','--stage','-z']).split('\0').filter(Boolean)) {
      const split=entry.indexOf('\t'),[mode,oid,stage]=entry.slice(0,split).split(' '),file=entry.slice(split+1);
      if(stage!=='0') fail('UNMERGED_INDEX');
      if(!['100644','100755'].includes(mode)) fail(mode==='120000'?'SYMLINK_NOT_INSPECTED':'NON_REGULAR_SOURCE');
      add(file,mode,blob(oid));
    }
  } else {
    if(coverage.shallow) fail('INCOMPLETE_SHALLOW_HISTORY');
    const revisions=text(['rev-list','--all']).trim().split('\n').filter(Boolean),seen=new Set(),seenTags=new Set();
    const addTree=revision=>{
      for(const entry of text(['ls-tree','-r','-z',revision]).split('\0').filter(Boolean)) {
        const split=entry.indexOf('\t'),[mode,type,oid]=entry.slice(0,split).split(' '),file=entry.slice(split+1);
        if(type!=='blob' || !['100644','100755'].includes(mode)) fail(mode==='120000'?'SYMLINK_NOT_INSPECTED':'NON_REGULAR_SOURCE');
        if(seen.has(`${oid}:${file}`)) continue;seen.add(`${oid}:${file}`);
        add(file,mode,blob(oid),`history/${oid}`);
      }
    };
    for(const revision of revisions) {
      coverage.commits++;addTree(revision);
      add(`commit-${revision}.txt`,'100644',{size:Number(text(['cat-file','-s',revision]).trim()),read:()=>git(['cat-file','commit',revision])},'metadata',true);
    }
    for(const entry of text(['for-each-ref','--format=%(objecttype) %(objectname)']).trim().split('\n').filter(Boolean)) {
      const [type,oid]=entry.split(' ');
      if(type==='tree') {coverage.tree_refs++;addTree(oid);continue;}
      if(!['commit','tag'].includes(type)) fail('NON_COMMIT_REF_NOT_INSPECTED');
      if(type==='tag') {
        if(seenTags.has(oid)) continue;seenTags.add(oid);
        const targetType=text(['cat-file','-t',`${oid}^{}`]).trim();
        if(targetType==='tree') {coverage.tree_refs++;addTree(`${oid}^{}`);}
        else if(targetType!=='commit') fail('NON_COMMIT_REF_NOT_INSPECTED');
        coverage.tags++;
        add(`tag-${oid}.txt`,'100644',{size:Number(text(['cat-file','-s',oid]).trim()),read:()=>git(['cat-file','tag',oid])},'metadata',true);
      }
    }
  }
  return {entries,coverage,root};
}

export function checkSecrets(args = ['--history'], {cwd = path.resolve(import.meta.dirname,'..'), run = spawnSync} = {}) {
  if (args.length !== 1 || !['--history','--staged','--worktree'].includes(args[0])) throw new Error('Invalid secret scan scope.');
  const options = {cwd,encoding:'utf8',maxBuffer:16*1024*1024,timeout:120000};
  const version = run('gitleaks',['version'],options);
  if (version.error || version.status !== 0) return {status:'blocked',error_code:'SCANNER_NOT_INSTALLED',required_version:GITLEAKS_VERSION};
  if ((version.stdout || '').trim().replace(/^v/,'') !== GITLEAKS_VERSION) return {status:'blocked',error_code:'SCANNER_VERSION_MISMATCH',required_version:GITLEAKS_VERSION};
  const scope = args[0];
  const base={scanner:'gitleaks',version:GITLEAKS_VERSION,scope,matched_content_logged:false};
  let scratch,coverage;
  try {
    const selected=selectSources(scope,cwd);coverage=selected.coverage;
    const config=sourceFile(selected.root,'.gitleaks.toml');
    if(config.size>FILE_LIMIT) fail('OVERSIZED_CONFIG');
    const configBytes=config.read();
    const temporaryRoot=realpathSync(os.tmpdir());
    storageDoctor({secret_scan:temporaryRoot},{sourceRoots:[selected.root]});
    scratch=mkdtempSync(path.join(temporaryRoot,'mnemuron-secret-scan-'));
    const inputs=path.join(scratch,'inputs');mkdirSync(inputs,{mode:0o700});
    const manifest=[];
    for(const entry of selected.entries) {
      const content=entry.read();
      if(content.length!==entry.size) fail('SOURCE_CHANGED');
      if(!isUtf8(content) || content.includes(0)) fail('BINARY_PAYLOAD_NOT_INSPECTED');
      if(content.toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1')) fail('LFS_PAYLOAD_NOT_INSPECTED');
      if(scanPublicationFile(entry.file,content).some(f=>f.rule==='memory-export-review')) fail('MEMORY_EXPORT_NOT_INSPECTED');
      const destination=path.join(inputs,entry.file);mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
      writeFileSync(destination,content,{flag:'wx',mode:0o600});manifest.push([entry.file,sha256(content)]);
    }
    const configPath=path.join(scratch,'scanner.toml'),ignorePath=path.join(scratch,'empty-ignore'),reportPath=path.join(scratch,'report.json');
    writeFileSync(configPath,configBytes,{flag:'wx',mode:0o600});writeFileSync(ignorePath,'',{flag:'wx',mode:0o600});
    writeFileSync(reportPath,'',{flag:'wx',mode:0o600});
    // Gitleaks dir ignores .gitignore; git --staged inspects only a diff. Scan our exact, bounded snapshot instead.
    const result=run('gitleaks',['dir',inputs,'--config',configPath,'--redact=100','--no-banner','--no-color','--log-level=error',
      '--ignore-gitleaks-allow','--gitleaks-ignore-path',ignorePath,'--report-format','json','--report-path',reportPath],{...options,cwd:scratch});
    if(result.error || ![0,1].includes(result.status)) return {...base,status:'blocked',coverage,error_code:'SCANNER_FAILED',exit_code:result.status};
    if(lstatSync(reportPath).size>16*1024*1024) fail('SCANNER_REPORT_INVALID');
    let report;
    try {report=JSON.parse(readFileSync(reportPath,'utf8'));} catch {fail('SCANNER_REPORT_INVALID');}
    if(!Array.isArray(report) || report.some(f=>!f || typeof f.RuleID!=='string' || !/^[a-z0-9_-]{1,100}$/i.test(f.RuleID)) || (result.status===0)!==(report.length===0)) fail('SCANNER_REPORT_INVALID');
    const counts=new Map();for(const finding of report) counts.set(finding.RuleID,(counts.get(finding.RuleID) || 0)+1);
    return {...base,status:result.status===0?'passed':'failed',coverage,exit_code:result.status,
      error_code:result.status===1?'SECRET_FINDINGS':null,findings_count:report.length,findings_by_rule:Object.fromEntries(counts),
      snapshot_sha256:sha256(JSON.stringify(manifest)),config_sha256:sha256(configBytes)};
  } catch(error) {
    return {...base,status:'blocked',error_code:error.scanCode || 'SCAN_PREFLIGHT_FAILED',...(coverage?{coverage}:{}),scope_complete:false};
  } finally { if(scratch) rmSync(scratch,{recursive:true,force:true}); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result=checkSecrets(process.argv.slice(2)); console.log(JSON.stringify(result)); process.exitCode=result.status==='passed'?0:1;
}
