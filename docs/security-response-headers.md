# Public response security headers

OAuth/Console and the MCP Gateway share `shared/security-headers.mjs`. This is
response hardening, not an authorization grant or a finding of an exploitable
vulnerability. Existing CSP, frame restrictions, cookies, Origin/CSRF checks,
MFA, scopes, owner controls and cache policies are unchanged.

## Policy and transport

Both runtime configurations accept one optional field:

```json
"security_headers": { "hsts_max_age_seconds": 300 }
```

Omission defaults to 300 seconds. An integer from 0 through 31536000 is valid;
`null` omits application HSTS when the edge is the designated policy owner.
Zero sends `max-age=0` to clear the browser's policy for this host. There is no
`includeSubDomains` or `preload` option. Invalid policy values fail startup.

HSTS is emitted only for non-isolated mode, a configured HTTPS origin, exactly
one matching Host header, and an existing trusted loopback proxy peer
(`127.0.0.1`, `::1`, or IPv4-mapped loopback). The two validated production
services bind loopback and require a fixed HTTPS proxy identity. This supports
Cloudflare/approved reverse-proxy TLS termination without trusting caller
`Forwarded` or `X-Forwarded-Proto`. It does not establish TLS for an arbitrary
HTTP deployment; deployments must preserve the existing transport contract.
Isolated HTTP development never receives HSTS, even with forged TLS headers.

Every application response also receives:

```http
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
```

The current Console uses none of these browser APIs. TOTP QR codes are generated
as server-side SVG for display and do not use the browser camera. Review this
policy explicitly before introducing recording, scanning, location, payments,
or USB features; do not weaken CSP or authentication as a workaround.

The shared policy is installed before dispatch, covering login/Console HTML,
OAuth interactions, APIs, metadata, static assets, redirects and application
errors. HSTS still requires the transport conditions above. Existing `no-store`
for pages/APIs and `no-cache` for assets are preserved; no per-user or reflected
header values are introduced. Core's private API is not modified.

## Rollout guidance

Start with `max-age=300` on both OAuth and Gateway, for the current public host
only. Before deployment, confirm the actual public TLS termination and any
Cloudflare/proxy header rewriting. Choose one effective HSTS policy owner and
ensure both services agree if they share a host. An edge rule can override an
application header or serve cached responses; this source change cannot control
Cloudflare-generated errors, challenges, or HTTP-to-HTTPS redirects.

After separately authorized deployment, inspect normal public HTTPS responses
for login, OAuth metadata/interactions, an anonymous Console 401, Gateway/MCP,
and errors; verify one consistent HSTS value, Permissions-Policy, unchanged CSP
and cache control. Confirm browser login and actual client compatibility. No
longer HSTS lifetime, subdomain policy or preload is approved by this change.

Removing an application header does not immediately clear previously cached
HSTS. With the proposed policy it expires five minutes after the last received
header; an authorized `max-age=0` response can clear host policy sooner. Any
longer edge policy must be handled separately. No production settings, DNS,
TLS, credentials, model switches or workers are changed by this patch.

## Authorization error classification

An initial GET or POST `/authorize` with absent or empty `client_id` returns
local HTTP 400 `invalid_request`. Unknown clients remain `invalid_client`.
Neither case redirects to supplied input. Unregistered callback variants remain
rejected; registered callbacks, PKCE, state echo and existing consent behavior
remain unchanged. Generic MCP personal-token support is unaffected.
