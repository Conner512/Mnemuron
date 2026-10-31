import assert from "node:assert/strict";
import test from "node:test";
import { memoryFixture } from "./helpers/core-memory-fixture.mjs";
import { callTool, TOOLS } from "../../plugins/mnemuron/scripts/mcp-core.mjs";
import { memoryTraits,groundedConcept } from "../lib/memory/traits.mjs";

test("TRAITS-01: a save stores kind, concepts and strength and reads them back", async t => {
  const { store, a } = await memoryFixture(t);
  const saved = store.saveMemory(a.auth, { content: "Deploys run through pct exec", scope: "user", kind: "workflow", concepts: [" deploy ", "PVE", "deploy"], strength: 9 }).memory;
  assert.equal(saved.kind, "workflow");
  assert.deepEqual(saved.concepts, ["deploy", "PVE"]);
  assert.equal(saved.strength, 9);
  const plain = store.saveMemory(a.auth, { content: "No traits here", scope: "user" }).memory;
  assert.deepEqual({ kind: plain.kind, concepts: plain.concepts, strength: plain.strength }, { kind: null, concepts: [], strength: null });
});

test("TRAITS-02: a correction carries traits forward and lets the correction override them", async t => {
  const { store, a } = await memoryFixture(t);
  const saved = store.saveMemory(a.auth, { content: "Port is 8080", scope: "user", kind: "fact", concepts: ["port"], strength: 5 }).memory;
  const first = store.supersedeMemory(a.auth, saved.memory_id, { content: "Port is 8443", reason: "changed" }).replacement_memory;
  assert.deepEqual({ kind: first.kind, concepts: first.concepts, strength: first.strength }, { kind: "fact", concepts: ["port"], strength: 5 });
  const second = store.supersedeMemory(a.auth, first.memory_id, { content: "Port is 9443", reason: "changed again", strength: 8 }).replacement_memory;
  assert.deepEqual({ kind: second.kind, concepts: second.concepts, strength: second.strength }, { kind: "fact", concepts: ["port"], strength: 8 });
});

test("TRAITS-03: invalid traits are refused before anything is written", async t => {
  const { store, a } = await memoryFixture(t);
  for (const [bad, code] of [[{ kind: "category" }, "INVALID_MEMORY_KIND"], [{ concepts: "x" }, "INVALID_CONCEPTS"], [{ concepts: Array(9).fill("a").map((v, i) => v + i) }, "INVALID_CONCEPTS"],
    [{ concepts: ["x".repeat(41)] }, "INVALID_CONCEPTS"], [{ strength: 0 }, "INVALID_STRENGTH"], [{ strength: 7.5 }, "INVALID_STRENGTH"]]) {
    assert.throws(() => store.saveMemory(a.auth, { content: "rejected", scope: "user", ...bad }), error => error.errorCode === code, JSON.stringify(bad));
  }
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM memories").get().n, 0);
  assert.deepEqual(memoryTraits({}), {});
});

test("TRAITS-04: retries with the same traits are idempotent and different traits conflict", async t => {
  const { store, a } = await memoryFixture(t);
  const body = { content: "Retry me", scope: "user", operation_id: "traits-retry", kind: "bug", strength: 3 };
  const first = store.saveMemory(a.auth, body), again = store.saveMemory(a.auth, body);
  assert.equal(again.idempotent, true);
  assert.equal(again.memory.memory_id, first.memory.memory_id);
  assert.throws(() => store.saveMemory(a.auth, { ...body, strength: 4 }), error => error.errorCode === "IDEMPOTENCY_CONFLICT");
});

test("TRAITS-05: the plugin remember and supersede tools publish the trait fields", () => {
  for (const name of ["mnemuron_remember", "mnemuron_supersede_memory"]) {
    const { properties } = TOOLS.find(tool => tool.name === name).inputSchema;
    assert.deepEqual(properties.kind.enum, ["fact", "preference", "workflow", "architecture", "bug", "pattern"]);
    assert.equal(properties.concepts.maxItems, 8);
    assert.deepEqual([properties.strength.minimum, properties.strength.maximum], [1, 10]);
  }
  assert.equal(typeof callTool, "function");
});

