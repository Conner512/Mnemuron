import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {libraryView,completedFeaturePanels} from '../../../web/console/visuals.mjs';
import {text} from '../../../web/console/catalog.mjs';
import {declarations} from './helpers/css.mjs';

const data={results:[{memory_id:'synthetic-active',content:'Synthetic memory',status:'active'},{memory_id:'synthetic-old',content:'Synthetic old memory',status:'superseded'}]};
const batch=['memory.batch_classify','memory.batch_retract'];
const render=(allowedActions=[],locale='zh-CN')=>libraryView(k=>text(k,locale),{data,readOnly:false,allowedActions});

test('Memory selection requires actual batch permission, not permission to create memories',()=>{
 for(const permissions of [[],['memory.create'],['memory.correct'],['memory.retract']])assert.doesNotMatch(render(permissions),/data-batch-memory|data-memory-selection/);
});

test('Selection is beside its memory, without a separate visible label, and remains accessible',()=>{
 const html=render(batch);
 assert.match(html,/<td><div class="memory-content-cell"><input[^>]+data-batch-memory="synthetic-active"[^>]+aria-label="选择这条记忆"[^>]*><button[^>]+data-memory="synthetic-active"/);
 assert.equal((html.match(/data-batch-memory=/g)||[]).length,1,'inactive versions cannot be selected');
 assert.doesNotMatch(html,/<label class="check-field"|>选择这条记忆</);
 assert.match(render(batch,'en'),/aria-label="Select memory"/);
});

test('Batch actions sit above the list, start disabled and respect each granted action',()=>{
 const html=render(batch);
 assert.ok(html.indexOf('data-memory-selection')<html.indexOf('id="memory-rows"'));
 assert.match(html,/data-selection-count[^>]*>0</);
 for(const action of batch)assert.match(html,new RegExp(`data-console-action="${action}"[^>]*disabled`));
 assert.match(html,/data-clear-selection[^>]*disabled/);
 const classifyOnly=render([batch[0]]);
 assert.match(classifyOnly,/data-console-action="memory.batch_classify"/);
 assert.doesNotMatch(classifyOnly,/data-console-action="memory.batch_retract"/);
 assert.doesNotMatch(completedFeaturePanels(text,'memories',data,{allowed_actions:batch}),/data-console-action="memory.batch_/,'no duplicate far-away actions');
 const blocked=completedFeaturePanels(text,'memories',data,{allowed_actions:['memory.create']});
 assert.match(blocked,/data-i18n="batchUnavailable"/);
});

test('Memory search hides only its placeholder while focused; selection layout is inline',()=>{
 const css=fs.readFileSync(new URL('../../../web/console/styles.css',import.meta.url),'utf8');
 assert.equal(declarations(css,'[data-search-input]:focus::placeholder').color,'transparent');
 assert.equal(declarations(css,'.memory-content-cell').display,'flex');
 assert.equal(declarations(css,'.memory-select').width,'16px');
 assert.match(render(batch),/class="sr-only" data-i18n="query"/,'persistent accessible search label');
});
