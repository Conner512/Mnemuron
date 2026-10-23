"""Mnemuron Hermes adapter core, intentionally limited to the Python stdlib."""

from __future__ import annotations

import contextvars
import hashlib
import json
import logging
import os
import re
import stat
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping
from .sync_protocol import request_json, queue_items, queue_summary, flush_queue, validate_acceptance, immutable_envelope


LOGGER = logging.getLogger(__name__)
IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
RETENTION_PERMANENT = "permanent"
MAX_INJECTION_CHARS = 30 * 1024
PENDING_TTL_HOURS = 24


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_utc(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _identifier(value: Any, label: str) -> str:
    text = str(value or "").strip()
    if not IDENTIFIER.fullmatch(text):
        raise ValueError(f"{label} is invalid")
    return text


def _session_identifier(value: Any) -> str:
    raw = str(value or "").strip()
    prefixed = f"hermes:{raw}" if raw else f"hermes-session:{uuid.uuid4()}"
    if IDENTIFIER.fullmatch(prefixed):
        return prefixed
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]
    return f"hermes-session:{digest}"


def _turn_identifier(value: Any, session_id: Any = "") -> str:
    raw = str(value or session_id or "").strip()
    prefixed = f"hermes-turn:{raw}" if raw else f"hermes-turn:{uuid.uuid4()}"
    if IDENTIFIER.fullmatch(prefixed):
        return prefixed
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]
    return f"hermes-turn:{digest}"


def _json_safe(value: Any, depth: int = 0) -> Any:
    if depth > 20:
        return "[MaxDepth]"
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item, depth + 1) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(item, depth + 1) for item in value]
    if hasattr(value, "__dict__"):
        return _json_safe(vars(value), depth + 1)
    return str(value)


