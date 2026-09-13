"""Native Hermes entrypoint for Mnemuron."""

from __future__ import annotations

import json
import logging
from typing import Any, Mapping

from .client import (
    AdapterConfig,
    GATEWAY_SCOPE,
    MnemuronClient,
    PendingResumeStore,
    TaskScopeStore,
    format_preview,
    format_status,
    parse_command,
    scope_tokens,
)


LOGGER = logging.getLogger(__name__)


STATUS_SCHEMA = {
    "name": "mnemuron_status",
    "description": "Show Mnemuron server identity, capture counts, checkpoints, and local synchronization state.",
    "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
}
PREVIEW_SCHEMA = {
    "name": "mnemuron_preview_resume",
    "description": "Create an immutable Resume Preview. Never confirms or injects a Resume Packet.",
    "parameters": {
        "type": "object",
        "properties": {"query": {"type": "string", "description": "Task name or exact task ID."}},
        "required": ["query"],
        "additionalProperties": False,
    },
}
CONFIRM_SCHEMA = {
    "name": "mnemuron_confirm_resume",
    "description": "Confirm or cancel an already displayed Resume Preview using its exact ID and version.",
    "parameters": {
        "type": "object",
        "properties": {
            "resume_id": {"type": "string"},
            "preview_version": {"type": "integer", "minimum": 1},
            "confirmed": {"type": "boolean"},
        },
        "required": ["resume_id", "preview_version", "confirmed"],
        "additionalProperties": False,
    },
}
REMEMBER_SCHEMA = {
    "name": "mnemuron_remember",
    "description": "Explicitly save a fact, decision, constraint, or next step. Reuse operation_id and the same payload when retrying an uncertain save; separate saves use separate keys.",
    "parameters": {
        "type": "object",
        "properties": {
            "content": {"type": "string"},
            "scope": {"type": "string", "enum": ["user", "project", "task", "workstream", "session"]},
            "project_id": {"type": "string"},
            "task_id": {"type": "string"},
            "workstream_id": {"type": "string"},
            "session_id": {"type": "string"},
            "operation_id": {"type": "string", "minLength": 1, "maxLength": 128, "pattern": "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$"},
        },
        "required": ["content", "scope"],
        "additionalProperties": False,
    },
}


