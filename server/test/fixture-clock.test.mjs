import assert from "node:assert/strict";
import test from "node:test";
import { fixtureClock } from "./helpers/fixture-clock.mjs";

test("fixture capture times stay inside the default retention window and keep their order", () => {
  const at = fixtureClock("2026-09-03T04:00:00.000Z");
  const times = ["2026-09-03T01:00:00.000Z", "2026-09-03T01:01:00.000Z", "2026-09-03T04:00:00.000Z"].map(at);
  const values = times.map(Date.parse);
  assert.deepEqual(values.map((v) => v - values[0]), [0, 60_000, 3 * 3_600_000]);
  const now = Date.now();
  assert.ok(values.at(-1) <= now - 59 * 60_000 && values.at(-1) > now - 2 * 3_600_000);
  assert.ok(values[0] > now - 30 * 86_400_000, "fixtures must not be expired on arrival");
  assert.equal(at("2026-09-03T01:00:00.000Z"), times[0], "mapping is deterministic within a file");
});
