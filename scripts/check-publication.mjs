import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const prohibitedPath = /(?:^(?:private|evidence|backups|tmp|dist)\/|(?:^|\/)(?:credentials|node_modules|__pycache__|\.mnemuron)\/|\.(?:sqlite3?|db)(?:-.*)?$|\.(?:log|jsonl|zip|tar|gz|bundle|key|pem|p12|pfx)$|(?:^|\/)(?:EXECUTION_STATUS|worktree-files)\.json$)/i;
const rules = [
  ['private-key', /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/g],
  ['token', /\b(?:ghp_|gho_|github_pat_|AKIA)[A-Za-z0-9_]{16,}/g],
  ['personal-home', /\/(?:Users|home)\/(?!example\b|test\b|openclaw\b|hermes\b)[\w.-]+/g],
  ['private-ip', /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g],
  ['fixed-container', /\b(?:pve-)?ct\d{2,}\b/gi],
  ['local-build', /\+codex\.\d{10,}/g],
  ['non-synthetic-uuid', /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi],
];

export function scanPublicationFile(file, content) {
  const findings = [];
  const add = (rule, line = 1) => findings.push({ file, rule, line });
  if (prohibitedPath.test(file) || /\.env(?:\.|$)/.test(file) && !file.endsWith('.example')) add('private-artifact');
  if (content.includes('\0')) add('binary-content');
  for (const [rule, pattern] of rules) {
    for (const match of file.matchAll(pattern)) {
      if (rule !== 'non-synthetic-uuid' || !/^(?:11111111|00000000)-/i.test(match[0])) add(rule);
    }
    for (const match of content.matchAll(pattern)) {
      if (rule === 'non-synthetic-uuid' && /^(?:11111111|00000000)-/i.test(match[0])) continue;
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
  const findings = [];
  let scanned = 0;
  const scan = (file, content) => { findings.push(...scanPublicationFile(file, content)); scanned += 1; };
  if (args.length === 1 && ['--worktree', '--staged'].includes(args[0])) {
    const staged = args[0] === '--staged';
    const files = [...new Set(git(['ls-files', '-z', ...(staged ? [] : ['-c', '-o', '--exclude-standard'])]).split('\0').filter(Boolean))];
    for (const file of files) {
      if (staged) scan(file, git(['show', `:${file}`]));
      else if (existsSync(path.join(cwd, file))) scan(file, readFileSync(path.join(cwd, file), 'utf8'));
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
          scan(file, git(['cat-file', 'blob', oid]));
        }
      }
    } else {
      for (const file of git(['ls-tree', '-r', '--name-only', '-z', commit]).split('\0').filter(Boolean)) {
        scan(file, git(['show', `${commit}:${file}`]));
      }
    }
  } else {
    throw new Error('usage: node scripts/check-publication.mjs --worktree | --staged | --ref REF [--history]');
  }
  return { status: findings.length ? 'failed' : 'passed', scanned, findings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = checkPublication(process.argv.slice(2));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.findings.length ? 1 : 0;
}
