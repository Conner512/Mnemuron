# Deployment inputs and release gates

No hostnames, real accounts, credentials, tunnels or ChatGPT connections are provisioned by the test suite. Missing operational inputs block deployment, not local development. Record actual values privately; leave this public checklist generic.

| Required input | Where it is used | Initial status |
| --- | --- | --- |
| Controlled public HTTPS authorization hostname | Issuer, host validation, discovery, callback `iss` | Operator supplied |
| Controlled public HTTPS MCP hostname and matching public origin mode | Exact `/mcp` resource, protected-resource metadata and audience; shared or separate origin explicitly configured | Operator supplied |
| Exact callback shown by the intended ChatGPT app | Single pre-registered redirect URI | Operator supplied; bootstrap discovery can precede it |
| Approved tunnel/proxy and exact host/path allowlist | One shared host or two separate hosts; loopback origins; no Core, admin, health or private-file exposure | Not deployed by implementation |
| Maintained Node LTS executable and install root | Two independent service processes | Verify on target |
| Gateway-to-AS reachability without changing canonical identity | Default issuer HTTPS, or explicit literal loopback transport for co-located services only | Test discovery and introspection independently of browser access |
| Two separate OS service identities and private paths | Secret/account/database access separation | Provision on target |
| Owner password, verified TOTP, immutable subject and recovery storage | Local owner setup; issuer/sub identity mapping | Generate locally, never in chat |
| Three distinct credentials | ChatGPT client, gateway introspection, Core read-only agent | Generate/provision separately |
| Existing private Core URL, user and dedicated agent | Business reads and self-identity validation | Required only for `readonly` |
| Current Core with `/v1/identity` and `/readyz/search` | Minimum-scope credential and search checks | Verify before `readonly` |
| Explicit deployment and real-data access authority | Public exposure and ChatGPT linking | Separate from local test authority |

## Stage gates

1. **Local build:** both dependency locks installed; synthetic AS/gateway/SDK/Core integration, negative, concurrency and restart tests pass; existing Core/adapter tests retained.
2. **Metadata-only deployment:** real domains and scoped ingress approved; both discovery documents and the 401 challenge match; no tokens, tools, login bypass, or Core access. Private paths must remain unreachable.
3. **Real `auth_only` connection:** exact callback installed, local owner enrolled, separate secrets provisioned; actual ChatGPT login, explicit consent, diagnostic, refusal/cancellation, expiry/refresh, and revocation observed.
4. **Real `readonly` connection:** dedicated Core key has exactly two read scopes; user/agent mapping is verified; actual search/detail/project preview, history/pagination, cross-user denial, and backend failure paths observed. No write/capture/Resume tools exposed.

Do not mark stages 2–4 passed from local tests. A screenshot of app creation is not evidence of a completed token/refresh/tool lifecycle. Any release/promotion decision remains explicit; no component changes `production_ready` to `true`.

## Proxy acceptance

- Forward only the supplied route allowlist to the matching loopback service; preserve unrelated services and existing rules.
- Check provider resume paths and interaction GET/POST routes, not only the top-level discovery URL.
- Protocol endpoints must return protocol responses rather than browser challenges. Change only relevant host/path policies; do not disable account-wide security.
- Verify no caching of MCP, tokens or interactions, both in response headers and proxy behavior.
- Test denial of `/v1/*`, administration, environment/configuration files, databases, health routes, unknown paths and incorrect Host/Origin.
- Set the origin Host explicitly to the corresponding public hostname. Only the local proxy peer is trusted; forwarded host/scheme/IP supplied by callers are not identity inputs.
- In shared-origin mode, do not serve unrelated scripts, HTML or uploads on the same hostname. Verify that browser cookies never authenticate MCP, private paths are rejected at ingress, and both discovery documents identify the same exact issuer and `/mcp` resource.

The ingress and service files are templates, not applied configuration. Validate them with the target proxy/service manager before any activation. No production endpoint or proxy behavior was assumed during implementation.
