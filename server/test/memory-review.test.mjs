import assert from "node:assert/strict";
import test from "node:test";
import { memoryFixture } from "./helpers/core-memory-fixture.mjs";
import { consoleRead } from "../lib/console-read.mjs";

const DAY = 86_400_000, ago = days => new Date(Date.now() - days * DAY).toISOString();

test("REVIEW-01: the stale review lists weak idle and long untouched memories with reasons; reads by assistants keep a memory out", async t => {
  const f = await memoryFixture(t);
  const save = (content, strength, days) => {
    const m = f.store.saveMemory(f.a.auth, { scope: "user", content, strength }).memory;
    f.store.db.prepare("UPDATE memories SET created_at=?, updated_at=? WHERE memory_id=?").run(ago(days), ago(days), m.memory_id);
    return m;
  };
  const weak = save("Weak and idle", 2, 70);
  const old = save("Old and untouched", 6, 200);
  save("Weak but recent", 2, 20);
  save("Strong and old", 9, 400);
  const readByAssistant = save("Weak but read by an assistant", 2, 70);
  const readInConsole = save("Weak, only browsed in the console", 2, 70);
  f.store.audit({ auth: f.a.auth, action: "memory.read", targetType: "memory", targetId: readByAssistant.memory_id });
  const consoleCred = f.store.issueCredential({ label: "console", userId: "user-coretest-a", deviceId: "console", agentId: "mnemuron-console", agentInstanceId: "console", scopes: ["console:read", "memory:read"] });
  const consoleAuth = f.store.authenticate(consoleCred.api_key);
  f.store.audit({ auth: consoleAuth, action: "memory.read", targetType: "memory", targetId: readInConsole.memory_id });
  const result = await consoleRead(f.store, consoleAuth, "memories", { review: "stale" });
  const listed = new Map(result.results.map(r => [r.memory_id, r.review]));
  assert.deepEqual([...listed.keys()].sort(), [weak.memory_id, old.memory_id, readInConsole.memory_id].sort());
  assert.deepEqual(listed.get(weak.memory_id), { strength: 2, age_days: 70, last_read_days: null });
  assert.equal(listed.get(old.memory_id).age_days, 200);
  await assert.rejects(consoleRead(f.store, consoleAuth, "memories", { review: "all" }), /Invalid review/);
});
