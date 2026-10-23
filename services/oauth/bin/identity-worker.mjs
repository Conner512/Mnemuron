#!/usr/bin/env node
import {readPrivate,requireConfig} from '../../../shared/oauth-common.mjs';
import {acquireAuthorizationLease} from '../src/process-lease.mjs';
import {runIsolatedMaintenance} from '../src/isolated-maintenance.mjs';
const args=process.argv.slice(2);
let release;
try{
  requireConfig(args.length===3&&args[0]==='--config'&&args[2]==='--once','worker --config /private/worker.json --once');
  requireConfig(process.getuid()===0,'local privileged coordinator');
  const config=readPrivate(args[1],{json:true});release=acquireAuthorizationLease(args[1]);
  console.log(JSON.stringify(runIsolatedMaintenance(config)));
}catch{console.error(JSON.stringify({status:'failed',error_code:'IDENTITY_MAINTENANCE_INCOMPLETE'}));process.exitCode=1;}
finally{release?.();}
