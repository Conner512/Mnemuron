import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  partitionProfiles,
  QUICK_DEFAULTS,
  runFailureRecoveryHarness,
} from "../bin/mnemuron-failure-recovery-harness.mjs";

test("failure recovery partition profiles retain declared durations and explicit acceleration", () => {
  const profiles = partitionProfiles(0.001);
  assert.deepEqual(profiles.map((profile) => profile.target_duration_seconds), [300, 1800, 7200]);
  assert.ok(profiles.every((profile) => profile.accelerated));
  assert.ok(profiles.every((profile) => profile.observed_hold_ms >= 25));
  assert.throws(() => partitionProfiles(0), /greater than 0/u);
  assert.throws(() => partitionProfiles(2), /at most 1/u);
});

test("failure recovery harness passes only disposable local isolation", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-failure-test-"));
  const evidenceDir = path.join(root, "evidence");
  try {
    const { summary } = await runFailureRecoveryHarness({
      ...QUICK_DEFAULTS,
      executionLayer: "local-isolated",
      runId: "failure-test-local",
      evidenceDir,
    });
    assert.equal(summary.status, "pass_isolated_only");
    assert.equal(summary.production_contacted, false);
    assert.equal(summary.production_database_written, false);
    assert.equal(summary.production_service_restarted, false);
    assert.equal(summary.temporary_production_key_created, false);
    assert.equal(summary.other_agents_touched, false);
    assert.equal(summary.production_ready_changed, false);
    assert.deepEqual(summary.cases.map((item) => item.id), [
      "FR-00", "FR-01", "FR-02", "FR-03", "FR-04", "FR-05",
    ]);
    assert.ok(summary.cases.every((item) => item.result === "pass"));
    assert.equal(summary.cases.find((item) => item.id === "FR-01").evidence.cycles.length, 5);
    assert.equal(
      summary.cases.find((item) => item.id === "FR-03").evidence.real_private_tls_partition,
      false,
    );
    assert.equal(
      summary.cases.find((item) => item.id === "FR-05").evidence.scheduled_backup_used,
      false,
    );
    for (const file of summary.evidence_files) {
      const target = path.join(evidenceDir, file);
      assert.equal(statSync(target).mode & 0o777, 0o600);
    }
    assert.equal(statSync(evidenceDir).mode & 0o777, 0o700);
    const persisted = JSON.parse(readFileSync(path.join(evidenceDir, "summary.json"), "utf8"));
    assert.equal(persisted.status, "pass_isolated_only");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
