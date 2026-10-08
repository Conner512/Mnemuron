// Synthetic in-process fixtures only. No HTTP endpoint, model call or historical backfill.
export function seedEntityBrowser(core,owner){
 const s=core.store,user=owner.account.user_id,writer=core.issue(user,'synthetic-entity-ui'),g=s.entities;
 const named=(content,name,kind='object',scope={scope:'user'})=>{const m=s.saveMemory(writer.auth,{...scope,content}).memory,source=g.source(user,m.memory_id),e=g.createFromSource(source,name,kind,'model');return {m,source,e};};
 const proof=x=>({user_id:user,memory_id:x.m.memory_id,revision:x.source.revision,state_hash:x.source.state_hash,scope_key:x.source.scope_key});
 const longName='SyntheticLongObject'+'x'.repeat(61); // Exactly 80 code points; no forced word breaks in stored text.
 const long=named(`${longName} is the primary synthetic server. Maybe the owner calls it Pending Alias.`,longName,'server');
 const alias=g.addName(long.e,'Pending Alias',{origin:'model',state:'pending',proof:proof(long)});
 const manual=g.addName(long.e,'Original manual alias',{origin:'manual',proof:proof(long)});
 const member=s.saveMemory(writer.auth,{scope:'user',content:'Synthetic linked member, separate from the source anchor.'}).memory,memberSource=g.source(user,member.memory_id);
 s.db.prepare("INSERT INTO memory_entity_members VALUES(?,?,?,?,?,'accepted')").run(user,long.e.entity_id,member.memory_id,JSON.stringify({...proof(long),memory_id:member.memory_id,revision:memberSource.revision,state_hash:memberSource.state_hash}),'manual');
 const person=named('Ali is a synthetic person; perhaps also A-person.','Ali','person');
 const place=named('Ali is a synthetic place, not the person.','Ali','place');
 const other=named('Secondary synthetic server is a separate machine.','Secondary synthetic server','server');
 const proposal=g.propose(long.e,other.e,{proof:{source:proof(long),target:proof(other)}});
 const related=named('Synthetic Vendor hosts a synthetic server.','Synthetic Vendor','vendor');
 g.addName(related.e,'synthetic server',{origin:'model',state:'pending',proof:proof(related),relation:'related'});
 const stale=named('STALE ANCHOR CONTENT MUST NEVER BE SHOWN','Stale synthetic object');
 g.addName(stale.e,'Stale pending alias',{origin:'model',state:'pending',proof:proof(stale)});s.retractMemory(writer.auth,stale.m.memory_id,{});
 for(const [id,name] of [['synthetic-staging','Staging project'],['synthetic-production','Production project']]){s.upsertProject(writer.auth,{project_id:id,name});named(`web-01 belongs to ${name}.`,'web-01','server',{scope:'project',project_id:id});}
 return {memory_id:long.m.memory_id,entity_id:long.e.entity_id,long_name:longName,manual_name_id:manual,pending_name_id:alias,member_id:member.memory_id,person_id:person.e.entity_id,place_id:place.e.entity_id,other_id:other.e.entity_id,proposal_id:proposal,stale_id:stale.e.entity_id};
}
export function seedEntityBrowserPending(core,owner){
 const s=core.store,user=owner.account.user_id,writer=core.issue(user,'synthetic-delayed-entity-'+Date.now()),g=s.entities;
 const m=s.saveMemory(writer.auth,{scope:'user',content:'Delayed pending object may also be called Delayed pending alias.'}).memory,source=g.source(user,m.memory_id),e=g.createFromSource(source,'Delayed pending object','object','model');
 g.addName(e,'Delayed pending alias',{origin:'model',state:'pending',proof:{user_id:user,memory_id:m.memory_id,revision:source.revision,state_hash:source.state_hash,scope_key:source.scope_key}});
 return {entity_id:e.entity_id,memory_id:m.memory_id};
}
