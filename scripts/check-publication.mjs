import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isUtf8 } from 'node:buffer';

const prohibitedPath = /(?:^(?:private|evidence|backups|tmp|dist)\/|(?:^|\/)(?:credentials|node_modules|__pycache__|\.mnemuron|exports|vector-data|vector-snapshots|model-cache|audit-private|job-spool)\/|\.(?:sqlite3?|db)(?:-.*)?$|\.(?:log|jsonl|snapshot|dump|zip|tar|tgz|gz|bundle|key|pem|p12|pfx)$|(?:^|\/)(?:EXECUTION_STATUS|worktree-files|identity-map|accounts|recovery|memory-export|memories-export)\.json$)/i;
const publicEmail = value => /^(?:noreply@github\.com|[^\s@]+@(?:users\.noreply\.github\.com|example\.(?:com|org|net))|\s*)$/.test(value.trim());
const rules = [
  ['private-key', /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/g],
  ['token', /\b(?:ghp_|gho_|github_pat_|AKIA)[A-Za-z0-9_]{16,}/g],
  ['project-or-model-key', /\b(?:mnm_|sk-(?:proj-|ant-)?)[A-Za-z0-9_-]{24,}/g],
  ['bearer-or-jwt', /\bBearer\s+[A-Za-z0-9_.~-]{24,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['inline-secret-review', /["']?(?:client_secret|api_key|access_token|refresh_token|totp_secret|recovery_codes?|password)["']?\s*[:=]\s*["'][A-Za-z0-9_+\/.=:-]{16,}["']/gi],
  ['personal-home', /\/(?:Users|home)\/(?!example\b|test\b|openclaw\b|hermes\b)[\w.-]+/g],
  ['private-ip', /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g],
  ['fixed-container', /\b(?:pve-)?ct\d{2,}\b/gi],
  ['local-build', /\+codex\.\d{10,}/g],
  ['non-synthetic-uuid', /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi],
];

export function scanPublicationFile(file, content) {
  const findings = [];
  const add = (rule, line = 1) => findings.push({ file, rule, line });
  if (Buffer.isBuffer(content)) {
    if (!isUtf8(content)) add('binary-content');
    content = content.toString('utf8');
  }
  if (prohibitedPath.test(file) || /\.env(?:\.|$)/.test(file) && !file.endsWith('.example')) add('private-artifact');
  if (content.includes('\0')) add('binary-content');
  if (content.startsWith('version https://git-lfs.github.com/spec/v1')) add('lfs-object-not-inspected');
  if (file.endsWith('.json')) {
    try {
      const value = JSON.parse(content);
      const records = Array.isArray(value) ? value : value.memories || value.events || value.messages;
      if (Array.isArray(records) && records.some(x => x && typeof x === 'object'
        && (typeof x.content === 'string' || typeof x.raw_payload === 'object')
        && (x.memory_id || x.event_id || x.role || value.memories))) add('memory-export-review');
      if (value?.mfa?.secret || value?.totp?.secret || value?.recovery_codes?.length) add('authentication-material');
    } catch { /* Source fragments are not runtime JSON. */ }
  }
  for (const [rule, pattern] of rules) {
    for (const match of file.matchAll(pattern)) {
      if (rule !== 'non-synthetic-uuid' || !/^(?:11111111|00000000)-/i.test(match[0])) add(rule);
    }
    for (const match of content.matchAll(pattern)) {
      if (rule === 'non-synthetic-uuid' && /^(?:11111111|00000000)-/i.test(match[0])) continue;
      // Exact public configuration-symbol mapping; not an exemption for fixtures or example secrets.
      if (file === 'plugins/mnemuron/scripts/storage.mjs' && rule === 'inline-secret-review'
        && /^api_key:\s*"MNEMURON_API_KEY"$/.test(match[0])) continue;
      add(rule, content.slice(0, match.index).split('\n').length);
    }
  }
  if ((file.startsWith('server/seed/') || file === 'plugins/mnemuron/fixtures/tasks.json') && file.endsWith('.json')) {
    try {
      const value = JSON.parse(content);
      for (const task of Array.isArray(value) ? value : [value]) {
        if (!task.task_id) continue;
        if (!task.title?.startsWith('Example: ')) add('seed-not-example');
        for (const field of ['progress', 'decisions', 'blockers', 'next_steps', 'conflicts']) {
          if (!Array.isArray(task[field]) || task[field].length) add('seed-history');
        }
      }
    } catch { add('invalid-seed'); }
  }
  return findings;
}

export function checkPublication(args, cwd = path.resolve(import.meta.dirname, '..')) {
  const git = (argv) => execFileSync('git', argv, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const gitBytes = argv => execFileSync('git', argv, {cwd, maxBuffer:64*1024*1024});
  const findings = [];
  let scanned = 0;
  const coverage = { files: 0, commits: 0, tags: 0, refs: [], shallow: git(['rev-parse', '--is-shallow-repository']).trim() === 'true',
    remote_refs: 'not_inspected', pr: 'not_inspected', issues: 'not_inspected', releases: 'not_inspected',
    actions: 'not_inspected', lfs_payloads: 'not_inspected', forks_and_cached_refs: 'not_inspected' };
  const scan = (file, content) => { findings.push(...scanPublicationFile(file, content)); scanned += 1; };
  const inspect = (file, size, read) => {
    const pathFindings=scanPublicationFile(file,'');
    if(pathFindings.some(f=>f.rule==='private-artifact') || size>4*1024*1024) {
      findings.push(...pathFindings,{file,rule:size>4*1024*1024?'oversized-payload-not-inspected':'private-payload-not-inspected',line:1});
      scanned++;return;
    }
    scan(file,read());
  };
  const inspectBlob = (file, oid) => inspect(file,Number(git(['cat-file','-s',oid]).trim()),()=>gitBytes(['cat-file','blob',oid]));
  if (args.length === 1 && ['--worktree', '--staged'].includes(args[0])) {
    const staged = args[0] === '--staged';
    const files = [...new Set(git(['ls-files', '-z', ...(staged ? [] : ['-c', '-o', '--exclude-standard'])]).split('\0').filter(Boolean))];
    for (const file of files) {
      if (staged) inspectBlob(file,`:${file}`);
      else {
        let info;
        try { info=lstatSync(path.join(cwd,file)); } catch(error) { if(error.code==='ENOENT') continue; throw error; }
        if (info.isSymbolicLink()) { scan(file, ''); findings.push({file, rule:'symlink-not-followed', line:1}); }
        else inspect(file,info.size,()=>readFileSync(path.join(cwd, file)));
      }
    }
  } else if (args.length === 1 && args[0] === '--all-refs') {
    coverage.refs = git(['for-each-ref', '--format=%(refname)']).trim().split('\n').filter(Boolean);
    const revisions = git(['rev-list', '--all']).trim().split('\n').filter(Boolean);
    const seen = new Set();
    for (const revision of revisions) {
      coverage.commits++;
      const fields = git(['show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce%x00%B', revision]).split('\0');
      for (const [index, text] of fields.entries()) {
        const file = `commit-${revision.slice(0,12)}/${['author','author-email','committer','committer-email','message'][index]}`;
        findings.push(...scanPublicationFile(file, text));
        if ([1,3].includes(index) && !publicEmail(text)) {
          findings.push({file,rule:'commit-email-review',line:1});
        }
      }
      for (const entry of git(['ls-tree','-r','-z',revision]).split('\0').filter(Boolean)) {
        const split = entry.indexOf('\t');
        const [, type, oid] = entry.slice(0,split).split(' '), file = entry.slice(split+1);
        if (type !== 'blob' || seen.has(`${oid}:${file}`)) continue;
        seen.add(`${oid}:${file}`); inspectBlob(file,oid);
      }
    }
    for (const ref of coverage.refs.filter(ref=>ref.startsWith('refs/tags/'))) {
      if (git(['cat-file','-t',ref]).trim() === 'tag') {
        coverage.tags++;
        const text = git(['cat-file','tag',ref]);
        findings.push(...scanPublicationFile('tag-'+git(['rev-parse',ref]).trim().slice(0,12),text));
        const email = text.match(/^tagger .* <([^>]+)>/m)?.[1];
        if (email && !publicEmail(email)) findings.push({file:'tag-metadata',rule:'tag-email-review',line:1});
      }
    }
  } else if (args.length >= 2 && args.length <= 3 && args[0] === '--ref' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(args[1]) && (!args[2] || args[2] === '--history')) {
    const commit = git(['rev-parse', '--verify', `${args[1]}^{commit}`]).trim();
    if (args[2] === '--history') {
      const seen = new Set();
      for (const revision of git(['rev-list', commit]).trim().split('\n')) {
        for (const entry of git(['ls-tree', '-r', '-z', revision]).split('\0').filter(Boolean)) {
          const split = entry.indexOf('\t');
          const [, type, oid] = entry.slice(0, split).split(' ');
          const file = entry.slice(split + 1);
          if (type !== 'blob' || seen.has(`${oid}:${file}`)) continue;
          seen.add(`${oid}:${file}`);
          inspectBlob(file,oid);
        }
      }
    } else {
      for (const file of git(['ls-tree', '-r', '--name-only', '-z', commit]).split('\0').filter(Boolean)) {
        inspectBlob(file,`${commit}:${file}`);
      }
    }
  } else {
    throw new Error('usage: node scripts/check-publication.mjs --worktree | --staged | --ref REF [--history] | --all-refs');
  }
  coverage.files = scanned;
  coverage.payloads_not_inspected = findings.filter(f=>/payload-not-inspected$/.test(f.rule)).length;
  coverage.local_history = args.includes('--all-refs') || args.includes('--history') ? (coverage.shallow?'incomplete_shallow':'inspected_local_reachable') : 'not_inspected';
  return { status: findings.length ? 'failed' : 'passed', scanned, findings, coverage };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = checkPublication(process.argv.slice(2));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.findings.length ? 1 : 0;
}
