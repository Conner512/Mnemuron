// Shared synthetic fixture for lifecycle read tests. No lifecycle mutation action exists yet, so the
// lifecycle state is created at runtime in a disposable database behind a real loopback Core HTTP app.
import {memoryFixture} from './core-memory-fixture.mjs';

export const REMOTE='https://git.example.test/synthetic/lifecycle-source.git';

export async function world(t,{readerScopes=['memory:read','resume:read','task:reconcile:read','memory:sources:read']}={}){
  const f=await memoryFixture(t),{store,a,other}=f,user=a.auth.user_id;
  const credential=(agentId,agentInstanceId,scopes)=>{const c=store.issueCredential({userId:user,deviceId:`device-${agentInstanceId}`,agentId,agentInstanceId,scopes});return {...c,auth:store.authenticate(c.api_key)};};
  const reader=credential('test','reader-lr',readerScopes);
  const consoleReader=credential('mnemuron-console','console-lr',['memory:read','resume:read','console:read']);
  const task=(id,project,name,extra={})=>store.upsertTask(a.auth,{task_id:id,project_id:project,project_name:name,title:`Lifecycle ${id}`,goal:'Synthetic lifecycle read check',status:'active',workstreams:[],...extra});
  task('task-lr-live','proj-lr-live','Lifecycle Live');task('task-lr-dead','proj-lr-dead','Lifecycle Dead');
  task('task-lr-src','proj-lr-src','Lifecycle Source');task('task-lr-tgt','proj-lr-tgt','Lifecycle Target');
  store.upsertProject(a.auth,{project_id:'proj-lr-src',name:'Lifecycle Source',aliases:['old-codename'],git_remotes:[REMOTE]});
  const save=(label,payload)=>store.saveMemory(a.auth,{content:`LRMARK ${label} synthetic lifecycle record`,...payload}).memory.memory_id;
  const m={neutral:save('neutral',{scope:'user'}),live:save('live',{scope:'project',project_id:'proj-lr-live'}),dead:save('dead',{scope:'project',project_id:'proj-lr-dead'}),
    deadTask:save('deadtask',{scope:'task',task_id:'task-lr-dead'}),src:save('src',{scope:'project',project_id:'proj-lr-src'}),srcTask:save('srctask',{scope:'task',task_id:'task-lr-src'}),
    tgt:save('tgt',{scope:'project',project_id:'proj-lr-tgt'})};
  const foreignMemory=store.saveMemory(other.auth,{scope:'user',content:'LRMARK foreign synthetic lifecycle record'}).memory.memory_id;
  const row=(id,state,into=null)=>store.db.prepare('INSERT OR REPLACE INTO project_lifecycle VALUES (?,?,?,?,1,?)').run(user,id,state,into,new Date().toISOString());
  row('proj-lr-dead','deleted');row('proj-lr-src','merged','proj-lr-tgt');
  const query=async(body,owner=reader)=>f.request('POST','/v1/memories/query',{query:'LRMARK',limit:50,...body},owner);
  const ids=response=>response.body.results.map(r=>r.memory_id).sort();
  // Simulated lifecycle mutation (no route exists yet): the state change and the generation bump commit together.
  const mutate=(id,state,into=null)=>store.memoryTransaction(()=>{
    if(state==='active')store.db.prepare("UPDATE project_lifecycle SET state='active',merged_into=NULL,lifecycle_revision=lifecycle_revision+1 WHERE user_id=? AND project_id=?").run(user,id);
    else row(id,state,into);
    return store.lifecycle.bumpGeneration(user);
  });
  return {...f,user,reader,consoleReader,credential,task,save,m,foreignMemory,row,mutate,query,ids};
}
