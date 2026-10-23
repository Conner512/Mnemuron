import test from 'node:test';
import assert from 'node:assert/strict';
import {auditView} from '../../../web/console/visuals.mjs';
import {collectAuditExport,auditExportPage} from '../../../web/console/audit.mjs';
import {catalog,text} from '../../../web/console/catalog.mjs';

const facts={source:'core',entries:[{audit_id:'audit-1',credential_id:'credential-1',action:'memory.query',kind:'read',outcome:'success',created_at:'2026-10-08T01:00:00.000Z',query:{result_refs_kind:'lexical_subquery',result_refs:['own-memory','foreign-memory'],result_refs_truncated:true}}],credentials:{'credential-1':{label:'Synthetic <script>agent</script>',agent_id:'synthetic-agent',agent_instance_id:'synthetic-instance',device_id:'synthetic-device',revoked:true,connection:{type:'personal',connection_id:'connection-1',label:'Current synthetic connection',kind:'generic_mcp',state:'ready',credential_version:2}}},memories:{'own-memory':{title:'Current own title',status:'active'}},next_offset:null};

test('Audit UI: exact source, recorded references, current labels, owner links and compact filters in both locales',()=>{
 for(const locale of ['en','zh-CN']){
   const html=auditView(key=>text(key,locale),{data:facts,source:'core'});
   for(const value of ['credential-1','synthetic-instance','connection-1','Current own title','2026-10-08T01:00:00.000Z'])assert.ok(html.includes(value));
   assert.match(html,/data-memory="own-memory"/);assert.doesNotMatch(html,/data-memory="foreign-memory"|<script>/);assert.match(html,/&lt;script&gt;/);
   assert.match(html,/class="audit-filter-panel" >/);assert.match(html,/data-audit-group="memory" aria-pressed="true"/);
   for(const [,key] of html.matchAll(/data-i18n="([^"]+)"/g))assert.ok(Object.hasOwn(catalog[locale],key),`${locale}:${key}`);
   const filtered=auditView(key=>text(key,locale),{data:facts,filters:{action:'memory.query'}});assert.match(filtered,/class="audit-filter-panel" open/);
 }
 const identity=auditView(text,{source:'identity',group:'security',data:{entries:[{action:'account.login',kind:'auth',outcome:'success',created:1}]}});assert.doesNotMatch(identity,/data-memory=|Recorded credential/);assert.match(identity,/data-audit-group="security" aria-pressed="true"/);
 const old=auditView(text,{data:{entries:[{action:'memory.query',query:{result_refs:null}}]}});assert.match(old,/auditActorUnknown/);assert.match(old,/auditRefsNotRecorded/);
 const inherited=auditView(text,{data:{entries:[{action:'memory.read',target_type:'memory',target_id:'constructor'}],memories:{}}});assert.doesNotMatch(inherited,/data-memory=/);
});

test('Audit UI: details name each object once; every recorded ID is labelled once under folded technical details',()=>{
 const connectionId='02503645c080eda35700f00a5d750b4c8ccc992239ed0da6a3c26027812e1b6b';
 const read={audit_id:'audit-read',credential_id:'credential-read',action:'memory.read',kind:'read',outcome:'success',created_at:'2026-10-15T11:21:50.000Z',target_type:'memory',target_id:'memory-read'};
 const data={entries:[read,facts.entries[0]],memories:{'memory-read':{title:'Current read title'},...facts.memories},credentials:{...facts.credentials,
  'credential-read':{label:'Account-bound connection',agent_id:'chatgpt-web',agent_instance_id:'connection-'+connectionId,device_id:'identity-service',revoked:false,
   connection:{type:'personal',connection_id:connectionId,label:'Mnemuron',kind:'chatgpt_oauth',state:'ready',credential_version:1}}}};
 for(const locale of ['en','zh-CN']){
  const html=auditView(key=>text(key,locale),{data});
  const [first,second]=html.split('<li class="timeline-item"').slice(1);
  for(const [item,ids,labels] of [[first,['memory-read',connectionId,'credential-read','audit-read'],['auditMemoryId','auditConnectionId','auditCredentialId','auditEventId']],
   [second,['own-memory','foreign-memory','connection-1','credential-1','audit-1'],['auditResultIds','auditConnectionId','auditCredentialId','auditEventId']]]) {
   const [main,technical]=item.split('<details class="audit-technical">');
   assert.doesNotMatch(main,/data-audit-copy=/,`${locale}: no IDs beside names`);
   for(const id of ids){assert.equal(technical.split(`data-audit-copy="${id}"`).length-1,1,`${locale}:${id} copy`);assert.equal(item.split(`<code>${id}</code>`).length-1,1,`${locale}:${id} shown once`);}
   for(const key of labels)assert.match(technical,new RegExp(`<dt><span data-i18n="${key}">`),`${locale}:${key}`);
   for(const key of ['auditActionLabel','auditCredential'])assert.match(main,new RegExp(`<dt><span data-i18n="${key}">`),`${locale}:${key}`);
  }
  assert.match(first,/data-i18n="auditMemoryLabel"[\s\S]*data-memory="memory-read"[\s\S]*data-i18n="auditConnectionLabel"[\s\S]*<strong>Mnemuron<\/strong>/);
  // The instance repeats the connection ID; the agent and device stay under technical details.
  assert.doesNotMatch(first,new RegExp('connection-'+connectionId));assert.match(first,/<details class="audit-technical">[\s\S]*chatgpt-web[\s\S]*identity-service/);
  assert.match(second,/<details class="audit-technical">[\s\S]*synthetic-instance/);
  assert.doesNotMatch(html,/chatgpt_oauth|auditCurrentTitle/);assert.match(html,/data-i18n="connChatGPT"/);assert.match(html,/data-i18n="auditCurrentNote"/);
 }
});

