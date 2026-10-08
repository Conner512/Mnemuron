import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {catalog} from '../../../web/console/catalog.mjs';

// Every error code a console action or read can raise reaches the browser as that code (never as
// CONSOLE_REQUEST_FAILED) and has a message in both languages. Codes only; messages never cross the BFF.
const sources=['server/lib/console/service.mjs','server/lib/console/features.mjs','server/lib/console/organize.mjs','server/lib/console/models.mjs',
  'server/lib/console/state.mjs','server/lib/memory-derived/store.mjs','server/lib/memory/web-visibility.mjs','server/lib/console-read.mjs',
  // Console project views and every lifecycle read check (deleted, corrupt or oversized metadata) reach Console reads.
  'server/lib/console/projects.mjs','server/lib/lifecycle/resolver.mjs',
  // Model-list discovery returns the shared transport's fixed codes directly.
  'server/lib/model-providers/transport.mjs',
  // Project lifecycle mutations (preview and confirm).
  'server/lib/lifecycle/mutations.mjs'];
const read=file=>fs.readFileSync(new URL('../../../'+file,import.meta.url),'utf8');
const raised=new Set(['INVALID_PAYLOAD']);
for(const file of sources){const s=read(file);
  for(const m of s.matchAll(/Error\([^;]*?,\s*['"]([A-Z][A-Z_]{2,})['"]\)/g))raised.add(m[1]);
  for(const m of s.matchAll(/fail\(['"]([A-Z][A-Z_]{2,})['"]\)/g))raised.add(m[1]);}
const bff=read('services/oauth/src/console-core.mjs');

test('ERRORS-01: console error codes are forwarded by the BFF and translated in both languages',()=>{
  assert.ok(raised.size>30,'the scan found the console error codes');
  const collapsed=[...raised].filter(code=>!bff.includes(`'${code}'`));
  const untranslated=[...raised].filter(code=>!catalog['zh-CN'][code]||!catalog.en[code]);
  assert.deepEqual(collapsed,[],'collapsed to CONSOLE_REQUEST_FAILED');assert.deepEqual(untranslated,[],'missing messages');
});
test('ERRORS-02: client-side import and session errors have messages',()=>{
  for(const code of ['IMPORT_INVALID_JSON','INVALID_IMPORT','IMPORT_EMPTY','IMPORT_FILE_TOO_LARGE','STALE_ACCOUNT','UNAVAILABLE'])
    assert.ok(catalog['zh-CN'][code]&&catalog.en[code],code);
});
