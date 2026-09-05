import copy
import json
import multiprocessing
import socket
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from adapters.hermes.sync_protocol import (request_json, retry_state, failure, flush_queue,
    queue_items, queue_summary, immutable_envelope, validate_acceptance)


def accept(item):
    return {'status':'accepted','received':1,'inserted':1,'duplicate':0,'accepted_event_ids':[item['payload']['event']['event_id']]}


def flush_worker(directory, hold, connection):
    root=Path(directory)
    def send(item):
        connection.send('sending')
        if hold: connection.recv()
        return accept(item)
    connection.send(flush_queue(queue_items(root/'outbox','event'),root=root,credential='test',send=send))


class SyncReliabilityTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='mnemuron-core-test-python-')
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.outbox=self.root/'outbox'

    def enqueue(self, id, lane='a', at='2026-01-01T00:00:00Z'):
        file=self.outbox/(id+'.json')
        immutable_envelope(file, {'event':{'event_id':id,'session_id':lane,'captured_at':at,'content':'SENSITIVE-BODY'}})
        return file

    def test_shared_vectors_and_persisted_retry_after(self):
        vectors=json.loads((Path(__file__).resolve().parents[3]/'server/test/helpers/sync-contract-vectors.json').read_text())
        for case in vectors['vectors']:
            with self.subTest(case=case):
                state=retry_state(failure(case['code'],case['status'],case.get('retry_after')),now=vectors['now'],rng=lambda:1)
                self.assertEqual((state['state'],state['next_retry_at']),(case['state'],case['next_retry_at']))
        for index,value in enumerate(['600','Thu, 01 Jan 2026 00:10:00 GMT','invalid']):
            root=self.root/str(index);(root/'outbox').mkdir(parents=True)
            file=root/'outbox/item.json';immutable_envelope(file,{'event':{'event_id':'item','session_id':'a'}})
            raw=file.read_bytes();calls=[]
            def send(item):
                calls.append(1)
                raise failure('HTTP_429',429,value)
            flush_queue(queue_items(root/'outbox','event'),root=root,credential='test',send=send,now=lambda:vectors['now'],rng=lambda:1)
            # Re-discover from disk, as after a process restart; no early retry.
            result=flush_queue(queue_items(root/'outbox','event'),root=root,credential='test',send=accept,now=lambda:vectors['now']+500)
            self.assertEqual(result['flushed'],0);self.assertEqual(file.read_bytes(),raw)
            self.assertEqual(json.loads(Path(str(file)+'.state').read_text())['attempt_count'],1)

    def test_auth_pause_bad_lane_and_original_envelope(self):
        first=self.enqueue('first');raw=first.read_bytes();self.enqueue('other','b')
        calls=[]
        def unauthorized(item):
            calls.append(1);raise failure('HTTP_401',401)
        run=lambda send,key='test':flush_queue(queue_items(self.outbox,'event'),root=self.root,credential=key,send=send)
        run(unauthorized);run(unauthorized);self.assertEqual(len(calls),1)
        self.assertEqual(first.read_bytes(),raw);self.assertEqual(run(accept,'rotated')['flushed'],2)
        self.enqueue('bad');self.enqueue('dependent','a','2026-01-01T00:00:01Z');self.enqueue('healthy','b')
        def reject(item):
            if item['payload']['event']['event_id']=='bad': raise failure('REQUEST_BODY_TOO_LARGE',413)
            return accept(item)
        result=run(reject,'rotated');self.assertEqual(result['flushed'],1);self.assertEqual(result['quarantined'],1)
        self.assertEqual(queue_summary(queue_items(self.outbox,'event'))['counts']['blocked_gap'],1)
        self.assertTrue((self.outbox/'bad.json').exists())
        with self.assertRaises(RuntimeError): immutable_envelope(self.outbox/'bad.json',{'different':'intent'})
        corrupt=self.enqueue('corrupt','c');Path(str(corrupt)+'.state').write_text('BROKEN')
        run(accept,'rotated');self.assertEqual(Path(str(corrupt)+'.state').read_text(),'BROKEN')
        self.assertNotIn('SENSITIVE',json.dumps(queue_summary(queue_items(self.outbox,'event'))))

    def test_network_deadline_status_and_no_redirect_forward(self):
        hits=[]
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_GET(self):
                hits.append(self.path)
                try:
                    if self.path=='/reset': self.connection.shutdown(socket.SHUT_RDWR);self.connection.close();return
                    if self.path=='/redirect': self.send_response(302);self.send_header('Location',f'http://127.0.0.1:{self.server.server_port}/never');self.end_headers();return
                    if self.path=='/large': self.send_response(200);self.end_headers();self.wfile.write(b'x'*(2*1024*1024+1));return
                    if self.path=='/drip':
                        self.send_response(200);self.end_headers();self.wfile.write(b'{');self.wfile.flush()
                        for _ in range(200): self.wfile.write(b' ');self.wfile.flush();time.sleep(.015)
                        return
                    self.send_response(int(self.path[1:]));self.send_header('Retry-After','60');self.end_headers();self.wfile.write(b'<html>SECRET PROXY BODY</html>')
                except (OSError,BrokenPipeError): pass
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        request=lambda endpoint:request_json(urllib.request.Request(f'http://127.0.0.1:{server.server_port}'+endpoint,headers={'Authorization':'Bearer synthetic-only'}),.25)
        for status in (401,429,503):
            with self.assertRaises(RuntimeError) as caught: request('/'+str(status))
            self.assertEqual(caught.exception.status_code,status);self.assertNotIn('SECRET',str(caught.exception))
        for endpoint in ('/redirect','/large','/reset','/drip'):
            start=time.monotonic()
            with self.assertRaises(RuntimeError): request(endpoint)
            self.assertLess(time.monotonic()-start,1.2)
        self.assertNotIn('/never',hits)
        original_resolver=socket.getaddrinfo
        def slow_resolver(*args,**kwargs):
            time.sleep(.7)
            return original_resolver(*args,**kwargs)
        with patch('socket.getaddrinfo',slow_resolver):
            start=time.monotonic()
            with self.assertRaises(RuntimeError) as caught: request('/200')
            self.assertEqual(caught.exception.error_code,'TOTAL_TIMEOUT')
            self.assertLess(time.monotonic()-start,.6)
        self.assertNotIn('/200',hits)

    def test_exact_injection_response_and_false_acceptance(self):
        payload={'attempt_id':'attempt','event_id':'event','preview_version':1,'session_id':'a','turn_id':'turn-a','workstream_id':'w','occurred_at':'2026-01-01T00:00:00Z','phase':'acknowledged'}
        item={'resume_id':'resume','payload':payload}
        correct={'event_id':'event','inserted':1,'duplicate':0,'delivery':{'resume_id':'resume','preview_version':1,'attempts':[{'attempt_id':'attempt','session_id':'a','turn_id':'turn-a','workstream_id':'w','acknowledged_at':payload['occurred_at'],'event_ids':['event'],'ack_complete':True}]}}
        validate_acceptance('injection',item,correct)
        for field in ('attempt_id','session_id','turn_id','workstream_id','acknowledged_at'):
            bad=copy.deepcopy(correct);bad['delivery']['attempts'][0][field]='wrong'
            with self.assertRaises(RuntimeError): validate_acceptance('injection',item,bad)
        directory=self.root/'injection';file=directory/'receipt.json';immutable_envelope(file,item)
        result=flush_queue(queue_items(directory,'injection'),root=self.root,credential='test',send=lambda _: {'ok':True})
        self.assertEqual(result['flushed'],0);self.assertTrue(file.exists())
        self.assertEqual(queue_summary(queue_items(directory,'injection'))['counts']['blocked_reconciliation'],1)

    def test_two_process_flush_and_dead_owner_recovery(self):
        self.enqueue('event')
        context=multiprocessing.get_context('spawn');parent,child=context.Pipe()
        owner=context.Process(target=flush_worker,args=(str(self.root),True,child));owner.start()
        self.addCleanup(lambda: owner.kill() if owner.is_alive() else None)
        self.assertTrue(parent.poll(3));self.assertEqual(parent.recv(),'sending')
        competitor,worker=context.Pipe();other=context.Process(target=flush_worker,args=(str(self.root),False,worker));other.start()
        self.assertTrue(competitor.poll(3));self.assertEqual(competitor.recv()['flushed'],0);other.join(3)
        owner.kill();owner.join(3)
        result=flush_queue(queue_items(self.outbox,'event'),root=self.root,credential='test',send=accept)
        self.assertEqual(result['flushed'],1);self.assertFalse((self.outbox/'event.json').exists())
