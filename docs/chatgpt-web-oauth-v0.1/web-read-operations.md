# Read-only memory operations

This workflow keeps Web memory reading separate from local capture, writes,
project restoration and handoff. It adds no service, dependency or new OAuth
scope. Existing private memories are not automatically approved.

## Review and grant one memory

Use the existing private Core configuration and local administrator environment,
outside the checkout. Never put a credential in a command argument or give an
administrator key to the Web gateway.

1. Review the exact memory in a trusted local reader.
2. Inspect its current revision, state hash and classification.
3. Grant only that reviewed version. If it changed, review it again.

```bash
node server/bin/mnemuron-admin.mjs memory-web-visibility --memory MEMORY_ID --inspect
node server/bin/mnemuron-admin.mjs memory-web-visibility \
  --memory MEMORY_ID --revision REVIEWED_REVISION --state-hash REVIEWED_STATE_HASH --allow
node server/bin/mnemuron-admin.mjs memory-web-visibility --list --limit 20
```

The inventory contains metadata only. Follow its `next_request` using `--after`
and `--limit`; it lists explicit grants, not all memories or publicly classified
records. There is no wildcard grant or automatic historical approval.

Use `--deny` with the current revision/hash to remove an explicit grant. Updates,
retractions and privacy changes invalidate grants automatically. `secret` cannot
be granted. A `public` record is eligible through its classification; restricting
it requires changing that classification locally, not merely deleting a grant.

Revocation blocks subsequent requests. It cannot erase text already delivered
to ChatGPT or another client, including content retained in an existing chat.

## Inspect individual reads

The Web gateway emits versioned `web-read-audit-v1` JSON records to its existing
log sink. Configure retention and operator access through the host's normal log
management; this feature creates no additional database or background service.

Each record can include the server-generated request ID, timestamp, tool, status,
latency, an authenticated connection hash, exact memory IDs/revisions, body-page
offset/length and completion flags. Search/summary references are bounded and
explicitly mark incomplete audit coverage. No query, memory body, claim quote,
credential, raw OAuth subject, provider configuration or pagination cursor is
logged. Unknown legacy revisions remain `null`, not invented values.

`connection_id` hashes the verified issuer, OAuth client and immutable subject.
It identifies that authenticated client/account combination, **not a physical
device, browser tab or individual refresh-token family**. Different terminals
using the same OAuth identity cannot be distinguished by this evidence. Caller
`_meta` and claimed device names do not establish identity.

Inspect existing JSONL logs or a system journal export offline:

```bash
journalctl -u YOUR_WEB_UNIT -o json --since today |
  node adapters/chatgpt-web/bin/read-audit.mjs --memory MEMORY_ID --limit 20
```

The viewer accepts optional `--request` and `--connection` filters, projects an
allowlist again, and reports ignored lines and truncated results. It does not
open a database, read memory contents or contact a server. Legacy unversioned logs
are ignored rather than upgraded into stronger evidence.

`read_outcome=success` means the tool produced a valid result.
`transport_outcome=response_finished` means the HTTP response completed locally;
`connection_closed` records an interrupted connection. Neither proves client
consumption: `client_consumption_verified` is always false. A failed or unexecuted
request must not be counted as a completed memory read.

## Real-client acceptance

After deploying the reviewed candidate, refresh the existing connection's tool
metadata and test in a new conversation, following the
[official refresh workflow](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata).
Verify the actual advertised schema, not only `auth_status`.

Use a clearly synthetic, individually granted fixture:

1. Search for its exact marker; check the returned ID and revision.
2. Fetch with a small `content_limit` to force multiple pages. Follow the returned
   `next_request` unchanged until null and `content_complete=true`; source
   pagination has a separate continuation.
3. Repeat a fresh search/read in another new conversation; compare ID/revision.
4. Revoke only the fixture's local Web grant. A new search must omit it and a new
   detail request must fail closed. Cached text in a previous chat is not a test.
5. Correlate the real client calls with request-level audit records, keeping
   operator/SDK probes separate. Record OAuth-token revocation separately from
   per-memory grant revocation.

Keep account-specific IDs, screenshots, deployment details and logs in a private
evidence directory outside Git. Publish only source, synthetic tests and sanitized
results. Do not push private backup references, runtime data or all Git refs.

Passing these checks establishes the tested read-only path, not global
`production_ready`, Web writing, project recovery or handoff readiness.
