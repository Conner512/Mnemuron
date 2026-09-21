import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import {X509Certificate} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createPrivateIngress,validateIngressConfig} from '../src/private-ingress.mjs';

function certificates(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mnemuron-private-ingress-test-'));
  fs.chmodSync(dir,0o700);
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const run=args=>{
    const result=spawnSync('/usr/bin/openssl',args,{cwd:dir,encoding:'utf8'});
    assert.equal(result.status,0,'synthetic certificate generation failed');
  };
  run(['ecparam','-name','prime256v1','-genkey','-noout','-out','ca.key']);
  run(['req','-new','-x509','-sha256','-key','ca.key','-out','ca.pem','-days','1','-subj','/CN=Synthetic isolated CA']);
  for(const name of ['server','client','other']){
    run(['ecparam','-name','prime256v1','-genkey','-noout','-out',`${name}.key`]);
    run(['req','-new','-key',`${name}.key`,'-out',`${name}.csr`,'-subj',`/CN=${name}.example.test`]);
    fs.writeFileSync(path.join(dir,`${name}.ext`),`basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=${name==='server'?'serverAuth':'clientAuth'}\n${name==='server'?'subjectAltName=DNS:server.example.test\n':''}`,{mode:0o600});
    run(['x509','-req','-sha256','-in',`${name}.csr`,'-CA','ca.pem','-CAkey','ca.key','-set_serial',String({server:2,client:3,other:4}[name]),'-out',`${name}.pem`,'-days','1','-extfile',`${name}.ext`]);
  }
  for(const file of fs.readdirSync(dir))fs.chmodSync(path.join(dir,file),0o600);
  return {dir,read:name=>fs.readFileSync(path.join(dir,name))};
}

test('private ingress: mTLS, exact source and leaf pin, byte preservation and bounded shutdown',async t=>{
  const cert=certificates(t),requests=[];
  const origin=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=Buffer.concat(chunks).toString();
    requests.push({url:req.url,headers:req.headers,body});
    res.setHeader('set-cookie','synthetic=session; Secure; HttpOnly; SameSite=Lax');
    res.end(body||'synthetic login');
  });
  origin.listen(0,'127.0.0.1');await once(origin,'listening');
  t.after(()=>{origin.closeAllConnections();origin.close();});
  const base={listen_host:'127.0.0.1',listen_port:0,allowed_peer:'127.0.0.1',
    server_name:'server.example.test',upstream_port:origin.address().port,
    ca_file:path.join(cert.dir,'ca.pem'),cert_file:path.join(cert.dir,'server.pem'),key_file:path.join(cert.dir,'server.key'),
    client_fingerprint_sha256:new X509Certificate(cert.read('client.pem')).fingerprint256.replaceAll(':','').toLowerCase(),
    idle_timeout_ms:5000,shutdown_timeout_ms:100};
  const ingress=createPrivateIngress(base,{isolated:true});
  ingress.server.listen(0,'127.0.0.1');await once(ingress.server,'listening');
  t.after(()=>ingress.close());
  const request=(overrides={},body='',pauseResponseMs=0)=>new Promise((resolve,reject)=>{
    const req=https.request({host:'127.0.0.1',port:ingress.server.address().port,servername:'server.example.test',
      ca:cert.read('ca.pem'),cert:cert.read('client.pem'),key:cert.read('client.key'),agent:false,
      method:body?'POST':'GET',path:'/interaction/synthetic/login',
      headers:{host:'server.example.test',origin:'https://server.example.test',cookie:'synthetic=csrf',connection:'close'},
      timeout:3000,...overrides},res=>{
        const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));
        res.on('error',reject);
        if(pauseResponseMs){res.pause();setTimeout(()=>res.resume(),pauseResponseMs);}
      });req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('synthetic request timeout')));req.end(body);
  });
  await t.test('valid peer forwards bytes and security headers without rewriting',async()=>{
    const body='csrf=synthetic&value='+('memory-is-not-read-🙂'.repeat(16000));
    const response=await request({},body);
    assert.equal(response.status,200);assert.equal(response.body,body);
    assert.match(response.headers['set-cookie'][0],/Secure; HttpOnly; SameSite=Lax/);
    assert.equal(requests[0].headers.origin,'https://server.example.test');
    assert.equal(requests[0].headers.cookie,'synthetic=csrf');assert.equal(requests[0].url,'/interaction/synthetic/login');
  });
  for(const [name,overrides] of [
    ['missing client certificate',{cert:undefined,key:undefined}],
    ['same CA but wrong leaf',{cert:cert.read('other.pem'),key:cert.read('other.key')}],
    ['wrong SNI',{servername:'wrong.example.test',checkServerIdentity:()=>undefined}],
    ['missing SNI',{servername:'',checkServerIdentity:()=>undefined}],
    ['untrusted server CA',{ca:cert.read('other.pem')}],
  ])await t.test(name,async()=>{await assert.rejects(request(overrides));assert.equal(requests.length,1);});
  await t.test('wrong source is rejected before forwarding',async()=>{
    const denied=createPrivateIngress({...base,allowed_peer:'127.0.0.2'},{isolated:true});
    denied.server.listen(0,'127.0.0.1');await once(denied.server,'listening');
    try{await assert.rejects(request({port:denied.server.address().port}));assert.equal(requests.length,1);}finally{await denied.close();}
  });
  await t.test('production config rejects loopback, wildcards, public peers and non-loopback upstream',()=>{
    assert.throws(()=>validateIngressConfig(base));
    const syntheticPrivate=last=>[192,168,50,last].join('.');
    const production={...base,listen_host:syntheticPrivate(10),listen_port:47835,allowed_peer:syntheticPrivate(11)};
    assert.doesNotThrow(()=>validateIngressConfig(production));
    for(const change of [{listen_host:'0.0.0.0'},{allowed_peer:'8.8.8.8'},{upstream_host:syntheticPrivate(12)},
      {client_fingerprint_sha256:''},{server_name:'*'},{connection_limit:1000000}])assert.throws(()=>validateIngressConfig({...production,...change}));
  });
  await t.test('insecure key permissions fail closed',()=>{
    fs.chmodSync(base.key_file,0o644);
    try{assert.throws(()=>createPrivateIngress(base,{isolated:true}));}finally{fs.chmodSync(base.key_file,0o600);}
  });
  await t.test('connection limit and bounded drain include idle authenticated clients',async()=>{
    const limited=createPrivateIngress({...base,connection_limit:1},{isolated:true});
    limited.server.listen(0,'127.0.0.1');await once(limited.server,'listening');
    const peer=tls.connect({host:'127.0.0.1',port:limited.server.address().port,servername:'server.example.test',
      ca:cert.read('ca.pem'),cert:cert.read('client.pem'),key:cert.read('client.key')});
    peer.on('error',()=>{});
    try{
      await once(peer,'secureConnect');await assert.rejects(request({port:limited.server.address().port}));
      const started=Date.now();await limited.close();assert.ok(Date.now()-started<1500);
    }finally{peer.destroy();await limited.close();}
  });
  await t.test('slow reader receives the complete response when origin closes',async()=>{
    const body='synthetic-response-'.repeat(500000);
    const response=await request({},body,200);
    assert.equal(response.status,200);assert.ok(response.body===body,'all response bytes must drain before closure');
  });
  await t.test('unavailable origin never fabricates a successful response',async()=>{
    origin.closeAllConnections();await new Promise(resolve=>origin.close(resolve));
    await assert.rejects(request());
  });
  await t.test('shutdown closes the listener',async()=>{
    await ingress.close();assert.equal(ingress.server.listening,false);
  });
});
