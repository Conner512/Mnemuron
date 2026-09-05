import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  HISTORICAL_BODY_BYTES,
  latencySummary,
  makeSizedEnvelope,
  NEAR_LIMIT_BODY_BYTES,
  OVER_LIMIT_BODY_BYTES,
  QUICK_DEFAULTS,
  runLocalHarness,
} from "../bin/mnemuron-capacity-harness.mjs";

function identity(label) {
  return {
    eventId: `capacity-test-${label}`,
    runId: "capacity-test",
    sessionId: "capacity-test-session",
  };
}

test("capacity harness creates exact encoded body sizes and latency percentiles", () => {
  for (const [label, bytes] of [
    ["historical", HISTORICAL_BODY_BYTES],
    ["near", NEAR_LIMIT_BODY_BYTES],
    ["over", OVER_LIMIT_BODY_BYTES],
  ]) {
    const sized = makeSizedEnvelope(bytes, identity(label));
    assert.equal(sized.bytes, bytes);
    assert.equal(Buffer.byteLength(sized.body), bytes);
  }
  assert.deepEqual(latencySummary([
    { status: 202, latency_ms: 1 },
    { status: 202, latency_ms: 2 },
    { status: 202, latency_ms: 3 },
    { status: 413, latency_ms: 4 },
  ]), {
    count: 4,
    statuses: { "202": 3, "413": 1 },
    p50_ms: 2,
    p95_ms: 4,
    p99_ms: 4,
    max_ms: 4,
  });
});

test("quick local harness preserves isolation and quarantines permanent 413 without blocking", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-capacity-harness-test-"));
  const evidenceDir = path.join(root, "evidence");
  try {
    const { summary } = await runLocalHarness({
      ...QUICK_DEFAULTS,
      runId: "local-test",
      evidenceDir,
    });
    assert.equal(summary.production_contacted, false);
    assert.equal(summary.schema_version, "mnemuron-capacity-backpressure-local-v0.2");
    assert.equal(summary.production_ready_changed, false);
    assert.equal(summary.hermes_touched, false);
    assert.equal(summary.final_integrity_check, "ok");
    assert.equal(summary.load_reconciliation.missing_count, 0);
    assert.equal(summary.cases.find((item) => item.id === "BODY-03").result, "pass");
    assert.equal(summary.cases.find((item) => item.id === "QUEUE-03").result, "pass");
    assert.equal(summary.cases.find((item) => item.id === "QUEUE-04").result, "pass");
    assert.equal(
      summary.cases.find((item) => item.id === "QUEUE-04").evidence.actual_behavior,
      "permanent_413_quarantined_later_valid_event_drained",
    );
    assert.equal(summary.cases.find((item) => item.id === "QUEUE-04").blocker, null);
    assert.equal(summary.status, "pass");
    const backup = summary.cases.find((item) => item.id === "RET-03").evidence.backup;
    assert.equal(backup.integrity_check, "ok");
    assert.equal(backup.rate_pages, 100);
    assert.ok(backup.progress_steps > 0);
    assert.ok(backup.rewind_signals >= 0);
    assert.ok(backup.total_pages_max >= backup.total_pages_min);
    assert.ok(backup.pages_backed_up > 0);
    assert.ok(backup.last_progress.remaining_pages >= 0);
    assert.equal(statSync(evidenceDir).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(evidenceDir, "summary.json")).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
