import { MnemuronStore } from "../../lib/store.mjs";
let store;
process.on("message", message => {
  if (message.databasePath) {
    store = new MnemuronStore(message.databasePath);
    process.send({ ready: true });
    return;
  }
  try {
    process.send({ result: store.saveMemory(message.auth, message.body) });
  } catch (error) {
    process.send({ error_code: error.errorCode, status: error.statusCode, error: error.message });
  } finally { store.close(); process.disconnect(); }
});
