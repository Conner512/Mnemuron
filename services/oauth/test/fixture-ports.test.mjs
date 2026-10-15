import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { freePort } from "./fixture.mjs";

test("FIXTURE-01: freePort never hands the same port to two fixture roles in one process", async (t) => {
  // Force the collision Linux CI can produce: the OS offers an already reserved port first.
  const first = await freePort(), listen = net.Server.prototype.listen;
  let forced = false;
  t.mock.method(net.Server.prototype, "listen", function (port, ...rest) { if (!forced && port === 0) { forced = true; return listen.call(this, first, ...rest); } return listen.call(this, port, ...rest); });
  const second = await freePort();
  assert.equal(forced, true);
  assert.notEqual(second, first);
  t.mock.restoreAll();
  const ports = [];
  for (let i = 0; i < 100; i++) ports.push(await freePort());
  assert.equal(new Set([first, second, ...ports]).size, ports.length + 2);
});
