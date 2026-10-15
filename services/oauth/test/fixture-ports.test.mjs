import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import {once} from 'node:events';
import {freePort,listen,close} from './fixture.mjs';
test('Fixture ports remain reserved until their actual listener is ready',async t=>{
 const port=await freePort(),competitor=net.createServer();
 const rejected=once(competitor,'error');competitor.listen(port,'127.0.0.1');
 assert.equal((await rejected)[0].code,'EADDRINUSE');
 const actual=http.createServer((req,res)=>res.end('synthetic-ready'));await listen(actual,port);t.after(()=>close(actual));
 assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(),'synthetic-ready');
});