test("TRAITS-06: the library filters by kind (including unmarked) and lists traits, facets and overview count kinds", async t => {
  const { store, a } = await memoryFixture(t);
  store.saveMemory(a.auth, { content: "Workflow one", scope: "user", kind: "workflow", concepts: ["deploy"], strength: 8 });
  store.saveMemory(a.auth, { content: "Unmarked", scope: "user" });
  const organizer = store.consoleService.organizer;
  const rows = kind => organizer.rows(a.auth, organizer.filter(a.auth.user_id, { kind }), { limit: 10 }).rows;
  assert.deepEqual(rows("workflow").map(r => [r.content, r.kind, r.strength, r.concepts]), [["Workflow one", "workflow", 8, ["deploy"]]]);
  assert.deepEqual(rows("none").map(r => r.content), ["Unmarked"]);
  assert.throws(() => organizer.filter(a.auth.user_id, { kind: "technical" }), error => error.errorCode === "INVALID_PAYLOAD");
  const kinds = Object.fromEntries(organizer.facets(a.auth).kinds.map(k => [k.kind, k.count]));
  assert.equal(kinds.workflow, 1); assert.equal(kinds.none, 1); assert.equal(kinds.bug, 0);
});

test('TRAITS-07: the keyword fill writes kind, concepts and strength for unmarked memories only, never over the writer', async t => {
  const { fixture, organizer } = await import('./helpers/memory-models.mjs');
  const { MemoryJobs } = await import('../lib/memory-jobs/store.mjs');
  const { MemoryWorker, scheduleTraits } = await import('../lib/memory-jobs/worker.mjs');
  const f = fixture(t), plain = f.save('Mnemuron deploys through pct exec on PVE.'), partial = f.save('Gemini rejected the entity schema.', { kind: 'bug' }), done = f.save('Reply in Chinese.', { kind: 'preference', concepts: ['中文'], strength: 8 });
  const seen = [];
  const model = organizer(input => { seen.push(input); return { results: input.sources.map(s => ({ memory_id: s.memory_id, revision: s.revision, kind: 'workflow', concepts: s.content.includes('Gemini')?['Gemini']:['Mnemuron', ' PVE ', 'pve'], strength: 6 })) }; });
  const jobs = new MemoryJobs(f.s), scheduled = scheduleTraits(f.s, jobs, { userId: f.auth.user_id, organizer: model });
  assert.equal(scheduled.scanned, 2, 'a memory that already has kind and strength is not sent');
  await new MemoryWorker(f.s, jobs, model).drain();
  assert.equal(seen.length, 1); assert.equal(seen[0].operation, 'traits'); assert.deepEqual(seen[0].kinds, ['fact', 'preference', 'workflow', 'architecture', 'bug', 'pattern']);
  const traits = id => f.s.traits.get(f.auth.user_id, id);
  assert.deepEqual(traits(plain.memory_id), { kind: 'workflow', concepts: ['Mnemuron', 'PVE'], strength: 6 });
  assert.deepEqual(traits(partial.memory_id), { kind: 'bug', concepts: ['Gemini'], strength: 6 }, 'the writer kind is kept; only grounded missing fields are filled');
  assert.deepEqual(traits(done.memory_id), { kind: 'preference', concepts: ['中文'], strength: 8 });
  assert.equal(scheduleTraits(f.s, jobs, { userId: f.auth.user_id, organizer: model }).scanned, 0, 'filled memories are not offered again');
});

test('TRAITS-09: automatic keyword grounding preserves identifier boundaries and Chinese subject names',()=>{
  const content='部署 CUCM 15 与 Nexus-9000，版本是 17.9.8，文档地址 192.0.2.10。使用 ＰＶＥ 与 Équipe，平台是思科。';
  for(const concept of ['CUCM','Nexus-9000','17.9.8','192.0.2.10','PVE','équipe','思科'])assert.equal(groundedConcept(content,concept),true,concept);
  for(const concept of ['Cuc','Nexus','17.9','192.0.2.1','阿里云','Proxmox','Cisco',''])assert.equal(groundedConcept(content,concept),false,concept);
  assert.equal(groundedConcept('Synthetic\n  Server runs here.','synthetic server'),true,'format-only whitespace and case normalization is safe');
});