test('Audit export: one exact source, independent paging, limited provenance, duplicate suppression and no bodies',async()=>{
 const requests=[];const doc=await collectAuditExport(async params=>{requests.push(params);return {...facts,entries:facts.entries.map(e=>({...e,metadata_json:'PRIVATE SECRET',content:'PRIVATE BODY'})),memories:{...facts.memories,'foreign-memory-unreferenced':{title:'PRIVATE FOREIGN'},'own-memory':{...facts.memories['own-memory'],content:'PRIVATE BODY'}},credentials:{'credential-1':{...facts.credentials['credential-1'],key_hash:'PRIVATE KEY',connection:{...facts.credentials['credential-1'].connection,secret_cipher:'PRIVATE SECRET'}}},next_offset:params.offset===0?100:null};},{source:'core',action:'memory.query'});
 assert.deepEqual(requests.map(q=>[q.source,q.offset,q.action]),[['core',0,'memory.query'],['core',100,'memory.query']]);assert.equal(doc.entries.length,1);assert.equal(doc.source,'core');assert.equal(doc.entries[0].source,'core');
 assert.equal(doc.credentials['credential-1'].agent_instance_id,'synthetic-instance');assert.equal(doc.credentials['credential-1'].connection.connection_id,'connection-1');assert.equal(doc.memories['own-memory'].title,'Current own title');
 assert.doesNotMatch(JSON.stringify(doc),/PRIVATE|content"|metadata_json|key_hash|secret_cipher/);assert.match(doc.provenance.query_results,/not_final/);
 const identity=await collectAuditExport(async()=>({source:'identity',entries:[{audit_id:'identity-1',created:1,action:'account.login'}],next_offset:null,credentials:facts.credentials,memories:facts.memories}),{source:'identity'});
 assert.deepEqual(Object.keys(identity.credentials),[]);assert.deepEqual(Object.keys(identity.memories),[]);assert.equal(identity.entries[0].source,'identity');
});

test('Audit export: stale source/account, failed reads and malformed paging never complete a partial download',async()=>{
 let active=true,resolve;const waiting=collectAuditExport(()=>new Promise(r=>resolve=r),{source:'core'},()=>active);active=false;resolve(facts);await assert.rejects(waiting,/STALE_ACCOUNT/);
 await assert.rejects(collectAuditExport(async()=>({...facts,source:'identity'}),{source:'core'}),/INVALID_AUDIT_PAGE/);
 await assert.rejects(collectAuditExport(async()=>({...facts,next_offset:0}),{source:'core'}),/INVALID_AUDIT_PAGE/);
 let calls=0;await assert.rejects(collectAuditExport(async()=>{if(++calls===2)throw new Error('UNAVAILABLE');return {...facts,next_offset:100};}),/UNAVAILABLE/);
 assert.equal(calls,2);
 const legacy=auditExportPage({...facts,entries:[{audit_id:'old',query:{result_refs:null,result_refs_kind:'not_recorded'}}]},'core');assert.equal(legacy.entries[0].query.result_refs,null);
});
