import {fail} from '../../lib/model-providers/contracts.mjs';
export const matches=(p,f={})=>{
  const one=c=>c.has_id?c.has_id.includes(p.id):c.key?(c.match.any?c.match.any.includes(p.payload[c.key]):p.payload[c.key]===c.match.value):matches(p,c);
  return (f.must || []).every(one) && !(f.must_not || []).some(one) && (!f.should?.length || f.should.some(one));
};
export class MockVectorStore {
  constructor(){this.collections=new Map();this.down=false;this.searchCalls=[];}
  available(){if(this.down)fail('VECTOR_UNAVAILABLE');}
  async health(){this.available();return {state:'ready',synthetic:true};}
  async ensureCollection(name,config){this.available();const old=this.collections.get(name);if(old && JSON.stringify(old.config)!==JSON.stringify(config))fail('VECTOR_PROFILE_MISMATCH');if(!old)this.collections.set(name,{config,points:new Map()});}
  async upsert(name,points){this.available();for(const p of points)this.collections.get(name).points.set(p.id,structuredClone(p));}
  async deleteByDocumentRevision(name,filter){this.available();for(const [id,p] of this.collections.get(name).points)if(matches(p,filter))this.collections.get(name).points.delete(id);}
  async search(name,vector,filter,limit){this.available();this.searchCalls.push({name,vector,filter,limit});return [...this.collections.get(name).points.values()].filter(p=>matches(p,filter))
    .map(p=>({...p,score:p.vector.reduce((s,n,i)=>s+n*vector[i],0)})).sort((a,b)=>b.score-a.score || a.id.localeCompare(b.id)).slice(0,limit);}
  async scroll(name,offset=null){this.available();const all=[...this.collections.get(name).points.values()],start=offset || 0;return {points:all.slice(start,start+100),next_page_offset:start+100<all.length?start+100:null};}
}
