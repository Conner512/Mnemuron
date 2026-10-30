"""Console handoff boundaries; isolated files and synthetic responses only."""
import copy
import json
import multiprocessing
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from adapters.hermes import PluginRuntime
from adapters.hermes.client import AdapterConfig, MnemuronClient, PendingResumeStore, scope_tokens
from adapters.hermes.sync_protocol import failure


def mark_from_process(directory, attempt_id, start, readers, results):
    store = PendingResumeStore(Path(directory), "synthetic-stream")
    original = store._read
    def overlapping_read(target):
        record = original(target)
        if record.get("attempt_id") == attempt_id and not record.get("context_returned_at"):
            # Without a directory lock both readers reach this barrier before either writes. With the lock,
            # the first reader times out and commits; the second then observes the durable handoff marker.
            try:
                readers.wait(timeout=1)
            except threading.BrokenBarrierError:
                pass
        return record
    store._read = overlapping_read
    start.wait(timeout=5)
    results.put(store.mark_context_returned(attempt_id))


def nested_pending_access(directory, packet, results):
    first = PendingResumeStore(Path(directory), "synthetic-stream")
    same = PendingResumeStore(Path(directory) / ".." / Path(directory).name, "synthetic-stream")
    other = PendingResumeStore(Path(directory).parent / "unrelated-pending", "synthetic-stream")
    with first._lock:
        same.queue(packet, scope_tokens(session_id="session-a"), console_confirmed=True)
        nested = same.counts()
        with ThreadPoolExecutor(max_workers=1) as pool:
            unrelated = pool.submit(other.counts).result(timeout=2)
    results.put((nested, unrelated))


class ConsoleResumeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="mnemuron-core-test-hermes-console-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.values = {
            "server_url": "https://synthetic.example.test", "api_key_file": str(root / "key"),
            "outbox_dir": str(root / "outbox"), "pending_resume_dir": str(root / "pending"),
            "task_scope_dir": str(root / "scopes"), "injection_event_outbox_dir": str(root / "injections"),
            "device_id": "synthetic-hermes-device", "agent_id": "hermes", "agent_instance_id": "synthetic-hermes-instance",
            "project_id": "synthetic-original-project", "task_id": "synthetic-original-task", "workstream_id": "synthetic-stream",
        }
        self.config = AdapterConfig.from_mapping(self.values)
        self.client = MnemuronClient(self.config)
        self.packet = {"resume_id": "synthetic-console-resume", "preview_version": 1,
                       "project": {"project_id": "synthetic-resumed-project"},
                       "task": {"task_id": "synthetic-resumed-task"}, "context": {"goal": "Synthetic resumed context"}}
        self.response = {"status": "pending", "delivery_recorded": False, "resume_packet": self.packet,
                         "target": {"credential_id": "synthetic-credential", "agent_id": "hermes",
                                    "device_id": self.config.device_id, "agent_instance_id": self.config.agent_instance_id,
                                    "session_id": "hermes:session-a", "workstream_id": self.config.workstream_id}}

    def test_pending_read_uses_the_real_capture_session_and_exact_destination(self):
        calls = []
        self.client.request = lambda *args: (calls.append(args), copy.deepcopy(self.response))[1]
        self.assertEqual(self.client.pending_resume("session-a")["resume_packet"], self.packet)
        self.assertEqual(calls, [("POST", "/v1/resume/pending", {"session_id": "hermes:session-a", "workstream_id": "synthetic-stream"})])
        for key in ["session_id", "workstream_id", "device_id", "agent_id", "agent_instance_id"]:
            response = copy.deepcopy(self.response)
            response["target"][key] = "wrong-destination"
            self.client.request = lambda *_args: response
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.client.pending_resume("session-a")

    def test_bad_packet_never_becomes_a_delivery_and_only_old_server_404_is_empty(self):
        for patch in [{"delivery_recorded": True}, {"resume_packet": None}, {"status": "delivered"},
                      {"resume_packet": {**self.packet, "preview_version": True}}]:
            self.client.request = lambda *_args: {**self.response, **patch}
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                self.client.pending_resume("session-a")
        for status in [404, 403, 503]:
            def reject(*_args):
                raise failure("SYNTHETIC_ERROR", status)
            self.client.request = reject
            if status == 404:
                self.assertIsNone(self.client.pending_resume("session-a"))
            else:
                with self.assertRaises(RuntimeError) as caught:
                    self.client.pending_resume("session-a")
                self.assertEqual(caught.exception.status_code, status)

    def test_empty_or_unsupported_runtime_does_not_pull(self):
        self.client.request = lambda *_args: self.fail("must not send an unaffiliated host request")
        self.assertIsNone(self.client.pending_resume(""))
        self.client.config = replace(self.config, agent_id="legacy-agent")
        self.assertIsNone(self.client.pending_resume("session-a"))

    def test_real_hook_path_defers_scope_until_acceptance_and_recovers_the_same_local_queue(self):
        class Context:
            def get_config(_self, key, default=None):
                return self.values.get(key, default)
        runtime = PluginRuntime(Context())
        runtime.client = lambda: self.client
        runtime._capture = lambda *_args, **_kwargs: None
        pulls, records = [], []
        self.client.pending_resume = lambda *args: (pulls.append(args), self.response)[1]
        self.client.flush_injection_event_outbox = lambda: None
        self.client.queue_injection_event = lambda record, phase: records.append((phase, record))
        def unavailable(*_args):
            raise failure("HTTP_503", 503)
        self.client.submit_injection_record = unavailable
        kwargs = {"session_id": "session-a", "turn_id": "real-turn", "user_message": "continue"}
        with self.assertLogs("adapters.hermes", level="WARNING"):
            self.assertIsNone(runtime.pre_llm_call(**kwargs))
        self.assertEqual(runtime.task_scopes().counts(), {"pending": 0, "active": 0, "superseded": 0})
        self.assertEqual(len(pulls), 1)
        queued = runtime.pending()._read(runtime.pending()._files()[0])
        self.assertEqual(queued["target_tokens"], scope_tokens(session_id="session-a"))
        self.assertEqual(queued["console_confirmed_scope"]["task"]["task_id"], "synthetic-resumed-task")
        self.client.submit_injection_record = lambda record, phase: records.append((phase, record))
        result = runtime.pre_llm_call(**kwargs)
        self.assertIn("Synthetic resumed context", result["context"])
        self.assertEqual(runtime.task_scopes().resolve(scope_tokens(session_id="session-a"))["task_id"], "synthetic-resumed-task")
        self.assertIsNone(runtime.pre_llm_call(**kwargs), "same host attempt must not return the context again")
        self.assertEqual(len(pulls), 1)
        runtime.on_session_end(session_id="session-a", turn_id="real-turn", completed=True)
        self.assertEqual([phase for phase, _ in records], ["failed", "injected", "acknowledged"])
        self.assertEqual(runtime.pending().counts(), {"pending": 0, "in_flight": 0, "delivered": 1})

    def test_context_handoff_marker_survives_restart_but_failed_attempt_can_retry(self):
        store = PendingResumeStore(self.config.pending_resume_dir, self.config.workstream_id)
        store.queue(self.packet, scope_tokens(session_id="session-a"), console_confirmed=True)
        self.assertIsNone(store.claim(scope_tokens(session_id="session-b"), "session-b", "wrong-turn"))
        record = store.claim(scope_tokens(session_id="session-a"), "session-a", "real-turn")
        self.assertTrue(store.mark_context_returned(record["attempt_id"]))
        restarted = PendingResumeStore(self.config.pending_resume_dir, self.config.workstream_id)
        self.assertFalse(restarted.mark_context_returned(record["attempt_id"]))
        self.assertTrue(restarted.claim(scope_tokens(session_id="session-a"), "session-a", "real-turn")["context_returned_at"])
        restarted.finish("session-a", False)
        retried = restarted.claim(scope_tokens(session_id="session-a"), "session-a", "retry-turn")
        self.assertNotEqual(retried["attempt_id"], record["attempt_id"])
        self.assertFalse(retried.get("context_returned_at"))
        self.assertTrue(restarted.mark_context_returned(retried["attempt_id"]))

    def test_completion_racing_context_handoff_never_fabricates_an_acknowledgement(self):
        store = PendingResumeStore(self.config.pending_resume_dir, self.config.workstream_id)
        store.queue(self.packet, scope_tokens(session_id="session-a"), console_confirmed=True)
        record = store.claim(scope_tokens(session_id="session-a"), "session-a", "real-turn")
        # The host ends while central injected acceptance is still awaited. There was no context handoff.
        ended = store.finish("session-a", True)
        self.assertEqual(ended[0]["phase"], "failed")
        self.assertEqual(ended[0]["record"]["error_code"], "context_not_handed_off")
        self.assertFalse(store.mark_context_returned(record["attempt_id"]))
        self.assertEqual(store.counts(), {"pending": 1, "in_flight": 0, "delivered": 0})

    def test_fresh_core_authorization_can_renew_expired_pending_but_never_in_flight(self):
        store = PendingResumeStore(self.config.pending_resume_dir, self.config.workstream_id)
        target = scope_tokens(session_id="session-a")
        original = store.queue(self.packet, target, console_confirmed=True)
        file = store._files()[0]
        expired = {**original, "expires_at": "2000-01-01T00:00:00Z"}
        file.write_text(json.dumps(expired), encoding="utf-8")
        self.assertIsNone(store.claim(target, "session-a", "turn-a"))
        renewed = store.queue(self.packet, target, console_confirmed=True)
        self.assertNotEqual(renewed["attempt_id"], original["attempt_id"])
        claimed = store.claim(target, "session-a", "turn-a")
        self.assertIsNotNone(claimed)
        file.write_text(json.dumps({**claimed, "expires_at": "2000-01-01T00:00:00Z"}), encoding="utf-8")
        self.assertEqual(store.queue(self.packet, target, console_confirmed=True)["attempt_id"], claimed["attempt_id"])

    def test_concurrent_hooks_with_distinct_pending_instances_return_one_context(self):
        class Context:
            def get_config(_self, key, default=None):
                return self.values.get(key, default)
        runtime = PluginRuntime(Context())
        runtime.client = lambda: self.client
        runtime._capture = lambda *_args, **_kwargs: None
        self.client.flush_injection_event_outbox = lambda: None
        self.client.pending_resume = lambda *_args: self.fail("the existing local claim must be reused")
        runtime.pending().queue(self.packet, scope_tokens(session_id="session-a"), console_confirmed=True)
        claimed = runtime.pending().claim(scope_tokens(session_id="session-a"), "session-a", "real-turn")
        accepted, readers = threading.Barrier(2), threading.Barrier(2)
        phase = threading.local()
        def accept(record, event_phase):
            self.assertEqual(event_phase, "injected")
            self.assertEqual(record["attempt_id"], claimed["attempt_id"])
            accepted.wait(timeout=3)
            phase.marking = True
        self.client.submit_injection_record = accept
        original = PendingResumeStore._read
        def overlapping_read(store, target):
            record = original(store, target)
            if getattr(phase, "marking", False) and not record.get("context_returned_at"):
                try:
                    readers.wait(timeout=1)
                except threading.BrokenBarrierError:
                    pass
            return record
        kwargs = {"session_id": "session-a", "turn_id": "real-turn", "user_message": "continue"}
        with patch.object(PendingResumeStore, "_read", overlapping_read), ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(runtime.pre_llm_call, **kwargs) for _ in range(2)]
            results = [future.result(timeout=5) for future in futures]
        contexts = [result["context"] for result in results if result]
        self.assertEqual(len(contexts), 1)
        self.assertIn("Synthetic resumed context", contexts[0])
        self.assertTrue(runtime.pending().claim(scope_tokens(session_id="session-a"), "session-a")["context_returned_at"])

    def test_independent_processes_commit_the_context_handoff_marker_once(self):
        store = PendingResumeStore(self.config.pending_resume_dir, self.config.workstream_id)
        store.queue(self.packet, scope_tokens(session_id="session-a"), console_confirmed=True)
        claimed = store.claim(scope_tokens(session_id="session-a"), "session-a", "real-turn")
        context = multiprocessing.get_context("spawn")
        start, readers, results = context.Barrier(3), context.Barrier(2), context.Queue()
        workers = [context.Process(target=mark_from_process, args=(str(self.config.pending_resume_dir), claimed["attempt_id"], start, readers, results)) for _ in range(2)]
        try:
            for worker in workers:
                worker.start()
            start.wait(timeout=5)
            marked = [results.get(timeout=5) for _ in workers]
            for worker in workers:
                worker.join(timeout=5)
                self.assertEqual(worker.exitcode, 0)
            self.assertEqual(sorted(marked), [False, True])
            self.assertFalse(store.mark_context_returned(claimed["attempt_id"]))
        finally:
            for worker in workers:
                if worker.is_alive():
                    worker.terminate()
                worker.join(timeout=5)
            results.close()

    def test_pending_directory_lock_is_reentrant_without_blocking_unrelated_queues(self):
        context = multiprocessing.get_context("spawn")
        results = context.Queue()
        worker = context.Process(target=nested_pending_access, args=(str(self.config.pending_resume_dir), self.packet, results))
        try:
            worker.start()
            worker.join(timeout=5)
            self.assertEqual(worker.exitcode, 0, "nested pending access must not deadlock")
            nested, unrelated = results.get(timeout=1)
            self.assertEqual(nested, {"pending": 1, "in_flight": 0, "delivered": 0})
            self.assertEqual(unrelated, {"pending": 0, "in_flight": 0, "delivered": 0})
        finally:
            if worker.is_alive():
                worker.terminate()
            worker.join(timeout=5)
            results.close()

    def test_late_parallel_503_or_stale_409_cannot_reopen_a_returned_console_context(self):
        for status, code in [(503, "HTTP_503"), (409, "RESUME_CONTEXT_CHANGED")]:
            with self.subTest(status=status):
                values = {**self.values, "pending_resume_dir": str(self.config.pending_resume_dir / str(status)),
                          "task_scope_dir": str(self.config.task_scope_dir / str(status))}
                class Context:
                    def get_config(_self, key, default=None):
                        return values.get(key, default)
                runtime = PluginRuntime(Context())
                client = MnemuronClient(runtime.config())
                runtime.client = lambda: client
                runtime._capture = lambda *_args, **_kwargs: None
                client.flush_injection_event_outbox = lambda: None
                client.queue_injection_event = lambda *_args: self.fail("a late callback cannot fabricate a failure receipt")
                runtime.pending().queue(self.packet, scope_tokens(session_id="session-a"), console_confirmed=True)
                claimed = runtime.pending().claim(scope_tokens(session_id="session-a"), "session-a", "real-turn")
                accepted, returned, counter_lock = threading.Barrier(2), threading.Event(), threading.Lock()
                submissions, terminal = [], []
                def submit(record, event_phase):
                    if event_phase != "injected":
                        terminal.append((event_phase, record["attempt_id"]))
                        return
                    with counter_lock:
                        submissions.append(record["attempt_id"])
                        number = len(submissions)
                    if number <= 2:
                        accepted.wait(timeout=3)
                    if number == 2:
                        self.assertTrue(returned.wait(timeout=3))
                        raise failure(code, status)
                client.submit_injection_record = submit
                def invoke():
                    result = runtime.pre_llm_call(session_id="session-a", turn_id="real-turn", user_message="continue")
                    if result:
                        returned.set()
                    return result
                with ThreadPoolExecutor(max_workers=2) as pool:
                    futures = [pool.submit(invoke) for _ in range(2)]
                    results = [future.result(timeout=5) for future in futures]
                self.assertEqual(sum(bool(result) for result in results), 1)
                current = runtime.pending().claim(scope_tokens(session_id="session-a"), "session-a", "real-turn")
                self.assertEqual(current["attempt_id"], claimed["attempt_id"])
                self.assertTrue(current["context_returned_at"])
                self.assertIsNone(runtime.pending().release(claimed["attempt_id"]))
                self.assertIsNone(invoke())
                self.assertEqual(submissions, [claimed["attempt_id"], claimed["attempt_id"]])
                runtime.on_session_end(session_id="session-a", turn_id="real-turn", completed=True)
                self.assertEqual(terminal, [("acknowledged", claimed["attempt_id"])])
                self.assertEqual(runtime.pending().counts(), {"pending": 0, "in_flight": 0, "delivered": 1})


if __name__ == "__main__":
    unittest.main()
