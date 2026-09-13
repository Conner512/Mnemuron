import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MnemuronStore} from '../../lib/store.mjs';
import {Organizer,Embedder} from '../../lib/model-providers/providers.mjs';
export const config={config_version:'mnemuron-memory-first-v1',deployment_mode:'test',development:{synthetic_data:true},modules:{memory:{enabled:true},handoff:{enabled:false,existing_inflight_policy:'drain_before_disable'}}};
export const taxonomy={version:'synthetic-taxonomy-v1',categories:['uncategorized','engineering','preferences']};
export function profile(kind='organizer',patch={}){return {enabled:true,provider_id:'synthetic-'+kind,protocol:'mock',model:'synthetic-'+kind,profile_revision:'fixture-v1',auth:{none:true},
  timeouts:{request_ms:1000},limits:{input_bytes:1000000,input_tokens:1000000,output_bytes:1000000,output_tokens:10000,batch_size:20,concurrency:2,daily_requests:10000},
  retry:{max_attempts:3,base_ms:100,max_ms:10000,repair_once:false},capabilities:{native_schema:true},egress:{approved:true,origins:[],addresses:[],allow_private:false,sensitivities:['public','internal','sensitive'],query_approved:true},
  ...(kind==='embedder'?{dimensions:3,distance:'Cosine',query_prefix:'',document_prefix:'',normalization:'l2',chunker_version:'utf8-chunks-v1'}:{}),...patch};}
export function organizer(mock=input=>({results:input.sources.map(s=>input.operation==='classification'?{memory_id:s.memory_id,category:'engineering',tags:['synthetic']}:
  {memory_id:s.memory_id,revision:s.revision,start:0,end:s.content.length,quote:s.content})}),patch={}){return new Organizer(profile('organizer',patch),{synthetic:true,mock});}
export function embedder(mock=texts=>texts.map(t=>/网络|network|router|packet/i.test(t)?[1,0,0]:/storage|disk|磁盘/i.test(t)?[0,1,0]:[0,0,1]),patch={}){return new Embedder(profile('embedder',patch),{synthetic:true,mock});}
export function fixture(t){
  const root=mkdtempSync(path.join(os.tmpdir(),'mnemuron-model-fixture-')),s=new MnemuronStore(root+'/synthetic.sqlite3',{memoryConfig:config});
  const credential=s.issueCredential({label:'Synthetic',userId:'synthetic-owner',deviceId:'synthetic-device',agentId:'synthetic',agentInstanceId:'synthetic-agent',scopes:['memory:read','memory:write','capture:write']});
  const auth=s.authenticate(credential.api_key);
  t.after(()=>{s.close();rmSync(root,{recursive:true,force:true});});
  return {s,auth,root,save:(content,extras={})=>s.saveMemory(auth,{content,scope:'user',...extras}).memory};
}
