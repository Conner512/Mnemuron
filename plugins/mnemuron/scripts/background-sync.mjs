import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {loadRuntimeEnv, resolveDataDir} from './storage.mjs';
import {atomicState, claimLane, queueItems, queueState} from './sync-protocol.mjs';
import {flushDeliveryReceiptOutbox, flushInjectionEventOutbox, flushOutbox} from './remote-client.mjs';

const script=fileURLToPath(import.meta.url);
const directories={event:'outbox',receipt:'delivery-receipt-outbox',injection:'injection-event-outbox'};
export const backgroundSyncEnabled=env=>env.MNEMURON_BACKGROUND_SYNC==='true';
const items=root=>Object.entries(directories).flatMap(([kind,dir])=>queueItems(path.join(root,dir),kind));

export function startBackgroundSync(env) {
  const child=spawn(process.execPath,[script],{env,detached:true,stdio:'ignore'});
  child.on('error',()=>{});child.unref();
}

// This is a bounded outbox pump, not an always-on service. The immutable envelopes,
// per-session lane locks and exact server receipts remain the source of truth.
export async function runBackgroundSync(env, {maxRunMs=60000}={}) {
  const runtimeEnv=loadRuntimeEnv(env),root=resolveDataDir(runtimeEnv);
  const release=claimLane(root,'background-outbox-pump');if(!release)return;
  const status=path.join(root,'background-sync.state'),started=Date.now();
  const publish=state=>atomicState(status,{state,pid:process.pid,started_at:new Date(started).toISOString(),updated_at:new Date().toISOString(),queued:items(root).length});
  let released=false,drained=false;
  const unlock=()=>{if(!released){release();released=true;}};
  const stop=()=>{try{publish('paused');}finally{unlock();process.exit(0);}};
  const deadline=setTimeout(stop,maxRunMs);deadline.unref();
  process.once('SIGTERM',stop);
  try {
    publish('running');
    const transportEnv={...runtimeEnv,MNEMURON_REQUEST_TIMEOUT_MS:'60000'};
    while(Date.now()-started<maxRunMs) {
      for(const flush of [flushDeliveryReceiptOutbox,flushInjectionEventOutbox,flushOutbox]) await flush(transportEnv);
      const remaining=items(root);
      if(!remaining.length){await delay(150);if(!items(root).length){drained=true;break;}continue;}
      if(!remaining.some(item=>!item.parse_error && ['pending','retry_wait','blocked_gap'].includes(queueState(item).state)))break;
      await delay(500);
    }
    publish(drained?'idle':'paused');
  }catch {publish('failed');}
  finally {
    clearTimeout(deadline);process.removeListener('SIGTERM',stop);unlock();
    // Close the enqueue-versus-exit race after releasing singleton ownership.
    if(drained && items(root).length)startBackgroundSync(runtimeEnv);
  }
}

if(process.argv[1] && path.resolve(process.argv[1])===script) {
  runBackgroundSync(process.env).catch(()=>{process.exitCode=1;});
}
