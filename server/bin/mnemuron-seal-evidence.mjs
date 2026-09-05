#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const evidenceDir = path.resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Usage: mnemuron-seal-evidence EVIDENCE_DIR");
if (!statSync(evidenceDir).isDirectory()) throw new Error("Evidence path is not a directory.");

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function writePrivate(file, value) {
  writeFileSync(file, value, { mode: 0o600 });
  chmodSync(file, 0o600);
}

chmodSync(evidenceDir, 0o700);
const excluded = new Set(["checksums.sha256", "seal-manifest.json"]);
const files = readdirSync(evidenceDir)
  .filter((name) => !excluded.has(name) && statSync(path.join(evidenceDir, name)).isFile())
  .sort();
for (const name of files) chmodSync(path.join(evidenceDir, name), 0o600);

const entries = files.map((name) => ({
  file: name,
  bytes: statSync(path.join(evidenceDir, name)).size,
  sha256: sha256File(path.join(evidenceDir, name)),
}));
const checksumFile = path.join(evidenceDir, "checksums.sha256");
writePrivate(checksumFile, `${entries.map((entry) => `${entry.sha256}  ${entry.file}`).join("\n")}\n`);
writePrivate(path.join(evidenceDir, "seal-manifest.json"), `${JSON.stringify({
  schema_version: "mnemuron-evidence-seal-v0.1",
  sealed_at: new Date().toISOString(),
  evidence_directory: evidenceDir,
  files: entries,
  checksums_sha256: sha256File(checksumFile),
}, null, 2)}\n`);

process.stdout.write(`${JSON.stringify({ status: "sealed", evidence_dir: evidenceDir, files: entries.length })}\n`);