class PluginRuntime:
    SETTING_DEFAULTS = {
        "server_url": "",
        "api_key_file": "",
        "outbox_dir": "~/.hermes/mnemuron/outbox",
        "pending_resume_dir": "~/.hermes/mnemuron/pending-resume",
        "task_scope_dir": "~/.hermes/mnemuron/task-scopes",
        "device_id": "hermes-host",
        "agent_id": "hermes",
        "agent_instance_id": "hermes-local",
        "project_id": "project-mnemuron",
        "task_id": "task-mnemuron-hermes-adapter-v01",
        "workstream_id": "workstream-hermes",
        "raw_retention_days": 30,
        "request_timeout_seconds": 5,
        "allow_insecure_http": False,
    }

    def __init__(self, ctx):
        self.ctx = ctx

    def config(self) -> AdapterConfig:
        values = {
            key: self.ctx.get_config(key, default)
            for key, default in self.SETTING_DEFAULTS.items()
        }
        return AdapterConfig.from_mapping(values)

    def client(self) -> MnemuronClient:
        return MnemuronClient(self.config())

    def pending(self) -> PendingResumeStore:
        config = self.config()
        return PendingResumeStore(config.pending_resume_dir, config.workstream_id)

    def task_scopes(self) -> TaskScopeStore:
        return TaskScopeStore(self.config().task_scope_dir)

    def _scope_tokens(self, *, session_id: Any = None, platform: Any = "", sender_id: Any = "") -> list[str]:
        gateway = list(GATEWAY_SCOPE.get({}).get("tokens") or [])
        current = scope_tokens(platform=platform, user_id=sender_id, session_id=session_id)
        return list(dict.fromkeys(gateway + current))

    def _capture(self, event_type: str, hook_name: str, *, task_scope: Mapping[str, Any] | None = None, **payload: Any) -> None:
        try:
            client = self.client()
            if task_scope is None:
                tokens = self._scope_tokens(
                    session_id=payload.get("session_id"),
                    platform=(payload.get("raw") or {}).get("platform") if isinstance(payload.get("raw"), dict) else "",
                )
                task_scope = self.task_scopes().resolve(tokens)
            event = client.event(event_type, hook_name, task_scope=task_scope, **payload)
            result = client.submit_event(event)
            if result.get("delivery") == "queued":
                LOGGER.warning("Mnemuron queued %s for retry: %s", hook_name, result.get("error"))
        except Exception as error:
            LOGGER.warning("Mnemuron %s capture failed: %s", hook_name, error)

    def pre_gateway_dispatch(self, *, event=None, **_kwargs):
        source = getattr(event, "source", None)
        platform = getattr(source, "platform", "")
        GATEWAY_SCOPE.set({
            "tokens": scope_tokens(
                platform=platform,
                chat_id=getattr(source, "chat_id", ""),
                user_id=getattr(source, "user_id", ""),
            ),
            "platform": str(getattr(platform, "value", platform) or ""),
        })
        return {"action": "allow"}

    def on_session_start(self, **kwargs):
        tokens = self._scope_tokens(
            session_id=kwargs.get("session_id"), platform=kwargs.get("platform") or "",
        )
        task_scope = self.task_scopes().activate(tokens, str(kwargs.get("session_id") or ""))
        self._capture(
            "session_start", "on_session_start",
            task_scope=task_scope,
            session_id=kwargs.get("session_id"),
            turn_id=kwargs.get("turn_id"),
            content={"platform": kwargs.get("platform"), "model": kwargs.get("model")},
            raw=kwargs,
            model=kwargs.get("model"),
        )

    def pre_llm_call(self, **kwargs):
        session_id = str(kwargs.get("session_id") or "")
        platform = kwargs.get("platform") or ""
        sender_id = kwargs.get("sender_id") or ""
        candidates = self._scope_tokens(session_id=session_id, platform=platform, sender_id=sender_id)
        task_scope = self.task_scopes().activate(candidates, session_id)
        self._capture(
            "user_message", "pre_llm_call",
            task_scope=task_scope,
            session_id=session_id,
            turn_id=kwargs.get("turn_id"),
            content=kwargs.get("user_message"),
            raw={
                "session_id": session_id,
                "task_id": kwargs.get("task_id"),
                "turn_id": kwargs.get("turn_id"),
                "user_message": kwargs.get("user_message"),
                "is_first_turn": kwargs.get("is_first_turn"),
                "model": kwargs.get("model"),
                "platform": platform,
                "parent_session_id": kwargs.get("parent_session_id"),
                "sender_id_present": bool(sender_id),
            },
            model=kwargs.get("model"),
        )
        pending_store = self.pending()
        client = self.client()
        try:
            client.flush_injection_event_outbox()
        except Exception as error:
            LOGGER.warning("Mnemuron injection-event synchronization unavailable: %s", error)
            return None
        pending = pending_store.claim(candidates, session_id, kwargs.get("turn_id"))
        if pending:
            try:
                client.submit_injection_record(pending, "injected")
            except Exception as error:
                failed = pending_store.fail(
                    str(pending.get("attempt_id") or ""),
                    error_message=f"The Mnemuron server did not confirm the injection declaration: {error}",
                )
                if failed:
                    client.queue_injection_event(failed["record"], failed["phase"])
                LOGGER.warning("Mnemuron Resume injection deferred: %s", error)
                return None
            LOGGER.info(
                "Mnemuron injecting confirmed Resume Packet %s v%s",
                pending.get("resume_id"), pending.get("preview_version"),
            )
            return {"context": pending["text"]}
        return None

    def post_llm_call(self, **kwargs):
        self._capture(
            "assistant_message", "post_llm_call",
            session_id=kwargs.get("session_id"),
            turn_id=kwargs.get("turn_id"),
            content=kwargs.get("assistant_response"),
            raw={
                "session_id": kwargs.get("session_id"),
                "task_id": kwargs.get("task_id"),
                "turn_id": kwargs.get("turn_id"),
                "user_message": kwargs.get("user_message"),
                "assistant_response": kwargs.get("assistant_response"),
                "model": kwargs.get("model"),
                "platform": kwargs.get("platform"),
            },
            model=kwargs.get("model"),
        )

    def post_tool_call(self, **kwargs):
        self._capture(
            "tool_result", "post_tool_call",
            session_id=kwargs.get("session_id"),
            turn_id=kwargs.get("turn_id"),
            content={
                "tool_name": kwargs.get("tool_name"),
                "args": kwargs.get("args"),
                "result": kwargs.get("result"),
                "status": kwargs.get("status"),
                "error_type": kwargs.get("error_type"),
                "error_message": kwargs.get("error_message"),
                "duration_ms": kwargs.get("duration_ms"),
            },
            raw=kwargs,
            tool_name=kwargs.get("tool_name"),
            tool_use_id=kwargs.get("tool_call_id"),
        )

    def on_session_end(self, **kwargs):
        session_id = str(kwargs.get("session_id") or "")
        success = bool(kwargs.get("completed")) and not bool(kwargs.get("failed")) and not bool(kwargs.get("interrupted"))
        self._capture(
            "session_end", "on_session_end",
            session_id=session_id,
            turn_id=kwargs.get("turn_id"),
            # The complete lifecycle result remains in raw_hook_payload.
            # Empty content lets the server skip a redundant session_end checkpoint.
            # after post_llm_call already created the meaningful turn snapshot.
            content=None,
            raw=kwargs,
            model=kwargs.get("model"),
        )
        try:
            finished = self.pending().finish(session_id, success)
            client = self.client() if finished else None
            for item in finished:
                try:
                    client.submit_injection_record(item["record"], item["phase"])
                except Exception as error:
                    client.queue_injection_event(item["record"], item["phase"])
                    LOGGER.warning("Mnemuron queued Resume %s event: %s", item["phase"], error)
        except Exception as error:
            LOGGER.warning("Mnemuron Resume injection acknowledgement failed: %s", error)

    def status_tool(self, _args, **_kwargs) -> str:
        return json.dumps(self.client().status(), ensure_ascii=False, indent=2)

    def preview_tool(self, args, **_kwargs) -> str:
        query = str(args.get("query") or "").strip()
        if not query:
            raise ValueError("query is required")
        return json.dumps(self.client().request("POST", "/v1/resume/preview", {"query": query}), ensure_ascii=False, indent=2)

    def confirm_tool(self, args, **kwargs) -> str:
        resume_id = str(args.get("resume_id") or "")
        version = int(args.get("preview_version") or 0)
        confirmed = bool(args.get("confirmed"))
        result = self.client().request(
            "POST", f"/v1/resume/{urllib_quote(resume_id)}/confirm",
            {"preview_version": version, "confirmed": confirmed},
        )
        if confirmed and result.get("resume_packet"):
            session_id = str(kwargs.get("session_id") or "")
            target = scope_tokens(platform="hermes", session_id=session_id)
            self.task_scopes().stage(result["resume_packet"], target, self.config().workstream_id)
            queued = self.pending().queue(result["resume_packet"], target)
            result["adapter_injection"] = {
                "status": queued.get("status"),
                "message": "Send one ordinary message such as 继续 to inject this Packet once.",
            }
        return json.dumps(result, ensure_ascii=False, indent=2)

    def remember_tool(self, args, **kwargs) -> str:
        config = self.config()
        tokens = self._scope_tokens(session_id=kwargs.get("session_id"))
        active_scope = self.task_scopes().resolve(tokens) or {}
        explicit_target = any(args.get(field) is not None for field in ["project_id", "task_id", "workstream_id"])
        body = {
            **args,
            "project_id": args.get("project_id") if explicit_target else active_scope.get("project_id") or config.project_id,
            "task_id": args.get("task_id") if explicit_target else active_scope.get("task_id") or config.task_id,
            "workstream_id": args.get("workstream_id") if explicit_target else active_scope.get("workstream_id") or config.workstream_id,
            "session_id": args.get("session_id") or kwargs.get("session_id"),
            "source": "explicit-hermes",
        }
        return json.dumps(self.client().remember(body), ensure_ascii=False, indent=2)

    def command(self, raw_args: str) -> str:
        action, rest = parse_command(raw_args)
        client = self.client()
        if action == "help":
            return "\n".join([
                "/mnemuron status",
                "/mnemuron continue <任务>",
                "/mnemuron confirm <resume_id> <version>",
                "/mnemuron cancel <resume_id> <version>",
                "/mnemuron remember [--operation-id <id>] <内容>",
            ])
        if action == "status":
            return format_status(client.status())
        if action == "continue":
            if not rest:
                return "请提供任务名称：/mnemuron continue <任务>"
            return format_preview(client.request("POST", "/v1/resume/preview", {"query": rest}))
        if action == "remember":
            if not rest:
                return "请提供要保存的内容：/mnemuron remember <内容>"
            operation = {}
            if rest.startswith("--operation-id"):
                parts = rest.split(maxsplit=2)
                if len(parts) != 3 or parts[0] != "--operation-id":
                    return "用法：/mnemuron remember --operation-id <id> <原内容>"
                operation["operation_id"] = parts[1]
                rest = parts[2]
            config = self.config()
            active_scope = self.task_scopes().resolve(list(GATEWAY_SCOPE.get({}).get("tokens") or [])) or {}
            saved = client.remember({
                "content": rest,
                **operation,
                "scope": "task",
                "project_id": active_scope.get("project_id") or config.project_id,
                "task_id": active_scope.get("task_id") or config.task_id,
                "workstream_id": active_scope.get("workstream_id") or config.workstream_id,
                "source": "explicit-hermes-command",
            })
            return f"已保存到 Mnemuron：{(saved.get('memory') or {}).get('memory_id')}"
        pieces = rest.split()
        if len(pieces) != 2:
            return f"/mnemuron {action} <resume_id> <version>"
        resume_id, version_text = pieces
        try:
            version = int(version_text)
        except ValueError:
            return f"/mnemuron {action} <resume_id> <version>"
        confirmed = action == "confirm"
        result = client.request(
            "POST", f"/v1/resume/{urllib_quote(resume_id)}/confirm",
            {"preview_version": version, "confirmed": confirmed},
        )
        if not confirmed:
            return f"Resume Preview 已取消：{resume_id}"
        packet = result.get("resume_packet")
        if not packet:
            return "Resume Packet 未返回，未进入本地注入队列。"
        tokens = list(GATEWAY_SCOPE.get({}).get("tokens") or [])
        try:
            self.task_scopes().stage(packet, tokens, self.config().workstream_id)
            queued = self.pending().queue(packet, tokens)
        except ValueError:
            return (
                "Resume Packet 已确认，但当前命令没有安全的会话作用域，未进入注入队列。"
                "请在普通对话中调用确认工具重试。"
            )
        if queued.get("status") == "delivered":
            return "Resume Packet 已在此前的 Hermes 轮次中完成注入，无需重复恢复。"
        return "Resume Packet 已确认并进入待恢复队列。请发送普通消息“继续”，它会在下一轮一次性注入。"

    def safe_command(self, raw_args: str) -> str:
        try:
            return self.command(raw_args)
        except Exception as error:
            if getattr(error, "operation_id", None):
                status = getattr(error, "status_code", None)
                outcome = (
                    f"保存请求被拒绝 ({getattr(error, 'error_code', None) or status})"
                    if status and status < 500 else "保存结果尚未确认"
                )
                return (
                    f"{outcome}；如需重试，请在同一任务和会话使用 "
                    f"/mnemuron remember --operation-id {error.operation_id} <原内容>。"
                )
            message = str(error).replace("\n", " ").strip()
            LOGGER.warning("Mnemuron command failed: %s", message[:300])
            lowered = message.lower()
            if "preview expired" in lowered:
                return "Resume Preview 已过期，无需取消或确认。请重新创建并检查一份新的 Preview。"
            if "version changed" in lowered:
                return "Resume Preview 版本已变化，请重新创建并检查一份新的 Preview。"
            if "already cancelled" in lowered:
                return "Resume Preview 已取消，请重新创建并检查一份新的 Preview。"
            if "already confirmed" in lowered:
                return "Resume Preview 已确认，无需重复确认。"
            return f"Mnemuron 命令执行失败：{message[:240] or type(error).__name__}"


