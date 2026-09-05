#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runFr04 } from "./mnemuron-fr04-private-tls.mjs";
import { readRemoteDeploymentConfig } from "./deployment-config.mjs";

const execFile = promisify(execFileCallback);
const deployment = readRemoteDeploymentConfig();
const PVE_HOST = deployment.sshHost;
const CTID = String(deployment.ctid);
const SERVER_URL = deployment.serverUrl;
const CT_SERVER_URL = "http://127.0.0.1:47831";
const CT_ADMIN_KEY = "/root/.mnemuron/credentials/admin.key";

function timestamp() {
  return new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

function writePrivate(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

async function execute(file, args, { ignoreFailure = false } = {}) {
  try {
    return await execFile(file, args, { encoding: "utf8", maxBuffer: 1024 * 1024 });
  } catch (error) {
    if (ignoreFailure) return { stdout: "", stderr: error.message, failed: true };
    throw error;
  }
}

async function ssh(args, options) {
  return execute("ssh", [PVE_HOST, ...args], options);
}

async function pct(args, options) {
  return ssh(["pct", ...args], options);
}

function helperArgs(command, paths, instance, extra = []) {
  return [
    "exec", CTID, "--",
    "/opt/mnemuron/node/bin/node", paths.ctHelper,
    command,
    "--server-url", CT_SERVER_URL,
    "--admin-key-file", CT_ADMIN_KEY,
    "--instance", instance,
    "--key-file", paths.ctKey,
    "--metadata-file", paths.ctMetadata,
    ...extra,
  ];
}

async function removeKnownArtifacts(paths) {
  for (const file of [paths.ctKey, paths.ctMetadata, paths.ctHelper]) {
    await pct(["exec", CTID, "--", "unlink", file], { ignoreFailure: true });
  }
  await pct(["exec", CTID, "--", "rmdir", paths.ctDir], { ignoreFailure: true });
  for (const file of [paths.pveKey, paths.pveHelper]) {
    await ssh(["unlink", file], { ignoreFailure: true });
  }
  await ssh(["rmdir", paths.pveDir], { ignoreFailure: true });
}

async function main() {
  const runId = `fr04-private-tls-${timestamp()}`;
  const evidenceDir = path.resolve("evidence", "failure-recovery", runId);
  const localDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-fr04-"));
  chmodSync(localDir, 0o700);
  const localHelper = path.resolve("server/bin/mnemuron-temporary-agent-key.mjs");
  const primaryInstance = `mnemuron-fr04-primary-${runId}`;
  const unrelatedInstance = `mnemuron-fr04-unrelated-${runId}`;
  const primary = {
    ctDir: `/run/${runId}`,
    ctHelper: `/run/${runId}/temporary-agent-key.mjs`,
    ctKey: `/run/${runId}/primary.key`,
    ctMetadata: `/run/${runId}/primary.metadata.json`,
    pveDir: `/tmp/${runId}`,
    pveHelper: `/tmp/${runId}/temporary-agent-key.mjs`,
    pveKey: `/tmp/${runId}/primary.key`,
    localKey: path.join(localDir, "primary.key"),
  };
  const unrelated = {
    ...primary,
    ctKey: `/run/${runId}/unrelated.key`,
    ctMetadata: `/run/${runId}/unrelated.metadata.json`,
    pveKey: `/tmp/${runId}/unrelated.key`,
    localKey: path.join(localDir, "unrelated.key"),
  };
  const lifecycle = {
    run_id: runId,
    primary: { instance: primaryInstance, created: null, revoked: null },
    unrelated: { instance: unrelatedInstance, created: null, revoked: null },
    local_key_files_removed: false,
    remote_key_files_removed: false,
    api_key_recorded: false,
  };
  let primaryCreated = false;
  let unrelatedCreated = false;
  let primaryRevoked = false;
  let unrelatedRevoked = false;
  try {
    await ssh(["install", "-d", "-m", "700", primary.pveDir]);
    await pct(["exec", CTID, "--", "install", "-d", "-m", "700", primary.ctDir]);
    await execute("scp", ["-q", localHelper, `${PVE_HOST}:${primary.pveHelper}`]);
    await pct(["push", CTID, primary.pveHelper, primary.ctHelper]);
    await pct(["exec", CTID, "--", "chmod", "700", primary.ctHelper]);
    const expiresAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const sharedCreate = [
      "--agent", "mnemuron-fr04",
      "--expires-at", expiresAt,
      "--scopes", "resume:read,resume:confirm",
    ];
    const primaryResult = await pct(helperArgs("create", primary, primaryInstance, [
      "--device", "failure-recovery-v01",
      "--label", "fr04-private-tls-primary",
      ...sharedCreate,
    ]));
    lifecycle.primary.created = JSON.parse(primaryResult.stdout);
    primaryCreated = true;
    const unrelatedResult = await pct(helperArgs("create", unrelated, unrelatedInstance, [
      "--device", "failure-recovery-v01-other",
      "--label", "fr04-private-tls-unrelated",
      ...sharedCreate,
    ]));
    lifecycle.unrelated.created = JSON.parse(unrelatedResult.stdout);
    unrelatedCreated = true;

    await pct(["pull", CTID, primary.ctKey, primary.pveKey]);
    await pct(["pull", CTID, unrelated.ctKey, unrelated.pveKey]);
    await ssh(["chmod", "600", primary.pveKey, unrelated.pveKey]);
    await execute("scp", ["-q", `${PVE_HOST}:${primary.pveKey}`, primary.localKey]);
    await execute("scp", ["-q", `${PVE_HOST}:${unrelated.pveKey}`, unrelated.localKey]);
    chmodSync(primary.localKey, 0o600);
    chmodSync(unrelated.localKey, 0o600);

    const result = await runFr04({
      serverUrl: SERVER_URL,
      primaryKeyFile: primary.localKey,
      unrelatedKeyFile: unrelated.localKey,
      runId,
      evidenceDir,
    });

    const primaryRevoke = await pct(helperArgs("revoke", primary, primaryInstance));
    lifecycle.primary.revoked = JSON.parse(primaryRevoke.stdout);
    primaryRevoked = true;
    const unrelatedRevoke = await pct(helperArgs("revoke", unrelated, unrelatedInstance));
    lifecycle.unrelated.revoked = JSON.parse(unrelatedRevoke.stdout);
    unrelatedRevoked = true;
    writePrivate(path.join(evidenceDir, "credential-lifecycle.json"), lifecycle);

    process.stdout.write(`${JSON.stringify({
      status: result.summary.result,
      run_id: runId,
      resume_id: result.summary.resume_id,
      receipt_id: result.summary.receipt_id,
      primary_credential_id: lifecycle.primary.created.credential_id,
      unrelated_credential_id: lifecycle.unrelated.created.credential_id,
      evidence_dir: evidenceDir,
    })}\n`);
  } finally {
    if (primaryCreated && !primaryRevoked) {
      const result = await pct(helperArgs("revoke", primary, primaryInstance), { ignoreFailure: true });
      if (!result.failed && result.stdout) lifecycle.primary.revoked = JSON.parse(result.stdout);
    }
    if (unrelatedCreated && !unrelatedRevoked) {
      const result = await pct(helperArgs("revoke", unrelated, unrelatedInstance), { ignoreFailure: true });
      if (!result.failed && result.stdout) lifecycle.unrelated.revoked = JSON.parse(result.stdout);
    }
    await removeKnownArtifacts(primary);
    await removeKnownArtifacts(unrelated);
    rmSync(localDir, { recursive: true, force: true });
    lifecycle.local_key_files_removed = true;
    lifecycle.remote_key_files_removed = true;
    try {
      if (readFileSync(path.join(evidenceDir, "manifest.json"))) {
        writePrivate(path.join(evidenceDir, "credential-lifecycle.json"), lifecycle);
      }
    } catch {
      // No evidence directory exists when setup fails before the runner starts.
    }
  }
}

await main();
