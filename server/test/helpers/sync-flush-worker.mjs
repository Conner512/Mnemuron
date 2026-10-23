import path from 'node:path';
import {queueItems,flushQueue} from '../../../plugins/mnemuron/scripts/sync-protocol.mjs';
// This child is created by an isolated test only; it has no CLI or live target mode.
process.once('message',async ({root,hold})=>{
  const result=await flushQueue(queueItems(path.join(root,'outbox'),'event'),{root,credential:'test',send:async item=>{
    process.send({phase:'sending'});
    if(hold)await new Promise(resolve=>process.once('message',resolve));
    return {status:'accepted',received:1,inserted:1,duplicate:0,accepted_event_ids:[item.payload.event.event_id]};
  }});
  process.send({result});process.disconnect();
});
