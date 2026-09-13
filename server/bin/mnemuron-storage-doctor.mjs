#!/usr/bin/env node
import path from 'node:path';
import { loadMemoryRuntimeFile, memoryRuntime, privateStoragePaths } from '../lib/memory-runtime.mjs';
import { storageDoctor } from '../lib/storage-policy.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--config') throw new Error('usage: mnemuron-storage-doctor --config ABSOLUTE_CONFIG_FILE');
  const configPath = args[1];
  if (!path.isAbsolute(configPath)) throw new Error('An absolute config path is required.');
  const config = loadMemoryRuntimeFile(configPath), runtime = memoryRuntime(config);
  if (!config.storage?.sqlite_path) throw new Error('storage.sqlite_path is required.');
  const result = storageDoctor(privateStoragePaths(config, config.storage?.sqlite_path, configPath), runtime);
  console.log(JSON.stringify({...result, credentials_read:false, database_opened:false}));
} catch (error) { console.error(JSON.stringify({status:'failed',error_code:error.errorCode || 'INVALID_CONFIG',data_read:false})); process.exitCode=1; }
