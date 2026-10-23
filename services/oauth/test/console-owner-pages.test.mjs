import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.document={body:{dataset:{}},documentElement:{dataset:{}},querySelectorAll:()=>[],addEventListener:()=>{}};
const {actionPage,overviewStatus}=await import('../../../web/console/actions.mjs');

// Owner pages after the split of the former "功能与处理" page: switches (system), background processing (jobs),
// retrieval mode (models), read policy (security) and health checks (storage). Synthetic owner state only.
const FLAGS=['memory','capture','conversation','cloud_write','cloud_submitted_grants','vector_search','processing','vector_catch_up','summary','traits','vector_build','handoff','connections'];
function owner(overrides={}){
  const flags=Object.fromEntries(FLAGS.map(k=>[k,['memory','vector_search','processing','vector_catch_up','handoff'].includes(k)]));
  const effective=Object.fromEntries(FLAGS.map(k=>[k,flags[k]?{effective:true,blockers:[]}:{effective:false,blockers:['FEATURE_DISABLED']}]));
  return {revision:2,flags,effective,vector_catch_up:{pending:0,error_code:null,failures:0},preferences:{retrieval_mode:'hybrid',read_policy:'active_uniform_v1'},
    read_policy_options:[{value:'chatgpt_per_memory_v1',active_readable:3},{value:'active_uniform_v1',active_readable:111}],
    schedule:{enabled:false,kinds:[],error_code:null},runs:[],legacy_runnable_jobs:0,...overrides};
}
const caps={owner_mode:true,enabled:true,writable:true,operator:false,management:{},actions:['jobs.schedule','models.save']};
const withOwner=(o,extra={})=>({...extra,features:{'system-health':{owner:o,services:{core:'ready',search:'ready'}},...(extra.features||{})}});
const sectionButtons=html=>[...html.matchAll(/data-console-action="features\.save"[^>]*data-section="([a-z_]+)"/g)].map(m=>m[1]);

const flagButtons=html=>[...html.matchAll(/data-console-action="features\.save"[^>]*data-section="flags" data-flags="([a-z_,]+)"/g)].map(m=>m[1]);
const embedder={kind:'embedder',config:{enabled:true,model:'synthetic-embedding'},verification:{state:'verified'}},organizer={kind:'organizer',config:{enabled:true,model:'synthetic-organizer'},verification:{state:'verified'}};

test('Processing page: one card per capability with its own switch, requirements, state and history action',()=>{
  const o=owner({vector_catch_up:{pending:2,error_code:null}});o.flags.summary=true;o.effective.summary={effective:false,blockers:['PROCESSING_PAUSED']};
  const html=actionPage('jobs',withOwner(o,{jobs:[],worker_enabled:true,features:{models:{models:[embedder,organizer]}}}),caps);
  assert.deepEqual([...html.matchAll(/data-capability="([a-z_]+)"/g)].map(m=>m[1]),['vector_catch_up','summary','traits']);
  assert.deepEqual(flagButtons(html),['processing','vector_search,vector_catch_up','summary','traits','memory,vector_build']);
  assert.match(html,/data-capability="vector_catch_up"[\s\S]*?嵌入模型 synthetic-embedding · 测试通过[\s\S]*?待索引 2 条[\s\S]*?混合（关键词 \+ 语义）[\s\S]*?data-section="retrieval"/);
  assert.doesNotMatch(html,/自动分类/,'classification is no longer a capability');assert.match(html,/data-capability="summary"[\s\S]*?class="no">后台整理已暂停 <a href="#processing-master">/,'each missing requirement links to where it is fixed');
  for(const kind of ['summary','traits'])assert.match(html,new RegExp(`data-capability="${kind}"[\\s\\S]*?data-console-action="processing.preview" data-kind="${kind}"`),kind);
  assert.doesNotMatch(html,/data-capability="vector_catch_up"[\s\S]*?data-console-action="processing.preview"[\s\S]*?data-capability="summary"/,'new memories reach the index by themselves; no batch on the semantic card');
  assert.match(html,/<h2>自动处理节奏<\/h2>[\s\S]*<h2>运行记录<\/h2>[\s\S]*<h2>其他开关<\/h2>/);
  // A switch button carries the change it makes, so confirming it really flips the switch; an on switch reads 已开启, not 运行中.
  assert.match(html,/data-capability="summary"[\s\S]*?data-flags="summary" data-target="off">关闭</);assert.match(html,/data-capability="traits"[\s\S]*?data-flags="traits" data-target="on">开启</);assert.match(html,/data-capability="traits"[\s\S]*?data-kind="traits">补全历史记忆</);assert.doesNotMatch(html,/实体提取/);
  assert.match(html,/data-capability="summary"[\s\S]*?<span class="tag" data-tone="warn">未生效<\/span>/);assert.doesNotMatch(html,/data-capability="[a-z_]+"[^]*?<span class="tag"[^>]*>运行中</);
  assert.doesNotMatch(html,/data-console-action="processing.preview" data-kind="vector"|data-console-action="vector.activate"/,'no spare collection: no rebuild offered');
  assert.match(html,/需要先在 Qdrant 预建一个空集合/);assert.match(html,/data-i18n="jobQueue"/);
  assert.doesNotMatch(actionPage('jobs',withOwner(o,{jobs:[],worker_enabled:true}),{...caps,owner_mode:false}),/data-capability=/,'other deployments keep the job queue page');
});

