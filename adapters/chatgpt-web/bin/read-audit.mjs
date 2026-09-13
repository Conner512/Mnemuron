#!/usr/bin/env node
import {createInterface} from 'node:readline';
import {projectAudit} from '../src/read-audit.mjs';

const args=process.argv.slice(2),options={limit:20};
try {
  if(args.includes('--help')) {
    console.log('Usage: read-audit [--memory ID] [--request ID] [--connection HASH] [--limit 1..100]\nRead private gateway JSONL or journalctl -o json from stdin. Output contains metadata only; no database, network or write access.');
    process.exit(0);
  }
  for(let i=0;i<args.length;i+=2) {
    const key=args[i].slice(2),value=args[i+1];
    if(!['memory','request','connection','limit'].includes(key) || value===undefined || !args[i].startsWith('--'))throw Error();
    if(key==='limit') {if(!/^[0-9]+$/.test(value) || Number(value)<1 || Number(value)>100)throw Error();options.limit=Number(value);}
    else {if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value))throw Error();options[key]=value;}
  }
  const records=[];let ignored=0,matched=0;
  for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
    try {
      if(Buffer.byteLength(line)>128*1024)throw Error();
      let parsed=JSON.parse(line);if(typeof parsed.MESSAGE==='string')parsed=JSON.parse(parsed.MESSAGE);
      const record=projectAudit(parsed);if(!record)throw Error();
      if(options.memory && !record.read?.memory_refs.some(r=>r.memory_id===options.memory))continue;
      if(options.request && record.request_id!==options.request)continue;
      if(options.connection && record.connection_id!==options.connection)continue;
      matched++;records.push(record);if(records.length>options.limit)records.shift();
    }catch{ignored++;}
  }
  console.log(JSON.stringify({records,matched_records:matched,ignored_lines:ignored,truncated:matched>records.length,
    ordering:'last_matching_input_records',content_returned:false,physical_device_verified:false},null,2));
}catch{console.error('Audit inspection refused. Check the supported filters and bounded limit.');process.exitCode=2;}
