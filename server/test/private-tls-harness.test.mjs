import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";
import { createBackupProgressTracker } from "../bin/mnemuron-capacity-harness.mjs";
import { readRemoteDeploymentConfig } from "../bin/deployment-config.mjs";
import {
  BACKUP_CODE,
  createResourceGuard,
  mergePveResourceSample,
  parseArgs,
  PVE_RESOURCE_SCRIPT,
  removeSqliteTemporaryArtifacts,
  RESOURCE_CODE,
  SQLITE_TEMP_SUFFIXES,
  SWAP_STOP_DELTA_BYTES,
} from "../bin/mnemuron-private-tls-harness.mjs";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

function resource(overrides = {}) {
  return {
    production_pid: 1234,
    production_restarts: 0,
    production_active: "active",
    production_memory_bytes: 200 * 1024 * 1024,
    filesystem_free_percent: 30,
    container_memory_current_bytes: 700 * 1024 * 1024,
    container_memory_max_bytes: 1024 * 1024 * 1024,
    container_memory_pressure_full_avg10: 0,
    container_swap_current_bytes: 64 * 1024 * 1024,
    container_memory_events_high: 0,
    container_memory_events_max: 0,
    container_memory_events_oom: 0,
    container_memory_events_oom_kill: 0,
    production_memory_events_high: 0,
    production_memory_events_max: 0,
    production_memory_events_oom: 0,
    production_memory_events_oom_kill: 0,
    ...overrides,
  };
}

test("resource guard warns but does not stop on three tiny swap increases", () => {
  const guard = createResourceGuard();
  const baseline = 64 * 1024 * 1024;
  guard.evaluate(resource({ container_swap_current_bytes: baseline }));
  guard.evaluate(resource({ container_swap_current_bytes: baseline + 8 * 1024 }));
  guard.evaluate(resource({ container_swap_current_bytes: baseline + 12 * 1024 }));
  const result = guard.evaluate(resource({ container_swap_current_bytes: baseline + 16 * 1024 }));

  assert.equal(result.stop_reason, null);
  assert.equal(result.swap_growth_samples, 3);
  assert.equal(result.swap_delta_bytes, 16 * 1024);
  assert.deepEqual(result.warnings, ["swap_increase_observed"]);
});

test("resource guard stops only after material swap delta grows for three samples", () => {
  const guard = createResourceGuard();
  const baseline = 64 * 1024 * 1024;
  guard.evaluate(resource({ container_swap_current_bytes: baseline }));
  guard.evaluate(resource({ container_swap_current_bytes: baseline + 8 * 1024 * 1024 }));
  guard.evaluate(resource({ container_swap_current_bytes: baseline + 16 * 1024 * 1024 }));
  const result = guard.evaluate(resource({
    container_swap_current_bytes: baseline + SWAP_STOP_DELTA_BYTES,
  }));

  assert.equal(result.stop_reason, "material_swap_growth_three_samples");
  assert.equal(result.swap_delta_bytes, SWAP_STOP_DELTA_BYTES);
  assert.equal(result.swap_growth_samples, 3);
});

test("resource guard combines near-limit container memory with full PSI", () => {
  const guard = createResourceGuard();
  const quiet = guard.evaluate(resource({
    container_memory_current_bytes: 950 * 1024 * 1024,
    container_memory_pressure_full_avg10: 0.4,
  }));
  assert.equal(quiet.stop_reason, null);

  const pressured = guard.evaluate(resource({
    container_memory_current_bytes: 950 * 1024 * 1024,
    container_memory_pressure_full_avg10: 1.2,
  }));
  assert.equal(pressured.stop_reason, "container_memory_pressure_threshold");
});

test("resource guard stops on a new OOM event and preserves the first reason", () => {
  const guard = createResourceGuard();
  guard.evaluate(resource({ container_memory_events_oom: 2 }));
  const oom = guard.evaluate(resource({ container_memory_events_oom: 3 }));
  assert.equal(oom.stop_reason, "container_oom_event");
  const later = guard.evaluate(resource({
    container_memory_events_oom: 3,
    production_active: "failed",
  }));
  assert.equal(later.stop_reason, "container_oom_event");
});

