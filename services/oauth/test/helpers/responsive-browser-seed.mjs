// Populated UI fixture only: real local records and fake model configuration. Never runs a provider.
import {generate} from 'otplib';
import {seconds} from '../../../../shared/oauth-common.mjs';
export async function seedResponsive(core,ids,owner,modelUrl){
 const user=owner.account.user_id,store=core.store,writer=core.issue(user,'synthetic-responsive');
 for(const kind of ['organizer','embedder'])store.consoleService.models.save(writer.auth,{kind,expected_revision:0,config:{
  enabled:true,protocol:'openai_compatible',base_url:modelUrl,model:`synthetic-${kind}-long-model-name-for-phone-and-tablet-layout`,profile_revision:'synthetic-layout-v1',
  daily_requests:20,output_tokens:1024,batch_size:10,sensitivities:['public','internal','sensitive'],egress_approved:false,query_approved:false,...(kind==='embedder'?{dimensions:3}:{})}});
 const source=store.derivedMemory.currentSource(user,store.saveMemory(writer.auth,{scope:'user',content:'合成布局记忆：长名称与状态应该保持可读。Synthetic layout record with readable long labels.'}).memory.memory_id);
 for(const [index,state] of ['pending','blocked_config','review_required','cancelled'].entries()){
  const job=store.memoryJobs.enqueue({type:index%2?'summary':'classification',userId:user,scope:source.scope_key,profile:'synthetic-responsive',metadata:{category:`synthetic-${index}`,taxonomy:store.consoleService.taxonomy(user)},items:[source]});
  store.db.prepare('UPDATE memory_jobs SET state=?,last_error_code=? WHERE job_id=?').run(state,state==='blocked_config'?'EGRESS_DENIED':state==='review_required'?'INVALID_MODEL_OUTPUT':null,job);
 }
 for(const client of [{device:'mobile',browser:'safari',os:'ios'},{device:'desktop',browser:'firefox',os:'linux'},{device:'tablet',browser:'edge',os:'windows'}])ids.newSession('console',{accountId:owner.account.account_id,client});
 ids.audit(owner.account.account_id,'account.login');
 for(const [index,profile] of ['readonly','memory_readwrite'].entries()){
  ids.db.prepare('DELETE FROM oauth_mfa_steps WHERE subject=?').run(owner.account.subject);
  await ids.connections.execute(owner.account.account_id,ids.session(owner.console.token,'console'),'connections.create',{
   kind:'generic_mcp',label:`Synthetic ${profile} connection with a deliberately long label 合成连接`,description:'Synthetic localhost acceptance only.',profile,
   current_password:'Synthetic password with spaces  ',otp:await generate({secret:owner.setup.secret,epoch:seconds()})},`synthetic-responsive-connection-${index}`);
 }
 return {models:2,jobs:4,sessions_added:3,connections:2,provider_calls:0};
}
