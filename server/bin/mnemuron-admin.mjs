#!/usr/bin/env node

import { chmodSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { backup } from "node:sqlite";
import { MnemuronStore, SCOPE_DEFAULTS } from "../lib/store.mjs";

function usage() {
  return `Usage:
  mnemuron-admin bootstrap-admin [--label LABEL]
  mnemuron-admin register-agent --device ID --agent ID --instance ID [--label LABEL]
  mnemuron-admin seed-project --file FILE
  mnemuron-admin seed-task --file FILE
  mnemuron-admin revoke-agent --instance ID
  mnemuron-admin reconciliation-scopes --instance ID [--apply]
  mnemuron-admin task-bootstrap-scopes --instance ID [--apply]
  mnemuron-admin project-bootstrap-scopes --instance ID [--apply]
  mnemuron-admin prune
  mnemuron-admin memory-index --database EXISTING_FILE [--rebuild]
  mnemuron-admin backup --file FILE

Environment:
  MNEMURON_DATABASE_PATH   SQLite database path
  MNEMURON_ADMIN_API_KEY   Required for administrative commands after bootstrap
`;
}

function argsMap(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      result._.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) result[key] = true;
    else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

const args = argsMap(process.argv.slice(2));
const command = args._[0];
if (!command || args.help) {
  process.stdout.write(usage());
  process.exit(command ? 0 : 2);
}

if(command==='memory-index' && (typeof args.database!=='string' || !path.isAbsolute(args.database) || !statSync(args.database).isFile())) {
  throw new Error('memory-index requires an explicit absolute --database path to an existing SQLite file.');
}
const databasePath = path.resolve(command==='memory-index'?args.database:
  process.env.MNEMURON_DATABASE_PATH || "/var/lib/mnemuron/mnemuron.sqlite3");
const store = new MnemuronStore(databasePath, {
  defaultRetentionDays: process.env.MNEMURON_RAW_RETENTION_DAYS || "30",
});

try {
  let result;
  if (command === "bootstrap-admin") {
    result = store.bootstrapAdmin({ label: args.label || "Mnemuron admin" });
  } else {
    const adminKey = process.env.MNEMURON_ADMIN_API_KEY;
    if (!adminKey) throw new Error("MNEMURON_ADMIN_API_KEY is required.");
    const auth = store.authenticate(adminKey);
    if (command === "register-agent") {
      if (!args.device || !args.agent || !args.instance) {
        throw new Error("--device, --agent, and --instance are required.");
      }
      result = store.registerAgent(auth, {
        label: args.label || args.instance,
        device_id: args.device,
        agent_id: args.agent,
        agent_instance_id: args.instance,
        scopes: SCOPE_DEFAULTS.agent,
      });
    } else if (command === "seed-project") {
      if (!args.file) throw new Error("--file is required.");
      const parsed = JSON.parse(readFileSync(path.resolve(args.file), "utf8"));
      const projects = Array.isArray(parsed) ? parsed : [parsed];
      result = { projects: projects.map((project) => store.upsertProject(auth, project)) };
    } else if (command === "seed-task") {
      if (!args.file) throw new Error("--file is required.");
      const parsed = JSON.parse(readFileSync(path.resolve(args.file), "utf8"));
      const tasks = Array.isArray(parsed) ? parsed : [parsed];
      result = { tasks: tasks.map((task) => store.upsertTask(auth, task)) };
    } else if (command === "revoke-agent") {
      if (!args.instance) throw new Error("--instance is required.");
      result = store.revokeAgent(auth, args.instance);
    } else if (command === "reconciliation-scopes") {
      if (!args.instance) throw new Error("--instance is required.");
      result = store.updateReconciliationScopes(auth, args.instance, {
        apply: args.apply === true,
      });
    } else if (command === "task-bootstrap-scopes") {
      if (!args.instance) throw new Error("--instance is required.");
      result = store.updateTaskBootstrapScopes(auth, args.instance, {
        apply: args.apply === true,
      });
    } else if (command === "project-bootstrap-scopes") {
      if (!args.instance) throw new Error("--instance is required.");
      result = store.updateProjectBootstrapScopes(auth, args.instance, {
        apply: args.apply === true,
      });
    } else if (command === "prune") {
      result = store.pruneExpired(auth);
    } else if(command==='memory-index') {
      store.requireScope(auth,'admin:tasks');
      if(args.rebuild===true)store.memorySearch.rebuild();
      const valid=store.memorySearch.validate();
      result={...store.memorySearch.status(),valid,business_records_rewritten:false,startup_verification_may_rebuild:true};
      if(!valid)process.exitCode=1;
    } else if (command === "backup") {
      if (!args.file) throw new Error("--file is required.");
      const target = path.resolve(args.file);
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      await backup(store.db, target);
      chmodSync(target, 0o600);
      result = { status: "completed", backup_file: target };
    } else {
      throw new Error(`Unknown command: ${command}`);
    }
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  store.close();
}