test('ChatGPT and coding-assistant pages hold their own connections, read scope and switches; models and security lose them',()=>{
  const o=owner(),connections={connections:[{connection_id:'c-gpt',label:'Synthetic GPT',kind:'chatgpt_oauth',profile:'memory_readwrite'},{connection_id:'c-mcp',label:'Synthetic MCP',kind:'generic_mcp',profile:'readonly'}],core_connections:[],legacy_connections:[]};
  const gpt=actionPage('connections',withOwner(o,connections),caps);
  assert.match(gpt,/data-connection-detail="c-gpt"/);assert.doesNotMatch(gpt,/data-connection-detail="c-mcp"/);
  assert.match(gpt,/data-read-policy="active_uniform_v1"[\s\S]*全部活动记忆：当前可读 111 条/);assert.deepEqual(sectionButtons(gpt).filter(x=>x!=='flags'),['read_policy']);
  assert.deepEqual(flagButtons(gpt),['cloud_write,cloud_submitted_grants,connections']);assert.match(gpt,/ChatGPT 保存和修正记忆/);
  const agents=actionPage('agents',withOwner(o,connections),caps);
  assert.match(agents,/data-connection-detail="c-mcp"/);assert.doesNotMatch(agents,/data-connection-detail="c-gpt"/);
  assert.deepEqual(flagButtons(agents),['capture,conversation,handoff']);assert.match(agents,/从事件提取记忆[\s\S]*从对话提取[\s\S]*任务接续/);
  const all=actionPage('connections',withOwner(o,connections),{...caps,owner_mode:false});
  assert.match(all,/data-connection-detail="c-gpt"/);assert.match(all,/data-connection-detail="c-mcp"/);assert.doesNotMatch(all,/data-flags=/,'other deployments keep the full connections page');
  const models=actionPage('models',withOwner(o,{models:[{...embedder,revision:1}]}),caps);
  assert.match(models,/data-i18n="modelUsedBy_embedder"/);assert.doesNotMatch(models,/data-retrieval-mode|data-first-run/);
  assert.doesNotMatch(actionPage('security',withOwner(o,{username:'S',sessions:[]}),caps),/data-read-policy/);
});

