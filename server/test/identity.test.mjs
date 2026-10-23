import test from "node:test";
import assert from "node:assert/strict";
import { memoryFixture, businessSnapshot } from "./helpers/core-memory-fixture.mjs";

test("authenticated credential identity is read-only, self-scoped and never returns a key", async t => {
  const f = await memoryFixture(t);
  const before = businessSnapshot(f.store);
  assert.equal((await fetch(`${f.baseUrl}/v1/identity`)).status, 401);
  for (const owner of [f.a, f.other]) {
    const response = await f.request("GET", "/v1/identity", undefined, owner);
    assert.equal(response.status, 200);
    assert.equal(response.body.identity.user_id, owner.auth.user_id);
    assert.equal(response.body.identity.agent_instance_id, owner.auth.agent_instance_id);
    assert.deepEqual(response.body.scopes, owner.auth.scopes);
    assert.equal(JSON.stringify(response.body).includes(owner.api_key), false);
  }
  assert.deepEqual(businessSnapshot(f.store), before);
});
