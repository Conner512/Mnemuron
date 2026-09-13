import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { memoryFixture, assertCode, businessSnapshot, assertIsolatedTarget } from "./helpers/core-memory-fixture.mjs";

test("B-03 B-04: SQLite capability and test target isolation are checked", async t => {
  const f = await memoryFixture(t);
  const db = new DatabaseSync(":memory:");
  try { db.exec("CREATE VIRTUAL TABLE probe USING fts5(content); INSERT INTO probe VALUES ('scope')"); assert.equal(db.prepare("SELECT COUNT(*) AS n FROM probe WHERE probe MATCH 'scope'").get().n, 1); } finally { db.close(); }
  assert.throws(() => assertIsolatedTarget(f.root, "/var/lib/mnemuron/mnemuron.sqlite3"));
  assert.throws(() => assertIsolatedTarget(f.root, f.databasePath, "https://mnemuron.example"));
});

test("S-01 S-02 S-03 S-04 S-05 S-12: task-derived project boundary applies to results and conflicts", async t => {
  const f = await memoryFixture(t), {store,a,other,alpha,beta,foreign}=f;
  const save = (owner, scope, task, suffix, workstream_id = null) => store.saveMemory(owner.auth, { scope, content: `升级决定 ${suffix}`, topic: "升级决定", ...(task ? { project_id: task.project_id, task_id: task.task_id } : {}), workstream_id }).memory.memory_id;
  const user = save(a,"user",null,"通用");
  const project = save(a,"project",alpha,"维持旧版本");
  const task = save(a,"task",alpha,"精确目标",alpha.task_id+"-one");
  const forbidden = [save(a,"project",beta,"已经升级",beta.task_id+"-one"),save(a,"project",beta,"另一方案",beta.task_id+"-two"),save(other,"project",foreign,"外部用户")];
  const before=businessSnapshot(store);
  const result=store.queryMemories(a.auth,{query:"升级决定",task_id:alpha.task_id,limit:20});
  assert.deepEqual(new Set(result.results.map(m=>m.memory_id)),new Set([user,project,task]));
  assert.equal(result.effective_scope.project_id,alpha.project_id);
  assert.equal(result.matched_candidate_count,3);
  for(const id of forbidden) assert.ok(!JSON.stringify(result).includes(id));
  assert.deepEqual(businessSnapshot(store),before);
  assertCode(()=>store.queryMemories(a.auth,{query:"升级",project_id:beta.project_id,task_id:alpha.task_id}),"SCOPE_MISMATCH");
  const p=store.queryMemories(a.auth,{query:"升级",project_id:alpha.project_id});
  assert.deepEqual(new Set(p.results.map(m=>m.memory_id)),new Set([user,project,task]));
  const global=store.queryMemories(a.auth,{query:"升级"});
  assert.equal(global.result_count,5);
  assert.ok(!JSON.stringify(global).includes(forbidden[2]));
  for(const id of [foreign.task_id,"task-unknown"]) {
    const r=await f.request("POST","/v1/memories/query",{query:"升级",task_id:id});
    assert.equal(r.status,404);assert.equal(r.body.error_code,"TASK_NOT_FOUND");
    assert.ok(!JSON.stringify(r.body).includes(id));
  }
});