test('Health page: every check has a level, problems carry a fix, and missing reads are shown as unknown',()=>{
  const levels=html=>Object.fromEntries([...html.matchAll(/<li data-health="([a-z]+)">[\s\S]*?<strong>([^<]+)<\/strong>/g)].map(m=>[m[2],m[1]]));
  const healthy=actionPage('storage',{counts:{memories:111},features:{'system-health':{owner:owner(),services:{core:'ready',search:'ready'}},'system-version':{schema_version:12,node:'v24.19.0'},
    backups:{status:'not_configured'},models:{models:[{kind:'embedder',config:{enabled:true,model:'synthetic-embedding'},verification:{state:'verified'}}]}}},caps);
  assert.deepEqual(levels(healthy),{'核心服务':'ok','关键词索引':'ok','嵌入模型':'ok','语义索引':'ok','调用额度':'ok','后台整理':'ok','数据库':'ok','备份':'warn'});
  assert.match(healthy,/没有配置定期备份[\s\S]*在 PVE 备份任务里加入 CT 131/);assert.match(healthy,/data-i18n="dataCounts"/);
  const broken=actionPage('storage',{counts:{},features:{'system-health':{owner:owner({vector_catch_up:{pending:2,error_code:'VECTOR_AUTH_FAILED'}}),services:{core:'ready',search:'ready'}}}},caps);
  assert.equal(levels(broken)['语义索引'],'bad');assert.match(broken,/重新签发 Qdrant 密钥/);
  const off=owner();off.flags.vector_catch_up=false;
  assert.match(actionPage('storage',{features:{'system-health':{owner:off,services:{core:'ready',search:'ready'}}}},caps),/增量索引未开启[\s\S]*打开“后台整理”和“语义检索”/);
  assert.deepEqual(levels(actionPage('storage',{features:{}},caps)),{'服务状态':'unknown','嵌入模型':'unknown'});
});

test('Overview status: four tiles from live counts, and one attention list from health checks and attention counts',()=>{
  const o=owner({vector_catch_up:{pending:8,error_code:null}});
  const data={counts:{memories:35830},insights:{statuses:[{value:'retracted',count:35713},{value:'active',count:111}]},features:{'system-health':{owner:o,services:{core:'ready',search:'ready'}},
    'model-usage':{models:[{kind:'embedder',configured:true,used:8,limit:250,total:{used:123,limit:1500}}]},backups:{status:'not_configured'},attention:{counts:{failed_jobs:2,stale_summaries:0,pending_reconciliation:0}},
    models:{models:[{kind:'embedder',config:{enabled:true,model:'synthetic'},verification:{state:'verified'}}]}}};
  const html=overviewStatus(data);
  const tiles=[...html.matchAll(/<a class="status-tile" href="([^"]+)" data-tone="([a-z]*)"><span class="status-label">([^<]+)<\/span><strong class="status-value">([^<]+)<\/strong>/g)].map(m=>[m[3],m[4],m[2],m[1]]);
  assert.deepEqual(tiles,[['活动记忆','111','','/app/memories'],['语义索引','103/111','warn','/app/jobs'],['今日嵌入调用','8/250','','/app/usage'],['系统健康','2 项','warn','/app/storage']]);
  assert.match(html,/共 35,830 条记录/,'the total is labelled as including history, the tile shows active');
  assert.match(html,/<h2>需要注意<\/h2>[\s\S]*语义索引[\s\S]*备份[\s\S]*2 个整理任务失败/);
  const calm=overviewStatus({insights:{statuses:[{value:'active',count:3}]},features:{'system-health':{owner:owner(),services:{core:'ready',search:'ready'}},backups:{status:'configured'},
    models:{models:[{kind:'embedder',config:{enabled:true},verification:{state:'verified'}}]}}});
  assert.match(calm,/系统健康<\/span><strong class="status-value">正常/);assert.match(calm,/目前没有需要处理的事/);
});

test('Usage page: a 14-day chart drawn to scale; the retired entities page renders nothing',()=>{
  assert.equal(actionPage('entities',{entities:[],proposals:[]},caps),null,'the entities page was replaced by keywords');
  const days=Array.from({length:14},(_,i)=>({day:`2026-10-${String(i+3).padStart(2,'0')}`,organizer:i===0?2:0,embedder:i===13?8:i===7?3:0}));
  const usage=actionPage('usage',{models:[{kind:'embedder',configured:true,used:8,limit:250,limit_mode:'manual',total:{used:123,limit:1500}},{kind:'organizer',configured:false}],history:days,searches_7d:128},caps);
  assert.equal((usage.match(/class="bar-(organizer|embedder)"/g)||[]).length,28);
  assert.match(usage,/近 14 天模型调用<\/span><strong class="status-value">13</);assert.match(usage,/近 7 天记忆搜索<\/span><strong class="status-value">128</);
  assert.match(usage,/今日调用<\/dt><dd>8 \/ 250[\s\S]*累计调用<\/dt><dd>123 \/ 1,500[\s\S]*你设置的调用上限/);
  const heights=[...usage.matchAll(/class="bar-embedder"><title>[^ ]+ 嵌入 (\d+)<\/title>/g)].map(m=>Number(m[1]));assert.deepEqual(heights.filter(Boolean),[3,8]);
  const tallest=Math.max(...[...usage.matchAll(/height="([\d.]+)" class="bar-embedder"/g)].map(m=>Number(m[1])));
  const gridTop=Math.min(...[...usage.matchAll(/<line [^>]*y1="([\d.]+)"[^>]*class="chart-grid"/g)].map(m=>Number(m[1])));
  assert.ok(Number.isFinite(gridTop)&&tallest<=174-gridTop+0.01&&tallest>0,'the tallest bar reaches at most the top grid line');
});

