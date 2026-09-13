#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { loadAuthConfig, loadAuthSecrets } from "../src/config.mjs";
import { Accounts, createOwner } from "../src/accounts.mjs";
import { AuthStore } from "../src/sqlite-adapter.mjs";
import { readPrivate, writePrivate, randomSecret, requireConfig } from "../../../shared/oauth-common.mjs";

const help = `Mnemuron OAuth local administrator (no public admin API)
Usage: node services/oauth/bin/admin.mjs COMMAND --config /absolute/auth.runtime.json [options]

  init-secrets              Create persistent signing, cookie and two separate client secrets; never overwrite
  owner-create              --username NAME [--password-file PRIVATE_FILE]; otherwise prompt without echo
  owner-enrollment          --output PRIVATE_FILE; write the sensitive authenticator URI locally
  owner-enroll-mfa          --recovery-output PRIVATE_FILE [--otp-file PRIVATE_FILE]
  owner-disable            Disable the owner and revoke all their grants and browser sessions
  owner-enable             Re-enable an owner only after verified MFA; revoked grants remain invalid
  owner-reset-mfa           --recovery-code-file PRIVATE_FILE; consume one recovery code, revoke and re-enroll
  grant-revoke             --all OR --subject SUB OR --client-id ID; also clears browser login sessions
  status                   Verify configuration, secrets, owner and database; never print secrets

--isolated-fixture accepts literal HTTP loopback only. It never bypasses password or MFA.
Secret contents are never accepted as command-line arguments. Domain/callback files are operator-supplied.
`;

export function initializeSecrets(config) {
  const targets = [config.private_jwks_file, config.cookie_keys_file, config.chatgpt_client.client_secret_file, config.introspection_client.client_secret_file];
  requireConfig(new Set(targets).size === targets.length && targets.every((file) => typeof file === "string" && !fs.existsSync(file)), "new, distinct secret destinations");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
  writePrivate(config.private_jwks_file, { keys: [{ ...privateKey.export({ format: "jwk" }), alg: "RS256", use: "sig", kid: randomSecret() }] });
  writePrivate(config.cookie_keys_file, [randomSecret(), randomSecret()]);
  writePrivate(config.chatgpt_client.client_secret_file, randomSecret());
  writePrivate(config.introspection_client.client_secret_file, randomSecret());
}

async function promptSecret(label) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Use a protected input file in non-interactive mode");
  let muted = false;
  const output = new Writable({ write(chunk, _encoding, done) { if (!muted) process.stdout.write(chunk); done(); } });
  const reader = createInterface({ input: process.stdin, output, terminal: true });
  process.stdout.write(label);
  muted = true;
  try { return await reader.question(""); } finally { reader.close(); process.stdout.write("\n"); }
}

export async function main(argv) {
  if (!argv.length || argv.includes("--help")) { console.log(help); return; }
  const command = argv[0];
  const args = new Map();
  for (let index = 1; index < argv.length; index++) {
    const name = argv[index];
    requireConfig(name.startsWith("--") && !args.has(name), "CLI arguments");
    args.set(name, ["--all", "--isolated-fixture"].includes(name) ? true : argv[++index]);
  }
  const config = loadAuthConfig(args.get("--config"), { isolated: args.has("--isolated-fixture") });
  const input = (name, label) => args.has(name) ? readPrivate(args.get(name)) : promptSecret(label);
  if (command === "init-secrets") {
    initializeSecrets(config);
    console.log("Created four separate persistent secrets. Configure the client secret in ChatGPT locally; do not paste it into a conversation.");
    return;
  }
  if (command === "owner-create") {
    const password = await input("--password-file", "New Mnemuron password: ");
    if (!args.has("--password-file")) requireConfig(password === await promptSecret("Repeat password: "), "password confirmation");
    const result = await createOwner(config.accounts_file, args.get("--username"), password);
    console.log(JSON.stringify(result));
    return;
  }
  if (command === "status") requireConfig(fs.existsSync(config.database_file), "authorization database has not been initialized");
  const store = new AuthStore(config.database_file);
  try {
    const accounts = new Accounts(config.accounts_file, store);
    switch (command) {
      case "owner-enrollment": writePrivate(args.get("--output"), accounts.enrollmentUri()); console.log("Authenticator enrollment URI written to the private output file."); break;
      case "owner-enroll-mfa": await accounts.enroll(await input("--otp-file", "Authenticator code: "), args.get("--recovery-output")); console.log("MFA verified. Recovery codes were written once to the private recovery output."); break;
      case "owner-disable": console.log(JSON.stringify({ disabled: true, revoked_grants: accounts.disable() })); break;
      case "owner-enable": {
        const owner = accounts.read(); owner.enabled = true; writePrivate(config.accounts_file, owner, { replace: true });
        console.log("Owner enabled. Previous grants remain revoked."); break;
      }
      case "owner-reset-mfa": console.log(JSON.stringify({ mfa_reset: true, revoked_grants: accounts.resetMfa(readPrivate(args.get("--recovery-code-file"))) })); break;
      case "grant-revoke": console.log(JSON.stringify({ revoked_grants: store.revoke({ all: args.has("--all"), subject: args.get("--subject"), clientId: args.get("--client-id") }) })); break;
      case "status": {
        loadAuthSecrets(config); const owner = accounts.read({ requireMfa: false });
        console.log(JSON.stringify({ mode: config.mode, storage_ready: store.ready(), owner_enabled: owner.enabled, mfa_verified: owner.mfa.verified,
          grants: store.summary(), production_ready: false })); break;
      }
      default: throw new Error("Unknown command; use --help");
    }
  } finally { store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => { console.error("Operation refused. Check the command, configuration and private file permissions; no secret values are printed."); process.exitCode = 1; });
}
