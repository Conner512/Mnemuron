import { queueItems, queueState } from '../../adapters/openclaw/dist/sync-protocol.mjs';

// Only the disposable loopback harness uses an accelerated retry clock. Live runners do not.
export async function drainIsolatedOutbox(client) {
  if(!['127.0.0.1','[::1]'].includes(client.config.serverUrl.hostname))throw Error('Retry-clock acceleration requires loopback isolation.');
  const result={queued_before:client.outboxFiles().length,flushed:0,quarantined:0,blocked:0,retry_clock:'accelerated_isolated'};
  const previous=client.retryOptions;
  try {
    for(let round=0;round<200;round++) {
      const queued=queueItems(client.config.outboxDir,'event');
      if(!queued.length)break;
      const due=Math.max(Date.now(),...queued.map(item=>Date.parse(queueState(item).next_retry_at)||0));
      client.retryOptions={...previous,now:()=>due};
      const current=await client.flushOutbox();
      result.flushed+=current.flushed;result.quarantined+=current.quarantined;result.blocked=current.blocked;
      if(!current.flushed && !current.quarantined)break;
    }
    return result;
  }finally{client.retryOptions=previous;}
}