test('Processing page: a switch on means automatic processing; the semantic card rebuilds onto a spare collection and activates the result',()=>{
  const o=owner({schedule:{enabled:true,kinds:['summary'],interval_minutes:15,max_items:7,budget:9},vector_index:{serving_generation:'gen-old',spare_collections:1}});o.flags.summary=true;
  const spare=actionPage('jobs',withOwner(o,{jobs:[],worker_enabled:true,features:{models:{models:[embedder,organizer]}}}),caps);
  assert.match(spare,/data-capability="summary"[\s\S]*?自动处理（每 15 分钟，每轮最多 7 条）/);assert.match(spare,/data-capability="traits"[\s\S]*?不会自动处理/);
  assert.match(spare,/data-console-action="processing.preview" data-kind="vector">重建索引/);
  assert.match(spare,/data-pacing[\s\S]*每 15 分钟一轮，每轮最多 7 条、9 次调用/);assert.doesNotMatch(spare,/启用自动规则/);
  const built=owner({vector_index:{serving_generation:'gen-old',spare_collections:0},runs:[{run_id:'r1',kind:'vector',state:'completed',generation:'gen-new',used:111,budget:200,count:111,model:'e',manifest_digest:'d'}]});
  const ready=actionPage('jobs',withOwner(built,{jobs:[],worker_enabled:true}),caps);
  assert.match(ready,/data-console-action="vector.activate" data-generation="gen-new"/);assert.match(ready,/新索引已建好，等待启用/);
});

