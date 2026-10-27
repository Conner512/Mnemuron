import assert from "node:assert/strict";
import test from "node:test";
import { memoryFixture } from "./helpers/core-memory-fixture.mjs";
import { similarMemories, SIMILAR_SCORE, DUPLICATE_SCORE } from "../lib/memory/similar.mjs";

test("SIMILAR-01: a repeated save over HTTP lists the earlier memory; a different one lists nothing", async t => {
  const f = await memoryFixture(t);
  const first = await f.request("POST", "/v1/memories", { scope: "user", content: "Backups run nightly at 03:00 to the NAS." });
  assert.equal(first.status, 201);
  assert.equal(first.body.similar_memories, undefined, "nothing similar yet");
  const again = await f.request("POST", "/v1/memories", { scope: "user", content: "backups run nightly at 03:00 to the NAS" });
  assert.deepEqual(again.body.similar_memories, [{ memory_id: first.body.memory.memory_id, similarity: 1, relation: "duplicate" }]);
  const other = await f.request("POST", "/v1/memories", { scope: "user", content: "The blog deploys on Cloudflare Pages." });
  assert.equal(other.body.similar_memories, undefined);
  const replay = await f.request("POST", "/v1/memories", { scope: "user", content: "backups run nightly at 03:00 to the NAS", operation_id: "op-1" });
  const replayed = await f.request("POST", "/v1/memories", { scope: "user", content: "backups run nightly at 03:00 to the NAS", operation_id: "op-1" });
  assert.equal(replayed.body.idempotent, true);
  assert.equal(replayed.body.similar_memories, undefined, "a replay does not recompute hints");
  assert.ok(replay.body.similar_memories.length >= 1);
});

test("SIMILAR-02: hints never cross owners and need read scope", async t => {
  const f = await memoryFixture(t);
  const foreign = f.store.saveMemory(f.other.auth, { scope: "user", content: "Shared phrasing across owners." }).memory;
  const mine = f.store.saveMemory(f.a.auth, { scope: "user", content: "Shared phrasing across owners." }).memory;
  assert.deepEqual(await similarMemories(f.store, f.a.auth, mine), []);
  assert.deepEqual(await similarMemories(f.store, { ...f.a.auth, scopes: ["memory:write"] }, mine), []);
  assert.ok(foreign.memory_id);
  assert.ok(SIMILAR_SCORE < DUPLICATE_SCORE && SIMILAR_SCORE > 0.84, "threshold sits above the closest distinct pair in calibration");
});
