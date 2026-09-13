# Public source boundary

Publish implementation code, generic specifications, empty example task seeds,
and tests built from synthetic data. Do not publish:

- Live task progress, memory exports, chat transcripts, or deployment timelines.
- Actual device, user, channel, Session, Resume, Receipt, or container identities.
- Private addresses, personal home paths, keys, runtime databases, or logs.
- Local installation build timestamps, measured hardware reports, or backup archives.

Use example-domain names, documentation IP ranges, generic client labels, and
clearly synthetic IDs in fixtures. Test results must be generated on each run;
do not place a user's actual acceptance history in seed data or release notes.

Run the publication check before committing or pushing:

```bash
node scripts/check-publication.mjs --worktree
node scripts/check-publication.mjs --staged
node scripts/check-publication.mjs --all-refs
node scripts/check-secrets.mjs --worktree
node scripts/check-secrets.mjs --staged
node scripts/check-secrets.mjs --history
```

The check reports categories and locations, never the matched content. It covers
common private-artifact paths, binary/LFS review markers, identifier patterns,
runtime-export features and populated example seeds. Example files are scanned,
not exempted. The single exact `api_key` to `MNEMURON_API_KEY` environment-symbol
mapping in the local plugin loader is allowlisted as code, not as a credential.
It does not prove that every possible secret or personal fact is absent. Review
the complete diff and any new documents manually as well.

Removing content from the latest tree does not remove it from older commits.
History rewriting is a separate, disruptive operation requiring repository-owner
authorization and coordination with other clones. Local backups and private refs
must never be pushed. Push only the explicitly reviewed public branch.

Releases, attachments, pull requests, other refs, and any separately published
artifacts require their own review; a source-tree check does not inspect them.

## Coverage and scanner requirements

`--worktree` covers tracked and non-ignored untracked files, without following
symlinks. `--staged` covers the complete index snapshot, not just changed files.
Known private artifact paths are blocked without reading their payloads; individual
payloads over 4 MiB also fail with an explicit not-inspected marker. This prevents
a privacy audit from opening a runtime database or silently skipping large files.
Ignored-but-tracked files remain covered. `--all-refs` scans all locally reachable
branch/tag/remote-tracking history, commit author/committer/message fields and
annotated tags. A shallow repository is explicitly incomplete. Remote-tracking
refs are only local copies, not evidence of a fresh remote inventory.

Normal project attribution, example-domain addresses and GitHub noreply addresses
are not private memory to remove. Other commit emails are review findings, not an
automatic deletion instruction. Context review remains necessary for names and
facts that have no recognizable sensitive pattern.

Coverage for remote refs, PRs, issues, release assets, Actions logs/artifacts, LFS
payloads and forks/cached refs is `not_inspected` unless separately verified.
No fetch, API write or history rewrite is performed by these scripts. A local
`passed` result applies only to its stated scope; it is not a repository-wide
privacy certification.

The complementary scanner is **Gitleaks 8.24.3**, using its default rules and
the repository's `.gitleaks.toml`. Its [directory scanner](https://github.com/gitleaks/gitleaks/blob/v8.24.3/sources/directory.go)
does not apply `.gitignore`, and its native staged scan covers a diff rather than
the complete index. `check-secrets.mjs` therefore prepares an exact temporary
source snapshot outside all worktrees: tracked plus non-ignored untracked files,
the complete index, or each distinct file/blob pair reachable from local history
and direct tree references, plus commit and annotated-tag metadata. Opaque blob
references block the scan because they have no source-path privacy boundary.
History mode refuses shallow clones.
It does not fetch remote objects or inspect unreachable objects and reflogs.

Known private paths, links (including symlink parents), submodules, oversized
files, binary content and LFS pointers block this scan instead of being silently
skipped. A snapshot is limited to 50,000 entries and 256 MiB total, with a 4 MiB
per-file limit. Temporary directories/files use 0700/0600 and are removed after
the run; forced termination may require private temporary-directory cleanup.
Repository ignore fingerprints and inline Gitleaks allow comments cannot suppress
this required scan. Default detector rules still have their documented limits;
a clean result is not proof of absent private context or every possible secret.

The wrapper refuses a missing or different version, captures scanner output
instead of forwarding snippets, and reports only counts, rule identifiers,
coverage and snapshot/configuration hashes. A missing scanner, unsafe payload,
or unusable report is `blocked`, never successful.
The wrapper does not install software. Obtain approval for installation in your
environment; CI installation is confined to a disposable runner with fixed version
and release-checksum validation.

## Optional local pre-commit integration

After reviewing any existing hooks, append this command to the repository's own
pre-commit hook (do not overwrite an existing hook or change a shared hooks path):

```bash
node scripts/publication-pre-commit.mjs
```

It requires both index publication checks and the fixed scanner, and reports only
counts/categories. No hook is installed automatically by package installation or
tests. A local hook is advisory defense; CI independently runs tests and publication
checks and never uploads private scan reports.

Keep full execution reports, environment baselines and migration-copy digests in
a private directory outside every worktree. Public PR text should state scope,
synthetic test results and unresolved categories, not include actual secret matches,
personal memory excerpts, production paths or deployment histories.
