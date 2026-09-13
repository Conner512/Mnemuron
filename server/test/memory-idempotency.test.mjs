import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { memoryFixture, businessSnapshot } from "./helpers/core-memory-fixture.mjs";
import { callTool, TOOLS } from "../../plugins/mnemuron/scripts/mcp-core.mjs";
import { MnemuronClient } from "../../adapters/openclaw/dist/client.js";
import { MnemuronStore } from "../lib/store.mjs";

async function hermesRemember(config, body) {
  const child = spawn("python3", [fileURLToPath(new URL("./helpers/memory-remember-hermes.py", import.meta.url))], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { errors += chunk; });
  const stopped = once(child, "close");
  child.stdin.end(JSON.stringify({ config, body }));
  const [code] = await stopped;
  assert.equal(code, 0, errors);
  const response = JSON.parse(output);
  if (response.error) throw Object.assign(new Error(response.error), { operation_id: response.operation_id });
  return response.result;
}

async function race(t, f, bodies) {
  const workers = bodies.map(() => fork(new URL("./helpers/memory-create-worker.mjs", import.meta.url), [], { stdio: ["ignore", "ignore", "pipe", "ipc"] }));
  t.after(() => { for (const worker of workers) if (worker.connected) worker.kill(); });
  await Promise.all(workers.map(async worker => { const ready=once(worker,"message");worker.send({databasePath:f.databasePath});assert.deepEqual((await ready)[0],{ready:true}); }));
  const results=workers.map(worker=>once(worker,"message").then(([message])=>message));
  workers.forEach((worker,index)=>worker.send({auth:f.a.auth,body:bodies[index]}));
  return Promise.all(results);
}

test("I-05: two independent processes create one Memory and one audit", async t => {
  const f=await memoryFixture(t);
  const body={content:"concurrent intent",scope:"user",operation_id:"concurrent-same"};
  const results=await race(t,f,[body,body]);
  assert.ok(results.every(r=>r.result),JSON.stringify(results));
  assert.equal(new Set(results.map(r=>r.result.memory.memory_id)).size,1);
  assert.equal(results.filter(r=>r.result.idempotent).length,1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM memories").get().n,1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='memory.create'").get().n,1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM memory_create_operations").get().n,1);
});

test("I-06: conflicting intents race with exactly one winner", async t => {
  const f=await memoryFixture(t);
  const body={content:"left",scope:"user",operation_id:"concurrent-conflict"};
  const results=await race(t,f,[body,{...body,content:"right"}]);
  assert.equal(results.filter(r=>r.result).length,1);
  assert.equal(results.filter(r=>r.error_code==="IDEMPOTENCY_CONFLICT"&&r.status===409).length,1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM memories").get().n,1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='memory.create'").get().n,1);
});

test("I-07: audit and operation-insert failures roll back; outer transactions remain owned", async t => {
  const {store,a}=await memoryFixture(t);
  for(const table of ["audit_events","memory_create_operations"]) {
    const condition=table==="audit_events"?"WHEN NEW.action = 'memory.create'":"";
    store.db.exec(`CREATE TEMP TRIGGER fail_create BEFORE INSERT ON ${table} ${condition} BEGIN SELECT RAISE(ABORT,'test failure'); END`);
    const before=businessSnapshot(store);
    assert.throws(()=>store.saveMemory(a.auth,{scope:"user",content:"atomic",operation_id:"atomic"}),/test failure/);
    assert.deepEqual(businessSnapshot(store),before);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM memory_create_operations").get().n,0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='memory.create'").get().n,0);
    store.db.exec("DROP TRIGGER fail_create");
  }
  store.db.exec("BEGIN IMMEDIATE");
  store.saveMemory(a.auth,{scope:"user",content:"nested",operation_id:"nested"});
  assert.equal(store.db.isTransaction,true);
  store.db.exec("ROLLBACK");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM memories").get().n,0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM memory_create_operations").get().n,0);
});

