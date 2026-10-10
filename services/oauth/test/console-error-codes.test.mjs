import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {catalog} from '../../../web/console/catalog.mjs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {ConsoleCore} from '../src/console-core.mjs';
import {BoundaryError} from '../../../shared/oauth-common.mjs';

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

test('ERRORS-03: owner/category errors preserve status and expose only allowlisted codes',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'console-errors-synthetic-'));
  fs.chmodSync(directory,0o700);
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const credential=path.join(directory,'credential');
  fs.writeFileSync(credential,'synthetic-console-token',{mode:0o600});
  let reply,requests=0;
  const server=http.createServer((req,res)=>{
    requests++;
    assert.equal(req.headers.authorization,'Bearer synthetic-console-token');
    res.writeHead(reply.status,{'content-type':'application/json'});
    res.end(JSON.stringify({error_code:reply.code,message:'PRIVATE_SYNTHETIC_MESSAGE',
      details:{record:'PRIVATE_SYNTHETIC_RECORD'},credential:'PRIVATE_SYNTHETIC_CREDENTIAL'}));
  });
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const core=new ConsoleCore({base_url:`http://127.0.0.1:${server.address().port}`},{user_id:'synthetic-owner'},
    {purpose:'console',credential_file:credential});
  const cases=[
    {code:'FEATURE_DISABLED',status:409},
    {code:'EXECUTION_GRANT_REQUIRED',status:409},
    // Model-provider guards use 400; the BFF must not rewrite their existing status.
    {code:'FEATURE_DISABLED',status:400},
    {code:'EXECUTION_GRANT_REQUIRED',status:400},
    {code:'INVALID_CATEGORY_DESCRIPTION',status:400},
    {code:'MEMORY_DISABLED',status:409},
    {code:'PRIVATE_SYNTHETIC_UNKNOWN',status:403,expected:'CONSOLE_REQUEST_FAILED'},
    {code:'FEATURE_DISABLED:PRIVATE_SYNTHETIC_SUFFIX',status:409,expected:'CONSOLE_REQUEST_FAILED'},
    {code:'PRIVATE_SYNTHETIC_UNKNOWN',status:500,expected:'CONSOLE_REQUEST_FAILED',expectedStatus:503},
    {code:'INVALID_CREDENTIAL',status:401,expected:'CONSOLE_REQUEST_FAILED',expectedStatus:503},
  ];
  for(const item of cases){
    reply=item;
    await assert.rejects(core.request('/v1/console/action'),error=>{
      assert.ok(error instanceof BoundaryError);
      assert.equal(error.status,item.expectedStatus??item.status);
      assert.equal(error.code,item.expected??item.code);
      assert.equal(error.message,error.code);
      assert.deepEqual(Object.keys(error).sort(),['code','status']);
      assert.doesNotMatch(JSON.stringify(error)+error.stack,/PRIVATE_SYNTHETIC/);
      if(!item.expected)for(const locale of ['zh-CN','en'])assert.ok(catalog[locale][item.code]);
      return true;
    });
  }
  assert.equal(requests,cases.length);
});
