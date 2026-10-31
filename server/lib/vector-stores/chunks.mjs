import {digest,fail,integer} from '../model-providers/contracts.mjs';

export const VECTOR_CHUNK_PLAN='utf8-request-budget-v2';

// Preserve every Unicode code point. This primitive remains useful to callers with a plain byte ceiling;
// documentChunks additionally accounts for JSON escapes, prefixes and the provider's complete request envelope.
export function splitDocument(content,maxBytes){
  integer(maxBytes,16,1000000);const parts=[];let text='',bytes=0;
  for(const char of content){const n=Buffer.byteLength(char);if(bytes+n>maxBytes){parts.push(text);text='';bytes=0;}text+=char;bytes+=n;}
  if(text)parts.push(text);return parts;
}

export function documentChunks(embedder,content){
  const texts=[];
  for(const part of splitDocument(content,8192)){
    const chars=Array.from(part);let start=0;
    while(start<chars.length){
      let low=1,high=chars.length-start,best=0;
      while(low<=high){
        const count=Math.floor((low+high)/2),text=chars.slice(start,start+count).join('');
        if(embedder.measureRequest([text],'document').fits){best=count;low=count+1;}else high=count-1;
      }
      // Even one source code point cannot fit: fail before reserving a paid call, never truncate or drop it.
      if(!best)fail('INPUT_TOO_LARGE');
      texts.push(chars.slice(start,start+best).join(''));start+=best;
    }
  }
  if(!texts.length)fail('INVALID_INPUT');
  // Limits are deliberately outside the model fingerprint. Bind progress to this exact layout as well,
  // so a budget/configuration change cannot reuse a different chunk at the same ordinal.
  const layout=digest([VECTOR_CHUNK_PLAN,texts]);
  return {layout,chunks:texts.map((text,chunk)=>({text,chunk}))};
}

export function documentBatches(embedder,chunks){
  const batches=[];let batch=[];
  for(const chunk of chunks){
    const next=[...batch,chunk];
    if(next.length<=embedder.profile.limits.batch_size&&embedder.measureRequest(next.map(c=>c.text),'document').fits){batch=next;continue;}
    if(batch.length)batches.push(batch);
    if(!embedder.measureRequest([chunk.text],'document').fits)fail('INPUT_TOO_LARGE');
    batch=[chunk];
  }
  if(batch.length)batches.push(batch);
  return batches;
}
