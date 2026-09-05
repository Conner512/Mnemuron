from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

from adapters.hermes import PluginRuntime, register
from adapters.hermes.client import (
    AdapterConfig,
    MnemuronClient,
    PendingResumeStore,
    TaskScopeStore,
    build_resume_injection_text,
    format_status,
    format_preview,
    injection_event_payload,
    parse_command,
    scope_tokens,
)


class AdapterConfigTests(unittest.TestCase):
    def values(self, root: Path) -> dict:
        return {
            "server_url": "https://mnemuron.example",
            "api_key_file": str(root / "key"),
            "outbox_dir": str(root / "outbox"),
            "device_id": "hermes-host",
            "agent_id": "hermes",
            "agent_instance_id": "hermes-local",
            "project_id": "project-mnemuron",
            "task_id": "task-mnemuron-hermes-adapter-v01",
            "workstream_id": "workstream-hermes",
        }

    def test_requires_https_and_valid_retention(self):
        with tempfile.TemporaryDirectory() as temporary:
            values = self.values(Path(temporary))
            config = AdapterConfig.from_mapping(values)
            self.assertEqual(config.raw_retention_days, 30)
            values["server_url"] = "http://mnemuron.example"
            with self.assertRaisesRegex(ValueError, "requires HTTPS"):
                AdapterConfig.from_mapping(values)
            values["allow_insecure_http"] = True
            values["raw_retention_days"] = "permanent"
            self.assertEqual(AdapterConfig.from_mapping(values).raw_retention_days, "permanent")

    def test_api_key_must_be_private(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            key = root / "key"
            key.write_text("mnm_test\n", encoding="utf-8")
            os.chmod(key, 0o644)
            client = MnemuronClient(AdapterConfig.from_mapping(self.values(root)))
            with self.assertRaises(PermissionError):
                client._api_key()
            os.chmod(key, 0o600)
            self.assertEqual(client._api_key(), "mnm_test")


class ResumeStoreTests(unittest.TestCase):
    def packet(self, activity_size: int = 0) -> dict:
        return {
            "resume_id": "11111111-1111-4111-8111-111111111111",
            "preview_version": 1,
            "project": {"project_id": "project-mnemuron", "name": "Mnemuron"},
            "task": {"task_id": "task-source", "title": "Hermes Adapter"},
            "context": {
                "goal": "continue safely",
                "progress": ["done"],
                "recent_activity": [{"content": "x" * activity_size}] if activity_size else [],
            },
        }

    def test_compacts_large_packet_below_limit(self):
        rendered = build_resume_injection_text(self.packet(100_000))
        self.assertLessEqual(len(rendered), 30 * 1024)
        self.assertIn("用户已确认", rendered)

    def test_pending_packet_is_scope_matched_and_acknowledged(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = PendingResumeStore(Path(temporary))
            telegram_scope = scope_tokens(platform="telegram", chat_id="chat-a", user_id="user-a")
            record = store.queue(self.packet(), telegram_scope)
            self.assertEqual(record["status"], "pending")
            self.assertIsNone(store.claim(scope_tokens(platform="telegram", user_id="user-b"), "session-b"))
            claimed = store.claim(
                scope_tokens(platform="telegram", user_id="user-a"),
                "session-a", "turn-a",
            )
            self.assertEqual(claimed["status"], "in_flight")
            injected = injection_event_payload(claimed, "injected")
            self.assertEqual(injected["turn_id"], "hermes-turn:turn-a")
            self.assertEqual(injected["workstream_id"], "workstream-hermes")
            finished = store.finish("session-a", True)
            self.assertEqual(len(finished), 1)
            acknowledged = injection_event_payload(
                finished[0]["record"], finished[0]["phase"]
            )
            self.assertEqual(acknowledged["attempt_id"], injected["attempt_id"])
            self.assertEqual(acknowledged["phase"], "acknowledged")
            self.assertEqual(store.counts()["delivered"], 1)

    def test_injection_event_outbox_retries_terminal_records(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            values = AdapterConfigTests().values(root)
            values["allow_insecure_http"] = True
            values["server_url"] = "http://mnemuron.test"
            key = root / "key"
            key.write_text("mnm_test\n", encoding="utf-8")
            os.chmod(key, 0o600)
            config = AdapterConfig.from_mapping(values)
            store = PendingResumeStore(config.pending_resume_dir, config.workstream_id)
            tokens = scope_tokens(platform="telegram", user_id="user-a")
            store.queue(self.packet(), tokens)
            claimed = store.claim(tokens, "session-a", "turn-a")
            finished = store.finish("session-a", True)[0]
            client = MnemuronClient(config)
            client.queue_injection_event(finished["record"], finished["phase"])
            calls = []
            def accept(method, endpoint, body):
                calls.append((method, endpoint, body))
                return {"inserted": 1, "duplicate": 0, "event_id": body["event_id"], "delivery": {
                    "resume_id": finished["record"]["resume_id"], "preview_version": body["preview_version"],
                    "attempts": [{**{key: body[key] for key in ("attempt_id", "session_id", "turn_id", "workstream_id")},
                                  "acknowledged_at": body["occurred_at"], "ack_complete": True, "event_ids": [body["event_id"]]}]}}
            client.request = accept
            result = client.flush_injection_event_outbox()
            self.assertEqual(result, {"queued_before": 1, "flushed": 1, "blocked": 0, "quarantined": 0})
            self.assertIn("/injection-events", calls[0][1])
            self.assertEqual(calls[0][2]["phase"], "acknowledged")

    def test_tool_session_token_matches_pre_llm_platform(self):
        tool_tokens = scope_tokens(platform="hermes", session_id="session-a")
        turn_tokens = scope_tokens(platform="telegram", session_id="session-a")
        self.assertTrue(set(tool_tokens).intersection(turn_tokens))

    def test_confirmed_resume_activates_durable_task_scope_for_later_events(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            store = TaskScopeStore(root / "task-scopes")
            target = scope_tokens(platform="telegram", chat_id="chat-a", user_id="user-a")
            staged = store.stage(self.packet(), target, "workstream-hermes")
            self.assertEqual(staged["status"], "pending")
            self.assertIsNone(store.activate(
                scope_tokens(platform="telegram", chat_id="chat-b", user_id="user-a"),
                "session-b",
            ))
            candidates = target + scope_tokens(platform="telegram", session_id="session-a")
            active = store.activate(candidates, "session-a")
            self.assertEqual(active["status"], "active")
            self.assertEqual(active["task_id"], "task-source")
            later = store.resolve(scope_tokens(platform="telegram", session_id="session-a"))
            self.assertEqual(later["resume_id"], self.packet()["resume_id"])
            self.assertEqual(store.counts(), {"pending": 0, "active": 1, "superseded": 0})
            self.assertEqual(os.stat(root / "task-scopes").st_mode & 0o777, 0o700)
            self.assertEqual(os.stat(next((root / "task-scopes").glob("*.json"))).st_mode & 0o777, 0o600)

    def test_dynamic_scope_overrides_static_event_task_but_preserves_agent_provenance(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            client = MnemuronClient(AdapterConfig.from_mapping(AdapterConfigTests().values(root)))
            event = client.event(
                "user_message", "pre_llm_call", session_id="session-a", content="继续",
                raw={"platform": "telegram"},
                task_scope={
                    "schema_version": "mnemuron-task-scope-v0.1",
                    "resume_id": "resume-a",
                    "preview_version": 1,
                    "project_id": "project-restored",
                    "task_id": "task-restored",
                    "workstream_id": "workstream-hermes",
                    "activated_at": "2026-08-26T00:00:00Z",
                },
            )
            self.assertEqual(event["project_id"], "project-restored")
            self.assertEqual(event["task_id"], "task-restored")
            self.assertEqual(event["provenance"]["agent_instance_id"], "hermes-local")
            self.assertEqual(event["raw_hook_payload"]["mnemuron_task_scope"]["source"], "confirmed-resume")


class CommandAndRegistrationTests(unittest.TestCase):
    def test_status_explains_raw_availability_categories(self):
        output = format_status({
            "mode": "remote-v0.1",
            "raw_availability": {
                "raw_events_available": 3079,
                "expired_events": 1,
                "unexplained_raw_unavailable": 0,
                "status": "accounted",
            },
        })
        self.assertIn(
            "Raw：3079 可用 / 1 已过期 / 0 无法解释 / 状态 accounted",
            output,
        )
        self.assertIn("Raw：中心暂未提供可用性分类", format_status({}))

    def test_command_aliases(self):
        self.assertEqual(parse_command("继续 Mnemuron"), ("continue", "Mnemuron"))
        self.assertEqual(parse_command("确认 abc 1"), ("confirm", "abc 1"))
        self.assertEqual(parse_command(""), ("status", ""))

    def test_preview_displays_task_status_and_expiry(self):
        output = format_preview({
            "status": "pending_confirmation",
            "project": {"name": "Mnemuron"},
            "task": {"title": "OpenClaw", "status": "completed", "goal": "verify"},
            "resume_id": "11111111-1111-4111-8111-111111111111",
            "preview_version": 1,
            "expires_at": "2026-08-25T06:30:00.000Z",
        })
        self.assertIn("任务状态：completed", output)
        self.assertIn("有效期至：2026-08-25T06:30:00.000Z", output)

    def test_safe_command_explains_expired_preview(self):
        class FakeContext:
            def get_config(self, _key, default=None):
                return default

        runtime = PluginRuntime(FakeContext())
        runtime.command = lambda _raw: (_ for _ in ()).throw(
            RuntimeError("Resume Preview expired; create and show a fresh preview.")
        )
        self.assertIn("已过期", runtime.safe_command("cancel id 1"))

    def test_registers_native_contract(self):
        class FakeContext:
            def __init__(self):
                self.tools = []
                self.commands = []
                self.hooks = []
                self.sections = []

            def get_config(self, _key, default=None):
                return default

            def register_tool(self, name, *_args, **_kwargs):
                self.tools.append(name)

            def register_command(self, name, *_args, **_kwargs):
                self.commands.append(name)

            def register_hook(self, name, *_args, **_kwargs):
                self.hooks.append(name)

            def register_system_prompt_section(self, section_id, *_args, **_kwargs):
                self.sections.append(section_id)

        context = FakeContext()
        register(context)
        self.assertEqual(set(context.tools), {
            "mnemuron_status", "mnemuron_preview_resume",
            "mnemuron_confirm_resume", "mnemuron_remember",
        })
        self.assertEqual(context.commands, ["mnemuron"])
        self.assertEqual(set(context.hooks), {
            "pre_gateway_dispatch", "on_session_start", "pre_llm_call",
            "post_llm_call", "post_tool_call", "on_session_end",
        })
        self.assertEqual(context.sections, ["mnemuron.handoff"])

    def test_session_end_keeps_details_raw_without_checkpoint_content(self):
        class FakeContext:
            def get_config(self, _key, default=None):
                return default

        runtime = PluginRuntime(FakeContext())
        captured = []
        runtime.pending = lambda: type("Pending", (), {"finish": lambda *_args: []})()
        runtime._capture = lambda event_type, hook_name, **payload: captured.append(
            (event_type, hook_name, payload)
        )
        runtime.on_session_end(
            session_id="session-a", turn_id="turn-a", completed=True,
            failed=False, interrupted=False, turn_exit_reason="completed",
            model="fixture", platform="telegram",
        )
        self.assertIsNone(captured[0][2]["content"])
        self.assertTrue(captured[0][2]["raw"]["completed"])

    def test_event_omits_none_content_for_server_checkpoint_deduplication(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            values = AdapterConfigTests().values(root)
            event = MnemuronClient(AdapterConfig.from_mapping(values)).event(
                "session_end", "on_session_end", session_id="session-a",
                content=None, raw={"completed": True},
            )
            self.assertNotIn("content", event)
            self.assertTrue(event["raw_hook_payload"]["completed"])


if __name__ == "__main__":
    unittest.main()
