# Dependency decision

The OAuth protocol and HTTP MCP transport are optional components, not additions to the dependency-free Core or existing stdio plugin. Use a full checkout and install each lock separately.

| Component | Direct dependency | Pinned version | Purpose |
| --- | --- | --- | --- |
| Authorization service | `oidc-provider` | `9.12.2` | Authorization/OIDC protocol, static clients, resource indicators, token lifecycle |
| Authorization service | `otplib` | `13.5.0` | TOTP enrollment, verification and time-window validation |
| HTTP MCP gateway | `@modelcontextprotocol/sdk` | `1.32.2` | Streamable HTTP, protocol negotiation, bounded tool validation and SDK-client tests |
| HTTP MCP gateway | `zod` | `4.6.7` | Strict input/output validation for gateway tools |

Both component lockfiles pin the transitive dependency tree. Initial installation and tests used Node.js **24.19.0 LTS**. Normal startup requires an LTS release with major version at least 24; an LTS flag does not replace checking the runtime's upstream maintenance lifetime. Non-LTS Node may be used only by isolated fixtures, not deployment. `node:sqlite`, HTTP, cryptography, scrypt, file protection and process control use Node's standard library.

```bash
npm ci --prefix services/oauth --ignore-scripts
npm ci --prefix adapters/chatgpt-web --ignore-scripts
npm audit --prefix services/oauth --omit=dev
npm audit --prefix adapters/chatgpt-web --omit=dev
npm run test:oauth
```

The package-local installation creates no system service and requires no root dependency install. Audit results are point-in-time advisory checks, not a security certification. Review upstream advisories and release notes before upgrading; update exact versions and locks together and repeat negative, concurrency, restart, and Core regressions. Do not apply an unreviewed `npm audit fix --force` to a deployed authorization service.

The provider configuration uses its maintained Adapter, interaction and policy interfaces. The application supplies an independent durable SQLite adapter, owner authentication and explicit consent; using the provider does not remove those responsibilities. The application pre-reads a bounded raw form and rejects duplicate parameters before dispatch. The provider's supported `req.body` fallback handles that raw form; it emits a one-time upstream-parser warning. No provider source is patched, and the warning is not suppressed. Recheck this integration on a provider update.

The gateway uses the SDK rather than reflecting arbitrary protocol versions. The public gateway does not import the local plugin's entire tool handler. All dependency licenses remain applicable; Mnemuron's components retain Apache-2.0 with their own LICENSE/NOTICE copies. Dependencies are installed from the registry, not vendored into the repository.

## Tool input resource bounds

[GHSA-46jr-4wx8-v453](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-46jr-4wx8-v453) affects SDK versions `>=1.3.0, <1.32.0`: schema validation can consume excessive resources for many small nested input elements. Upgrading alone does not enable the upstream guard. The gateway explicitly sets `maxToolInputElements: 256`, which counts nested object keys and array elements before tool schema validation and rejects excess input with `isError: true`. Current valid tool arguments use fewer than 64 elements, including the largest supported arrays (20 workstream IDs, 8 memory types and 3 statuses).

The existing authenticated JSON parser still caps the entire request at 65,536 bytes before SDK dispatch; the element bound complements that byte limit. A real HTTP regression sends only a small synthetic nested payload below the byte cap, verifies the SDK's element-limit rejection before a Core tool call, and then successfully calls the normal tool with its maximum supported array lengths. Dependency updates retain exact direct pins and refreshed lockfiles; no deployment-time audit repair or dependency source patch is required.

## Primary references

- [OpenAI remote MCP authentication](https://developers.openai.com/plugins/build/auth): discovery, resource indicators, callback and client requirements.
- [MCP authorization contract](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization): protected-resource discovery and authorization boundaries.
- [oidc-provider at the pinned revision](https://github.com/panva/node-oidc-provider/tree/v9.12.2): provider, Adapter, interactions and token policies.
- [Official MCP TypeScript SDK at the pinned revision](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.32.2): stateless Streamable HTTP and server/client APIs.
- [otplib at the pinned revision](https://github.com/yeojz/otplib/tree/v13.5.0): TOTP verification and enrollment APIs.

The service layout, local owner policy, scope names, TTLs, limits, and release stages are Mnemuron design choices, not claims that OpenAI mandates those defaults.
