import {MnemuronStore} from '../../lib/store.mjs';
let store;
process.on('message',message=>{
  if(message.databasePath){store=new MnemuronStore(message.databasePath);process.send({ready:true});return;}
  try{process.send({result:store.rotateAgentKey(message.auth,message.agent)});}
  catch(error){process.send({error_code:error.errorCode});}
  finally{store.close();process.disconnect();}
});
