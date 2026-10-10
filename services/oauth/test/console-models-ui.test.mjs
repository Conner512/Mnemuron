import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.document={body:{dataset:{}},documentElement:{dataset:{}},querySelectorAll:()=>[],addEventListener:()=>{}};
const {actionPage}=await import('../../../web/console/actions.mjs');
const data={models:[{kind:'organizer',config:{enabled:true},has_key:false},{kind:'embedder',config:{enabled:true,dimensions:768},has_key:true}],processing:{classification:{ready:false,blockers:['WORKER_DISABLED']},summary:{ready:false,blockers:['WORKER_DISABLED']},vector:{ready:false,blockers:['VECTOR_DISABLED'],search_ready:false,search_blockers:['VECTOR_NOT_READY'],indexed_documents:0,state:'not_started'},settings:{schedule_enabled:false}}};
test('Models page explains both roles and blocked processing without fake ready states',()=>{
 const html=actionPage('models',data,{enabled:true,writable:true,allowed_actions:['models.save','models.test','jobs.schedule','vector.schedule']});
 for(const role of ['organizerPurpose','embedderPurpose','modelPipeline','probeNotRun'])assert.match(html,new RegExp(`data-i18n="${role}"`));
 assert.match(html,/后台处理已暂停/);assert.match(html,/向量库尚未配置/);
 assert.match(html,/<button\b(?=[^>]*data-console-action="vector.schedule")(?=[^>]*disabled)/);
 assert.match(html,/<button\b(?=[^>]*data-console-action="jobs.schedule")(?=[^>]*disabled)/);
 assert.doesNotMatch(html,/data-console-action="models.disable"/,'test permission must not imply disable permission');
});
test('Model processing actions require exact capabilities even with a writable memory credential',()=>{
 const html=actionPage('models',data,{enabled:true,writable:true,allowed_actions:['memory.create']});
 assert.doesNotMatch(html,/data-console-action="(?:models\.|jobs\.|vector\.)/);
 const jobs=actionPage('jobs',{jobs:[]},{enabled:true,writable:true,allowed_actions:['memory.create']});
 assert.doesNotMatch(jobs,/data-console-action="jobs\./);
});
test('Current-revision verification shows bounded checks and escaped error diagnostics',()=>{
 const d=structuredClone(data);d.models[0].verification={state:'verified',checks:['classification','summary'],updated_at:Date.now()};d.models[1].verification={state:'failed',error_code:'<unsafe>',updated_at:Date.now()};
 const html=actionPage('models',d,{allowed_actions:[]});assert.match(html,/data-i18n="probeVerified"/);assert.match(html,/data-i18n="probeFailed"/);assert.doesNotMatch(html,/<unsafe>/);assert.match(html,/&lt;unsafe&gt;/);
});
