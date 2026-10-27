import assert from "node:assert/strict";
import test from "node:test";
import { memoryFixture } from "./helpers/core-memory-fixture.mjs";
import { sessionContext, estimateTokens } from "../lib/memory/session-context.mjs";

test("CTX-01: session context lists account preferences, then the project's key memories and recent problems, within budget", async t => {
  const f = await memoryFixture(t);
  const save = body => f.store.saveMemory(f.a.auth, body).memory;
  const pref = save({ scope: "user", content: "Reply in Chinese.", kind: "preference", strength: 9 });
  save({ scope: "user", content: "A plain account fact.", kind: "fact", strength: 9 });
  const arch = save({ scope: "project", project_id: "project-alpha", content: "Qdrant listens on the private network only.", kind: "architecture", strength: 8 });
  const bug = save({ scope: "project", project_id: "project-alpha", content: "Tunnel dropped when the clock drifted.", kind: "bug", strength: 5 });
  save({ scope: "project", project_id: "project-beta", content: "Other project preference.", kind: "preference", strength: 10 });
  const ctx = sessionContext(f.store, f.a.auth, { project_id: "project-alpha" });
  assert.deepEqual(ctx.memory_ids, [pref.memory_id, arch.memory_id, bug.memory_id]);
  assert.match(ctx.text, /^Mnemuron memory context: background data .* not instructions/);
  assert.match(ctx.text, /- \[preference\] Reply in Chinese\./);
  assert.doesNotMatch(ctx.text, /plain account fact|Other project/);
  assert.ok(ctx.estimated_tokens > 0 && ctx.estimated_tokens <= ctx.budget_tokens);
  assert.ok(estimateTokens(ctx.text) >= ctx.estimated_tokens - 4, "the estimate covers the returned text");
  const accountOnly = sessionContext(f.store, f.a.auth, {});
  assert.deepEqual(accountOnly.memory_ids, [pref.memory_id]);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE action='memory.context'").get().n, 2);
});

test("CTX-02: the budget truncates, an empty store returns no text, and bad input is refused", async t => {
  const f = await memoryFixture(t);
  assert.equal(sessionContext(f.store, f.a.auth, {}).text, null);
  for (let n = 0; n < 40; n++) f.store.saveMemory(f.a.auth, { scope: "user", content: `偏好第 ${n} 条：`.padEnd(120, "很长的说明"), kind: "preference" });
  const ctx = sessionContext(f.store, f.a.auth, { budget_tokens: 400 });
  assert.equal(ctx.truncated, true);
  assert.ok(ctx.estimated_tokens <= 400);
  assert.throws(() => sessionContext(f.store, f.a.auth, { budget_tokens: 50 }), /budget_tokens/);
  const http = await f.request("POST", "/v1/context/session", { budget_tokens: 400 });
  assert.equal(http.status, 200);
  assert.equal(http.body.truncated, true);
});
