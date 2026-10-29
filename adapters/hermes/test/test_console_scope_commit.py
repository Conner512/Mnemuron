"""Exact Console bindings and handoff commit faults through the real Hermes hooks."""
import errno
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from adapters.hermes import PluginRuntime
from adapters.hermes import client as core
from adapters.hermes.client import GATEWAY_SCOPE, MnemuronClient, TaskScopeStore, scope_tokens


class ConsoleScopeCommitTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="mnemuron-core-test-hermes-commit-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        values = {"server_url": "https://synthetic.example.test", "api_key_file": str(self.root / "key"),
                  "outbox_dir": str(self.root / "outbox"), "pending_resume_dir": str(self.root / "pending"),
                  "task_scope_dir": str(self.root / "scopes"), "device_id": "synthetic-device",
                  "agent_id": "hermes", "agent_instance_id": "synthetic-instance",
                  "project_id": "default-project", "task_id": "default-task", "workstream_id": "synthetic-stream"}
        class Context:
            def get_config(_self, key, default=None):
                return values.get(key, default)
        self.runtime = PluginRuntime(Context())
        self.client = MnemuronClient(self.runtime.config())
        self.runtime.client = lambda: self.client
        self.events, self.receipts = [], []
        self.client.request = lambda *_args, **_kwargs: self.fail("network forbidden")
        self.client.submit_event = lambda event: (self.events.append(event), {"delivery": "synchronized"})[1]
        self.client.flush_injection_event_outbox = lambda: None
        self.client.submit_injection_record = lambda record, phase: self.receipts.append((phase, record["attempt_id"]))
        self.client.queue_injection_event = self.client.submit_injection_record
        self.packet = {"resume_id": "synthetic-console-resume", "preview_version": 1,
                       "project": {"project_id": "selected-project"}, "task": {"task_id": "selected-task"},
                       "context": {"goal": "Synthetic authorized context"}}
        self.client.pending_resume = lambda session, *_args: (
            {"resume_packet": self.packet, "target": {"workstream_id": "synthetic-stream"}}
            if session == "session-a" else None)
        token = GATEWAY_SCOPE.set({})
        self.addCleanup(GATEWAY_SCOPE.reset, token)

    def invoke(self, session="session-a", sender="alice"):
        return self.runtime.pre_llm_call(session_id=session, turn_id="synthetic-turn",
                                         user_message="Synthetic message", platform="telegram", sender_id=sender)

    def gateway(self, sender="alice"):
        GATEWAY_SCOPE.set({"tokens": scope_tokens(platform="telegram", chat_id="synthetic-group", user_id=sender)})

    def scope(self, session="session-a", sender="alice"):
        return self.runtime.task_scopes().resolve(self.runtime._scope_tokens(
            session_id=session, platform="telegram", sender_id=sender))

    def prior_manual_scope(self):
        packet = {**self.packet, "resume_id": "synthetic-manual-resume", "task": {"task_id": "manual-task"}}
        scopes = self.runtime.task_scopes()
        tokens = scope_tokens(platform="telegram", chat_id="synthetic-group", user_id="alice")
        scopes.stage(packet, tokens, "synthetic-stream")
        scopes.activate(tokens + scope_tokens(session_id="session-a"), "session-a")

    def test_console_binding_is_exact_across_senders_restarts_and_capture(self):
        self.gateway()
        self.assertIn("Synthetic authorized context", self.invoke()["context"])
        active = self.scope()
        self.assertEqual(active["active_tokens"], scope_tokens(session_id="session-a"))
        # A fresh store must enforce the same rule from persistent state, not a hook-local filter.
        for sender in ["alice", "bob"]:
            self.gateway(sender)
            self.assertIsNone(self.scope("session-b", sender))
            self.assertIsNone(self.invoke("session-b", sender))
            captured = [e for e in self.events if e["session_id"] == "hermes:session-b"][-1]
            self.assertEqual(captured["task_id"], "default-task")
            self.assertEqual(captured["project_id"], "default-project")
        self.assertIsNone(self.runtime.task_scopes().resolve(scope_tokens(platform="telegram", chat_id="synthetic-group")))
        self.assertEqual(self.scope()["task_id"], "selected-task")

    def test_legacy_widened_active_tokens_cannot_override_original_session_targets(self):
        scopes = self.runtime.task_scopes()
        target = scope_tokens(session_id="session-a")
        scopes.stage(self.packet, target, "synthetic-stream")
        scopes.activate(target, "session-a")
        file = scopes._files()[0]
        saved = json.loads(file.read_text())
        saved["active_tokens"] += scope_tokens(platform="telegram", chat_id="synthetic-group", user_id="alice")
        file.write_text(json.dumps(saved))
        self.gateway()
        self.assertIsNone(self.scope("session-b"))
        self.assertEqual(self.scope()["task_id"], "selected-task")
        second = {**self.packet, "resume_id": "synthetic-second", "task": {"task_id": "second-task"}}
        scopes.stage(second, scope_tokens(session_id="session-b"), "synthetic-stream")
        scopes.activate(self.runtime._scope_tokens(session_id="session-b"), "session-b")
        self.assertEqual(self.scope()["task_id"], "selected-task", "B must not supersede exact A")
        self.assertEqual(self.scope("session-b")["task_id"], "second-task")

    def test_exact_binding_preserves_manual_chat_scope_for_other_sessions(self):
        self.gateway()
        self.prior_manual_scope()
        self.assertIsNotNone(self.invoke())
        self.assertEqual(self.scope()["task_id"], "selected-task")
        self.gateway("bob")
        self.assertEqual(self.scope("session-b", "bob")["task_id"], "manual-task")
        # The generic manual session-only API must likewise not supersede a broad binding globally.
        scopes = self.runtime.task_scopes()
        packet = {**self.packet, "resume_id": "synthetic-session-c", "task": {"task_id": "task-c"}}
        scopes.stage(packet, scope_tokens(session_id="session-c"), "synthetic-stream")
        scopes.activate(self.runtime._scope_tokens(session_id="session-c"), "session-c")
        self.assertEqual(self.scope("session-b", "bob")["task_id"], "manual-task")

    def assert_failed_prepare_retries(self, fault):
        self.gateway()
        self.prior_manual_scope()
        with fault, self.assertLogs("adapters.hermes", level="WARNING"):
            self.assertIsNone(self.invoke())
        pending = self.runtime.pending()
        row = pending._read(pending._files()[0])
        self.assertFalse(row.get("context_returned_at"))
        self.assertEqual(self.scope()["task_id"], "manual-task")
        # A normal early activation must not turn an orphan prepared file into authority.
        self.runtime.task_scopes().activate(self.runtime._scope_tokens(session_id="session-a"), "session-a")
        self.assertEqual(self.scope()["task_id"], "manual-task")
        self.runtime.on_session_end(session_id="session-a", completed=True)
        self.assertNotIn("acknowledged", [phase for phase, _ in self.receipts])
        result = self.invoke()
        self.assertIn("Synthetic authorized context", result["context"])
        self.assertEqual(self.scope()["task_id"], "selected-task")
        self.assertIsNone(self.invoke())
        self.runtime.on_session_end(session_id="session-a", completed=True)
        self.assertEqual([phase for phase, _ in self.receipts].count("acknowledged"), 1)

    def test_scope_write_failure_leaves_no_false_handoff_or_ack(self):
        self.assert_failed_prepare_retries(patch.object(TaskScopeStore, "stage", side_effect=OSError(errno.ENOSPC, "synthetic scope write fault")))

    def test_scope_written_then_prepare_raises_stays_inert(self):
        original = TaskScopeStore.stage
        def prepare_then_fail(store, *args, **kwargs):
            original(store, *args, **kwargs)
            raise OSError(errno.EIO, "synthetic preparation failure after stage")
        self.assert_failed_prepare_retries(patch.object(TaskScopeStore, "stage", prepare_then_fail))

    def test_marker_write_failure_does_not_activate_prepared_scope(self):
        original = core._atomic_json_write
        def fail_marker(target, record):
            if target.parent == self.client.config.pending_resume_dir and record.get("context_returned_at"):
                raise OSError(errno.ENOSPC, "synthetic handoff commit failure")
            return original(target, record)
        self.assert_failed_prepare_retries(patch.object(core, "_atomic_json_write", fail_marker))

    def test_committed_scope_survives_failed_turn_recovery_and_pending_renewal(self):
        self.assertIsNotNone(self.invoke())
        pending = self.runtime.pending()
        for action in [lambda: pending.finish("session-a", False), pending.recover_in_flight]:
            action()
            self.assertEqual(self.scope()["task_id"], "selected-task")
            file = pending._files()[0]
            row = pending._read(file)
            row["expires_at"] = "2000-01-01T00:00:00Z"
            file.write_text(json.dumps(row))
            pending.queue(self.packet, scope_tokens(session_id="session-a"), console_confirmed=True)
            self.assertEqual(self.scope()["task_id"], "selected-task")
            self.assertIsNotNone(self.invoke())

    def test_stale_accepted_callback_cannot_prepare_scope_after_terminal_event(self):
        def accept_then_end(record, phase):
            self.receipts.append((phase, record["attempt_id"]))
            self.runtime.pending().finish("session-a", True)
        self.client.submit_injection_record = accept_then_end
        with patch.object(TaskScopeStore, "stage", side_effect=AssertionError("stale callback prepared scope")):
            self.assertIsNone(self.invoke())
        self.assertIsNone(self.scope())
        self.assertEqual(self.runtime.pending().counts()["delivered"], 0)

    def test_failed_retry_commit_keeps_previous_successful_scope(self):
        self.assertIsNotNone(self.invoke())
        pending = self.runtime.pending()
        first = pending._read(pending._files()[0])["scope_commit"]
        pending.finish("session-a", False)
        original = core._atomic_json_write
        def fail_marker(target, record):
            if target.parent == self.client.config.pending_resume_dir and record.get("context_returned_at"):
                raise OSError(errno.ENOSPC, "synthetic retry commit failure")
            return original(target, record)
        with patch.object(core, "_atomic_json_write", fail_marker), self.assertLogs("adapters.hermes", level="WARNING"):
            self.assertIsNone(self.invoke())
        self.assertEqual(pending._read(pending._files()[0])["scope_commit"], first)
        self.assertEqual(self.scope()["task_id"], "selected-task")

    def test_persistent_pending_failure_reprepares_same_attempt_after_another_binding(self):
        self.gateway()
        self.prior_manual_scope()
        pending = self.runtime.pending()
        original = core._atomic_json_write
        refused = False
        def fail_pending_volume(target, record):
            nonlocal refused
            if target.parent == self.client.config.pending_resume_dir:
                refused = refused or bool(record.get("context_returned_at"))
                if refused:
                    raise OSError(errno.ENOSPC, "synthetic pending volume unavailable")
            return original(target, record)
        with patch.object(core, "_atomic_json_write", fail_pending_volume):
            with self.assertRaises(OSError):
                self.invoke()
        row = pending._read(pending._files()[0])
        attempt = row["attempt_id"]
        self.assertEqual(row["status"], "in_flight")
        self.assertFalse(row.get("context_returned_at"))
        self.assertNotIn("acknowledged", [phase for phase, _ in self.receipts])
        scopes = self.runtime.task_scopes()
        packet = {**self.packet, "resume_id": "intervening-manual", "task": {"task_id": "intervening-task"}}
        scopes.stage(packet, scope_tokens(session_id="session-a"), "synthetic-stream")
        scopes.activate(self.runtime._scope_tokens(session_id="session-a"), "session-a")
        self.assertEqual(self.scope()["task_id"], "intervening-task")
        self.assertIsNotNone(self.invoke())
        self.assertEqual(pending._read(pending._files()[0])["scope_commit"]["attempt_id"], attempt)
        self.assertEqual(self.scope()["task_id"], "selected-task")
        self.assertIsNone(self.invoke())
        self.runtime.on_session_end(session_id="session-a", completed=True)
        self.assertEqual([phase for phase, _ in self.receipts].count("acknowledged"), 1)

    def test_prepared_scope_requires_receipt_for_exact_identity(self):
        self.gateway()
        self.prior_manual_scope()
        self.assertIsNotNone(self.invoke())
        scopes = self.runtime.task_scopes()
        file = next(file for file in scopes._files() if "handoff_commit" in json.loads(file.read_text()))
        original = json.loads(file.read_text())
        for mutation in [{"task_id": "unapproved-task"}, {"project_id": "unapproved-project"},
                         {"workstream_id": "unapproved-stream"}, {"target_tokens": ["session:session-b"]},
                         {"active_session_id": "session-b"},
                         {"handoff_commit": {**original["handoff_commit"], "attempt_id": "uncommitted-attempt"}}]:
            file.write_text(json.dumps({**original, **mutation}))
            self.assertEqual(self.scope()["task_id"], "manual-task")
            scopes.activate(self.runtime._scope_tokens(session_id="session-a"), "session-a")
            self.assertEqual(self.scope()["task_id"], "manual-task")
        file.write_text(json.dumps(original))
        self.assertEqual(self.scope()["task_id"], "selected-task")

    def test_newest_exact_binding_wins_with_equal_or_backwards_clock(self):
        self.gateway()
        self.prior_manual_scope()
        scopes = self.runtime.task_scopes()
        file = scopes._files()[0]
        previous = json.loads(file.read_text())
        previous["activated_at"] = "2099-01-01T00:00:00Z"
        file.write_text(json.dumps(previous))
        self.assertIsNotNone(self.invoke())
        self.assertEqual(self.scope()["task_id"], "selected-task")
        self.assertEqual(self.scope("session-b")["task_id"], "manual-task")
        packet = {**self.packet, "resume_id": "manual-session-c", "task": {"task_id": "task-c"}}
        scopes.stage(packet, scope_tokens(session_id="session-c"), "synthetic-stream")
        scopes.activate(self.runtime._scope_tokens(session_id="session-c"), "session-c")
        self.assertEqual(self.scope("session-c")["task_id"], "task-c")
        self.assertEqual(self.scope()["task_id"], "selected-task")

    def test_no_fallible_permission_or_logging_step_after_handoff_commit(self):
        original_chmod = core.os.chmod
        def directories_only(path, mode):
            if Path(path).suffix == ".json":
                raise OSError(errno.EIO, "post-commit chmod forbidden")
            return original_chmod(path, mode)
        with patch.object(core.os, "chmod", directories_only), patch("adapters.hermes.LOGGER.info", side_effect=RuntimeError("synthetic logger fault")):
            self.assertIsNotNone(self.invoke())
        self.assertEqual(os.stat(self.runtime.pending()._files()[0]).st_mode & 0o777, 0o600)
        self.assertEqual(self.scope()["task_id"], "selected-task")


if __name__ == "__main__":
    unittest.main()