test("S-06 S-07 S-08 S-09 S-10 S-11: branches, shared provenance, and dynamic sessions", async t => {
  const {store,a,alpha,beta}=await memoryFixture(t);
  const observed="observed-alpha", session="session-dynamic";
  for(const task of [alpha,beta]) store.appendEvents(a.auth,{events:[{event_id:randomUUID(),event_type:"user_message",captured_at:new Date().toISOString(),project_id:task.project_id,task_id:task.task_id,workstream_id:task===alpha?observed:beta.task_id+"-one",session_id:session,content:"unlabelled"}]});
  const global=store.saveMemory(a.auth,{scope:"user",content:"scope-query shared"}).memory;
  const branch=store.saveMemory(a.auth,{scope:"user",content:"scope-query contextual",project_id:alpha.project_id,task_id:alpha.task_id,workstream_id:observed,session_id:session}).memory;
  const project=store.saveMemory(a.auth,{scope:"project",content:"scope-query project",task_id:alpha.task_id,workstream_id:observed,session_id:session}).memory;
  assert.equal(branch.scope,"user");assert.equal(project.scope,"project");assert.equal(project.project_id,alpha.project_id);
  for(const include_shared of [true,false]) {
    const noBranch=store.queryMemories(a.auth,{query:"scope-query",task_id:alpha.task_id,include_shared});assert.equal(noBranch.result_count,3);
    const filtered=store.queryMemories(a.auth,{query:"scope-query",task_id:alpha.task_id,source_workstream_ids:[observed],include_shared});
    assert.deepEqual(new Set(filtered.results.map(m=>m.memory_id)),new Set(include_shared?[global.memory_id,branch.memory_id,project.memory_id]:[branch.memory_id,project.memory_id]));
  }
  assertCode(()=>store.queryMemories(a.auth,{query:"scope-query",task_id:alpha.task_id,source_workstream_ids:[beta.task_id+"-one"]}),"SCOPE_MISMATCH");
  assert.equal(store.saveMemory(a.auth,{scope:"session",content:"switched task",session_id:session,task_id:beta.task_id}).memory.task_id,beta.task_id);
  const events=store.db.prepare("SELECT task_id FROM events WHERE session_id=? ORDER BY rowid").all(session);
  assert.deepEqual(events.map(e=>e.task_id),[alpha.task_id,beta.task_id]);
});

test("S-09 S-12: conflicts retain only in-scope variants, including a first saved observed branch", async t => {
  const f = await memoryFixture(t);
  const save = (owner, task, workstream_id, content) => f.store.saveMemory(owner.auth, {
    content, scope: "workstream", task_id: task.task_id, workstream_id,
    topic: "database selection", memory_type: "decision",
  }).memory;
  const left = save(f.a, f.alpha, "first-observed-alpha", "database selection SQLite");
  const right = save(f.b, f.alpha, f.alpha.task_id + "-two", "database selection PostgreSQL");
  const forbidden = [
    save(f.a, f.beta, f.beta.task_id + "-one", "database selection external MySQL"),
    save(f.a, f.beta, f.beta.task_id + "-two", "database selection external Oracle"),
    save(f.other, f.foreign, f.foreign.task_id + "-one", "database selection foreign"),
  ];
  const result = f.store.queryMemories(f.a.auth, { query: "database selection", task_id: f.alpha.task_id, limit: 1 });
  assert.equal(result.matched_candidate_count, 2);
  assert.equal(result.conflict_presentation.potential_conflicts.length, 1);
  assert.deepEqual(new Set(result.conflict_presentation.potential_conflicts[0].memory_ids), new Set([left.memory_id, right.memory_id]));
  for (const memory of forbidden) {
    assert.ok(!JSON.stringify(result).includes(memory.memory_id));
    assert.ok(!JSON.stringify(result).includes(memory.content));
  }
  const filtered = f.store.queryMemories(f.a.auth, {
    query: "database selection", task_id: f.alpha.task_id,
    source_workstream_ids: ["first-observed-alpha"], include_shared: false,
  });
  assert.deepEqual(filtered.results.map(m => m.memory_id), [left.memory_id]);
  assert.equal(filtered.conflict_presentation.potential_conflicts.length, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0);
  assertCode(() => f.store.saveMemory(f.a.auth, { scope: "user", content: "unknown branch", workstream_id: "unknown-branch" }), "WORKSTREAM_NOT_FOUND", 404);
});

