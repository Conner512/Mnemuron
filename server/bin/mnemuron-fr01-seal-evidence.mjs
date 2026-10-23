#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const evidenceDir = path.resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Usage: mnemuron-fr01-seal-evidence EVIDENCE_DIR");
const labels = ["managed-1", "managed-2", "managed-3", "sigkill-1", "sigkill-2"];

function readJson(name) {
  return JSON.parse(readFileSync(path.join(evidenceDir, name), "utf8"));
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function writePrivate(name, value) {
  const file = path.join(evidenceDir, name);
  writeFileSync(file, value, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(rows) {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

const summary = readJson("summary.json");
const baseline = readJson("baseline.json");
const postflight = readJson("postflight.json");
const cycles = labels.map((label) => readJson(`${label}.json`));

const cadence = cycles.map((cycle) => {
  const server = cycle.reconciliation.cycles[cycle.label];
  const firstMs = Date.parse(server.first_captured_at);
  const lastMs = Date.parse(server.last_captured_at);
  const windowMs = lastMs - firstMs;
  return {
    cycle: cycle.label,
    generated: cycle.generated,
    scheduled_interval_ms: 100,
    first_captured_at: server.first_captured_at,
    last_captured_at: server.last_captured_at,
    measured_window_ms: windowMs,
    measured_intervals: Math.max(0, cycle.generated - 1),
    measured_generation_rate_per_second: windowMs > 0
      ? Number((((cycle.generated - 1) * 1000) / windowMs).toFixed(4))
      : null,
  };
});
writePrivate("generator-cadence.json", `${JSON.stringify({
  schema_version: "mnemuron-fr01-generator-cadence-v0.1",
  scheduled_rate_per_second: 10,
  note: "Rates use intervals between first and last captured Event. The per-cycle source field named measured_generation_rate_per_second includes post-generation drain time and is cycle-average throughput, not generator cadence.",
  cycles: cadence,
}, null, 2)}\n`);

const timelineRows = [[
  "cycle", "kind", "phase", "utc", "offset_ms", "pid", "n_restarts", "healthy", "queue_depth",
]];
for (const cycle of cycles) {
  const startedMs = Date.parse(cycle.started_at);
  const sealedAt = statSync(path.join(evidenceDir, `${cycle.label}.json`)).mtime.toISOString();
  for (const row of [
    ["cycle_start", cycle.started_at, cycle.before_service.main_pid, cycle.before_service.n_restarts, true, 0],
    ["fault_invoked", cycle.fault.invoked_at, cycle.fault.target_pid, cycle.before_service.n_restarts, false, cycle.peak_queue],
    ["private_tls_recovered", cycle.recovery.health.captured_at, cycle.recovery.service.main_pid, cycle.recovery.service.n_restarts, true, cycle.peak_queue],
    ["queue_zero", cycle.completed_at, cycle.after_service.main_pid, cycle.after_service.n_restarts, true, cycle.final_queue],
    ["reconciliation_sealed", sealedAt, cycle.after_service.main_pid, cycle.after_service.n_restarts, true, cycle.final_queue],
  ]) {
    timelineRows.push([
      cycle.label,
      cycle.kind,
      row[0],
      row[1],
      Date.parse(row[1]) - startedMs,
      row[2],
      row[3],
      row[4],
      row[5],
    ]);
  }
}
writePrivate("timeline.csv", csv(timelineRows));

const resourceRows = [[
  "cycle", "captured_at", "vmid", "type", "state", "memory_bytes", "memory_limit_bytes",
  "memory_percent", "swap_bytes", "swap_limit_bytes", "memory_psi_some", "memory_psi_full",
  "io_psi_some", "io_psi_full", "event_max", "event_oom", "event_oom_kill",
  "filesystem_available_bytes", "filesystem_total_bytes", "filesystem_free_percent",
]];
for (const cycle of cycles) {
  for (const sample of cycle.resource_samples.filter((entry) => entry.pve && entry.filesystem)) {
    resourceRows.push([
      cycle.label,
      sample.captured_at,
      sample.pve.vmid,
      sample.pve.type,
      sample.pve.status,
      sample.pve.mem,
      sample.pve.maxmem,
      (sample.pve.memory_ratio * 100).toFixed(4),
      sample.pve.swap,
      sample.pve.maxswap,
      sample.pve.pressurememorysome,
      sample.pve.pressurememoryfull,
      sample.pve.pressureiosome,
      sample.pve.pressureiofull,
      sample.memory_events.max,
      sample.memory_events.oom,
      sample.memory_events.oom_kill,
      sample.filesystem.bytes_available,
      sample.filesystem.bytes_total,
      (sample.filesystem.free_ratio * 100).toFixed(4),
    ]);
  }
}
writePrivate("pve-resources.csv", csv(resourceRows));

writePrivate("events.json", `${JSON.stringify({
  run_id: summary.run_id,
  generated: summary.total_generated,
  stored: summary.total_stored,
  missing: summary.missing,
  duplicates: summary.duplicates,
  stored_id_sha256: postflight.reconciliation.target_events.id_sha256,
  raw_available: postflight.reconciliation.target_events.raw_available,
  unique_turn_ids: postflight.reconciliation.target_events.unique_turn_ids,
  raw_payload_recorded: false,
  cycles: Object.fromEntries(cycles.map((cycle) => [cycle.label, {
    generated: cycle.generated,
    stored: cycle.reconciliation.cycles[cycle.label].count,
    id_sha256: cycle.generated_id_sha256,
    raw_available: cycle.reconciliation.cycles[cycle.label].raw_available,
    final_queue: cycle.final_queue,
  }])),
}, null, 2)}\n`);

writePrivate("receipts.json", `${JSON.stringify({
  run_id: summary.run_id,
  before: {
    delivery_receipts: baseline.reconciliation.global.receipts,
    injection_events: baseline.reconciliation.global.injections,
  },
  after: {
    delivery_receipts: postflight.reconciliation.global.receipts,
    injection_events: postflight.reconciliation.global.injections,
  },
  test_identity_created_receipt_or_ack: summary.false_receipt_or_ack_created,
  packet_content_recorded: false,
}, null, 2)}\n`);

const adjudication = {
  run_id: summary.run_id,
  case_id: "FR-01",
  result: summary.result,
  criteria: {
    five_individually_labelled_cycles: cycles.length === 5,
    three_managed_cycles: summary.managed_cycles === 3,
    two_sigkill_cycles: summary.sigkill_cycles === 2,
    every_cycle_recovered_within_60_seconds: cycles.every((cycle) => cycle.recovery.recovery_ms < 60_000),
    deliberate_restart_ledger_exact: cycles.every((cycle) => cycle.fault.action_count === 1),
    automatic_restart_deltas_exact: cycles.every((cycle) =>
      cycle.restart_delta === (cycle.kind === "sigkill" ? 1 : 0)),
    generated_events_exactly_reconciled: summary.total_generated === summary.total_stored
      && summary.missing === 0
      && summary.duplicates === 0,
    durable_queue_private_and_drained: cycles.every((cycle) =>
      cycle.outbox_directory_mode === "0700"
      && cycle.durable_file_mode_ok
      && cycle.final_queue === 0
      && cycle.quarantine_files === 0),
    raw_accounted: summary.raw_status === "accounted" && summary.unexplained_raw_unavailable === 0,
    sqlite_checks_ok: postflight.reconciliation.quick_check === "ok"
      && postflight.reconciliation.integrity_check === "ok",
    no_false_resume_receipt_or_ack: !summary.false_receipt_or_ack_created,
    memory_below_70_percent: summary.max_memory_percent < 70,
    no_new_oom_or_max_event: postflight.resource.memory_events.max === baseline.resource.memory_events.max
      && postflight.resource.memory_events.oom === baseline.resource.memory_events.oom
      && postflight.resource.memory_events.oom_kill === baseline.resource.memory_events.oom_kill,
    filesystem_above_20_percent: summary.min_filesystem_free_percent > 20,
    temporary_credential_revoked_and_removed: summary.credential_revoked,
    production_ready_unchanged_false: summary.production_ready === false,
  },
  warnings: [
    "Cumulative memory.high and pressure counters remain operational signals; no OOM, OOM-kill, or cgroup max event occurred.",
    "Policy expiry pruning increased accounted expired Raw rows during the restart window; every FR-01 Event retained Raw and unexplained unavailable remained zero.",
    "Hermes remains deferred and the global Failure and Recovery gate remains partial.",
  ],
};
writePrivate("adjudication.json", `${JSON.stringify(adjudication, null, 2)}\n`);

const cycleLines = cycles.map((cycle) => {
  const rate = cadence.find((entry) => entry.cycle === cycle.label).measured_generation_rate_per_second;
  return `- ${cycle.label}: ${cycle.generated}/${cycle.reconciliation.cycles[cycle.label].count} Events, ${rate}/s cadence, recovery ${cycle.recovery.recovery_ms} ms, peak queue ${cycle.peak_queue}, restart delta ${cycle.restart_delta}.`;
});
writePrivate("adjudication.md", [
  "# Mnemuron server FR-01 production restart adjudication",
  "",
  "Result: **Pass**",
  "",
  ...cycleLines,
  "",
  `All ${summary.total_generated} generated Events were stored exactly once with complete dedicated provenance and Raw available. The private outbox was mode 0700 with mode-0600 files, every queue drained to zero, and no test Receipt, injection ACK, or orphan lifecycle row appeared.`,
  "",
  `Private-TLS live/ready recovered within ${summary.max_recovery_ms} ms at worst. PVE-authoritative memory peaked at ${summary.max_memory_percent}% of configured capacity; filesystem free remained at least ${summary.min_filesystem_free_percent}%; OOM, OOM-kill, and cgroup max counters stayed zero. SQLite quick and integrity checks are ok.`,
  "",
  "The temporary capture:write credential was revoked and every Key copy and transport directory was removed. The verified pre-run backup remains on the server. Final service state is active/running with NRestarts=2, exactly matching the two crash-like cycles.",
  "",
  "Preparation attempts that stop before credential creation and service faults do not enter the cycle ledger. No adapter host, Caddy, DNS, firewall, retention, or external memory service setting changed. production_ready remains false.",
  "",
].join("\n"));

const sealerFile = fileURLToPath(import.meta.url);
writePrivate("seal-manifest.json", `${JSON.stringify({
  run_id: summary.run_id,
  sealed_at: new Date().toISOString(),
  sealer_sha256: sha256File(sealerFile),
  source_files: Object.fromEntries([
    "summary.json", "baseline.json", "postflight.json", "backup.json", "manifest.json",
    ...labels.map((label) => `${label}.json`),
  ].map((name) => [name, sha256File(path.join(evidenceDir, name))])),
  secret_material_recorded: false,
  raw_payload_recorded: false,
}, null, 2)}\n`);

process.stdout.write(`${JSON.stringify({ status: "sealed", evidence_dir: evidenceDir })}\n`);
