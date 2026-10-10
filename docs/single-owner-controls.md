# Single-owner Console controls

`console.owner_user_id` (Core) and `identity.owner_account_id` (OAuth) explicitly bind the existing owner. Identity storage remains `multi_account_v1`; MFA, CSRF, current sessions, credential binding and existing scopes remain mandatory. Owner mode blocks other Console accounts and new registration. Invitation issuance stays in the existing server CLI.

The existing `/app/system`, `/console-api/system-health`, and `/console-api/action` expose controls. No ingress or public MCP scope changes are needed. Model secrets stay write-only; trusted origins, infrastructure and OS privileges remain deployment controls.

Before enabling owner configuration, run `server/bin/mnemuron-owner-migrate.mjs` against the private Core database and configuration with the exact user ID and `--apply-paused`. The caller must first verify the exact single active, MFA-verified, bound OAuth account. The migration adds policy, runs, frozen items and job associations, with lifecycle protection triggers. It does not modify existing outbox records, model settings or usage counters. It initializes all five processing switches and automatic scheduling off; non-processing settings retain their approved baseline.

Feature and schedule saves require fresh password plus OTP. Saving feature flags pauses existing execution grants. A manual run requires an inert, bounded preview (at most 100 records), then explicit confirmation of its frozen revision/hash digest, model revision and hard call budget. A grant is bound to its authorizing Console credential, policy revision and lifecycle generation. Every claim, network request and publication rechecks relevant authority. Existing jobs without grants cannot be claimed. Cancellation fences leases; data already sent cannot be recalled, but late output cannot publish.

Automatic rules are explicit grants for newly created rows after the save's rowid high-water mark. Old revisions/outbox replays are excluded. Each run remains bounded and also consumes existing model quotas. A model revision change disables the rule with a visible blocker until another explicit save. Vector generations build frozen manifests and require separate activation. Query egress is separately controlled and budgeted.

Read policy can be narrowed or restored only within the original deployment baseline. The form reports current active record counts for available policies. Cloud write and submitted-version grants cannot exceed deployment configuration; public OAuth/MCP scopes never change.

Back up code/configuration and use SQLite online backup locally before migration. For rollback, stop Core/OAuth, turn all owner processing flags and schedules off and fence owner leases, verify both legacy worker flags false, then restore only original code and remove the owner configuration keys. Keep the additive tables and all newer user data. Never restore an old database over newer data. Isolated tests verify baseline code accepts the additive schema.

Validation uses disposable databases, loopback services, stub models and separate browser contexts. Production acceptance must not invoke model probes or start runs. Core health and anonymous route checks do not establish signed-in UI acceptance.
