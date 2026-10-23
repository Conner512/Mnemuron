# Bounded Hook synchronization and forward-only capture

The optional local client setting `background_sync: true` moves ordinary outbox
uploads out of synchronous Hook execution. Each Hook durably enqueues its event
and any real Stop ACK before starting a detached pump. The pump is single-owner,
lasts at most 60 seconds, and uses existing per-session ordering, retry state and
exact server receipt validation. A stopped pump retains unacknowledged records;
the next Hook starts recovery. It is not an always-on service. Auth/protocol and
receipt mismatches remain blocked, not silently reset.

Resume injection still requires the central declaration to succeed. Preview,
explicit confirmation, next-turn arming, Session ownership and real Stop turn IDs
are unchanged. Background upload does not authorize injection or task switching.

The server optionally accepts this private runtime configuration:

```json
{
  "memory": {
    "capture_extraction": {
      "enabled": true,
      "conversation": {
        "enabled": true,
        "user_ids": ["example-owner"],
        "after": "2030-01-01T00:00:00.000Z",
        "max_chars": 600
      }
    }
  }
}
```

This is conservative extractive capture, not model-powered semantic memory.
Only direct affirmative user statements matching bounded rules are retained,
with exact source spans, source versions, medium confidence and an explicit
unverified-statement warning. Questions, requests, confirmations, code/quoted
content, credential-like text and uncertain claims are excluded. It does not
cover all natural language and is not a complete secret detector. Existing
explicit memory operations remain available.

Both captured and received timestamps must follow activation. Owner selection
uses the trusted credential identity, not client-supplied user IDs. Historical
checkpoint processing does not activate conversation capture. The default is
off. Existing labeled extraction is preserved; Markdown-bold labels are now
recognized with a distinct extraction version. Original records and lifecycle
are not overwritten. No database migration, model service or vector index is
required. Generated memories remain subject to existing per-record Web visibility
and owner isolation; no new ChatGPT Web grants are made automatically.

Regression evidence: `plugins/mnemuron/test/background-sync.test.mjs` covers slow
transport, concurrent capture, false receipt retention, killed-pump recovery and
Stop ACK ownership. `server/test/conversation-capture.test.mjs` covers exact spans,
deduplication, opt-in activation, owner/Web isolation and rejected inputs.
