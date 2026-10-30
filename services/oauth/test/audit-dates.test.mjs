import test from 'node:test';
import assert from 'node:assert/strict';
import {auditDateRange,auditLocalToUTC,auditLocalValue} from '../../../web/console/audit.mjs';
import {auditGroup,auditKind,auditUnclassified,auditQuery} from '../../../shared/console-queries.mjs';
import {CONSOLE_REVIEW_ACTIONS,CONSOLE_REVIEW_VIEWS} from '../../../shared/console-contract.mjs';

test('memory workbench reads stay in system; explicit review and search feedback writes stay in memory',()=>{
 for(const view of [...CONSOLE_REVIEW_VIEWS,'memory-processing','search-feedback']){const action='console.read.'+view;
  assert.equal(auditGroup(action),'system');assert.equal(auditKind(action),'read');assert.equal(auditUnclassified(action),false);}
 for(const name of [...CONSOLE_REVIEW_ACTIONS,'search.feedback']){const action='console.'+name;
  assert.equal(auditGroup(action),'memory');assert.equal(auditKind(action),'write');assert.equal(auditUnclassified(action),false);}
});
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
 for(const a of ['cloud.memory.save','cloud.memory.supersede','cloud.memory.retract']){assert.equal(auditGroup(a),'memory',a);assert.equal(auditKind(a),'write',a);}
 for(const a of ['console.read.memory','console.read.memories','console.read.memory-versions','console.read.memory-meta','console.read.overview']){assert.equal(auditGroup(a),'system',a);assert.equal(auditUnclassified(a),false,a);}
 assert.equal(auditGroup('console.security.password'),'security');assert.equal(auditGroup('console.models.test'),'system');assert.equal(auditUnclassified('future.global.failure'),true);assert.equal(auditUnclassified('console.models.test'),false);
 for(const p of [{group:'global'},{group:'system',source:'core'},{group:'system',user_id:'foreign'},{cursor:'WzAsMF0'}])assert.throws(()=>auditQuery(p));
});
