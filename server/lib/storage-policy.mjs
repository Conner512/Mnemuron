import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { ValidationError } from './errors.mjs';

export const SOURCE_ROOT = path.resolve(import.meta.dirname, '../..');
export function realDestination(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
    throw new ValidationError('Persistent paths must be absolute.', 'INVALID_STORAGE_PATH');
  }
  // Resolve component by component: lexical normalization before resolving a link
  // would give the wrong destination for link/../new-file.
  let current = path.parse(value).root;
  for (const part of value.split(path.sep).filter(Boolean)) {
    if (part === '.') continue;
    if (part === '..') { current = path.dirname(current); continue; }
    current = path.join(current, part);
    try { lstatSync(current); current = realpathSync(current); }
    catch (error) { if (error.code !== 'ENOENT') throw new ValidationError('Persistent path cannot be resolved.', 'INVALID_STORAGE_PATH');
      // A dangling link is not a nonexistent child directory.
      if (existsSync(path.dirname(current))) {
        try { if (lstatSync(current).isSymbolicLink()) throw new ValidationError('Dangling storage link.', 'INVALID_STORAGE_PATH'); }
        catch (inner) { if (inner.code !== 'ENOENT') throw inner; }
      }
    }
  }
  return current;
}
const inside = (root, target) => { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };

export function storageDoctor(paths, { deploymentMode = 'production', syntheticData = false, sourceRoots = [SOURCE_ROOT] } = {}) {
  if (!['production', 'development', 'test'].includes(deploymentMode)) throw new ValidationError('Invalid deployment mode.', 'INVALID_DEPLOYMENT_MODE');
  if (deploymentMode !== 'production' && syntheticData !== true) throw new ValidationError('Development storage requires explicit synthetic_data.', 'SYNTHETIC_DATA_REQUIRED');
  const roots = new Set([SOURCE_ROOT, ...sourceRoots].map(realDestination));
  for (const root of [...roots]) {
    try {
      const result = execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain', '-z'], { encoding:'utf8', stdio:['ignore','pipe','ignore'], timeout:5000 });
      for (const item of result.split('\0')) if (item.startsWith('worktree ')) roots.add(realDestination(item.slice(9)));
    } catch { /* A source archive still has an explicit source root. */ }
  }
  const checks = [];
  for (const [field, supplied] of Object.entries(paths)) {
    if (supplied === null || supplied === undefined) continue;
    const target = realDestination(supplied);
    let ancestor = target;
    while (ancestor !== path.dirname(ancestor)) {
      if (existsSync(path.join(ancestor, '.git'))) roots.add(realDestination(ancestor));
      ancestor = path.dirname(ancestor);
    }
    const containing = [...roots].filter(root => inside(root, target));
    if (containing.some(root => !(deploymentMode !== 'production' && syntheticData && inside(path.join(root, '.dev'), target)))) {
      throw new ValidationError(`Private persistent path rejected (${field}).`, 'PRIVATE_PATH_IN_SOURCE');
    }
    const permissions = existsSync(target) ? statSync(target).mode & 0o777 : null;
    checks.push({ field, state:'accepted', exists:permissions !== null,
      permission_warning:permissions !== null && (permissions & 0o077) !== 0 });
  }
  return { read_only:true, status:'passed', deployment_mode:deploymentMode, checked:checks,
    sqlite_sidecars:'same guarded parent', migration_applied:false, data_read:false };
}
