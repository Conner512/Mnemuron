import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {VectorIndex} from '../vector-stores/index.mjs';
import {QdrantStore} from '../vector-stores/qdrant.mjs';
import {vectorAcceptanceTarget} from './vector.mjs';
import {rankMetrics} from './quality.mjs';
import {ModelError,fail} from '../model-providers/contracts.mjs';

// Caller owns a fresh synthetic database; no configured or production store is opened here.
export async function evaluateQualityProjection({store,auth,byMemoryId,fixture,config,embedder,vectorTransport,onProgress=()=>{}}){
  const result={status:'failed',hard_correctness:'failed',quality:'not_run',cleanup:'not_needed',queries:[],human_review:'not_run'};
  let backend,index,generation,collection,owned=false;
  try{
    backend=new QdrantStore(vectorAcceptanceTarget(config),{transport:vectorTransport});
    if(!embedder.profile.egress.sensitivities.includes('sensitive') || !embedder.profile.egress.query_approved)fail('QUERY_EGRESS_NOT_APPROVED');
    result.health=await backend.health();
    index=new VectorIndex(store,backend,new Map([[embedder.profile.fingerprint,embedder]]),{prefix:'quality_'+randomUUID().replaceAll('-','').slice(0,16)});
    generation=index.begin(embedder.profile.fingerprint);
    collection=store.db.prepare('SELECT collection_name FROM memory_vector_generations WHERE generation=?').get(generation).collection_name;
    if((await backend.call('/collections/'+collection+'/exists',undefined,'GET')).exists)fail('COLLECTION_ALREADY_EXISTS');
    owned=true;result.collection=collection;result.cleanup='pending';
    const sync=await index.sync(generation);assert.equal(sync.complete,true);index.activate(generation);
    assert.equal(sync.processed,fixture.documents.length+2);
    assert.equal((await index.sync(generation)).processed,0);
    const points=[];let offset=null;
    do{const page=await backend.scroll(collection,offset);points.push(...page.points);offset=page.next_page_offset ?? null;}while(offset!==null);
    assert.equal(points.length,fixture.documents.length+2);
    for(const point of points){
      assert.deepEqual(Object.keys(point.payload).sort(),['content_hash','document','lifecycle','owner','profile','revision','scope']);
      assert.equal(Object.hasOwn(point,'vector'),false);assert.doesNotMatch(JSON.stringify(point.payload),/FORBIDDEN|synthetic-quality-owner/);
    }
    result.indexed_sources=sync.processed;result.points=points.length;result.repeat_processed=0;
    const rankings={};let completeDetails=0;
    for(const query of fixture.queries){
      const mode=query.kind==='exact'?'hybrid':'semantic';
      const response=await index.search(auth,{query:query.query,mode,session_id:'synthetic-evaluation-session',limit:20});
      assert.equal(response.retrieval.degraded,false);
      const ids=response.results.map(m=>byMemoryId.get(m.memory_id));assert.equal(new Set(ids).size,ids.length);
      assert.ok(ids.every(id=>fixture.documents.some(d=>d.id===id)));
      for(const memory of response.results){
        const original=fixture.documents.find(d=>d.id===byMemoryId.get(memory.memory_id));
        assert.equal(store.memoryDetail(auth,memory.memory_id).memory.content,original.content);completeDetails++;
      }
      rankings[query.id]=ids;result.queries.push({id:query.id,mode,top_ids:ids.slice(0,5),degraded:false});
      onProgress({phase:'projection-query',id:query.id,mode,completed:result.queries.length,total:fixture.queries.length});
    }
    result.exact=rankMetrics(fixture.queries.filter(q=>q.kind==='exact'),rankings,fixture.forbidden_ids);
    result.semantic=rankMetrics(fixture.queries.filter(q=>q.kind==='semantic'),rankings,fixture.forbidden_ids);
    result.detail_reads=completeDetails;
    assert.equal(result.exact.scope_leaks+result.semantic.scope_leaks,0);
    result.hard_correctness='passed';
    result.quality=result.exact.top1>=fixture.thresholds.exact_top1 && result.semantic.top1>=fixture.thresholds.semantic_top1 &&
      result.semantic.mrr>=fixture.thresholds.semantic_mrr && result.semantic.recall_at_5>=fixture.thresholds.semantic_recall_at_5?'passed':'failed';
  }catch(error){result.error_code=error instanceof ModelError?error.code:error?.code==='ERR_ASSERTION'?'ASSERTION_FAILED':'PROJECTION_FAILED';}
  finally{
    if(owned)try{
      // Only the exact collection proven absent before this run may be removed.
      if((await backend.call('/collections/'+collection+'/exists',undefined,'GET')).exists)await backend.call('/collections/'+collection,undefined,'DELETE');
      if((await backend.call('/collections/'+collection+'/exists',undefined,'GET')).exists)fail('CLEANUP_INCOMPLETE');
      result.cleanup='passed';
    }catch{result.cleanup='failed';result.hard_correctness='failed';}
  }
  result.status=result.hard_correctness==='passed' && result.quality==='passed' && result.cleanup==='passed'?'passed':'failed';
  return result;
}
