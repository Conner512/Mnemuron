import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {memoryFixture} from './helpers/core-memory-fixture.mjs';
import {consoleRead} from '../lib/console-read.mjs';
import {CONSOLE_WRITE_SCOPES} from '../../shared/console-contract.mjs';

// Library paging: each page reports the total matching records so the console can show "page n of m" and jump.
test('library pages report the total across pages, for the filter in use and this account only',async t=>{
  const f=await memoryFixture(t),store=f.store;
  const auth=store.authenticate(store.issueCredential({userId:f.a.auth.user_id,deviceId:'synthetic-console',agentId:'mnemuron-console',agentInstanceId:randomUUID(),scopes:CONSOLE_WRITE_SCOPES}).api_key);
  const before=(await consoleRead(store,auth,'memories',{limit:'5'})).total;
  for(let i=0;i<12;i++)store.saveMemory(f.a.auth,{scope:'user',content:`Synthetic paging memory ${i}.`});
  store.saveMemory(f.other.auth,{scope:'user',content:'Synthetic paging memory of another account.'});
  const first=await consoleRead(store,auth,'memories',{limit:'5'}),third=await consoleRead(store,auth,'memories',{limit:'5',offset:'10'});
  assert.equal(first.total,before+12);assert.equal(third.total,before+12);
  assert.equal(first.results.length,5);assert.equal(first.next_offset,5);
  const found=await consoleRead(store,auth,'memories',{limit:'5',query:'paging',mode:'lexical'});
  assert.equal(found.total,12,'a search reports its own total');
});
