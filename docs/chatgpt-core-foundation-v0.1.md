# ChatGPT Core Foundation v0.1

> Public specification and example configuration only. Personal deployment records and acceptance evidence are retained privately. This document is not proof of production readiness; `production_ready=false` remains the release boundary.

## Status and acceptance boundary

The ChatGPT core covers Project Bootstrap, exact current-Session attestation, serialized Resume delivery, whole-turn binding, and durable Stop ACK. Compaction must preserve an in-flight Receipt and its Task/Workstream provenance. Actual startup/resume recovery remains distinct from `SessionStart(source=compact)`.

Real acceptance must independently verify compaction, matching Stop ACK, and subsequent-turn non-reinjection for each supported client. Results from one client cannot establish another client's acceptance.

## Project and first Canonical Task

The new-Project path is explicit and side-effect bounded:

1. `mnemuron_preview_project_bootstrap` freezes one proposed Project, its first Canonical Task, and the local destination Workstream. It does not create business objects or change Task Scope.
2. Matching, ambiguous, identifier-colliding, or competing pending Project proposals fail closed. A filesystem path alone is not sufficient evidence of an existing Project.
3. A separate `mnemuron_confirm_project_bootstrap` call must present the exact Bootstrap ID, Preview version, Credential, and Session.
4. Positive confirmation atomically creates the Project, initial active Canonical Task v1, initial Workstream, canonical revision, confirmation record, and audit record.
5. The plugin does not return the server binding packet to the model. It stages a local `task_bootstrap` Scope as `pending`; the next ordinary `UserPromptSubmit` activates it.
6. This path creates no Resume, Injection Event, Delivery Receipt, Checkpoint, or Memory, and never rebinds historical Events.

HTTP(S), SSH URL, and SCP-style Git remotes are canonicalized before persistence. URL credentials, passwords, query parameters, and fragments are not frozen into Preview, Project, or audit state. Project Bootstrap uses independent preview/confirm scopes; Agent credentials receive them only through an explicit administrator scope update.

## Exact current-Session gate

Session-taking MCP tools require a valid local Hook attestation for the supplied Session. When `CODEX_THREAD_ID` or `CODEX_SESSION_ID` is available, the supplied ID must equal the current runtime ID; if the two runtime identifiers disagree, the operation fails closed. A valid attestation from an older conversation is therefore insufficient to Preview, Confirm, stage, or take delivery in the current conversation.

This cross-check applies to Resume confirmation/delivery and both Task and Project Bootstrap paths. Server-side Credential, Preview version, and target Session checks remain a separate second boundary.

## Resume delivery linearization

Resume delivery is serialized by an atomic filesystem lock scoped to the exact Session and shared across MCP server processes. The lock carries a random owner token and process identity; only the current owner may release it. A concurrent loser returns `delivery_in_progress` without a Resume Packet. Live-lock recovery is deferred, dead owners are recoverable, and stale-lock replacement cannot be removed by the previous owner.

After claiming a Resume, the plugin submits the exact `delivered` Receipt to Mnemuron server and validates the returned Resume ID, Preview version, Receipt ID, `in_flight` state, and incomplete ACK state before activating Scope or returning context. A terminal or mismatched 2xx response becomes `delivery_reconciliation_required`; it does not inject or activate.

## Whole-turn binding safety

An ordinary turn that has an unreturned MCP Resume is kept unbound until authoritative context is actually returned. If delivery is deferred or reconciliation is required, its UserPrompt, tool Events, assistant Stop, and other Hook Events do not inherit an older active Scope. This prevents a failed delivery turn from being attributed to the wrong Task.

On a successful retry, the opening UserPrompt remains unbound because it occurred before the tool returned context. Subsequent tool and Stop Events in that turn use the exact activated Resume Scope. Task Bootstrap activation remains next-ordinary-turn only and cannot pre-empt an unresolved Resume.

## Multiple pending items and ordering

Different Sessions remain independent. Within one Session:

- multiple Resume deliveries are retained rather than overwritten;
- at most one Resume is in flight and successful deliveries are processed in FIFO order;
- repeated take calls for the current in-flight item reuse its Receipt and do not return context twice;
- a later Task Bootstrap is the only Bootstrap activated, while older pending Bootstrap bindings become superseded;
- exact Resume activation supersedes same-Session pending Bootstrap bindings but leaves other Sessions untouched.

Ordering uses delivery declaration/arming/creation timestamps, then stable identifiers to provide a deterministic total order. When two records receive the same millisecond timestamp, the identifier tie-break is deterministic but is not a persisted causal sequence. This is the remaining P3: strict real-arrival FIFO inside a same-millisecond tie is not guaranteed. A future monotonic per-Session sequence can close it without weakening current isolation or at-most-once context return.

## Durable Stop ACK

The Stop Hook first records a Session-, turn-, Receipt-, Resume-, Preview-, Attempt-, and Workstream-bound ACK intent. Under the same Session delivery lock, that intent can finish only the exact in-flight delivery whose context was returned.

Before network submission, the delivery file is advanced to `delivered` with `delivery_ack_pending=true` and the exact acknowledged payload persisted as a local journal. If a process exits after this point, the next matching SessionStart replays the journal once. Lock contention preserves the pending intent for the owning Session; another Session cannot consume it, and recovery of an old Attempt cannot ACK a replacement Receipt.

## Release acceptance

- Verify the installed and running plugin versions, trusted Hooks, and source hashes for each client.
- Complete a real Project + initial Canonical Task Preview → Confirm → next-turn binding and persistence check.
- Complete Resume delivery, compaction, terminal ACK, and subsequent-turn non-reinjection checks.
- Evaluate the same-millisecond ordering limitation before promotion.
- Validate OpenClaw and Hermes separately if included in the release scope, and retain `production_ready=false` until every release gate passes.
