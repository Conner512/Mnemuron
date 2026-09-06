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
node scripts/check-publication.mjs --ref origin/main --history
```

The check reports categories and locations, never the matched content. It covers
common private-artifact paths, identifier patterns, and populated example seeds.
It does not prove that every possible secret or personal fact is absent. Review
the complete diff and any new documents manually as well.

Removing content from the latest tree does not remove it from older commits.
History rewriting is a separate, disruptive operation requiring repository-owner
authorization and coordination with other clones. Local backups and private refs
must never be pushed. Push only the explicitly reviewed public branch.

Releases, attachments, pull requests, other refs, and any separately published
artifacts require their own review; a source-tree check does not inspect them.
