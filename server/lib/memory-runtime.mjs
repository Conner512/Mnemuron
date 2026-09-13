import { readFileSync } from 'node:fs';
import { storageDoctor, SOURCE_ROOT } from './storage-policy.mjs';
import { ValidationError } from './errors.mjs';
import {validateProfile,strictObject,integer} from './model-providers/contracts.mjs';
import {vectorConfig} from './vector-stores/qdrant.mjs';

export function memoryRuntime(input) {
  if (input === undefined || input === null) return { version:'memory-first-v1', legacy:true,
    memory:true, handoff:true, captureExtraction:true, deploymentMode:'production', syntheticData:false,
    notice:'Legacy handoff behavior retained; explicitly configure modules before switching to memory-only.' };
  if (typeof input !== 'object' || Array.isArray(input) || input.config_version !== 'mnemuron-memory-first-v1') throw new ValidationError('Invalid memory runtime config.', 'INVALID_MEMORY_CONFIG');
  const object=value=>value!==null && typeof value==='object' && !Array.isArray(value);
  for(const key of ['modules','storage','memory','privacy','providers','vector_store','jobs','development']) {
    if(Object.hasOwn(input,key) && !object(input[key]))throw new ValidationError('Invalid configuration section.','INVALID_MEMORY_CONFIG');
  }
  if(input.development?.synthetic_data!==undefined && typeof input.development.synthetic_data!=='boolean')throw new ValidationError('Invalid synthetic data flag.','INVALID_MEMORY_CONFIG');
  if(input.deployment_mode!==undefined && !['production','test','development'].includes(input.deployment_mode))throw new ValidationError('Invalid deployment mode.','INVALID_MEMORY_CONFIG');
  for (const name of ['memory','handoff']) if (typeof input.modules?.[name]?.enabled !== 'boolean') throw new ValidationError('Explicit module flags are required.', 'INVALID_MEMORY_CONFIG');
  if (input.modules.handoff.existing_inflight_policy !== 'drain_before_disable') throw new ValidationError('Existing handoff must drain.', 'INVALID_DRAIN_POLICY');
  if (input.storage?.reject_private_paths_inside_git_worktree !== undefined && input.storage.reject_private_paths_inside_git_worktree !== true) throw new ValidationError('Storage isolation cannot be disabled.', 'INVALID_STORAGE_POLICY');
  try {
    const synthetic=input.deployment_mode==='test' && input.development?.synthetic_data===true;
    strictObject(input.providers || {},['organizer','embedder']);
    for(const kind of ['organizer','embedder'])if(input.providers?.[kind])validateProfile(input.providers[kind],{kind,synthetic});
    if(input.vector_store)vectorConfig(input.vector_store);
    if(input.vector_store?.enabled && !input.providers?.embedder?.enabled)throw new Error('missing embedding');
    if(input.jobs){strictObject(input.jobs,['enabled','lease_ms','concurrency','batch_size','timezone','periods','poll_ms']);
      if(typeof input.jobs.enabled!=='boolean')throw new Error('invalid jobs');
      for(const [key,min,max] of [['lease_ms',100,600000],['concurrency',1,16],['batch_size',1,128],['poll_ms',1000,3600000]])if(input.jobs[key]!==undefined)integer(input.jobs[key],min,max);
      if(input.jobs.timezone!==undefined){if(typeof input.jobs.timezone!=='string' || !input.jobs.timezone.length)throw new Error('invalid timezone');new Intl.DateTimeFormat('en',{timeZone:input.jobs.timezone});}
      if(input.jobs.periods!==undefined && (!Array.isArray(input.jobs.periods) || !input.jobs.periods.length || input.jobs.periods.length>2 || new Set(input.jobs.periods).size!==input.jobs.periods.length || input.jobs.periods.some(p=>!['daily','weekly'].includes(p))))throw new Error('invalid periods');
    }
    for(const key of ['capture_extraction','retrieval'])if(Object.hasOwn(input.memory || {},key) && !object(input.memory[key]))throw new Error('invalid memory section');
    if(input.memory?.retrieval?.mode!==undefined && !['lexical','hybrid','semantic'].includes(input.memory.retrieval.mode))throw new Error('invalid retrieval');
  }catch{throw new ValidationError('Invalid model, vector or worker configuration.', 'INVALID_MEMORY_CONFIG');}
  for(const [section,key,value] of [[input.memory,'automatic_fact_overwrite',false],[input.memory,'preserve_atomic_records',true],[input.privacy,'include_body_in_logs',false],[input.privacy,'automatic_export',false]]){
    if(section?.[key]!==undefined && section[key]!==value)throw new ValidationError('Unsafe memory policy.','INVALID_MEMORY_CONFIG');
  }
  if (input.memory?.capture_extraction?.enabled !== undefined && typeof input.memory.capture_extraction.enabled !== 'boolean') throw new ValidationError('Invalid capture flag.', 'INVALID_MEMORY_CONFIG');
  return { version:'memory-first-v1', legacy:false, memory:input.modules.memory.enabled, handoff:input.modules.handoff.enabled,
    captureExtraction:input.memory?.capture_extraction?.enabled === true,
    deploymentMode:input.deployment_mode || 'production', syntheticData:input.development?.synthetic_data === true,
    organizerConfigured:input.providers?.organizer?.enabled===true,embedderConfigured:input.providers?.embedder?.enabled===true,
    vectorConfigured:input.vector_store?.enabled===true,workerConfigured:input.jobs?.enabled===true };
}

export function privateStoragePaths(config = {}, databasePath, configPath) {
  config ||= {};
  const paths = { sqlite_path:databasePath, runtime_config:configPath };
  for (const [field, value] of Object.entries(config.storage || {})) {
    if (field.endsWith('_dir') || field.endsWith('_path')) paths[field] = value;
  }
  paths.sqlite_path = databasePath;
  paths.taxonomy_file = config.memory?.taxonomy_file;
  const references = (value, prefix = '') => {
    for (const [key, child] of Object.entries(value || {})) {
      if (key.endsWith('_file') || key.endsWith('_dir') || key.endsWith('_path')) paths[prefix + key] = child;
      else if (child && typeof child === 'object' && !Array.isArray(child)) references(child, prefix + key + '.');
    }
  };
  references(config.providers, 'providers.'); references(config.vector_store, 'vector_store.'); references(config.jobs, 'jobs.');
  return paths;
}

export function loadMemoryRuntimeFile(filename) {
  // No config bytes are read before the path passes the production boundary.
  storageDoctor({runtime_config:filename}, {sourceRoots:[SOURCE_ROOT]});
  let input;
  try { input = JSON.parse(readFileSync(filename, 'utf8')); }
  catch { throw new ValidationError('Memory runtime config cannot be read or parsed.', 'INVALID_MEMORY_CONFIG'); }
  memoryRuntime(input);
  storageDoctor(privateStoragePaths(input,input.storage?.sqlite_path,filename),{sourceRoots:[SOURCE_ROOT],...memoryRuntime(input)});
  return input;
}
