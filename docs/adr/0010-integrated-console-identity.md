# Integrated console and immutable accounts

Status: local implementation; deployment and unresolved operating policies are not approved.

The repository has an OAuth service using oidc-provider, a separate read-only MCP
gateway, and an owner-filtered Core SQLite store. There is no frontend framework
to reuse. Use a small, same-origin, server-rendered authentication surface and
native ES-module console, sharing local CSS tokens and a bilingual catalogue.
No second identity platform, CDN, browser-held bearer or simulated login.

Identity tables live in the existing private OAuth database. The account UUID,
issuer/subject and Core user ID are immutable and independent of username. A
versioned, opt-in migration preserves legacy identifiers and password parameters;
legacy processes must be stopped before migrating and cannot open the upgraded
database. Never roll back by restoring an old database over later accounts.

Core provisioning is an explicit local worker, not a public admin route. A
durable OAuth-side operation reserves encrypted credentials before a Core-side
idempotent transaction. Retries reconcile both databases and identity before
activation. There is no cross-database transaction. Registration waits for this
worker and recovery-code acknowledgement. The OAuth process needs no Core admin
bearer. Web and console get separate owner-bound, least-privilege credentials.

Every MCP request resolves its own immutable principal and credential. The
gateway never mutates a shared token. Console authentication is a separate
purpose-bound cookie backed by this same account repository, not an alternate
identity provider. Registration/recovery cookies cannot authenticate the console.

Production recovery proofs, session TTL, invitation batch limit, platform role
grants, model budget allocation, initial appearance defaults and sensitive web
actions require explicit operator policy. Missing policy blocks only the relevant
branch. Memory writes, task dispatch, export, role management and whole-database
restore are not authorized by showing their pages. production_ready stays false.