def _atomic_json_write(target: Path, value: Mapping[str, Any]) -> None:
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(target.parent, 0o700)
    temporary = target.with_name(f".{target.name}.{os.getpid()}.{uuid.uuid4()}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
        os.chmod(target, 0o600)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _clipped_text(value: Any, limit: int = 800) -> str:
    if isinstance(value, str):
        text = value
    elif value is None:
        text = ""
    else:
        text = json.dumps(_json_safe(value), ensure_ascii=False)
    if len(text) <= limit:
        return text
    return f"{text[: max(0, limit - 18)]}…[truncated]"


def _compact_items(values: Any, limit: int = 20, text_limit: int = 800) -> list[Any]:
    if not isinstance(values, list):
        return []
    compacted: list[Any] = []
    for value in values[:limit]:
        if isinstance(value, str):
            compacted.append(_clipped_text(value, text_limit))
        elif isinstance(value, Mapping):
            compacted.append({
                "text": _clipped_text(value, text_limit),
                "source_event_id": value.get("source_event_id"),
                "source_status": value.get("source_status"),
            })
        else:
            compacted.append(value)
    return compacted


def build_resume_injection_text(packet: Mapping[str, Any], max_chars: int = MAX_INJECTION_CHARS) -> str:
    if not isinstance(packet, Mapping):
        raise ValueError("Resume Packet is invalid")
    context = packet.get("context") if isinstance(packet.get("context"), Mapping) else {}
    checkpoints = []
    for checkpoint in list(context.get("latest_checkpoints") or [])[:4]:
        checkpoints.append({
            "checkpoint_id": checkpoint.get("checkpoint_id"),
            "version": checkpoint.get("version"),
            "workstream_id": checkpoint.get("workstream_id"),
            "session_id": checkpoint.get("session_id"),
            "created_at": checkpoint.get("created_at"),
            "goal": _clipped_text(checkpoint.get("goal"), 1200),
            "active_request": _clipped_text(checkpoint.get("active_request"), 1200),
            "latest_outcome": _clipped_text(checkpoint.get("latest_outcome"), 1600),
            "completed_items": _compact_items(checkpoint.get("completed_items"), 10, 500),
            "decisions": _compact_items(checkpoint.get("decisions"), 10, 500),
            "blockers": _compact_items(checkpoint.get("blockers"), 10, 500),
            "unfinished_items": _compact_items(checkpoint.get("unfinished_items"), 10, 500),
            "recommended_next_steps": _compact_items(checkpoint.get("recommended_next_steps"), 10, 500),
            "source_event_ids": list(checkpoint.get("source_event_ids") or [])[:50],
            "provenance": checkpoint.get("provenance"),
            "generation": checkpoint.get("generation"),
        })
    summary: dict[str, Any] = {
        "schema_version": "mnemuron-resume-injection-v0.1",
        "resume_id": packet.get("resume_id"),
        "preview_version": packet.get("preview_version"),
        "project": packet.get("project"),
        "task": packet.get("task"),
        "selected_workstreams": packet.get("selected_workstreams"),
        "context": {
            "goal": _clipped_text(context.get("goal"), 2000),
            "progress": _compact_items(context.get("progress"), 24, 900),
            "decisions": _compact_items(context.get("decisions"), 24, 900),
            "blockers": _compact_items(context.get("blockers"), 16, 900),
            "next_steps": _compact_items(context.get("next_steps"), 24, 900),
            "resources": _compact_items(context.get("resources"), 30, 600),
            "conflicts": _compact_items(context.get("conflicts"), 16, 900),
            "latest_checkpoints": checkpoints,
            "structured_memories": list(context.get("structured_memories") or [])[:10],
            "recent_activity": list(context.get("recent_activity") or [])[-12:],
        },
        "provenance": packet.get("provenance"),
        "injection_authorized_at": packet.get("injection_authorized_at"),
        "compaction": {
            "source_packet_chars": len(json.dumps(packet, ensure_ascii=False)),
            "selective_context": True,
            "raw_records_remain_in_mnemuron": True,
        },
    }

    def render() -> str:
        return "\n".join([
            "Mnemuron Resume Packet（用户已确认；选择性上下文）",
            "该 Packet 已经过 Preview 和用户显式确认，是本轮恢复的权威上下文。",
            "请直接基于它继续任务；不要为同一任务再次创建 Preview 或重复确认。",
            json.dumps(summary, ensure_ascii=False, indent=2),
        ])

    rendered = render()
    if len(rendered) > max_chars:
        summary["context"]["recent_activity"] = []
        summary["context"]["structured_memories"] = []
        summary["compaction"]["activity_and_memories_omitted"] = True
        rendered = render()
    if len(rendered) > max_chars:
        for checkpoint in summary["context"]["latest_checkpoints"]:
            checkpoint["completed_items"] = []
            checkpoint["decisions"] = []
            checkpoint["source_event_ids"] = []
        summary["context"]["progress"] = summary["context"]["progress"][:8]
        summary["context"]["decisions"] = summary["context"]["decisions"][:8]
        summary["context"]["resources"] = summary["context"]["resources"][:8]
        summary["compaction"]["checkpoint_details_reduced"] = True
        rendered = render()
    if len(rendered) > max_chars:
        raise ValueError(f"Selective Resume Packet still exceeds {max_chars} characters")
    return rendered


def scope_tokens(*, platform: Any = "", chat_id: Any = "", user_id: Any = "", session_id: Any = "") -> list[str]:
    tokens: list[str] = []
    platform_text = str(getattr(platform, "value", platform) or "unknown")
    for kind, value in (("chat", chat_id), ("user", user_id), ("session", session_id)):
        text = str(value or "").strip()
        if not text:
            continue
        namespace = "agent-session" if kind == "session" else platform_text
        digest = hashlib.sha256(f"{namespace}|{kind}|{text}".encode("utf-8")).hexdigest()
        tokens.append(f"{kind}:{digest}")
    return tokens


@dataclass(frozen=True)
class AdapterConfig:
    server_url: str
    api_key_file: Path
    outbox_dir: Path
    pending_resume_dir: Path
    task_scope_dir: Path
    injection_event_outbox_dir: Path
    device_id: str
    agent_id: str
    agent_instance_id: str
    project_id: str
    task_id: str
    workstream_id: str
    raw_retention_days: int | str = 30
    request_timeout_seconds: float = 5.0
    allow_insecure_http: bool = False

    @classmethod
    def from_mapping(cls, values: Mapping[str, Any]) -> "AdapterConfig":
        required = (
            "server_url", "api_key_file", "outbox_dir", "device_id", "agent_id",
            "agent_instance_id", "project_id", "task_id", "workstream_id",
        )
        for key in required:
            if not str(values.get(key) or "").strip():
                raise ValueError(f"Mnemuron setting {key} is required")
        server_url = str(values["server_url"]).rstrip("/")
        parsed = urllib.parse.urlparse(server_url)
        allow_http = bool(values.get("allow_insecure_http", False))
        if parsed.scheme not in {"http", "https"}:
            raise ValueError("server_url must use HTTP or HTTPS")
        if parsed.scheme != "https" and not allow_http:
            raise ValueError("The Hermes adapter requires HTTPS")
        retention: int | str = values.get("raw_retention_days", 30)
        if str(retention).lower() == RETENTION_PERMANENT:
            retention = RETENTION_PERMANENT
        else:
            retention = int(retention)
            if retention < 1:
                raise ValueError("raw_retention_days must be >= 1 or permanent")
        timeout = float(values.get("request_timeout_seconds", 5.0))
        if timeout < 0.25 or timeout > 60:
            raise ValueError("request_timeout_seconds must be between 0.25 and 60")
        outbox = Path(str(values["outbox_dir"])).expanduser().resolve()
        pending = Path(str(values.get("pending_resume_dir") or outbox.parent / "pending-resume")).expanduser().resolve()
        task_scopes = Path(str(values.get("task_scope_dir") or pending.parent / "task-scopes")).expanduser().resolve()
        injection_events = Path(str(
            values.get("injection_event_outbox_dir") or pending.parent / "injection-event-outbox"
        )).expanduser().resolve()
        return cls(
            server_url=server_url,
            api_key_file=Path(str(values["api_key_file"])).expanduser().resolve(),
            outbox_dir=outbox,
            pending_resume_dir=pending,
            task_scope_dir=task_scopes,
            injection_event_outbox_dir=injection_events,
            device_id=_identifier(values["device_id"], "device_id"),
            agent_id=_identifier(values["agent_id"], "agent_id"),
            agent_instance_id=_identifier(values["agent_instance_id"], "agent_instance_id"),
            project_id=_identifier(values["project_id"], "project_id"),
            task_id=_identifier(values["task_id"], "task_id"),
            workstream_id=_identifier(values["workstream_id"], "workstream_id"),
            raw_retention_days=retention,
            request_timeout_seconds=timeout,
            allow_insecure_http=allow_http,
        )


class PendingResumeStore:
    def __init__(self, directory: Path, workstream_id: str = "workstream-hermes"):
        self.directory = Path(directory)
        self.workstream_id = _identifier(workstream_id, "workstream_id")
        self._lock = threading.RLock()

    def _ensure(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.directory, 0o700)

    def _files(self) -> list[Path]:
        self._ensure()
        return sorted(self.directory.glob("*.json"))

    def _read(self, target: Path) -> dict[str, Any]:
        return json.loads(target.read_text(encoding="utf-8"))

    def _target(self, resume_id: str, version: int) -> Path:
        return self.directory / f"{_identifier(resume_id, 'resume_id')}-v{int(version)}.json"

    def queue(self, packet: Mapping[str, Any], target_tokens: list[str]) -> dict[str, Any]:
        resume_id = _identifier(packet.get("resume_id"), "resume_id")
        version = int(packet.get("preview_version") or 0)
        if version < 1:
            raise ValueError("preview_version is invalid")
        if not target_tokens:
            raise ValueError("No Hermes session or gateway scope is available for safe injection")
        with self._lock:
            self._ensure()
            target = self._target(resume_id, version)
            if target.exists():
                existing = self._read(target)
                if existing.get("status") in {"pending", "in_flight", "delivered"}:
                    return existing
            now = utc_now()
            record = {
                "schema_version": "mnemuron-pending-resume-v0.1",
                "resume_id": resume_id,
                "preview_version": version,
                "idempotency_key": f"resume:{resume_id}:v{version}",
                "attempt_id": str(uuid.uuid4()),
                "injection_event_id": str(uuid.uuid4()),
                "injection_method": "hermes-pre-llm-call",
                "workstream_id": self.workstream_id,
                "text": build_resume_injection_text(packet),
                "target_tokens": sorted(set(target_tokens)),
                "status": "pending",
                "created_at": now,
                "updated_at": now,
                "expires_at": (datetime.now(timezone.utc) + timedelta(hours=PENDING_TTL_HOURS)).isoformat().replace("+00:00", "Z"),
            }
            _atomic_json_write(target, record)
            return record

    def claim(self, candidate_tokens: list[str], session_id: str,
              turn_id: Any = None) -> dict[str, Any] | None:
        candidates = set(candidate_tokens)
        with self._lock:
            for target in self._files():
                record = self._read(target)
                if record.get("status") == "delivered":
                    continue
                if _parse_utc(record["expires_at"]) <= datetime.now(timezone.utc):
                    continue
                if record.get("status") == "in_flight" and record.get("claimed_session_id") == session_id:
                    return record
                if record.get("status") != "pending":
                    continue
                if not candidates.intersection(record.get("target_tokens") or []):
                    continue
                now = utc_now()
                claimed = {
                    **record,
                    "attempt_id": record.get("attempt_id") or str(uuid.uuid4()),
                    "injection_event_id": record.get("injection_event_id") or str(uuid.uuid4()),
                    "injection_method": record.get("injection_method") or "hermes-pre-llm-call",
                    "workstream_id": record.get("workstream_id") or self.workstream_id,
                    "status": "in_flight",
                    "claimed_session_id": session_id,
                    "server_session_id": _session_identifier(session_id),
                    "claimed_turn_id": _turn_identifier(turn_id, session_id),
                    "injected_at": now,
                    "claimed_at": now,
                    "updated_at": now,
                }
                _atomic_json_write(target, claimed)
                return claimed
        return None

    def release(self, attempt_id: str) -> dict[str, Any] | None:
        with self._lock:
            for target in self._files():
                record = self._read(target)
                if record.get("status") != "in_flight" or record.get("attempt_id") != attempt_id:
                    continue
                record.update({
                    "status": "pending",
                    "claimed_session_id": None,
                    "server_session_id": None,
                    "claimed_turn_id": None,
                    "injected_at": None,
                    "claimed_at": None,
                    "updated_at": utc_now(),
                })
                _atomic_json_write(target, record)
                return record
        return None

    def fail(self, attempt_id: str, *,
             error_code: str = "central_attestation_unavailable",
             error_message: str = "The Mnemuron server did not confirm the injection declaration before context handoff.") -> dict[str, Any] | None:
        with self._lock:
            for target in self._files():
                record = self._read(target)
                if record.get("status") != "in_flight" or record.get("attempt_id") != attempt_id:
                    continue
                now = utc_now()
                failed = {
                    **record,
                    "failed_event_id": record.get("failed_event_id") or str(uuid.uuid4()),
                    "failed_at": now,
                    "error_code": error_code,
                    "error_message": error_message,
                }
                _atomic_json_write(target, self._retry_record(record, now))
                return {"phase": "failed", "record": failed}
        return None

    def _retry_record(self, record: Mapping[str, Any], now: str) -> dict[str, Any]:
        return {
            **record,
            "attempt_id": str(uuid.uuid4()),
            "injection_event_id": str(uuid.uuid4()),
            "acknowledged_event_id": None,
            "failed_event_id": None,
            "status": "pending",
            "claimed_session_id": None,
            "server_session_id": None,
            "claimed_turn_id": None,
            "injected_at": None,
            "claimed_at": None,
            "updated_at": now,
        }

    def finish(self, session_id: str, success: bool) -> list[dict[str, Any]]:
        finished: list[dict[str, Any]] = []
        with self._lock:
            for target in self._files():
                record = self._read(target)
                if record.get("status") != "in_flight" or record.get("claimed_session_id") != session_id:
                    continue
                now = utc_now()
                if success:
                    record.update({
                        "status": "delivered",
                        "acknowledged_event_id": record.get("acknowledged_event_id") or str(uuid.uuid4()),
                        "delivered_at": now,
                        "updated_at": now,
                    })
                    _atomic_json_write(target, record)
                    finished.append({"phase": "acknowledged", "record": record})
                else:
                    failed = {
                        **record,
                        "failed_event_id": record.get("failed_event_id") or str(uuid.uuid4()),
                        "failed_at": now,
                        "error_code": "agent_turn_failed",
                        "error_message": "Hermes reported that the Agent turn did not complete successfully.",
                    }
                    _atomic_json_write(target, self._retry_record(record, now))
                    finished.append({"phase": "failed", "record": failed})
        return finished

    def recover_in_flight(self) -> list[dict[str, Any]]:
        recovered: list[dict[str, Any]] = []
        with self._lock:
            for target in self._files():
                record = self._read(target)
                if record.get("status") != "in_flight":
                    continue
                now = utc_now()
                failed = {
                    **record,
                    "failed_event_id": record.get("failed_event_id") or str(uuid.uuid4()),
                    "failed_at": now,
                    "error_code": "adapter_restarted",
                    "error_message": "Hermes restarted before the matching session-end hook acknowledged this attempt.",
                }
                _atomic_json_write(target, self._retry_record(record, now))
                recovered.append({"phase": "failed", "record": failed})
        return recovered

    def counts(self) -> dict[str, int]:
        result = {"pending": 0, "in_flight": 0, "delivered": 0}
        with self._lock:
            for target in self._files():
                status_value = self._read(target).get("status")
                if status_value in result:
                    result[status_value] += 1
        return result


def injection_event_payload(record: Mapping[str, Any], phase: str) -> dict[str, Any]:
    if phase == "injected":
        event_id = record.get("injection_event_id")
        occurred_at = record.get("injected_at")
    elif phase == "acknowledged":
        event_id = record.get("acknowledged_event_id")
        occurred_at = record.get("delivered_at")
    elif phase == "failed":
        event_id = record.get("failed_event_id")
        occurred_at = record.get("failed_at")
    else:
        raise ValueError("phase is invalid")
    payload = {
        "event_id": _identifier(event_id, "event_id"),
        "attempt_id": _identifier(record.get("attempt_id"), "attempt_id"),
        "preview_version": int(record.get("preview_version") or 0),
        "phase": phase,
        "session_id": _identifier(record.get("server_session_id"), "session_id"),
        "turn_id": _identifier(record.get("claimed_turn_id"), "turn_id"),
        "workstream_id": _identifier(record.get("workstream_id"), "workstream_id"),
        "injection_method": _identifier(record.get("injection_method"), "injection_method"),
        "occurred_at": occurred_at,
    }
    if phase == "failed":
        payload["error_code"] = _identifier(
            record.get("error_code") or "agent_turn_failed", "error_code"
        )
        payload["error_message"] = record.get("error_message")
    return payload


def _tokens_match(record_tokens: Any, candidate_tokens: Any) -> bool:
    record_set = {str(value) for value in (record_tokens or [])}
    candidate_set = {str(value) for value in (candidate_tokens or [])}
    for kind in ("chat", "session", "user"):
        record_kind = {value for value in record_set if value.startswith(f"{kind}:")}
        candidate_kind = {value for value in candidate_set if value.startswith(f"{kind}:")}
        if record_kind and candidate_kind:
            return bool(record_kind.intersection(candidate_kind))
    return bool(record_set.intersection(candidate_set))


class TaskScopeStore:
    def __init__(self, directory: Path):
        self.directory = Path(directory)
        self._lock = threading.RLock()

    def _ensure(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.directory, 0o700)

    def _files(self) -> list[Path]:
        self._ensure()
        return sorted(self.directory.glob("*.json"))

    def _read(self, target: Path) -> dict[str, Any]:
        return json.loads(target.read_text(encoding="utf-8"))

    def _target(self, resume_id: str, version: int) -> Path:
        return self.directory / f"{_identifier(resume_id, 'resume_id')}-v{int(version)}.json"

    def stage(self, packet: Mapping[str, Any], target_tokens: list[str], workstream_id: str) -> dict[str, Any]:
        resume_id = _identifier(packet.get("resume_id"), "resume_id")
        version = int(packet.get("preview_version") or 0)
        project_id = _identifier((packet.get("project") or {}).get("project_id"), "project_id")
        task_id = _identifier((packet.get("task") or {}).get("task_id"), "task_id")
        target_workstream = _identifier(workstream_id, "workstream_id")
        if version < 1:
            raise ValueError("preview_version is invalid")
        if not target_tokens:
            raise ValueError("No Hermes conversation scope is available for task binding")
        with self._lock:
            self._ensure()
            target = self._target(resume_id, version)
            if target.exists():
                return self._read(target)
            now = utc_now()
            record = {
                "schema_version": "mnemuron-task-scope-v0.1",
                "resume_id": resume_id,
                "preview_version": version,
                "project_id": project_id,
                "task_id": task_id,
                "workstream_id": target_workstream,
                "target_tokens": sorted(set(target_tokens)),
                "active_tokens": [],
                "status": "pending",
                "created_at": now,
                "updated_at": now,
                "expires_at": (datetime.now(timezone.utc) + timedelta(hours=PENDING_TTL_HOURS)).isoformat().replace("+00:00", "Z"),
            }
            _atomic_json_write(target, record)
            return record

    def activate(self, candidate_tokens: list[str], session_id: str = "") -> dict[str, Any] | None:
        with self._lock:
            records = [(target, self._read(target)) for target in self._files()]
            now = utc_now()
            pending = [
                (target, record) for target, record in records
                if record.get("status") == "pending"
                and record.get("expires_at", "") > now
                and _tokens_match(record.get("target_tokens"), candidate_tokens)
            ]
            if not pending:
                return self.resolve(candidate_tokens)
            target, record = max(pending, key=lambda item: item[1].get("created_at", ""))
            for other_target, other in records:
                if other.get("status") != "active":
                    continue
                if not _tokens_match(other.get("active_tokens") or other.get("target_tokens"), candidate_tokens):
                    continue
                other.update({
                    "status": "superseded",
                    "superseded_by": record["resume_id"],
                    "updated_at": now,
                })
                _atomic_json_write(other_target, other)
            active = {
                **record,
                "status": "active",
                "active_tokens": sorted(set((record.get("target_tokens") or []) + candidate_tokens)),
                "active_session_id": session_id or None,
                "activated_at": now,
                "updated_at": now,
            }
            _atomic_json_write(target, active)
            return active

    def resolve(self, candidate_tokens: list[str]) -> dict[str, Any] | None:
        with self._lock:
            active = []
            for target in self._files():
                record = self._read(target)
                if record.get("status") != "active":
                    continue
                if _tokens_match(record.get("active_tokens") or record.get("target_tokens"), candidate_tokens):
                    active.append(record)
            return max(active, key=lambda record: record.get("activated_at", ""), default=None)

    def counts(self) -> dict[str, int]:
        result = {"pending": 0, "active": 0, "superseded": 0}
        with self._lock:
            for target in self._files():
                status_value = self._read(target).get("status")
                if status_value in result:
                    result[status_value] += 1
        return result


class MnemuronClient:
    def __init__(self, config: AdapterConfig):
        self.config = config
        self._lock = threading.RLock()

    def _api_key(self) -> str:
        mode = stat.S_IMODE(self.config.api_key_file.stat().st_mode)
        if mode & 0o077:
            raise PermissionError("Mnemuron API key file must use private permissions")
        key = self.config.api_key_file.read_text(encoding="utf-8").strip()
        if not key.startswith("mnm_"):
            raise ValueError("Mnemuron API key file is invalid")
        return key

    def request(self, method: str, endpoint: str, body: Any = None) -> dict[str, Any]:
        target = urllib.parse.urljoin(f"{self.config.server_url}/", endpoint.lstrip("/"))
        payload = None if body is None else json.dumps(_json_safe(body), ensure_ascii=False).encode("utf-8")
        headers = {"Authorization": f"Bearer {self._api_key()}", "Accept": "application/json"}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(target, data=payload, headers=headers, method=method)
        base = urllib.parse.urlsplit(self.config.server_url)
        resolved = urllib.parse.urlsplit(target)
        if (base.scheme, base.netloc) != (resolved.scheme, resolved.netloc):
            raise ValueError('Cross-origin request blocked')
        return request_json(request, self.config.request_timeout_seconds)

    def remember(self, body: Mapping[str, Any]) -> dict[str, Any]:
        operation_id = body.get("operation_id", str(uuid.uuid4()))
        if not isinstance(operation_id, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}", operation_id):
            raise ValueError("operation_id must be a non-empty ASCII identifier of at most 128 characters.")
        payload = {**body, "operation_id": operation_id}
        try:
            return self.request("POST", "/v1/memories", payload)
        except Exception as error:
            failure = RuntimeError(
                f"Memory save not confirmed; retry the same payload with operation_id={operation_id}. {error}"
            )
            failure.operation_id = operation_id
            failure.status_code = getattr(error, "status_code", None)
            failure.error_code = getattr(error, "error_code", None)
            raise failure from error

    def _outbox_files(self) -> list[Path]:
        self.config.outbox_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.config.outbox_dir, 0o700)
        return sorted(self.config.outbox_dir.glob("*.json"))

    def _queue(self, envelope: Mapping[str, Any]) -> None:
        event_id = _identifier(envelope["event"]["event_id"], "event_id")
        target = self.config.outbox_dir / f"{event_id}.json"
        immutable_envelope(target, envelope)

    def flush_outbox(self) -> dict[str, int]:
        with self._lock:
            return flush_queue(queue_items(self.config.outbox_dir, 'event'), root=self.config.outbox_dir.parent,
                credential=self.config.server_url+'|'+self._api_key(), predecessors=queue_items(self.config.injection_event_outbox_dir,'injection'), send=lambda item:self.request('POST','/v1/events',item['payload']))

    def _injection_event_files(self) -> list[Path]:
        directory = self.config.injection_event_outbox_dir
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(directory, 0o700)
        return sorted(directory.glob("*.json"))

    def queue_injection_event(self, record: Mapping[str, Any], phase: str) -> None:
        payload = injection_event_payload(record, phase)
        self._injection_event_files()
        target = self.config.injection_event_outbox_dir / f"{payload['event_id']}.json"
        immutable_envelope(target, {
            "resume_id": _identifier(record.get("resume_id"), "resume_id"),
            "payload": payload,
        })

    def flush_injection_event_outbox(self) -> dict[str, int]:
        with self._lock:
            return flush_queue(queue_items(self.config.injection_event_outbox_dir, 'injection'), root=self.config.outbox_dir.parent,
                credential=self.config.server_url+'|'+self._api_key(), predecessors=queue_items(self.config.outbox_dir,'event'), send=lambda item:self.request('POST',f"/v1/resume/{urllib.parse.quote(item['resume_id'],safe='')}/injection-events",item['payload']))

    def submit_injection_record(self, record: Mapping[str, Any], phase: str) -> dict[str, Any]:
        resume_id = _identifier(record.get("resume_id"), "resume_id")
        payload = injection_event_payload(record, phase)
        result = self.request(
            "POST", f"/v1/resume/{urllib.parse.quote(resume_id, safe='')}/injection-events",
            payload,
        )
        validate_acceptance('injection', {'resume_id':resume_id, 'payload':payload}, result)
        return result

    def submit_event(self, event: Mapping[str, Any]) -> dict[str, Any]:
        envelope = {"event": event, "raw_retention_days": self.config.raw_retention_days}
        with self._lock:
            self._queue(envelope)
            try:
                result = self.flush_outbox()
                queued = (self.config.outbox_dir / f"{event['event_id']}.json").exists()
                return {"delivery": "queued" if queued else "synchronized", "result": result}
            except Exception as error:
                self._queue(envelope)
                return {"delivery": "queued", "error": str(error)}

    def status(self) -> dict[str, Any]:
        flush = injection_flush = {"status": "not_run_read_only"}
        queued = len(self._outbox_files())
        queued_injection_events = len(self._injection_event_files())
        remote = self.request("GET", "/v1/status")
        pending = PendingResumeStore(
            self.config.pending_resume_dir, self.config.workstream_id
        ).counts()
        task_scopes = TaskScopeStore(self.config.task_scope_dir).counts()
        remote["server_reachable"] = True
        remote["adapter"] = {
            "mode": "hermes-native-v0.1",
            "queued_events": queued,
            "queued_injection_events": queued_injection_events,
            "sync_status": "pending" if queued or queued_injection_events else "synchronized",
            "injection_event_sync_status": "pending" if queued_injection_events else "synchronized",
            "last_flush": flush,
            "sync_state": queue_summary(queue_items(self.config.outbox_dir, 'event') + queue_items(self.config.injection_event_outbox_dir, 'injection'), self.config.outbox_dir.parent),
            "last_injection_event_flush": injection_flush,
            "local_identity": {
                "device_id": self.config.device_id,
                "agent_id": self.config.agent_id,
                "agent_instance_id": self.config.agent_instance_id,
            },
            "pending_resume_injections": pending,
            "task_scope_bindings": task_scopes,
        }
        return remote

    def event(self, event_type: str, hook_name: str, *, session_id: Any = None,
              turn_id: Any = None, content: Any = None, raw: Any = None,
              model: Any = None, tool_name: Any = None, tool_use_id: Any = None,
              cwd: Any = None, task_scope: Mapping[str, Any] | None = None) -> dict[str, Any]:
        raw_payload = _json_safe(raw)
        if isinstance(raw_payload, dict):
            raw_payload["mnemuron_task_scope"] = ({
                "schema_version": task_scope.get("schema_version"),
                "source": "confirmed-resume",
                "resume_id": task_scope.get("resume_id"),
                "preview_version": task_scope.get("preview_version"),
                "project_id": task_scope.get("project_id"),
                "task_id": task_scope.get("task_id"),
                "workstream_id": task_scope.get("workstream_id"),
                "activated_at": task_scope.get("activated_at"),
            } if task_scope else {"source": "adapter-default"})
        event = {
            "schema_version": "0.1.0",
            "event_id": str(uuid.uuid4()),
            "event_type": event_type,
            "hook_event_name": f"Hermes:{hook_name}",
            "captured_at": utc_now(),
            "project_id": (task_scope or {}).get("project_id") or self.config.project_id,
            "task_id": (task_scope or {}).get("task_id") or self.config.task_id,
            "workstream_id": (task_scope or {}).get("workstream_id") or self.config.workstream_id,
            "session_id": _session_identifier(session_id),
            "turn_id": str(turn_id) if turn_id else None,
            "cwd": str(cwd) if cwd else None,
            "model": str(model) if model else None,
            "tool_name": str(tool_name) if tool_name else None,
            "tool_use_id": str(tool_use_id) if tool_use_id else None,
            "provenance": {
                "device_id": self.config.device_id,
                "agent_id": self.config.agent_id,
                "agent_instance_id": self.config.agent_instance_id,
                "identity_status": "configured",
            },
            "capture_capability": {
                "user_messages": True,
                "assistant_messages": True,
                "tool_events": True,
                "session_lifecycle": True,
                "transcript_parser_used": False,
                "source": "hermes-native-plugin-hooks",
            },
            "raw_hook_payload": raw_payload,
        }
        if content is not None:
            event["content"] = _json_safe(content)
        return event


