"""Stdlib transport and durable retry contract shared semantically with the JS adapters."""
import hashlib
import http.client
import json
import math
import os
import queue as result_queue
import random
import re
import socket
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

RESPONSE_LIMIT = 2 * 1024 * 1024
_DNS_SLOTS = threading.BoundedSemaphore(8)

def failure(code, status=None, retry_after=None):
    error = RuntimeError(f"Mnemuron transport: {code}")
    error.error_code, error.status_code, error.retry_after = code, status, retry_after
    return error

class _DeadlineConnection:
    def _connect_resolved(self, address, timeout, source_address=None):
        # OS name resolution has no cancellable timeout. Bound its wait and the
        # number of outstanding daemon workers; late answers never open sockets.
        if not _DNS_SLOTS.acquire(blocking=False): raise failure('RESOLVER_BUSY')
        results = result_queue.Queue(maxsize=1)
        def resolve():
            try: results.put((socket.getaddrinfo(*address, 0, socket.SOCK_STREAM), None))
            except Exception as error: results.put((None, error))
            finally: _DNS_SLOTS.release()
        threading.Thread(target=resolve,daemon=True).start()
        try: addresses, error = results.get(timeout=max(.001,self._deadline-time.monotonic()))
        except result_queue.Empty: raise failure('TOTAL_TIMEOUT')
        if error: raise error
        last = None
        for family, kind, protocol, _, target in addresses:
            remaining=self._deadline-time.monotonic()
            if remaining <= 0 or self._expired: raise failure('TOTAL_TIMEOUT')
            sock=socket.socket(family,kind,protocol);self._deadline_socket=sock
            try:
                sock.settimeout(remaining)
                if source_address: sock.bind(source_address)
                sock.connect(target)
                remaining=self._deadline-time.monotonic()
                if remaining<=0: raise failure('TOTAL_TIMEOUT')
                sock.settimeout(remaining)
                return sock
            except Exception as error:
                sock.close();last=error
        if last: raise last
        raise failure('NETWORK_ERROR')

    def getresponse(self):
        try:
            response = super().getresponse()
            response._mnemuron_timer = self._timer
            response._mnemuron_expired = lambda: self._expired
            return response
        except Exception:
            if hasattr(self, '_timer'): self._timer.cancel()
            raise

    def connect(self):
        self._expired = False
        self._deadline_socket = None
        self._deadline = time.monotonic()+self.timeout
        self._create_connection = self._connect_resolved
        def expire():
            self._expired = True
            sock = self.sock or self._deadline_socket
            if sock:
                try: sock.shutdown(socket.SHUT_RDWR)
                except OSError: pass
        self._timer = threading.Timer(self.timeout, expire)
        self._timer.daemon = True
        self._timer.start()
        super().connect()
        self._deadline_socket = self.sock
        if self._expired:
            self.sock.close()
            raise failure("TOTAL_TIMEOUT")

class _HTTPConnection(_DeadlineConnection, http.client.HTTPConnection): pass
class _HTTPSConnection(_DeadlineConnection, http.client.HTTPSConnection): pass
class _HTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, request): return self.do_open(_HTTPConnection, request)
class _HTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, request): return self.do_open(_HTTPSConnection, request, context=self._context)
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None