test("I-09 I-10: rotated credentials replay; namespace and authorization remain isolated", async t => {
  const f=await memoryFixture(t),{store,a,b,other}=f;
  const body={content:"namespace",scope:"user",operation_id:"same-key"};
  const saved=store.saveMemory(a.auth,body);
  const otherAgent=store.saveMemory(b.auth,body),otherUser=store.saveMemory(other.auth,body);
  assert.equal(new Set([saved,otherAgent,otherUser].map(r=>r.memory.memory_id)).size,3);
  const key=store.rotateAgentKey(b.auth,a.auth.agent_instance_id);
  const result=await f.request("POST","/v1/memories",body,key);
  assert.equal(result.status,201);assert.equal(result.body.memory.memory_id,saved.memory.memory_id);assert.equal(result.body.idempotent,true);
  const old=await f.request("POST","/v1/memories",body,a);assert.equal(old.status,401);assert.equal(old.body.error_code,"INVALID_CREDENTIAL");
  const operation=store.db.prepare("SELECT credential_id FROM memory_create_operations WHERE user_id=? AND agent_instance_id=?").get(a.auth.user_id,a.auth.agent_instance_id);
  assert.equal(operation.credential_id,a.auth.credential_id);
  const readOnly=store.issueCredential({label:"readonly",userId:a.auth.user_id,deviceId:a.auth.device_id,agentId:a.auth.agent_id,agentInstanceId:a.auth.agent_instance_id,scopes:["memory:read"]});
  assert.equal((await f.request("POST","/v1/memories",body,readOnly)).status,403);
});

test("I-12: header-only key, malformed keys, stable defaults and explicit targets", async t => {
  const f=await memoryFixture(t),{store,a,alpha}=f;
  const body={content:"header save",scope:"user"};
  const first=await f.request("POST","/v1/memories",body,a,{"idempotency-key":"header-only"});
  const replay=await f.request("POST","/v1/memories",{...body,operation_id:"header-only"});
  assert.equal(first.status,201);assert.equal(replay.body.memory.memory_id,first.body.memory.memory_id);
  for(const operation_id of [null,"","has space","x\n", "x".repeat(129), 3]) assert.equal((await f.request("POST","/v1/memories",{...body,operation_id})).body.error_code,"INVALID_OPERATION_ID");
  const intent={content:"target freeze",scope:"task",task_id:alpha.task_id,operation_id:"freeze"};
  const original=store.saveMemory(a.auth,intent);
  store.db.prepare("UPDATE tasks SET project_id=? WHERE task_id=?").run(f.beta.project_id,alpha.task_id);
  const unchanged=store.saveMemory(a.auth,intent);
  assert.equal(unchanged.memory.memory_id,original.memory.memory_id);assert.equal(unchanged.memory.project_id,alpha.project_id);
  assert.throws(()=>store.saveMemory(a.auth,{...intent,project_id:f.beta.project_id}),e=>e.errorCode==="IDEMPOTENCY_CONFLICT");
});

