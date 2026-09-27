import test from 'node:test';import assert from 'node:assert/strict';
import {overviewView} from '../../../web/console/visuals.mjs';
import {text} from '../../../web/console/catalog.mjs';
globalThis.document={body:{dataset:{}},documentElement:{dataset:{}},querySelectorAll:()=>[],addEventListener:()=>{}};
const {actionPage}=await import('../../../web/console/actions.mjs');
const readonly={enabled:false,writable:false,operator:false,management:{},actions:[]};
test('BROWSE-UI-01: read-only jobs have a working detail entry without scheduling rights',()=>{
 const html=actionPage('jobs',{jobs:[{job_id:'synthetic-job',job_type:'summary',state:'blocked_config',processed:0,total:1}],worker_enabled:false},readonly);
 assert.equal(typeof html,'string');assert.match(html,/data-job-detail="synthetic-job"/);assert.doesNotMatch(html,/data-console-action="jobs\./);
});
test('BROWSE-UI-02: model, connection and security inspection is independent of write enablement',()=>{
 const model=actionPage('models',{models:[{kind:'organizer',revision:1,config:{enabled:false,model:'Synthetic model'},has_key:true}]},readonly);
 assert.equal(typeof model,'string');assert.match(model,/Synthetic model/);assert.doesNotMatch(model,/data-console-action="models\./);
 for(const [page,data] of [['connections',{connections:[],core_connections:[]}],['security',{username:'Synthetic',sessions:[]}],['storage',{counts:{memories:2}}]]){
  const html=actionPage(page,data,readonly);assert.equal(typeof html,'string');assert.doesNotMatch(html,/data-console-action=/);
 }
});
test('BROWSE-UI-03: overview metrics and processing stages navigate to their real pages',()=>{
 const html=overviewView({counts:{memories:1,sources:2,summaries:0,jobs:0}},{t:text,memoryRows:()=>''});
 assert.match(html,/<a[^>]*class="card metric"[^>]*href="\/app\/memories"/);
 assert.match(html,/href="\/app\/memories\?focus=sources"/);
 assert.match(html,/<a[^>]*class="processing-stage"[^>]*href="\/app\/summaries"/);
});