test("backup progress tracker records page rewind signals without retaining every step", () => {
  const tracker = createBackupProgressTracker();
  tracker.record({ totalPages: 1000, remainingPages: 900 });
  tracker.record({ totalPages: 1000, remainingPages: 800 });
  tracker.record({ totalPages: 1100, remainingPages: 1050 });
  tracker.record({ totalPages: 1100, remainingPages: 0 });
  assert.deepEqual(tracker.summary(), {
    progress_steps: 4,
    rewind_signals: 1,
    largest_remaining_increase_pages: 250,
    total_pages_min: 1000,
    total_pages_max: 1100,
    first_progress: { step: 1, total_pages: 1000, remaining_pages: 900 },
    last_progress: { step: 4, total_pages: 1100, remaining_pages: 0 },
  });
});

test("private TLS quick mode skips remote backup while formal mode keeps one bounded backup", () => {
  const required = [
    "--run-id", "v02-test", "--evidence-dir", "/tmp/v02-test",
    "--server-url", "https://localhost", "--ssh-host", "test-pve", "--ctid", "100",
  ];
  const quick = parseArgs(["--quick", ...required]);
  assert.equal(quick.backupMode, "skip");
  assert.equal(quick.backupTimeoutMs, 300_000);
  assert.equal(quick.backupRatePages, 8_192);

  const formal = parseArgs([
    ...required,
    "--backup-mode", "once",
    "--backup-timeout-ms", "120000",
    "--backup-rate-pages", "512",
  ]);
  assert.equal(formal.backupMode, "once");
  assert.equal(formal.backupTimeoutMs, 120_000);
  assert.equal(formal.backupRatePages, 512);
});

test("remote deployment config rejects placeholder and credential-bearing targets", () => {
  const target = { sshHost: "test-pve", ctid: 100, serverUrl: "https://localhost" };
  assert.deepEqual(readRemoteDeploymentConfig(target), { ...target, serverUrl: "https://localhost/" });
  for (const serverUrl of [
    "https://mnemuron.example.com", "https://mnemuron.example", "http://localhost",
    "https://sample-user:sample-password@localhost",
  ]) {
    assert.throws(() => readRemoteDeploymentConfig({ ...target, serverUrl }), /explicit HTTPS/);
  }
  assert.throws(() => readRemoteDeploymentConfig({ ...target, sshHost: "-oProxyCommand=example" }), /SSH host/);
  assert.throws(() => readRemoteDeploymentConfig({ ...target, ctid: "100;false" }), /positive integer/);
});

