import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout } from "node:timers/promises";
import { fixture } from "./fixture.mjs";
import { writePrivate } from "../../../shared/oauth-common.mjs";
import { AuthStore } from "../src/sqlite-adapter.mjs";

test("TOKEN-06 real child-process SIGKILL and clean restart preserve valid tokens without reviving consumed grants", async (t) => {
  const f = await fixture(t, { start: false });
  const configFile = path.join(f.directory, "runtime.json");
  writePrivate(configFile, f.config);
  let child;
  let logs = "";
  const stop = async (signal = "SIGTERM") => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit"); child.kill(signal); await exited;
  };
  f.stop = stop;
  const start = async () => {
    child = spawn(process.execPath, [new URL("../src/server.mjs", import.meta.url).pathname, "--isolated-fixture"],
      { env: { ...process.env, MNEMURON_OAUTH_CONFIG: configFile }, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { logs = (logs + chunk).slice(-100000); });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error("Synthetic authorization child failed to start");
      try { if ((await fetch(`${f.config.issuer}/readyz`)).status === 200) return; } catch {}
      await setTimeout(20);
    }
    throw new Error("Synthetic child readiness timeout");
  };
  await start();
  const authorization = await f.authorize();
  const original = (await f.exchange(authorization)).data;
  await stop("SIGKILL"); await start();
  assert.equal((await f.introspect(original.access_token)).data.active, true);
  const rotated = await f.token({ grant_type: "refresh_token", refresh_token: original.refresh_token });
  assert.equal(rotated.status, 200);
  await stop(); await start();
  assert.equal((await f.introspect(rotated.data.access_token)).data.active, true);
  assert.equal((await f.token({ grant_type: "refresh_token", refresh_token: original.refresh_token })).data.error, "invalid_grant");
  assert.equal((await f.introspect(rotated.data.access_token)).data.active, false);
  assert.equal((await f.exchange(authorization)).data.error, "invalid_grant");
  await stop();
  for (const secret of [f.password, f.secret, f.seed, original.access_token, original.refresh_token, authorization.callback.searchParams.get("code")]) {
    assert.equal(logs.includes(secret), false);
  }
});

test("OPS-05 isolated closed-database restore requires explicit grant revocation before accepting requests", async (t) => {
  const f = await fixture(t);
  const tokens = (await f.exchange(await f.authorize())).data;
  await f.stop();
  const snapshot = path.join(f.directory, "closed-snapshot.sqlite3");
  fs.copyFileSync(f.config.database_file, snapshot);
  fs.chmodSync(snapshot, 0o600);
  const restored = new AuthStore(snapshot);
  assert.ok(restored.summary().some(row => row.model === "Grant"));
  assert.ok(restored.revoke({ all: true }) >= 1);
  assert.equal(restored.summary().some(row => ["AccessToken", "RefreshToken", "Grant"].includes(row.model)), false);
  assert.equal(restored.ready(), true);
  restored.close();
  f.config.database_file = snapshot;
  await f.start();
  assert.equal((await f.introspect(tokens.access_token)).data.active, false);
  assert.equal((await f.token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })).data.error, "invalid_grant");
});