def urllib_quote(value: str) -> str:
    from urllib.parse import quote
    return quote(value, safe="")


def register(ctx) -> None:
    runtime = PluginRuntime(ctx)
    try:
        recovered = runtime.pending().recover_in_flight()
        client = runtime.client()
        for item in recovered:
            try:
                client.submit_injection_record(item["record"], item["phase"])
            except Exception:
                client.queue_injection_event(item["record"], item["phase"])
        client.flush_injection_event_outbox()
        if recovered:
            LOGGER.info("Mnemuron recovered %s pending Resume injection(s)", len(recovered))
    except Exception as error:
        LOGGER.warning("Mnemuron startup recovery unavailable: %s", error)

    ctx.register_tool("mnemuron_status", "mnemuron", STATUS_SCHEMA, runtime.status_tool, description=STATUS_SCHEMA["description"], emoji="🧠")
    ctx.register_tool("mnemuron_preview_resume", "mnemuron", PREVIEW_SCHEMA, runtime.preview_tool, description=PREVIEW_SCHEMA["description"], emoji="👁️")
    ctx.register_tool("mnemuron_confirm_resume", "mnemuron", CONFIRM_SCHEMA, runtime.confirm_tool, description=CONFIRM_SCHEMA["description"], emoji="✅")
    ctx.register_tool("mnemuron_remember", "mnemuron", REMEMBER_SCHEMA, runtime.remember_tool, description=REMEMBER_SCHEMA["description"], emoji="💾")
    ctx.register_command(
        "mnemuron", runtime.safe_command,
        description="查看或恢复 Mnemuron 跨 Agent 任务",
    )
    ctx.register_hook("pre_gateway_dispatch", runtime.pre_gateway_dispatch)
    ctx.register_hook("on_session_start", runtime.on_session_start)
    ctx.register_hook("pre_llm_call", runtime.pre_llm_call)
    ctx.register_hook("post_llm_call", runtime.post_llm_call)
    ctx.register_hook("post_tool_call", runtime.post_tool_call)
    ctx.register_hook("on_session_end", runtime.on_session_end)
    ctx.register_system_prompt_section(
        "mnemuron.handoff",
        (
            "For task continuation, create a Mnemuron Resume Preview first. Never confirm a Preview "
            "in the same turn. When a confirmed Mnemuron Resume Packet is present in the current "
            "user context, continue directly from it and do not preview or confirm it again."
        ),
        position="after_memory",
        max_chars=700,
    )
