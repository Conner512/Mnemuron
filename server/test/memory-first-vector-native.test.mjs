import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const read=name=>readFileSync(new URL('../../docs/memory-first-v0.1/'+name,import.meta.url),'utf8');
const unit=read('qdrant.service.example'),config=read('qdrant.native.example.yaml');

test('V-09: native backend example keeps authenticated loopback-only service boundaries',()=>{
  for(const pattern of [/host: 127\.0\.0\.1/,/http_port: 6333/,/grpc_port: null/,/telemetry_disabled: true/,
    /enable_cors: false/,/enable_snapshot_url_recovery: false/,/cluster:\s+enabled: false/])assert.match(config,pattern);
  assert.match(unit,/^EnvironmentFile=\/etc\/qdrant\/runtime\.env$/m);
  assert.doesNotMatch(config,/^\s*(?:api_key|read_only_api_key):/m);
});

test('V-09: native empty-key guard fails closed without starting a backend',()=>{
  const line=unit.split('\n').find(row=>row.startsWith('ExecStartPre='));
  assert.equal(line,`ExecStartPre=/bin/sh -c 'test -n "$$QDRANT__SERVICE__API_KEY"'`);
  const shell=line.slice("ExecStartPre=/bin/sh -c '".length,-1).replaceAll('$$','$');
  for(const value of [undefined,'','synthetic-key-for-offline-test']){
    const env=value===undefined?{}:{QDRANT__SERVICE__API_KEY:value};
    const result=spawnSync('/bin/sh',['-c',shell],{env,encoding:'utf8',timeout:2000});
    assert.equal(result.status,value?0:1);assert.equal(result.stdout,'');assert.equal(result.stderr,'');
  }
});

test('V-09: native service isolates storage and limits resources without enabling application integration',()=>{
  for(const expected of ['User=qdrant','Group=qdrant','UMask=0077','NoNewPrivileges=true','ProtectSystem=strict',
    'ProtectHome=true','PrivateTmp=true','PrivateDevices=true','ReadWritePaths=/var/lib/qdrant','CapabilityBoundingSet=',
    'MemoryHigh=1536M','MemoryMax=2G','CPUQuota=150%','TasksMax=256'])assert.ok(unit.split('\n').includes(expected));
  for(const directory of ['storage','snapshots','tmp'])assert.ok(config.includes('/var/lib/qdrant/'+directory));
  assert.doesNotMatch(unit+config,/mnemuron-server|memory\.runtime|worker-loop|cloudflared|docker|0\.0\.0\.0/);
});