test("S-09 S-10: ambiguous branches need an exact Task; Session filters preserve long-lived memories", async t => {
  const { store, a, alpha, beta } = await memoryFixture(t);
  for (const task of [alpha, beta]) {
    store.appendEvents(a.auth, { events: [{ event_id: randomUUID(), event_type: "user_message", captured_at: new Date().toISOString(), project_id: task.project_id, task_id: task.task_id, workstream_id: "shared-agent-branch", session_id: "switchable-session", content: "synthetic" }] });
    store.saveMemory(a.auth, { scope: "session", content: "session filter", task_id: task.task_id, workstream_id: "shared-agent-branch", session_id: "switchable-session" });
  }
  assertCode(() => store.queryMemories(a.auth, { query: "filter", source_workstream_ids: ["shared-agent-branch"] }), "SCOPE_AMBIGUOUS");
  assertCode(() => store.saveMemory(a.auth, { scope: "workstream", content: "ambiguous", workstream_id: "shared-agent-branch" }), "SCOPE_AMBIGUOUS");
  const durable = store.saveMemory(a.auth, { scope: "task", content: "session filter durable", task_id: alpha.task_id, session_id: "earlier-session" }).memory;
  const result = store.queryMemories(a.auth, { query: "session filter", task_id: alpha.task_id, session_id: "different-session", source_workstream_ids: ["shared-agent-branch"] });
  assert.deepEqual(result.results.map(m => m.memory_id), [durable.memory_id]);
});

test("V-01 V-02 V-03 V-07: Store and REST validate payload, UTF-16 limits, enums and topic", async t => {
  const f=await memoryFixture(t), {store,a}=f;
  const invalid=[
    [null,"INVALID_PAYLOAD"],[[],"INVALID_PAYLOAD"],["body","INVALID_PAYLOAD"],
    [{scope:"user",content:"   "},"INVALID_CONTENT"],[{scope:"user",content:3},"INVALID_CONTENT"],
    [{scope:"user",content:"x".repeat(4097)},"CONTENT_TOO_LONG"],
    [{scope:"wrong",content:"valid"},"INVALID_MEMORY_SCOPE"],
    [{scope:"user",content:"valid",memory_type:"wrong"},"INVALID_MEMORY_TYPE"],
    [{scope:"user",content:"valid",topic:" "},"INVALID_TOPIC"],
    [{scope:"user",content:"valid",topic:"x".repeat(121)},"INVALID_TOPIC"]];
  for(const [body,code] of invalid) {
    const before=businessSnapshot(store);
    assertCode(()=>store.saveMemory(a.auth,body),code);
    const result=await f.request("POST","/v1/memories",body);
    assert.equal(result.status,400);assert.equal(result.body.error_code,code);
    assert.deepEqual(businessSnapshot(store),before);
  }
  assert.equal(store.saveMemory(a.auth,{scope:"user",content:"😀".repeat(2048),topic:"x".repeat(120)}).memory.content.length,4096);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='memory.create'").get().n,1);
  const id=store.db.prepare("SELECT memory_id FROM memories").get().memory_id;
  assertCode(()=>store.retractMemory(a.auth,id,null),"INVALID_PAYLOAD");
  assertCode(()=>store.supersedeMemory(a.auth,id,{content:"valid",topic:"x".repeat(121)}),"INVALID_TOPIC");
});

