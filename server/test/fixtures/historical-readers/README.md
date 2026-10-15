# Historical Core readers

These test-only fixtures keep migration and old-reader refusal tests runnable in
source snapshots and shallow clones. They contain original source, not mocked
readers, altered version constants, database dumps, or current-code substitutes.
They are not imported by the application.

## Provenance

Each file was copied byte-for-byte from these existing source revisions:

| Reader | Original commit | Schema | Files |
| --- | --- | --- | --- |
| v7 | `ffbd18b5f21269ecfae01e801a480953a93ca271` | 7 | 44 |
| v8 | `e3ced0cf5b1d7c9041d7af3b44191b224d13ae93` | 8 | 46 |
| v9 candidate | `343cecdfd9c6a9ad64800bebbdf1f1f2e0289bc8` | 9 | 46 |
| v9 final | `e63249f9847ee9c62620290e9f3210bc063fad9f` | 9 | 46 |

`manifest.json` maps each commit and original path to its original Git blob ID,
Git mode, byte length and SHA-256. `blobs/<sha256>.<extension>` stores each distinct
file once as ordinary scan-visible source text: 86 blobs, 1,655,705 bytes total.
All retain the repository's Apache-2.0 license; see the root LICENSE and NOTICE.
The original commits are provenance identifiers, not remotely fetched dependencies.

## Included dependency closure

The entry point is `server/lib/store.mjs`. Starting at that file in each original
commit, recursively follow relative ESM imports and re-exports, retaining original
paths. The closures contain 43 (v7) or 45 (other readers) `.mjs` modules. They use
only Node built-ins and other included relative modules; no package install is
needed. Also include the original root `package.json`: ConsoleFeatures reads it
at module load with `readFileSync(new URL('../../../package.json', import.meta.url))`.
The reviewed closures have no computed/dynamic module imports and require no
other checked-in non-JavaScript resources. Runtime databases and configuration
are supplied by the existing isolated synthetic tests.

This excludes old tests, binaries, seed data, deployment configuration and unrelated
application modules. Neither a complete historical checkout nor old commit metadata
is bundled. Frozen bytes are excluded from line-ending conversion, not from
publication or secret scanning. Do not edit, format or regenerate individual blobs
from current application code.

## Integrity and reproduction

The test loader pins the SHA-256 of the manifest, rejects unlisted commits and
unsafe source paths, and verifies both SHA-256 and Git blob SHA-1 for every file
before creating an isolated temporary source tree. Missing or changed fixtures
fail the tests. There is no network fetch, skip or fallback. Temporary trees live
for the whole test and are cleaned up afterward, without a process-wide module
cache whose source files could disappear between tests.

When the original commits are available locally, each entry can be independently
reproduced using `git show <commit>:<path>`. Compare those bytes with its fixture,
check `git ls-tree <commit> -- <path>` for the recorded mode and Git blob ID, and
check SHA-256 and byte length. The Git blob digest is SHA-1 of
`"blob " + decimal_byte_length + NUL + original_bytes`.
A source-only checkout can verify all pinned digests and run the same real reader
behavior, but cannot independently prove commit membership without those original
objects. The complete commit/path/blob mapping preserves that audit trail.

Run `node --test server/test/historical-readers.test.mjs` for fixture integrity,
known schema versions, closure completeness, missing/corrupt payloads and cleanup.
The existing lifecycle suites still exercise real upgrades, rollback, refusal and
unchanged-record assertions. Run `node scripts/test-all.mjs --suite core` for the
full Core suite. Git-history publication/secret checks still need a non-shallow
repository; fixture-backed reader tests do not require the old historical objects.