test('TRAITS-10: a borrowed or invented model keyword fails the whole batch without changing manual metadata',async t=>{
  const {fixture,organizer}=await import('./helpers/memory-models.mjs');
  const {MemoryJobs}=await import('../lib/memory-jobs/store.mjs');
  const {MemoryWorker,scheduleTraits}=await import('../lib/memory-jobs/worker.mjs');
  const f=fixture(t),one=f.save('Mnemuron runs on PVE.'),two=f.save('Gemini rejected a schema.',{kind:'bug'}),manual=f.save('Always answer in Chinese.',{kind:'preference',concepts:['中文'],strength:8});
  const before=JSON.stringify(f.s.db.prepare('SELECT * FROM memory_traits ORDER BY memory_id').all());
  const model=organizer(input=>({results:input.sources.map(s=>({memory_id:s.memory_id,revision:s.revision,kind:'fact',concepts:['PVE'],strength:6}))}));
  const jobs=new MemoryJobs(f.s),scheduled=scheduleTraits(f.s,jobs,{userId:f.auth.user_id,organizer:model});
  await new MemoryWorker(f.s,jobs,model).drain();
  assert.equal(jobs.get(scheduled.jobs[0]).state,'review_required');assert.equal(jobs.get(scheduled.jobs[0]).last_error_code,'INVALID_SOURCE_SET');
  assert.equal(jobs.get(scheduled.jobs[0]).processed,0,'invalid model output is never checkpointed as a completed chunk');
  assert.equal(JSON.stringify(f.s.db.prepare('SELECT * FROM memory_traits ORDER BY memory_id').all()),before,'no valid prefix of an invalid batch is published');
  assert.deepEqual(f.s.traits.get(f.auth.user_id,one.memory_id),{kind:null,concepts:[],strength:null});
  assert.equal(f.s.traits.get(f.auth.user_id,two.memory_id).kind,'bug');
  assert.deepEqual(f.s.traits.get(f.auth.user_id,manual.memory_id).concepts,['中文'],'manual multilingual labels are unaffected');
});

test('TRAITS-12: an explicit retry reuses valid chunks but asks the model again for the invalid remainder',async t=>{
  const {fixture,organizer}=await import('./helpers/memory-models.mjs');
  const {MemoryJobs}=await import('../lib/memory-jobs/store.mjs');
  const {MemoryWorker,scheduleTraits}=await import('../lib/memory-jobs/worker.mjs');
  const f=fixture(t),one=f.save('Mnemuron runs on PVE.'),two=f.save('Gemini rejected a schema.');
  let repaired=false;const sent=[];
  const model=organizer(input=>{sent.push(input.sources.map(s=>s.memory_id));return {results:input.sources.map(s=>({memory_id:s.memory_id,revision:s.revision,kind:'fact',concepts:s.memory_id===two.memory_id&&repaired?['Gemini']:['PVE'],strength:6}))};});
  const jobs=new MemoryJobs(f.s,{batchSize:1}),scheduled=scheduleTraits(f.s,jobs,{userId:f.auth.user_id,organizer:model}),worker=new MemoryWorker(f.s,jobs,model);
  await worker.runOne();const failed=jobs.get(scheduled.jobs[0]);
  assert.equal(failed.state,'review_required');assert.equal(failed.processed,1);
  assert.deepEqual(jobs.items(failed).map(i=>i.state),['done','pending']);
  assert.equal(f.s.traits.get(f.auth.user_id,one.memory_id).kind,null,'successful chunks are not published independently');
  repaired=true;
  // Simulate an explicit, authorized retry; no automatic retry loop or budget reset is introduced.
  f.s.db.prepare("UPDATE memory_jobs SET state='pending',run_after=? WHERE job_id=?").run(jobs.clock(),failed.job_id);
  await worker.runOne();
  assert.equal(jobs.get(failed.job_id).state,'succeeded');assert.equal(jobs.get(failed.job_id).attempt_count,2);
  assert.deepEqual(sent,[[one.memory_id],[two.memory_id],[two.memory_id]],'a valid committed chunk is not paid for again');
  assert.deepEqual(f.s.traits.get(f.auth.user_id,two.memory_id).concepts,['Gemini']);
});

