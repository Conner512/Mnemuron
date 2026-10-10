import test from 'node:test';
import assert from 'node:assert/strict';
import {auditDateRange,auditLocalToUTC,auditLocalValue} from '../../../web/console/audit.mjs';
import {auditGroup,auditUnclassified,auditQuery} from '../../../shared/console-queries.mjs';
test('Audit local times round-trip, reject impossible dates/ranges, and handle timezone/DST explicitly',()=>{
 const prior=process.env.TZ;
 try{
  process.env.TZ='Asia/Shanghai';assert.equal(auditLocalToUTC('2026-10-09 14:33'),'2026-10-09T06:33:00.000Z');assert.equal(auditLocalValue('2026-10-09T06:33:00Z'),'2026-10-09 14:33');assert.deepEqual(auditDateRange('',''),{from:'',to:''});
  for(const x of ['2026-02-30 12:00','2026-13-01 12:00','2026-10-09 24:00','2026-10-09 12:60','bad','2026-10-09T12:00Z'])assert.throws(()=>auditLocalToUTC(x));
  assert.throws(()=>auditDateRange('2026-10-09 15:00','2026-10-09 14:59'),/auditDateRange/);
  process.env.TZ='America/New_York';assert.throws(()=>auditLocalToUTC('2026-03-08 02:30'));assert.equal(auditLocalToUTC('2026-11-01 01:30'),'2026-11-01T05:30:00.000Z');
  assert.equal(auditLocalValue(auditLocalToUTC('2026-11-01 01:30')),'2026-11-01 01:30');
 }finally{if(prior===undefined)delete process.env.TZ;else process.env.TZ=prior;}
});
test('Explicit group mapping includes connection singular/plural, preserves unknown history and rejects broader scopes',()=>{
 for(const a of ['connection.authorized','connection.tool_failed','connections.create','console.connections.rotate','credential.issue','console.devices.revoke'])assert.equal(auditGroup(a),'connections',a);
 for(const a of ['memory.read','console.memory.correct','console.memory.organize','memory.query'])assert.equal(auditGroup(a),'memory',a);
 assert.equal(auditGroup('console.security.password'),'security');assert.equal(auditGroup('console.models.test'),'system');assert.equal(auditUnclassified('future.global.failure'),true);assert.equal(auditUnclassified('console.models.test'),false);
 for(const p of [{group:'global'},{group:'system',source:'core'},{group:'system',user_id:'foreign'},{cursor:'WzAsMF0'}])assert.throws(()=>auditQuery(p));
});