GATEWAY_SCOPE: contextvars.ContextVar[dict[str, Any]] = contextvars.ContextVar(
    "mnemuron_gateway_scope", default={}
)


def parse_command(raw_args: str) -> tuple[str, str]:
    text = (raw_args or "").strip()
    if not text:
        return "status", ""
    first, _, remainder = text.partition(" ")
    aliases = {
        "status": "status", "状态": "status",
        "continue": "continue", "resume": "continue", "继续": "continue",
        "confirm": "confirm", "确认": "confirm",
        "cancel": "cancel", "取消": "cancel",
        "remember": "remember", "记住": "remember",
        "help": "help", "帮助": "help",
    }
    action = aliases.get(first.lower())
    return (action, remainder.strip()) if action else ("continue", text)


def format_status(status_value: Mapping[str, Any]) -> str:
    identity = status_value.get("identity") or {}
    adapter = status_value.get("adapter") or {}
    counts = status_value.get("counts") or {}
    raw = status_value.get("raw_availability")
    raw_line = (
        "Raw：中心暂未提供可用性分类"
        if not raw
        else (
            f"Raw：{raw.get('raw_events_available', 0)} 可用 / "
            f"{raw.get('expired_events', 0)} 已过期 / "
            f"{raw.get('unexplained_raw_unavailable', 0)} 无法解释 / "
            f"状态 {raw.get('status', 'unknown')}"
        )
    )
    return "\n".join([
        f"Mnemuron：{status_value.get('mode')}",
        f"身份：{identity.get('agent_instance_id')}@{identity.get('device_id')} ({identity.get('identity_status')})",
        f"同步：{adapter.get('sync_status')}，队列 {adapter.get('queued_events')}",
        f"数据：{counts.get('events', 0)} Event / {counts.get('checkpoints', 0)} Checkpoint / {counts.get('tasks', 0)} Task",
        raw_line,
    ])