test('TRAITS-11: direct fill validates the complete source set before writing and allows genuinely empty concepts',async t=>{
  const {store,a}=await memoryFixture(t),first=store.saveMemory(a.auth,{scope:'user',content:'Synthetic source one.'}).memory,
    second=store.saveMemory(a.auth,{scope:'user',content:'Synthetic source two.'}).memory;
  const sources=[first,second].map(m=>store.derivedMemory.currentSource(a.auth.user_id,m.memory_id));
  const output=sources.map(s=>({memory_id:s.memory_id,revision:s.revision,kind:'fact',concepts:[],strength:5}));
  const wrong=[output[0],{...output[1],concepts:['Invented platform']}];
  assert.throws(()=>store.traits.fill(a.auth.user_id,sources,wrong),e=>e.errorCode==='INVALID_SOURCE_SET');
  assert.equal(store.traits.get(a.auth.user_id,first.memory_id).kind,null);
  assert.throws(()=>store.traits.fill('another-user',sources,output),e=>e.errorCode==='STALE_INPUT');
  assert.throws(()=>store.traits.fill(a.auth.user_id,[null,sources[1]],output),e=>e.errorCode==='STALE_INPUT');
  assert.equal(store.traits.fill(a.auth.user_id,sources,output),2);
  assert.deepEqual(store.traits.get(a.auth.user_id,first.memory_id),{kind:'fact',concepts:[],strength:5});
});

test('TRAITS-08: out-of-bounds model output fails the job without writing', async t => {
  const { fixture, organizer } = await import('./helpers/memory-models.mjs');
  const { MemoryJobs } = await import('../lib/memory-jobs/store.mjs');
  const { MemoryWorker, scheduleTraits } = await import('../lib/memory-jobs/worker.mjs');
  const f = fixture(t), m = f.save('Synthetic memory for a bad model.');
  const model = organizer(input => ({ results: input.sources.map(s => ({ memory_id: s.memory_id, revision: s.revision, kind: 'category', concepts: [], strength: 11 })) }), { retry: { max_attempts: 1, base_ms: 1, max_ms: 1, repair_once: false } });
  const jobs = new MemoryJobs(f.s); scheduleTraits(f.s, jobs, { userId: f.auth.user_id, organizer: model });
  await new MemoryWorker(f.s, jobs, model).drain();
  assert.deepEqual(f.s.traits.get(f.auth.user_id, m.memory_id), { kind: null, concepts: [], strength: null });
});

test("TRAITS-SEARCH: keywords are searchable, follow corrections and survive an index rebuild", async t => {
  const { store, a } = await memoryFixture(t);
  const saved = store.saveMemory(a.auth, { content: "评论系统基于 Discussions，不需要数据库", scope: "user", concepts: ["giscus", "comments"] }).memory;
  store.saveMemory(a.auth, { content: "Unrelated note about backups", scope: "user" });
  const found = query => store.queryMemories(a.auth, { query }).results.map(r => r.memory_id);
  assert.deepEqual(found("giscus"), [saved.memory_id], "a keyword-only match is found");
  assert.deepEqual(found("comments"), [saved.memory_id], "an English keyword finds a Chinese body");
  store.traits.set("user-coretest-a", saved.memory_id, { concepts: ["utterances"] }, new Date().toISOString());
  assert.deepEqual(found("giscus"), [], "a removed keyword no longer matches");
  assert.deepEqual(found("utterances"), [saved.memory_id]);
  store.memorySearch.rebuild();
  assert.equal(store.memorySearch.validate(), true);
  assert.deepEqual(found("utterances"), [saved.memory_id]);
});
