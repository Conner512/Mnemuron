import assert from "node:assert/strict";
import test from "node:test";
import { memoryFixture } from "./helpers/core-memory-fixture.mjs";
import { projectProfile } from "../lib/memory/profile.mjs";

test("PROFILE-01: a project profile counts its own memories, ranks keywords and lists key memories and problems", async t => {
  const f = await memoryFixture(t);
  const save = (content, extra) => f.store.saveMemory(f.a.auth, { content, scope: "project", project_id: "project-alpha", ...extra }).memory;
  save("Deploys go through tar and pct exec.", { kind: "workflow", concepts: ["deploy", "PVE"], strength: 8 });
  save("Prefer LXC over VMs.", { kind: "preference", concepts: ["PVE", "LXC"], strength: 6 });
  const bug = save("ZFS ARC caused OOM until capped.", { kind: "bug", concepts: ["ZFS", "PVE"], strength: 5 });
  f.store.saveMemory(f.a.auth, { content: "Account-wide preference", scope: "user", kind: "preference", concepts: ["PVE"] });
  f.store.saveMemory(f.a.auth, { content: "Beta note", scope: "project", project_id: "project-beta", kind: "fact", concepts: ["PVE"] });
  const p = projectProfile(f.store, f.a.auth, "project-alpha");
  assert.equal(p.memory_count, 3, "account-wide and other projects' memories are left out");
  assert.deepEqual(p.kinds, { workflow: 1, preference: 1, bug: 1 });
  assert.deepEqual(p.concepts[0], { concept: "PVE", count: 3 });
  assert.deepEqual(p.key_memories.map(m => m.strength), [8, 6], "strongest first, problems excluded");
  assert.deepEqual(p.recent_problems.map(m => m.memory_id), [bug.memory_id]);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE action='memory.profile'").get().n, 1);
});

test("PROFILE-02: the HTTP route needs read scope and refuses an unknown or foreign project", async t => {
  const f = await memoryFixture(t);
  const ok = await f.request("POST", "/v1/projects/profile", { project_id: "project-alpha" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.memory_count, 0);
  const foreign = await f.request("POST", "/v1/projects/profile", { project_id: "project-foreign" });
  assert.notEqual(foreign.status, 200, "another owner's project is not readable");
  const missing = await f.request("POST", "/v1/projects/profile", {});
  assert.equal(missing.status, 400);
});
