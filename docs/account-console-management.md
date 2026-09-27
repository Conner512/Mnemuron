# Scoped account and invitation management

This extends the existing multi-account console; it does not replace OAuth or
introduce a second identity system. No database schema migration is required.

## Minimal management policy

Merge this into the existing private authorization configuration:

```json
{
  "identity": {
    "console_operations": false,
    "console_management": {
      "invitations": true,
      "accounts": true,
      "roles": false
    }
  },
  "login": { "registration_enabled": true }
}
```

These are fragments, not replacement configuration files. Keep all current MFA,
CSRF, PKCE, callback, cookie, database and credential settings. Configure an
explicit invitation batch limit and session lifetime through the existing fields.
An absent management policy retains the old `console_operations` behavior for
backwards compatibility; an explicit policy overrides it and defaults omitted
management permissions to false. Invalid fields and non-boolean values fail closed.

- Invitations: only operators can list metadata or issue/revoke codes. Issuance
  accepts integer counts up to the configured cap and integer TTLs of 1–1440
  minutes. Codes are random, single-use and absent from inventory responses.
- Accounts: operators see metadata only and can disable/enable eligible accounts
  when local identity maintenance is ready. They cannot inspect another owner's
  memory, impersonate users, change their password or reset their authenticator.
- Roles: when `roles` is false, the BFF denies role changes even if general
  console operations are enabled. Grant the initial operator to an exact existing
  account ID using `console-operator.mjs grant-operator`; there is no automatic
  first-user administrator. Protect the last active operator and forbid self-disable.
- General memory mutations, jobs, model configuration, exports and credential
  changes remain disabled with `console_operations: false` unless an explicit
  [basic-operation policy](console-browsing-and-basic-operations.md) enables a
  supported group. That policy does not enable paid models, jobs, exports or roles.
  Do not run
  `enable-console` just to enable invitation/account management. Web MCP is still
  read-only; handoff and production-readiness gates are unchanged.

All mutations require a real bound console session, same-origin form, CSRF token,
current actor ID, operation ID and action-specific validation. Privileged account
operations additionally require the current password and an unused TOTP. Turning
off an action also denies previously recorded operation-result replay.

## Registration and deployment requirements

The sign-in page links to `/register`. Enabled registration follows invitation →
username/password → local TOTP QR → one-time recovery-code display and acknowledgement
→ durable identity provisioning. Normal access starts only after MFA, acknowledgement
and Core binding are complete. A closed registration page explains the restriction
and links back to sign-in instead of displaying a generic API error. Recovery remains
blocked unless its independent proof policy and maintenance are configured.

Registration requires a tested provisioning worker. The existing optional in-process
worker is only suitable when its service identity is explicitly allowed to access
the configured files. **Do not grant a public OAuth process access to a separately
owned Core database merely to enable these screens.** A separated-service installation
can set `identity.provisioning` to
`{"enabled":true,"mode":"external_worker"}` and run the new private coordinator:

```bash
node services/oauth/bin/identity-worker.mjs --config /private/identity-worker.json --once
```

The operator-owned configuration uses `config_version: isolated-identity-worker-v1`
and three objects, each with numeric `uid` and `gid` for **distinct non-root** service
identities. `auth` supplies `config_file` and its `credential_directory`; `core`
supplies `database_file` and optional `memory_config_file`; `web` supplies its separate
`credential_directory` and existing `identity_map_file`. Every path is absolute and
outside Git. Preserve existing paths and owners. Keep this configuration in a
root-owned 0700 directory with 0600 permissions.

Run the coordinator as a bounded root oneshot, for example through a local systemd
timer. It listens on no port. Each fixed phase drops to its service uid/gid, handles
only durable account operations, and sends temporary credentials through private
pipes rather than argv/logs. No OAuth filesystem permission is widened. Limit the
service's writable directories, disable network access, and use only the setuid/setgid
capabilities needed to launch those phases. The OAuth config contains no Core path.

The worker reuses durable credential preparation and Core identity verification.
Both services must successfully receive their private key files before activation;
interrupted publication retries the same credential IDs. Concurrent disable fences
activation. Disable immediately blocks console/OAuth sessions, but reports
`revocation_pending` until the worker has revoked Core credentials. Enable reports
`provisioning` until complete. The inventory exposes these pending states rather
than pretending an asynchronous operation has finished. No personal memory is deleted.
External-worker recovery remains blocked; this coordinator does not add recovery or
password/TOTP-reset operations. Validate actual Linux uid separation before deployment.

Existing routes are reused: `/console-api/capabilities`, `/console-api/invitations`,
`/console-api/accounts`, `/console-api/action`, and the explicit registration steps.
Only publish these exact paths through the established ingress. No Core/admin routes,
new public maintenance endpoint, dynamic paths, DNS change or MCP write scope is needed.

The UI shows an operator action label independently of memory-write capabilities,
hides web role controls when denied, omits self-disable, displays factor/binding
status and explains disable/enable consequences. Numeric inputs match server bounds.
Issued codes remain only in the current result dialog; closing it removes plaintext
from the page. Existing operation receipts are encrypted and short-lived.

## Validation

```bash
node --test services/oauth/test/console-actions.test.mjs \
  services/oauth/test/registration-console.test.mjs \
  services/oauth/test/console-management-ui.test.mjs \
  services/oauth/test/boundaries.test.mjs
node scripts/test-all.mjs
```

Use disposable identities and databases. The registration regression exercises the
real periodic worker and verifies readonly credentials and no automatic operator role.
UI rendering tests do not replace real browser password/TOTP, CSRF/CSP and permission
checks. No test should require production personal memories or paid model calls.