test("V-04 V-05 V-06 V-08 V-09 V-10: write scope, identity and legacy compatibility", async t => {
  const {store,a,alpha,beta,foreign}=await memoryFixture(t);
  for(const scope of ["project","task","workstream","session"]) assertCode(()=>store.saveMemory(a.auth,{scope,content:"no target"}),"INVALID_MEMORY_SCOPE");
  assertCode(()=>store.saveMemory(a.auth,{scope:"task",content:"mismatch",task_id:alpha.task_id,project_id:beta.project_id}),"SCOPE_MISMATCH");
  assertCode(()=>store.saveMemory(a.auth,{scope:"task",content:"invisible",task_id:foreign.task_id}),"TASK_NOT_FOUND",404);
  const user=store.saveMemory(a.auth,{scope:"user",content:"preference",source:"legacy-adapter"}).memory;
  assert.equal(user.project_id,null);assert.equal(user.status,"active");
  assert.equal(store.saveMemory(a.auth,{scope:"workstream",content:"infer parent",workstream_id:alpha.task_id+"-one"}).memory.task_id,alpha.task_id);
  const first=store.saveMemory(a.auth,{scope:"session",content:"first session",session_id:"first-session",task_id:alpha.task_id}).memory;
  assert.equal(first.project_id,alpha.project_id);assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events").get().n,0);
  for(const field of ["user_id","agent_id","agent_instance_id","device_id","credential_id"]) assertCode(()=>store.saveMemory(a.auth,{scope:"user",content:"spoof",[field]:"other"}),"IDENTITY_MISMATCH");
  const explicit=store.saveMemory(a.auth,{scope:"user",content:"caller claim",source:"verified-label",confidence:999,source_event_ids:["fake-event"]}).memory;
  assert.equal(explicit.provenance.agent_instance_id,a.auth.agent_instance_id);
  assert.equal(explicit.generation.confidence,1);assert.deepEqual(explicit.source_event_ids,[]);
  assert.equal(explicit.verification.independently_fact_checked,false);
  store.db.prepare("UPDATE memories SET project_id=NULL,task_id=NULL WHERE memory_id=?").run(first.memory_id);
  assert.ok(!store.queryMemories(a.auth,{query:"first session",task_id:alpha.task_id}).results.some(m=>m.memory_id===first.memory_id));
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE memory_id=?").get(first.memory_id).n,1);
});

test("I-01 I-02 I-03 I-04 I-11 I-12: stable operation intent, replay and lifecycle", async t => {
  const f=await memoryFixture(t),{store,a,alpha}=f;
  const body={scope:"task",task_id:alpha.task_id,content:"safe retry",operation_id:"operation-same"};
  const saved=store.saveMemory(a.auth,body);
  for(let i=0;i<100;i++) { const replay=store.saveMemory(a.auth,{...body});assert.equal(replay.memory.memory_id,saved.memory.memory_id);assert.equal(replay.idempotent,true); }
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM memories").get().n,1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='memory.create'").get().n,1);
  for(const delta of [{content:"different"},{scope:"project"},{task_id:f.beta.task_id},{topic:"topic"},{memory_type:"decision"},{source:"different"},{workstream_id:alpha.task_id+"-one"}]) assertCode(()=>store.saveMemory(a.auth,{...body,...delta}),"IDEMPOTENCY_CONFLICT",409);
  assert.equal(store.saveMemory(a.auth,{operation_id:body.operation_id,content:body.content,task_id:body.task_id,scope:body.scope}).memory.memory_id,saved.memory.memory_id);
  const second=store.saveMemory(a.auth,{...body,operation_id:"operation-other",workstream_id:alpha.task_id+"-two"});assert.notEqual(second.memory.memory_id,saved.memory.memory_id);
  const {operation_id,...legacy}=body;assert.notEqual(store.saveMemory(a.auth,legacy).memory.memory_id,store.saveMemory(a.auth,legacy).memory.memory_id);
  const count=store.db.prepare("SELECT COUNT(*) AS n FROM memories").get().n;
  store.retractMemory(a.auth,saved.memory.memory_id,{});
  const replay=store.saveMemory(a.auth,body);assert.equal(replay.memory.status,"retracted");assert.equal(replay.memory.memory_id,saved.memory.memory_id);assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM memories").get().n,count);
  const corrected=store.saveMemory(a.auth,{...body,operation_id:"corrected"});store.supersedeMemory(a.auth,corrected.memory.memory_id,{content:"new fact"});assert.equal(store.saveMemory(a.auth,{...body,operation_id:"corrected"}).memory.status,"superseded");
  const headers=await f.request("POST","/v1/memories",body,a,{"idempotency-key":"different-key"});assert.equal(headers.status,400);assert.equal(headers.body.error_code,"IDEMPOTENCY_KEY_MISMATCH");
});
