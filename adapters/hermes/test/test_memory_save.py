import tempfile
import unittest
import urllib.error
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from adapters.hermes import PluginRuntime, REMEMBER_SCHEMA
from adapters.hermes.client import AdapterConfig, MnemuronClient


class MemorySaveTests(unittest.TestCase):
    def test_tool_and_command_use_single_send_operation_contract(self):
        with tempfile.TemporaryDirectory(prefix="mnemuron-core-test-") as temporary:
            root = Path(temporary)
            settings = {
                "server_url": "http://127.0.0.1:1",
                "allow_insecure_http": True,
                "api_key_file": str(root / "synthetic.key"),
                "outbox_dir": str(root / "outbox"),
                "task_scope_dir": str(root / "scopes"),
                "pending_resume_dir": str(root / "pending"),
                "device_id": "device-test",
                "agent_id": "hermes",
                "agent_instance_id": "agent-test",
                "project_id": "project-test",
                "task_id": "task-test",
                "workstream_id": "workstream-test",
            }
            client = MnemuronClient(AdapterConfig.from_mapping(settings))
            calls = []
            client.request = lambda method, endpoint, body: calls.append((method, endpoint, body)) or {"memory": {"memory_id": "synthetic"}}
            runtime = PluginRuntime(None)
            runtime.config = lambda: client.config
            runtime.client = lambda: client
            runtime.remember_tool({"scope": "user", "content": "tool", "operation_id": "original-operation"})
            self.assertEqual(calls[0][2]["operation_id"], "original-operation")
            self.assertEqual(calls[0][2]["scope"], "user")
            self.assertEqual(calls[0][2]["source"], "explicit-hermes")
            self.assertIn("synthetic", runtime.command("remember command"))
            self.assertEqual(len(calls), 2)
            self.assertRegex(calls[1][2]["operation_id"], r"^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$")
            self.assertNotEqual(calls[1][2]["operation_id"], "original-operation")
            self.assertIn("operation_id", REMEMBER_SCHEMA["parameters"]["properties"])
            runtime.remember_tool({"scope": "project", "content": "explicit target", "task_id": "another-task"})
            self.assertEqual(calls[2][2]["task_id"], "another-task")
            self.assertIsNone(calls[2][2]["project_id"])
            self.assertIsNone(calls[2][2]["workstream_id"])
            runtime.command("remember --operation-id command-retry same content")
            runtime.command("remember --operation-id command-retry same content")
            self.assertEqual(calls[3][2], calls[4][2])

    def test_invalid_keys_never_reach_transport_and_errors_preserve_retry_key(self):
        client = MnemuronClient(None)
        calls = []

        def fail(method, endpoint, body):
            calls.append(body)
            raise OSError("synthetic response loss")

        client.request = fail
        for key in [None, "", "bad key", "bad\n", "x" * 129, 3]:
            with self.assertRaises(ValueError):
                client.remember({"scope": "user", "content": "save", "operation_id": key})
        self.assertEqual(calls, [])
        body = {"scope": "user", "content": "save"}
        with self.assertRaises(RuntimeError) as first:
            client.remember(body)
        self.assertNotIn("operation_id", body)
        retry_key = first.exception.operation_id
        with self.assertRaises(RuntimeError) as second:
            client.remember({**body, "operation_id": retry_key})
        self.assertEqual(second.exception.operation_id, retry_key)
        self.assertEqual(calls[0], calls[1])
        self.assertEqual(len(calls), 2)
        self.assertIn(retry_key, str(second.exception))

    def test_http_conflict_keeps_machine_code_and_original_operation(self):
        client = MnemuronClient(SimpleNamespace(server_url="http://127.0.0.1:1", request_timeout_seconds=1))
        client._api_key = lambda: "mnm_synthetic"
        response = urllib.error.HTTPError(
            "http://127.0.0.1:1/v1/memories", 409, "Conflict", {},
            BytesIO(b'{"error":"different intent","error_code":"IDEMPOTENCY_CONFLICT"}'),
        )
        with patch("urllib.request.OpenerDirector.open", side_effect=response) as transport:
            with self.assertRaises(RuntimeError) as result:
                client.remember({"scope": "user", "content": "changed", "operation_id": "original"})
        self.assertEqual(transport.call_count, 1)
        self.assertEqual(result.exception.operation_id, "original")
        self.assertEqual(result.exception.status_code, 409)
        self.assertEqual(result.exception.error_code, "IDEMPOTENCY_CONFLICT")
        runtime = PluginRuntime(None)
        runtime.command = lambda _raw: (_ for _ in ()).throw(result.exception)
        self.assertIn("IDEMPOTENCY_CONFLICT", runtime.safe_command("remember changed"))