def request_json(request, timeout):
    opener = urllib.request.build_opener(_HTTPHandler(), _HTTPSHandler(), _NoRedirect())
    try:
        response = opener.open(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        response = error
    except (OSError, urllib.error.URLError, http.client.HTTPException) as error:
        raise failure('NETWORK_ERROR') from error
    try:
        with response:
            content = response.read(RESPONSE_LIMIT + 1)
            if getattr(response, '_mnemuron_expired', lambda: False)(): raise failure('TOTAL_TIMEOUT')
            if len(content) > RESPONSE_LIMIT: raise failure("RESPONSE_TOO_LARGE", response.code)
            try: data = json.loads(content.decode("utf-8"))
            except (ValueError, UnicodeError): data = None
            status = response.code
            if not 200 <= status < 300:
                code = data.get("error_code") if isinstance(data, dict) else None
                error = failure(code if isinstance(code, str) and re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}', code) else ("REDIRECT_BLOCKED" if 300 <= status < 400 else f"HTTP_{status}"), status, response.headers.get("Retry-After"))
                error.response_data = data
                raise error
            if not isinstance(data, dict): raise failure("INVALID_RESPONSE_JSON", status)
            return data
    except (TimeoutError, OSError, http.client.HTTPException) as error:
        raise failure("NETWORK_ERROR") from error
    finally:
        timer = getattr(response, '_mnemuron_timer', None)
        if timer: timer.cancel()

def retry_state(error, previous=None, *, now=None, rng=random.random, credential=""):
    now = time.time() * 1000 if now is None else now
    previous = previous or {}
    status = getattr(error, "status_code", None)
    code = getattr(error, "error_code", "NETWORK_ERROR")
    count = previous.get("attempt_count", 0) + 1
    iso = lambda value: datetime.fromtimestamp(value / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    state = {**previous, "attempt_count": count, "last_error_code": code, "last_http_status": status,
             "first_failed_at": previous.get("first_failed_at") or iso(now), "next_retry_at": None, "credential_fingerprint": credential}
    if status in (401, 403): state["state"] = "paused_auth"
    elif status == 409 or code == "RECEIPT_MISMATCH": state["state"] = "blocked_reconciliation"
    elif status == 413 or (status in (400, 422) and code in ("INVALID_PAYLOAD", "CONTENT_TOO_LONG", "SCOPE_MISMATCH", "INVALID_MEMORY_SCOPE", "REQUEST_BODY_TOO_LARGE")): state["state"] = "quarantined"
    elif code in ("RESPONSE_TOO_LARGE", "INVALID_RESPONSE_JSON", "REDIRECT_BLOCKED") or (status and status < 500 and status != 429): state["state"] = "blocked_protocol"
    else:
        state["state"] = "retry_wait"
        delay = min(300000, 1000 * 2 ** min(count - 1, 18)) * (0.5 + rng() * 0.5)
        if status == 429:
            value = getattr(error, "retry_after", None)
            try: until = now + float(value) * 1000
            except (ValueError, TypeError):
                try: until = parsedate_to_datetime(value).timestamp() * 1000
                except (ValueError, TypeError, OverflowError): until = now
            if math.isfinite(until) and now < until < 253402300799000: delay = max(delay, until - now)
        state["next_retry_at"] = iso(now + delay)
    return state

def atomic(file, value):
    temporary = file.with_name(file.name + "." + str(uuid.uuid4()) + ".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, file)

def immutable_envelope(file, value):
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    content = (json.dumps(value, ensure_ascii=False, sort_keys=True) + '\n').encode()
    if file.exists():
        if json.loads(file.read_text()) != value: raise failure('IMMUTABLE_ENVELOPE_CONFLICT')
        return
    temporary = file.with_name(file.name + '.' + str(uuid.uuid4()) + '.tmp')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    try:
        try: os.link(temporary, file)
        except FileExistsError:
            if json.loads(file.read_text()) != value: raise failure('IMMUTABLE_ENVELOPE_CONFLICT')
    finally: temporary.unlink()

def queue_items(directory, kind):
    if not directory.exists(): return []
    items = []
    for file in sorted(directory.glob("*.json")):
        try:
            raw = file.read_bytes()
            value = json.loads(raw)
            item = {"file": file, "kind": kind, **({"payload": value} if kind == "event" else value), "envelope_hash": hashlib.sha256(raw).hexdigest()}
            payload = item["payload"].get("event", {}) if kind == "event" else item["payload"]
            item["lane"] = "session:" + payload["session_id"] if payload.get("session_id") else "legacy"
            item["time"] = payload.get("captured_at") or payload.get("occurred_at") or ""
            if not isinstance(item['time'],str): item['time']='';item['parse_error']=True
            item['phase'] = payload.get('phase')
            item.pop('payload')
        except (ValueError, KeyError, TypeError, AttributeError): item = {"file": file, "kind": kind, "lane": "legacy", "time": "", "parse_error": True}
        items.append(item)
    return sorted(items, key=lambda item: (item["time"], item.get('phase') in ("acknowledged", "failed"), str(item["file"])))

def validate_acceptance(kind, item, result):
    payload = item["payload"]
    if kind == "event":
        event_id = payload.get("event", {}).get("event_id")
        if isinstance(result, dict) and isinstance(event_id, str) and event_id and result.get("status") == "accepted":
            counts = (result.get("inserted"), result.get("duplicate"))
            if (type(result.get("received")) in (int, float) and result["received"] == 1
                and all(type(n) in (int, float) and n in (0, 1) for n in counts) and sum(counts) == 1
                and isinstance(result.get("accepted_event_ids"), list) and result["accepted_event_ids"] == [event_id]): return
    else:
        delivery = result.get("delivery", {})
        attempt = next((x for x in delivery.get("attempts", []) if x.get("attempt_id") == payload.get("attempt_id")), {})
        field = {"injected": "injected_at", "acknowledged": "acknowledged_at", "failed": "failed_at"}.get(payload.get("phase"))
        if (result.get("event_id") == payload.get("event_id") and result.get("inserted", -2) + result.get("duplicate", -2) == 1
            and delivery.get("resume_id") == item.get("resume_id") and delivery.get("preview_version") == payload.get("preview_version")
            and all(attempt.get(key) == payload.get(key) for key in ("session_id", "turn_id", "workstream_id"))
            and attempt.get(field) == payload.get("occurred_at") and payload.get("event_id") in attempt.get("event_ids", [])
            and (payload.get("phase") != "acknowledged" or attempt.get("ack_complete") is True)): return
    raise failure("RECEIPT_MISMATCH")

def flush_queue(items, *, root, credential, send, predecessors=(), now=lambda: time.time() * 1000, rng=random.random, max_elapsed_ms=15000):
    # flock is process-owned, released by the kernel on death, and never stolen by mtime.
    import fcntl
    credential = hashlib.sha256(credential.encode()).hexdigest()
    markers = root / "sync-lanes"
    markers.mkdir(parents=True, exist_ok=True, mode=0o700)
    result = {"queued_before": len(items), "flushed": 0, "quarantined": 0, "blocked": 0}
    auth_file = root / 'sync-auth.state'
    try:
        if auth_file.exists() and json.loads(auth_file.read_text()).get('credential_fingerprint') == credential:
            return {**result, 'blocked': len(items)}
    except (ValueError, AttributeError): return {**result, 'blocked': len(items)}
    attempts = 0
    started = time.monotonic()
    for item in items:
        if attempts >= 100 or (time.monotonic()-started)*1000 >= max_elapsed_ms: break
        key = hashlib.sha256(item["lane"].encode()).hexdigest()
        lockfile = markers / (key + ".lock")
        with os.fdopen(os.open(lockfile, os.O_CREAT | os.O_RDWR, 0o600), "w") as lock:
            try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                result["blocked"] += 1
                continue
            if not item["file"].exists(): continue
            sidecar = Path(str(item["file"]) + ".state")
            marker = markers / (key + ".state")
            try:
                state = json.loads(sidecar.read_text()) if sidecar.exists() else {"state": "pending", "attempt_count": 0, "lane": item["lane"]}
                owner = json.loads(marker.read_text()).get("file") if marker.exists() else None
                if (not isinstance(state.get("attempt_count"), int) or state['attempt_count'] < 0
                    or (state.get('last_error_code') and not re.fullmatch(r'[A-Z0-9_]{1,64}',str(state['last_error_code'])))
                    or state.get('state') not in ('pending','retry_wait','paused_auth','quarantined','blocked_protocol','blocked_reconciliation','blocked_gap')): raise ValueError()
                if state.get('next_retry_at'): datetime.fromisoformat(state['next_retry_at'].replace('Z', '+00:00'))
                if any(other['lane'] == item['lane'] and other['time'] < item['time'] and other['file'].exists() for other in predecessors):
                    atomic(sidecar, {**state, 'state':'blocked_gap', 'last_error_code':'PENDING_PREDECESSOR'})
                    result['blocked'] += 1
                    continue
                if owner and owner != str(item["file"]):
                    atomic(sidecar, {**state, "state": "blocked_gap", "last_error_code": "LANE_GAP"})
                    result["blocked"] += 1
                    continue
            except (ValueError, AttributeError):
                atomic(marker, {"file": str(item["file"]), "state": "blocked_protocol"})
                result["blocked"] += 1
                continue
            if state["state"] in ("quarantined", "blocked_protocol", "blocked_reconciliation") or (state["state"] == "paused_auth" and state.get("credential_fingerprint") == credential):
                result["blocked"] += 1
                continue
            try:
                if state.get('credential_fingerprint') == credential and state.get("next_retry_at") and datetime.fromisoformat(state["next_retry_at"].replace("Z", "+00:00")).timestamp()*1000 > now():
                    result["blocked"] += 1
                    continue
                if item.get("parse_error"): raise failure("CORRUPT_ENVELOPE", 422)
                if state.get("envelope_hash") and state["envelope_hash"] != item["envelope_hash"]: raise failure("RECEIPT_MISMATCH")
                raw = item['file'].read_bytes()
                if hashlib.sha256(raw).hexdigest() != item['envelope_hash']: raise failure('RECEIPT_MISMATCH')
                value = json.loads(raw)
                item['payload'] = value if item['kind'] == 'event' else value['payload']
                attempts += 1
                atomic(sidecar, {**state,'state':'pending','attempt_count':state['attempt_count']+1,'envelope_hash':item['envelope_hash']})
                try: response = send(item)
                except Exception as error:
                    data = getattr(error, "response_data", None)
                    if getattr(error, "status_code", None) != 409 or not isinstance(data, dict) or data.get("error_code") != "IDEMPOTENT_REPLAY": raise
                    response = data
                validate_acceptance(item["kind"], item, response)
                atomic(root / 'sync-last-success.state', {'at':datetime.fromtimestamp(now()/1000, timezone.utc).isoformat()})
                auth_file.unlink(missing_ok=True)
                item["file"].unlink()
                sidecar.unlink(missing_ok=True)
                marker.unlink(missing_ok=True)
                result["flushed"] += 1
            except Exception as error:
                state = retry_state(error, state, now=now(), rng=rng, credential=credential)
                state.update(lane=item["lane"], envelope_hash=item.get("envelope_hash"))
                atomic(sidecar, state)
                atomic(marker, {"file": str(item["file"]), "state": state["state"]})
                result["quarantined" if state["state"] == "quarantined" else "blocked"] += 1
                if state['state'] == 'paused_auth':
                    atomic(auth_file, {'credential_fingerprint':credential,'last_error_code':state['last_error_code']})
                    break
            finally: item.pop('payload', None)
    return result

def queue_summary(items, root=None):
    counts = {}
    oldest = None
    last = None
    for item in items:
        try:
            file = Path(str(item["file"]) + ".state")
            data = json.loads(file.read_text()) if file.exists() else {'state':'pending','attempt_count':0}
            state = data.get('state')
            if (state not in ('pending','retry_wait','paused_auth','quarantined','blocked_protocol','blocked_reconciliation','blocked_gap')
                or not isinstance(data.get('attempt_count'),int)
                or (data.get('last_error_code') and not re.fullmatch(r'[A-Z0-9_]{1,64}',str(data['last_error_code'])))):
                raise ValueError()
            last = data.get('last_error_code') or last
            if item.get("parse_error"): state = "blocked_protocol"
        except (ValueError, AttributeError): state = "blocked_protocol";last='CORRUPT_SIDECAR'
        counts[state] = counts.get(state, 0) + 1
        try:
            age = time.time()*1000 - datetime.fromisoformat(item['time'].replace('Z','+00:00')).timestamp()*1000
            oldest = max(oldest or 0, age)
        except (ValueError, KeyError): pass
    success = None
    try:
        if root: success = json.loads((root / 'sync-last-success.state').read_text()).get('at')
    except (OSError, ValueError, AttributeError): pass
    return {"counts": counts, "queued": len(items), "high_water": len(items) >= 1000, 'oldest_age_ms':oldest,'last_error_code':last,'last_success_at':success}
