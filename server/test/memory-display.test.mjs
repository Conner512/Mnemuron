import test from 'node:test';
import assert from 'node:assert/strict';
import {splitLeadingPath} from '../../shared/memory-display.mjs';

test('DISPLAY-01: a clear leading path is split verbatim; everything else stays whole',()=>{
  const cases=[
    ['/Users/example/app/src/billing.ts: Invoices run nightly.',{path:'/Users/example/app/src/billing.ts',body:'Invoices run nightly.'}],
    ['~/repo/docs/0007-queue.md — Decision: one queue per tenant.',{path:'~/repo/docs/0007-queue.md',body:'Decision: one queue per tenant.'}],
    ['C:\\Users\\example\\notes\\router.txt: Guest Wi-Fi is isolated.',{path:'C:\\Users\\example\\notes\\router.txt',body:'Guest Wi-Fi is isolated.'}],
    ['[services/oauth/src/console.mjs] Codes only.',{path:'services/oauth/src/console.mjs',body:'Codes only.'}],
    ['`docs/guide.md`: backticked',{path:'docs/guide.md',body:'backticked'}],
    ['packages/ui/src/Row.tsx\nPath line, then the body.',{path:'packages/ui/src/Row.tsx',body:'Path line, then the body.'}],
    ['src/store.mjs:42: line-numbered',{path:'src/store.mjs:42',body:'line-numbered'}],
  ];
  for(const [input,expected] of cases){const parts=splitLeadingPath(input);assert.deepEqual(parts,expected,input);
    assert.ok(input.includes(parts.path)&&input.includes(parts.body),'both parts are verbatim slices of the stored text');}
  for(const input of ['A plain memory.','https://example.com/a/b: a URL','and/or: prose','/single: one segment','/Users/example/file.md:','中文 /home/example/y 在中间：不拆分','notes/todo: two segments, no extension','',null])
    assert.equal(splitLeadingPath(input),null,String(input));
});
