import assert from "node:assert/strict";
import test from "node:test";
import { memoryFixture } from "./helpers/core-memory-fixture.mjs";
import { READ_HALF_LIFE_DAYS, READ_WEIGHT, STRENGTH_WEIGHT, readTerm, strengthTerm } from "../lib/memory/salience.mjs";

const ids = result => result.results.map(r => r.memory_id);
const read = (store, auth, memoryId, at) => {
  store.audit({ auth, action: "memory.read", targetType: "memory", targetId: memoryId });
  if (at) store.db.prepare("UPDATE audit_events SET created_at=? WHERE audit_id=(SELECT audit_id FROM audit_events WHERE target_id=? ORDER BY rowid DESC LIMIT 1)").run(at, memoryId);
};

test("SAL-01: strength breaks an otherwise equal keyword tie and is reported in the ranking", async t => {
  const { store, a } = await memoryFixture(t);
  const strong = store.saveMemory(a.auth, { content: "Gateway port 8443 alpha", scope: "user", strength: 9 }).memory;
  const weak = store.saveMemory(a.auth, { content: "Gateway port 8443 bravo", scope: "user", strength: 2 }).memory;
  const result = store.queryMemories(a.auth, { query: "Gateway port 8443" });
  assert.deepEqual(ids(result), [strong.memory_id, weak.memory_id]);
  assert.equal(result.results[0].ranking.strength_score, strengthTerm(9));
  assert.equal(result.results[1].ranking.strength_score, strengthTerm(2));
  assert.match(result.results[0].ranking.method, /salience/);
});

test("SAL-02: recent assistant reads lift a memory; console browsing and old reads do not", async t => {
  const { store, a } = await memoryFixture(t);
  const first = store.saveMemory(a.auth, { content: "Backup target nas alpha", scope: "user" }).memory;
  const second = store.saveMemory(a.auth, { content: "Backup target nas bravo", scope: "user" }).memory;
  const order = () => ids(store.queryMemories(a.auth, { query: "Backup target nas" }));
  const baseline = order(), lower = baseline[1];
  const credential = store.issueCredential({ label: "console", userId: "user-coretest-a", deviceId: "console", agentId: "mnemuron-console", agentInstanceId: "console", scopes: ["memory:read"] });
  const consoleAuth = store.authenticate(credential.api_key);
  for (let n = 0; n < 10; n++) read(store, consoleAuth, lower);
  for (let n = 0; n < 10; n++) read(store, a.auth, lower, new Date(Date.now() - 120 * 86_400_000).toISOString());
  assert.deepEqual(order(), baseline, "console reads and reads outside the window are ignored");
  for (let n = 0; n < 6; n++) read(store, a.auth, lower);
  assert.deepEqual(order(), [lower, baseline[0]]);
  const weight = store.salience.of("user-coretest-a", [first.memory_id, second.memory_id]).get(lower);
  assert.equal(weight.reads, 6);
  assert.ok(weight.factor > 1 && weight.factor <= 1 + READ_WEIGHT);
});

test("SAL-03: terms are bounded, decay with age and never exceed their weights", () => {
  assert.equal(strengthTerm(undefined), 0);
  assert.equal(strengthTerm(5), 0);
  assert.equal(strengthTerm(10), 1);
  assert.equal(strengthTerm(1), -0.8);
  assert.equal(readTerm(0), 0);
  assert.equal(readTerm(1000), 1);
  assert.ok(readTerm(1) < readTerm(4) && readTerm(4) < readTerm(15));
  assert.ok(1 + STRENGTH_WEIGHT + READ_WEIGHT < 1.05, "salience stays below a few adjacent fused-rank gaps");
  assert.equal(READ_HALF_LIFE_DAYS, 21);
});
