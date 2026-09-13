#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadGatewayConfig, loadIdentityMap } from "../src/config.mjs";
import { fetchJson, readPrivate, writePrivate, requireConfig, privateDirectory, CORE_SCOPES } from "../../../shared/oauth-common.mjs";

export async function provisionCore(config, adminFile) {
  requireConfig(config.mode === "oauth" && config.tool_profile === "readonly", "readonly provisioning configuration");
  const mapping = loadIdentityMap(config);
  requireConfig(mapping.enabled, "enabled owner mapping");
  requireConfig(!fs.existsSync(config.core.credential_file), "new credential destination (never overwrite or blindly retry)");
  privateDirectory(path.dirname(config.core.credential_file), { create: true });
  const admin = readPrivate(adminFile);
  const options = { timeoutMs: config.core.timeout_ms, maxBytes: 65536 };
  const identity = await fetchJson(`${config.core.base_url}/v1/identity`, { headers: { authorization: `Bearer ${admin}` } }, options);
  requireConfig(identity.status === 200 && identity.data.identity?.user_id === mapping.mnemuron_user_id
    && identity.data.scopes?.includes("admin:devices"), "administrator must own the mapped user");
  // This explicit command makes one registration attempt. An uncertain response requires operator reconciliation, never auto-retry.
  const result = await fetchJson(`${config.core.base_url}/v1/agent-instances/register`, {
    method: "POST", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
    body: JSON.stringify({ label: "ChatGPT Web read-only gateway", device_id: "chatgpt-web-gateway", agent_id: "chatgpt-web",
      agent_instance_id: mapping.agent_instance_id, scopes: CORE_SCOPES }),
  }, options);
  requireConfig(result.status === 201 && result.data.credential?.user_id === mapping.mnemuron_user_id
    && result.data.credential?.agent_instance_id === mapping.agent_instance_id
    && result.data.credential.scopes.length === CORE_SCOPES.length
    && CORE_SCOPES.every((scope) => result.data.credential.scopes.includes(scope))
    && typeof result.data.api_key === "string" && result.data.api_key.startsWith("mnm_"), "registration response contract");
  writePrivate(config.core.credential_file, result.data.api_key);
  return { provisioned: true, scopes: CORE_SCOPES };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--help")) {
    console.log("Explicit core credential creation (one write, no automatic retries):\nnode adapters/chatgpt-web/bin/provision-core.mjs --config /absolute/gateway.json --admin-file /private/admin-token --provision\nReconcile any uncertain registration with the administrator before repeating. Do not give the admin token to the running gateway.");
  } else {
    (async () => {
      const argv = process.argv.slice(2);
      requireConfig(argv.includes("--provision"), "explicit --provision command");
      const value = (key) => argv[argv.indexOf(key) + 1];
      const config = loadGatewayConfig(value("--config"), { isolated: argv.includes("--isolated-fixture") });
      console.log(JSON.stringify(await provisionCore(config, value("--admin-file"))));
    })().catch(() => { console.error("Provisioning did not complete cleanly. Inspect the agent registration locally before retrying. No credential is printed."); process.exitCode = 1; });
  }
}
