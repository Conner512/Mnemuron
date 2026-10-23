import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,realpathSync,rmSync,writeFileSync,statSync,mkdirSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {createMnemuronApp} from '../server/lib/app.mjs';
import {MnemuronStore} from '../server/lib/store.mjs';
import assert from 'node:assert/strict';

const runLabel=process.argv[2];
if(runLabel!==undefined && !/^[a-z0-9-]+$/.test(runLabel))throw Error('A safe benchmark run label is required');

const terms=['语音','许可','音','C9800-CL','17.9.8','17.98','FDO1234ABCD','FDO1234ABCE','192.0.2.10','192.0.2.11','ＦＵＬＬＷＩＤＴＨ９９','MiXeD-Case77','😀','🛠','" OR NOT : ( ) % _','路由恢复','备份校验','端口隔离','凭证轮换','网络抖动','蓝牙连接','QoS-DSCP46','2001:db8::100','v0.2.17','FOC987ZYX01','FOC987ZYX02','Eth-Trunk99','11111111-1111-4111-8111-000000000007','syslog/notice','restore_checkpoint_v02'];
assert.equal(terms.length,30);
const percentile=(values,q)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*q)-1]??0;
const stats=values=>({count:values.length,p50_ms:percentile(values,.5),p95_ms:percentile(values,.95),max_ms:Math.max(0,...values)});
const report={schema_version:'core-memory-benchmark-v1',started_at:new Date().toISOString(),synthetic:true,production_touched:false,node:process.version,sqlite:null,hardware:{platform:os.platform(),release:os.release(),arch:os.arch(),cpu:os.cpus()[0].model,cpus:os.cpus().length,memory_bytes:os.totalmem()},thresholds:{warm_p95_ms:{10000:250,100000:750},concurrent_max_ms:5000},runs:[]};
report.actual_head=execFileSync('git',['rev-parse','HEAD'],{cwd:path.resolve(import.meta.dirname,'..'),encoding:'utf8'}).trim();
report.run_label=runLabel ?? null;
for(const size of [10000,100000]) {
  const root=realpathSync(mkdtempSync(path.join(os.tmpdir(),'mnemuron-core-bench-'))),database=path.join(root,'benchmark.sqlite3');
  assert.equal(path.dirname(root),realpathSync(os.tmpdir()));
  let store,app;
  try {
    store=new MnemuronStore(database);
    report.sqlite=store.db.prepare('SELECT sqlite_version() version').get().version;
    const key=store.issueCredential({label:'synthetic',userId:'bench-user',deviceId:'bench-device',agentId:'test',agentInstanceId:'bench-agent',scopes:['memory:read','memory:write','admin:tasks']});
    const auth=store.authenticate(key.api_key);
    for(const id of ['a','b'])store.upsertTask(auth,{task_id:`bench-task-${id}`,project_id:`bench-project-${id}`,project_name:`bench-project-${id}`,title:`bench-task-${id}`,goal:'Synthetic benchmark',status:'active',workstreams:[]});
    const seed=store.saveMemory(auth,{scope:'task',task_id:'bench-task-a',content:'template'}).memory;
    const template=store.db.prepare('SELECT * FROM memories WHERE memory_id=?').get(seed.memory_id);
    store.db.prepare('DELETE FROM memories WHERE memory_id=?').run(seed.memory_id);
    const columns=Object.keys(template),insert=store.db.prepare(`INSERT INTO memories(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`);
    const add=(id,content,overrides={})=>{const row={...template,memory_id:id,content,created_at:'2020-01-01T00:00:00Z',updated_at:'2020-01-01T00:00:00Z',content_hash:createHash('sha256').update(id).digest('hex'),...overrides};insert.run(...columns.map(c=>row[c]));};
    const forbidden=terms.flatMap((_,i)=>[`foreign-${i}`,`other-task-${i}`,`retracted-${i}`,`superseded-${i}`]);
    const cases=terms.map((query,i)=>({id:`query-${i}`,query,task_id:'bench-task-a',top_k:20,expected_ids:[`target-${i}`],forbidden_ids:forbidden,reason:i<3?'short Chinese, including one character':i===14?'literal operators must not become query syntax':i>=10&&i<=13?'Unicode normalization and symbols':'exact engineering identifier or Chinese operational phrase'}));
    const started=performance.now();
    store.db.exec('BEGIN IMMEDIATE');
    for(const [i,term] of terms.entries()) {
      add(`target-${i}`,term+' commonbenchword');
      add(`foreign-${i}`,term+' commonbenchword',{user_id:'foreign-user'});
      add(`other-task-${i}`,term+' commonbenchword',{task_id:'bench-task-b',project_id:'bench-project-b'});
      add(`retracted-${i}`,term+' commonbenchword',{status:'retracted'});
      add(`superseded-${i}`,term+' commonbenchword',{status:'superseded'});
    }
    for(let i=150;i<size;i++)add(`noise-${String(i).padStart(6,'0')}`,`commonbenchword unrelated-${i} synthetic-log-${i%113}`,{created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z',task_id:i%2?'bench-task-a':'bench-task-b',project_id:i%2?'bench-project-a':'bench-project-b'});
    store.db.exec('COMMIT');
    const fixture_ms=performance.now()-started;
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    store.close();store=null;
    const open=performance.now();store=new MnemuronStore(database);const reopen_ms=performance.now()-open;
    const read=spec=>store.queryMemories(auth,{query:spec.query,task_id:spec.task_id,limit:20});
    const cold=[],warm=[];let maxBytes=0;
    for(let round=0;round<4;round++)for(const spec of cases){
      const start=performance.now(),result=read(spec);(round?warm:cold).push(performance.now()-start);
      maxBytes=Math.max(maxBytes,Buffer.byteLength(JSON.stringify(result)));
      const ids=result.results.map(r=>r.memory_id);
      assert.ok(spec.expected_ids.some(id=>ids.includes(id)),spec.id+' missing target');
      assert.ok(spec.forbidden_ids.every(id=>!ids.includes(id)),spec.id+' leaked forbidden');
      if(spec.id==='query-3')assert.equal(ids[0],'target-3');
      if(round===0)spec.actual_ids=ids;
    }
    const commonStart=performance.now(),common=store.queryMemories(auth,{query:'commonbenchword',limit:20});
    const common_ms=performance.now()-commonStart;assert.equal(common.retrieval.candidate_truncated,true);assert.ok(Buffer.byteLength(JSON.stringify(common))<=128*1024);
    const tableBytes=store.db.prepare("SELECT name,sum(pgsize) bytes FROM dbstat WHERE name LIKE 'memory_search_%' GROUP BY name").all();
    store.close();store=null;
    app=createMnemuronApp({databasePath:database});const address=await app.listen({host:'127.0.0.1',port:0}),url=`http://127.0.0.1:${address.port}`;
    const loop=monitorEventLoopDelay({resolution:5});loop.enable();
    const reads=[],writes=[];let next=0;
    const work=Array.from({length:50},(_,i)=>i%5===0?'write':'read');
    await Promise.all(Array.from({length:4},async()=>{while(next<work.length){const index=next++,kind=work[index],spec=cases[index%cases.length];const start=performance.now();
      const response=await fetch(url+(kind==='write'?'/v1/memories':'/v1/memories/query'),{method:'POST',headers:{authorization:`Bearer ${key.api_key}`,'content-type':'application/json'},body:JSON.stringify(kind==='write'?{scope:'user',content:`concurrent-write-${index}`,operation_id:`write-${index}`}:{query:spec.query,task_id:spec.task_id})});
      assert.ok(response.ok);await response.json();(kind==='write'?writes:reads).push(performance.now()-start);
    }}));
    loop.disable();
    const recall=k=>cases.reduce((sum,c)=>sum+c.expected_ids.filter(id=>c.actual_ids.slice(0,k).includes(id)).length/c.expected_ids.length,0)/cases.length;
    const mrr=cases.reduce((sum,c)=>{const rank=c.actual_ids.findIndex(id=>c.expected_ids.includes(id));return sum+(rank<0?0:1/(rank+1));},0)/cases.length;
    const run={size,fixture_ms,reopen_ms,cold_first_pass:stats(cold),warm:stats(warm),quality:{recall_at_5:recall(5),recall_at_10:recall(10),mrr,forbidden_hits:0},common_query_ms:common_ms,common_candidate_truncated:common.retrieval.candidate_truncated,mixed_reads:stats(reads),mixed_writes:stats(writes),event_loop_delay:{p95_ms:loop.percentile(95)/1e6,max_ms:loop.max/1e6},max_response_bytes:maxBytes,rss_bytes:process.memoryUsage().rss,max_rss_bytes:process.resourceUsage().maxRSS*1024,database_bytes:statSync(database).size,index_tables:tableBytes,cases,passed:percentile(warm,.95)<=report.thresholds.warm_p95_ms[size] && Math.max(...reads,...writes)<=5000};
    report.runs.push(run);console.log(JSON.stringify({size,passed:run.passed,warm:run.warm,common_query_ms:common_ms,mixed_max_ms:Math.max(...reads,...writes)}));
  }finally{if(app)await app.close();if(store)store.close();rmSync(root,{recursive:true,force:true});}
}
report.completed_at=new Date().toISOString();report.passed=report.runs.every(r=>r.passed);
const destination=path.resolve('evidence/core-optimization-v0.2/benchmark-'+process.version+(runLabel?'-'+runLabel:'')+'.json');mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});writeFileSync(destination,JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(destination);
if(!report.passed)process.exitCode=1;