for (const adapter of ["ChatGPT", "OpenClaw", "Hermes"]) test(`I-08 I-12: ${adapter} lost response retry retains the exact operation`, async t => {
  const f=await memoryFixture(t),payloads=[];
  const proxy=http.createServer(async (request,response)=>{
    const chunks=[];for await (const chunk of request)chunks.push(chunk);
    const body=Buffer.concat(chunks);payloads.push(JSON.parse(body));
    const upstream=await fetch(new URL(request.url,f.baseUrl),{method:request.method,headers:{authorization:request.headers.authorization,"content-type":"application/json"},body});
    const text=await upstream.text();
    if(payloads.length===1) response.destroy();
    else { response.writeHead(upstream.status,{"content-type":"application/json"});response.end(text); }
  });
  await new Promise(resolve=>proxy.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>{proxy.closeAllConnections();proxy.close(resolve);}));
  const url=`http://127.0.0.1:${proxy.address().port}`;
  const keyFile=path.join(f.root,"synthetic.key");writeFileSync(keyFile,f.a.api_key,{mode:0o600});
  const env={MNEMURON_MODE:"remote",MNEMURON_CONFIG_PATH:path.join(f.root,"missing.json"),MNEMURON_SPIKE_DATA_DIR:f.root,MNEMURON_SERVER_URL:url,MNEMURON_ALLOW_INSECURE_HTTP:"true",MNEMURON_API_KEY:f.a.api_key,CODEX_THREAD_ID:"",CODEX_SESSION_ID:""};
  const client=new MnemuronClient({serverUrl:new URL(url),apiKeyFile:keyFile,requestTimeoutMs:2000});
  const hermesConfig = {server_url:url, api_key_file:keyFile, outbox_dir:path.join(f.root,"outbox"), pending_resume_dir:path.join(f.root,"pending"), task_scope_dir:path.join(f.root,"scopes"), device_id:"device-agent-a", agent_id:"test", agent_instance_id:"agent-a", project_id:f.alpha.project_id, task_id:f.alpha.task_id, workstream_id:f.alpha.task_id+"-one", allow_insecure_http:true};
  const save=body=>adapter==="ChatGPT"?callTool("mnemuron_remember",body,env):adapter==="Hermes"?hermesRemember(hermesConfig,body):client.remember(body);
  const body={scope:"user",content:"response lost after commit"};
  let failure;
  try { await save(body); } catch(error) { failure=error; }
  assert.ok(failure);
  assert.match(failure.operation_id,/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
  assert.ok(failure.message.includes(failure.operation_id));
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM memories").get().n,1);
  const firstId=f.store.db.prepare("SELECT memory_id FROM memories").get().memory_id;
  const retry=await save({...body,operation_id:failure.operation_id});
  assert.equal(retry.memory.memory_id,firstId);assert.equal(retry.idempotent,true);
  assert.deepEqual(payloads[0],payloads[1]);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM memories").get().n,1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='memory.create'").get().n,1);
  if(adapter==="ChatGPT") assert.ok(TOOLS.find(t=>t.name==="mnemuron_remember").inputSchema.properties.operation_id);
});

test("I-07 I-11: additive migration preserves old rows and operation keys survive retention and reopen", async t => {
  const f = await memoryFixture(t);
  f.store.saveMemory(f.a.auth, { content: "pre-migration memory", scope: "user" });
  f.store.db.exec("DROP TABLE memory_create_operations");
  const before = businessSnapshot(f.store);
  const columns = f.store.db.prepare("PRAGMA table_info(memories)").all();
  const migrated = new MnemuronStore(f.databasePath);
  try {
    assert.deepEqual(businessSnapshot(migrated), before);
    assert.deepEqual(migrated.db.prepare("PRAGMA table_info(memories)").all(), columns);
    const body = { content: "durable operation", scope: "user", operation_id: "survive-retention" };
    const saved = migrated.saveMemory(f.a.auth, body);
    migrated.appendEvents(f.a.auth, { events: [{ event_id: "expired-raw", event_type: "user_message", captured_at: "2000-01-01T00:00:00.000Z", content: "expired fixture" }], raw_retention_days: 1 });
    migrated.db.prepare("UPDATE events SET expires_at='2000-01-02T00:00:00.000Z' WHERE event_id='expired-raw'").run();
    assert.equal(migrated.pruneExpired().expired_events, 1);
    migrated.retractMemory(f.a.auth, saved.memory.memory_id, {});
    const reopened = new MnemuronStore(f.databasePath);
    try {
      const replay = reopened.saveMemory(f.a.auth, body);
      assert.equal(replay.memory.memory_id, saved.memory.memory_id);
      assert.equal(replay.memory.status, "retracted");
      assert.equal(reopened.db.prepare("SELECT COUNT(*) AS n FROM memory_create_operations").get().n, 1);
      assert.equal(reopened.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='memory.create'").get().n, 2);
      assert.equal(reopened.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    } finally { reopened.close(); }
  } finally { migrated.close(); }
});

test("I-12: an aborted request keeps its operation ID even with a read-only DOMException message", async t => {
  const f = await memoryFixture(t);
  const keyFile = path.join(f.root, "synthetic.key");
  writeFileSync(keyFile, f.a.api_key, { mode: 0o600 });
  const client = new MnemuronClient({ serverUrl: new URL(f.baseUrl), apiKeyFile: keyFile, requestTimeoutMs: 1000 });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.remember({ scope: "user", content: "aborted", operation_id: "aborted-operation" }, controller.signal), error => {
    assert.equal(error.operation_id, "aborted-operation");
    assert.equal(error.cause.name, "AbortError");
    return true;
  });
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM memories").get().n, 0);
});