def format_preview(preview: Mapping[str, Any]) -> str:
    if preview.get("status") != "pending_confirmation":
        return json.dumps(preview, ensure_ascii=False, indent=2)
    checkpoints = preview.get("latest_checkpoints") or []
    lines = [
        "Mnemuron Resume Preview（尚未确认）",
        f"项目：{(preview.get('project') or {}).get('name')}",
        f"任务：{(preview.get('task') or {}).get('title')}",
        f"任务状态：{(preview.get('task') or {}).get('status')}",
        f"目标：{(preview.get('task') or {}).get('goal')}",
        f"进度：{'；'.join(preview.get('progress') or []) or '无'}",
        f"阻塞：{'；'.join(preview.get('blockers') or []) or '无'}",
        f"下一步：{'；'.join(preview.get('next_steps') or []) or '无'}",
    ]
    for checkpoint in checkpoints:
        lines.append(
            f"Checkpoint：v{checkpoint.get('version')} / {checkpoint.get('workstream_id')} / "
            f"{(checkpoint.get('provenance') or {}).get('agent_instance_id')}@"
            f"{(checkpoint.get('provenance') or {}).get('device_id')}"
        )
    if not checkpoints:
        lines.append("Checkpoint：无；当前 Preview 来自任务、显式记忆和最近活动。")
    lines.extend([
        f"Resume ID：{preview.get('resume_id')}",
        f"版本：{preview.get('preview_version')}",
        f"有效期至：{preview.get('expires_at')}（30 分钟内确认）",
        f"确认：/mnemuron confirm {preview.get('resume_id')} {preview.get('preview_version')}",
        "确认前不会注入 Resume Packet。",
    ])
    return "\n".join(lines)
