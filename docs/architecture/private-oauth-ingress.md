# Optional private OAuth ingress

The public OAuth/MCP origin remains the canonical origin. A private reverse proxy
may reach the same loopback OAuth service through `services/oauth/src/private-ingress.mjs`
when sending LAN traffic out to a public tunnel introduces unnecessary latency.
This is an optional transport, not another identity provider or authentication mode.

## Boundaries

- The listener binds one RFC1918 IPv4 address. It accepts one exact peer IPv4 only.
- TLS 1.3 requires a client certificate from a dedicated CA **and** an exact SHA-256
  leaf fingerprint. The proxy validates the server certificate, CA and DNS name.
- The only upstream is `127.0.0.1` at the configured OAuth port. The transport
  preserves request bytes; it cannot select an owner, token, database or upstream URL.
- OAuth still checks Host, Origin, CSRF, MFA, PKCE, precise callbacks and consent.
  Console and OAuth sessions remain separate. MCP stays read-only.
- Handshakes, upstream connects, idle connections, connection counts and shutdown
  are bounded. No request content, cookies or peer certificate data is logged.
- The private route must be inside the proxy's existing source-address gate. Do
  not change public DNS, tunnel rules, Core routing, or unrelated virtual hosts.

Use a dedicated OS service identity, a read-only code directory and a private
configuration/certificate directory (0700, files 0600, owned by that identity).
Generate CA/server/client private keys on the hosts that use them; transfer only
public CSRs and certificates. Do not place real keys or deployment configuration
in this repository. Generate a dedicated CA, not one shared with general clients.

Example configuration shape (replace all placeholders in a private file):

```json
{
  "listen_host": "PRIVATE_OAUTH_IPV4",
  "listen_port": 47835,
  "allowed_peer": "PRIVATE_PROXY_IPV4",
  "server_name": "memory.example.test",
  "upstream_port": 47833,
  "ca_file": "/private/ingress/ca.pem",
  "cert_file": "/private/ingress/server.pem",
  "key_file": "/private/ingress/server.key",
  "client_fingerprint_sha256": "REPLACE_WITH_64_LOWERCASE_HEX_CHARACTERS"
}
```

Start with `node services/oauth/src/private-ingress.mjs /private/ingress/config.json`.
The CLI never accepts the tests' loopback/ephemeral listener exception.

For Caddy, use the existing approved OAuth/console path matcher and preserve the
public Host header. Configure `tls_client_auth`, a private CA `tls_trust_pool file`,
`tls_server_name`, and HTTP/1.1 on the private upstream. Never enable
`tls_insecure_skip_verify`. Keep MCP and other upstreams on their existing routes.
See [Caddy reverse-proxy transport documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

## Verification and rollback

Run `services/oauth/test/private-ingress.test.mjs` plus the full OAuth/MCP suites.
Verify missing/wrong certificates, wrong source/SNI, Host/Origin boundaries,
anonymous API rejection, static assets, public OAuth/MCP and actual browser timing.
Run synthetic UI verification; a public login page is not a real ChatGPT consent
and memory-read acceptance.

Before reload, compare adapted disk and running proxy configuration, back up the
exact configuration and prove only the scoped matcher/upstream changed. Keep the
previous release and route for rollback. Do not migrate identity data for this
transport/UI change. Record certificate expiry privately and renew before expiry:
generate a replacement pair, stage trust and fingerprint changes, verify, then
reload; never disable validation to work around an expired certificate. A failed
private path fails closed. Roll back the proxy to its prior public route if needed.

## Login purpose

`/login` enters the management console. A dynamic `/interaction/:uid` belongs to
one OAuth request and requires its original cookies; it is not a bookmarkable
integration-management page. Expired/mismatched links instruct the user to restart
from ChatGPT rather than sending them into an unrelated console login.