test("remote deployment CLI stops before credentials or network when its target is missing", () => {
  const env = { ...process.env };
  for (const name of ["MNEMURON_PVE_HOST", "MNEMURON_CTID", "MNEMURON_SERVER_URL"]) delete env[name];
  const script = new URL("../bin/mnemuron-private-tls-harness.mjs", import.meta.url);
  const result = spawnSync(process.execPath, [
    script.pathname, "--quick", "--run-id", "missing-target", "--evidence-dir", "/unused/privacy-test",
  ], { env, encoding: "utf8", timeout: 5000, input: "" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MNEMURON_PVE_HOST is required/);
  assert.doesNotMatch(result.stderr, /temporary Mnemuron key|Permission denied|Could not resolve hostname/);
});

test("private TLS embedded resource and backup probes compile before remote use", () => {
  assert.doesNotThrow(() => new vm.Script(RESOURCE_CODE));
  assert.doesNotThrow(() => new vm.Script(BACKUP_CODE));
  assert.match(PVE_RESOURCE_SCRIPT, /pvesh get/);
  assert.match(PVE_RESOURCE_SCRIPT, /memory\.max/);
});

test("PVE resource sample overrides the untrusted guest root cgroup", () => {
  const guest = {
    production_pid: 1234,
    production_restarts: 0,
    production_active: "active",
    production_memory_bytes: 200 * 1024 * 1024,
    filesystem_free_percent: 30,
    container_memory_current_bytes: 1_050_000_000,
    container_memory_max_bytes: null,
    container_memory_pressure_full_avg10: 2.53,
  };
  const record = mergePveResourceSample(guest, {
    vmid: 100,
    type: "lxc",
    status: "running",
    pid: 1101888,
    pve_node: "test-node",
    container_cgroup_path: "/sys/fs/cgroup/lxc/100",
    mem: 145_248_256,
    maxmem: 1_073_741_824,
    swap: 63_643_648,
    maxswap: 536_870_912,
    pressurememorysome: "0.00",
    pressurememoryfull: "0.00",
    pressureiosome: "0.00",
    pressureiofull: "0.00",
    cgroup_memory_peak_bytes: 1_065_000_000,
    cgroup_swap_peak_bytes: 70_000_000,
    cgroup_anon_bytes: 150_000_000,
    cgroup_file_bytes: 900_000_000,
    cgroup_events_high: 100,
    cgroup_events_max: 0,
    cgroup_events_oom: 0,
    cgroup_events_oom_kill: 0,
  }, { expectedCtid: 100 });

  assert.equal(record.container_metric_source, "pve-host-authoritative-v0.1");
  assert.equal(record.container_memory_current_bytes, 145_248_256);
  assert.equal(record.container_memory_max_bytes, 1_073_741_824);
  assert.equal(record.container_swap_current_bytes, 63_643_648);
  assert.equal(record.container_memory_pressure_full_avg10, 0);
  assert.equal(createResourceGuard().evaluate(record).stop_reason, null);
});

test("PVE resource sample fails closed when authoritative limits are absent", () => {
  assert.throws(() => mergePveResourceSample({}, {
    vmid: 100,
    type: "lxc",
    status: "running",
    pid: 1,
    pve_node: "test-node",
    container_cgroup_path: "/sys/fs/cgroup/lxc/100",
    mem: 1,
    maxmem: null,
  }, { expectedCtid: 100 }), /pve_resource_probe_invalid:maxmem/);
});

test("SQLite temporary cleanup includes rollback journals and private creation mode", () => {
  assert.deepEqual([...SQLITE_TEMP_SUFFIXES], ["", "-wal", "-shm", "-journal"]);
  assert.match(BACKUP_CODE, /process\.umask\(0o077\)/);
  assert.match(BACKUP_CODE, /\["SIGHUP", "SIGINT", "SIGTERM"\]/);
  assert.match(BACKUP_CODE, /setTimeout\(\(\) => stop\("deadline"\), deadlineMs\)/);
  assert.match(BACKUP_CODE, /deadlineTimer\.unref\(\)/);
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-backup-cleanup-"));
  const temporary = path.join(root, "backup.sqlite3.123.tmp");
  try {
    for (const suffix of SQLITE_TEMP_SUFFIXES) writeFileSync(`${temporary}${suffix}`, "test");
    removeSqliteTemporaryArtifacts(temporary);
    for (const suffix of SQLITE_TEMP_SUFFIXES) assert.equal(existsSync(`${temporary}${suffix}`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("embedded SQLite backup leaves one private verified file and no temporary sidecars", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-backup-success-"));
  const database = path.join(root, "source.sqlite3");
  const backupDir = path.join(root, "backups");
  try {
    const db = new DatabaseSync(database);
    for (const table of ["events", "tasks", "resumes", "credentials"]) {
      db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`);
      db.prepare(`INSERT INTO ${table} (id) VALUES (?)`).run(`${table}-1`);
    }
    db.close();
    const run = spawnSync(process.execPath, [
      "-e", BACKUP_CODE, "embedded-backup", database, backupDir, "100", "10000",
    ], { encoding: "utf8", timeout: 15_000 });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout.trim());
    assert.equal(result.status, "completed");
    assert.equal(result.integrity_check, "ok");
    assert.equal(statSync(result.backup_file).mode & 0o777, 0o600);
    assert.deepEqual(
      readdirSync(backupDir).filter((file) => file.includes(".tmp")),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("embedded SQLite backup owns its deadline and removes timeout artifacts", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-backup-timeout-"));
  const database = path.join(root, "source.sqlite3");
  const backupDir = path.join(root, "backups");
  try {
    const db = new DatabaseSync(database);
    for (const table of ["events", "tasks", "resumes", "credentials"]) {
      db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`);
      db.prepare(`INSERT INTO ${table} (id) VALUES (?)`).run(`${table}-1`);
    }
    db.exec("CREATE TABLE payloads (value BLOB)");
    db.exec("INSERT INTO payloads (value) VALUES (zeroblob(67108864))");
    db.close();

    const run = spawnSync(process.execPath, [
      "-e", BACKUP_CODE, "embedded-backup", database, backupDir, "1", "25",
    ], { encoding: "utf8", timeout: 15_000 });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout.trim());
    assert.equal(result.status, "timeout");
    assert.equal(result.error_class, "backup_deadline_exceeded");
    assert.equal(result.cleanup_completed, true);
    assert.deepEqual(readdirSync(backupDir), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
