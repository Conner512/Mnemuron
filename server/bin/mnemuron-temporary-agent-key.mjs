#!/usr/bin/env node

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      result._.push(item);
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for ${item}.`);
    result[item.slice(2)] = next;
    index += 1;
  }
  return result;
}

function writePrivate(file, content) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(file), 0o700);
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
}

async function api({ serverUrl, adminKey, method, endpoint, body }) {
  const response = await fetch(new URL(endpoint, serverUrl), {
    method,
    headers: {
      authorization: `Bearer ${adminKey}`,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${endpoint} failed (${response.status}).`);
  return data;
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
if (!new Set(["create", "revoke"]).has(command)) {
  throw new Error("Expected create or revoke.");
}
for (const required of ["admin-key-file", "instance", "key-file", "metadata-file"]) {
  if (!args[required]) throw new Error(`--${required} is required.`);
}

const serverUrl = args["server-url"] || "http://127.0.0.1:47831";
const adminKey = readFileSync(path.resolve(args["admin-key-file"]), "utf8").trim();
const keyFile = path.resolve(args["key-file"]);
const metadataFile = path.resolve(args["metadata-file"]);
const instance = args.instance;

function parseScopes(value) {
  if (!value) return ["capture:write"];
  const scopes = [...new Set(value.split(",").map((scope) => scope.trim()).filter(Boolean))];
  if (!scopes.length || scopes.some((scope) => !/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/u.test(scope))) {
    throw new Error("--scopes must be a comma-separated list such as resume:read,resume:confirm.");
  }
  return scopes;
}

if (command === "create") {
  for (const required of ["device", "agent", "expires-at"]) {
    if (!args[required]) throw new Error(`--${required} is required for create.`);
  }
  const result = await api({
    serverUrl,
    adminKey,
    method: "POST",
    endpoint: "/v1/agent-instances/register",
    body: {
      label: args.label || instance,
      device_id: args.device,
      agent_id: args.agent,
      agent_instance_id: instance,
      scopes: parseScopes(args.scopes),
      expires_at: args["expires-at"],
    },
  });
  writePrivate(keyFile, `${result.api_key}\n`);
  const metadata = {
    status: "created",
    credential_id: result.credential.credential_id,
    device_id: result.credential.device_id,
    agent_id: result.credential.agent_id,
    agent_instance_id: result.credential.agent_instance_id,
    scopes: result.credential.scopes,
    created_at: result.credential.created_at,
    expires_at: result.credential.expires_at,
    key_file_mode: "0600",
    api_key_in_output: false,
  };
  writePrivate(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(metadata)}\n`);
} else {
  const result = await api({
    serverUrl,
    adminKey,
    method: "POST",
    endpoint: `/v1/agent-instances/${encodeURIComponent(instance)}/revoke`,
  });
  rmSync(keyFile, { force: true });
  const metadata = {
    ...result,
    key_file_removed: true,
    api_key_in_output: false,
  };
  writePrivate(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(metadata)}\n`);
}