test('Overview pipeline, memory map and connection pages show the last 7 days of memory flow',()=>{
  const activity={window_days:7,sources:{chatgpt:4,agents:5,console:1,import:2,other:0},uses:{chatgpt:{search:30,read:13},agents:{search:6,read:2},console:{search:3,read:9}},redacted:1};
  const o=owner();o.flags.cloud_write=true;o.flags.capture=true;
  const html=overviewStatus({insights:{statuses:[{value:'active',count:111}],kinds:[{value:'workflow',count:100},{value:'none',count:11}]},features:{'system-health':{owner:o,services:{core:'ready',search:'ready'}},attention:{counts:{},activity_7d:activity}}});
  const stages=[...html.matchAll(/<a class="pipe-stage" data-group="[a-z]+" href="([^"]+)"><span class="pipe-label">([^<]+)<\/span><strong>([^<]+)<\/strong>/g)].map(m=>[m[2],m[3],m[1]]);
  assert.deepEqual(stages,[['写入','12','/app/memories'],['脱敏','1','/app/audit?group=system'],['类型','100/111','/app/memories?kind=none'],['关键词','0/0','/app/jobs#cap-traits'],['语义索引','111/111','/app/jobs'],['被读取','63','/app/audit?group=memory']]);
  for(const text of ['ChatGPT 4 · 编程助手 5 · 控制台和导入 3','写入前替换了密钥或令牌','写入的 Agent 标注类型','搜索 39 · 读取 24'])assert.ok(html.includes(text),text);
  assert.doesNotMatch(html,/data-memory-map/,'no map without graph data');
  const graph={memories:[{id:'m1',kind:'fact',concepts:['<b>Server</b>']},{id:'m2',kind:'preference',concepts:['<b>server</b>','PVE']},{id:'m3',kind:null,concepts:[]}],entities:[],links:[],truncated:false};
  const mapped=overviewStatus({insights:{statuses:[{value:'active',count:3}]},features:{'system-health':{owner:o,services:{core:'ready',search:'ready'}},attention:{counts:{},activity_7d:activity,graph}}});
  assert.match(mapped,/<div class="overview-hero"><section class="card map-card" data-memory-map data-indexed="[^"]*"><div class="map-zoom" role="group" aria-label="缩放">[\s\S]*?<aside class="map-panel" data-map-panel hidden><\/aside><canvas data-map-canvas role="img"/);
  assert.match(mapped,/<b>2<\/b><span>关键词<\/span>/,'distinct keywords, case-insensitive');assert.match(mapped,/data-live-stream/);
  assert.deepEqual([...mapped.matchAll(/class="node-key(?: map-kind)?" data-group="([a-z]+)"[^>]*>([^<]+)/g)].map(m=>[m[1],m[2].trim()]),[['fact','事实'],['pref','偏好'],['none','未标注类型'],['entity','关键词']]);
  assert.match(mapped,/data-map-kind="fact" aria-pressed="true"/,'each type in the legend is a toggle');assert.match(mapped,/data-map-days="30" aria-pressed="true">近 30 天/,'the window defaults to 30 days');
  assert.doesNotMatch(mapped,/<b>Server<\/b>/,'keywords are drawn on the canvas, never inserted as markup');
  const data={connections:[],core_connections:[],legacy_connections:[],features:{'system-health':{owner:o},attention:{activity_7d:activity}}};
  assert.match(actionPage('connections',data,caps),/data-activity="chatgpt">最近 7 天：搜索 <strong>30<\/strong> 次 · 读取 <strong>13<\/strong> 次 · 写入 <strong>4<\/strong> 条/);
  assert.match(actionPage('agents',data,caps),/data-activity="agents">最近 7 天：搜索 <strong>6<\/strong> 次 · 读取 <strong>2<\/strong> 次 · 提取 <strong>5<\/strong> 条/);
});

test('Processing runs: previews and retired kinds stay out of the history; an automatic rule says when it last looked',()=>{
  const run=(extra)=>({run_id:'r1',kind:'traits',state:'completed',budget:300,used:2,count:12,model:'synthetic-model',manifest_digest:'d',created_at:1,expires_at:2,...extra});
  const page=o=>actionPage('jobs',withOwner(o,{jobs:[],worker_enabled:true,features:{models:{models:[embedder,organizer]}}}),caps);
  const html=page(owner({runs:[run({run_id:'p1',state:'preview',expired:true}),run({run_id:'p2',state:'preview',expired:false,items:[{memory_id:'m',title:'x'}]}),run({run_id:'e1',kind:'entities',state:'cancelled'}),run({run_id:'c1'})]}));
  const history=html.slice(html.indexOf('<h2>运行记录</h2>'));
  assert.equal((history.match(/class="policy-box run-row"/g)||[]).length,1,'only the completed keyword fill is listed');
  assert.match(history,/data-run-state="completed"><strong>补全关键词<\/strong> · 已完成 · 调用 2\/300 · 12 条/);
  assert.doesNotMatch(html,/data-console-action="processing.start"|已过期|实体提取/);
  assert.match(html,/data-capability="traits"[\s\S]*?最近一次<\/dt><dd>已完成 · 12 条/);
  const o=owner({schedule:{enabled:true,kinds:['traits'],interval_minutes:60,max_items:10,budget:10,next_at:Date.UTC(2026,9,20,11,0),checks:{traits:{at:Date.UTC(2026,9,20,10,0),found:0}}}});o.flags.traits=true;
  assert.match(page(o),/data-capability="traits"[\s\S]*?自动检查<\/dt><dd>[^<]*没有需要处理的新记忆/);
  const first=owner({schedule:{enabled:true,kinds:['traits'],interval_minutes:60,max_items:10,budget:10,next_at:Date.UTC(2026,9,20,11,0)}});first.flags.traits=true;
  assert.match(page(first),/data-capability="traits"[\s\S]*?自动检查<\/dt><dd>等待第一次检查/);
});
