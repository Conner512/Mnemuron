import tls from 'node:tls';
import net from 'node:net';
import {pathToFileURL} from 'node:url';
import {readPrivate} from '../../../shared/oauth-common.mjs';

const privateIPv4=value=>net.isIPv4(value)&&(/^(10\.|192\.168\.)/.test(value)||/^172\.(1[6-9]|2\d|3[01])\./.test(value));
const integer=(value,min,max)=>Number.isInteger(value)&&value>=min&&value<=max;
export function validateIngressConfig(input,{isolated=false}={}){
  const c={connection_limit:128,handshake_timeout_ms:5000,connect_timeout_ms:3000,
    idle_timeout_ms:60000,shutdown_timeout_ms:5000,...input};
  const address=value=>privateIPv4(value)||(isolated&&/^127\./.test(value)&&net.isIPv4(value));
  if(!address(c.listen_host)||!address(c.allowed_peer)||!integer(c.listen_port,isolated?0:1024,65535)
    ||!integer(c.upstream_port,1024,65535)||c.upstream_host!==undefined
    ||!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/.test(c.server_name||'')
    ||!/^[a-f0-9]{64}$/.test(c.client_fingerprint_sha256||'')
    ||!integer(c.connection_limit,1,1024)
    ||!integer(c.handshake_timeout_ms,100,10000)||!integer(c.connect_timeout_ms,100,10000)
    ||!integer(c.idle_timeout_ms,1000,120000)||!integer(c.shutdown_timeout_ms,100,10000))
    throw new Error('PRIVATE_INGRESS_CONFIG_INVALID');
  return c;
}

// Transport only: the loopback authorization server still owns Host/Origin,
// cookies, MFA, CSRF and OAuth policy. No identity headers are manufactured here.
export function createPrivateIngress(input,{isolated=false}={}){
  const config=validateIngressConfig(input,{isolated}),connections=new Set();
  const server=tls.createServer({key:readPrivate(config.key_file),cert:readPrivate(config.cert_file),
    ca:readPrivate(config.ca_file),minVersion:'TLSv1.3',maxVersion:'TLSv1.3',
    requestCert:true,rejectUnauthorized:true,handshakeTimeout:config.handshake_timeout_ms,
    ALPNProtocols:['http/1.1']},socket=>{
    const fingerprint=socket.getPeerCertificate().fingerprint256?.replaceAll(':','').toLowerCase();
    if(!socket.authorized||socket.remoteAddress!==config.allowed_peer||socket.servername!==config.server_name
      ||fingerprint!==config.client_fingerprint_sha256){socket.destroy();return;}
    socket.pause();
    const upstream=net.createConnection({host:'127.0.0.1',port:config.upstream_port});
    const timer=setTimeout(()=>{socket.destroy();upstream.destroy();},config.connect_timeout_ms);
    timer.unref();
    socket.setTimeout(config.idle_timeout_ms,()=>socket.destroy());
    upstream.setTimeout(config.idle_timeout_ms,()=>upstream.destroy());
    socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());
    socket.on('close',()=>{clearTimeout(timer);upstream.destroy();});
    upstream.on('close',()=>{clearTimeout(timer);socket.destroy();});
    upstream.once('connect',()=>{clearTimeout(timer);socket.pipe(upstream);upstream.pipe(socket);socket.resume();});
  });
  server.on('connection',socket=>{
    if(socket.remoteAddress!==config.allowed_peer||connections.size>=config.connection_limit){socket.destroy();return;}
    connections.add(socket);socket.once('close',()=>connections.delete(socket));
  });
  // Do not log peer certificates, request bytes, cookies or TLS error objects.
  server.on('tlsClientError',()=>{});
  let closing;
  const close=()=>closing??=new Promise(resolve=>{
    if(!server.listening){for(const socket of connections)socket.destroy();resolve();return;}
    const timeout=setTimeout(()=>{for(const socket of connections)socket.destroy();},config.shutdown_timeout_ms);
    timeout.unref();server.close(()=>{clearTimeout(timeout);resolve();});
  });
  return {server,config,close};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const ingress=createPrivateIngress(readPrivate(process.argv[2],{json:true}));
    ingress.server.on('error',()=>{process.stderr.write('PRIVATE_INGRESS_UNAVAILABLE\n');process.exitCode=1;ingress.close();});
    ingress.server.listen(ingress.config.listen_port,ingress.config.listen_host);
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{ingress.close();});
  }catch{process.stderr.write('PRIVATE_INGRESS_START_FAILED\n');process.exitCode=1;}
}
