# Sensitivity levels removed

Mnemuron is used by a single owner whose memories are not shared with other people.
The per-memory sensitivity levels (`public`, `internal`, `sensitive`, `secret`) are
removed. Every memory is treated the same way.

## What changed

| Area | Before | Now |
| --- | --- | --- |
| ChatGPT reads | `public` visible; `internal`/`sensitive` need a grant or `read_all`; `secret` never | A per-revision grant, or the account-level `read_all` switch, which opens **every** record |
| ChatGPT cloud writes (supersede/retract) | `public` or explicitly granted records | Explicitly granted records only; `read_all` still widens reads only |
| `cloud_read=keep_private` on a cloud save | No grant; hidden from `read_all` | No grant; readable when `read_all` is on |
| External models (embedding, classification, summaries) | Only memories whose level is in the profile's `egress.sensitivities`; `secret` never | Any memory once the profile's egress is approved |
| Console | Sensitivity on create, a "change sensitivity" action, a model "highest sensitivity" field | Removed |
| Portable export / import | Records carried `sensitivity` | Export omits it; import accepts and ignores it |
| Runtime config `egress.sensitivities` | Required | Optional, accepted and ignored |

The model egress switch (`egress.approved`, and `query_approved` for query embedding)
is now the only gate for sending memory text to an external model. Keep it off for a
provider you do not trust with all of your memories.

## Upgrade

Core schema step 7 (`retire-sensitivity-levels`) runs once when Core opens an existing
database:

- Records classified `public` get a ChatGPT grant for their current revision, so they
  stay readable with `read_all` off. Like any grant, it ends when the record changes.
- Records classified `secret` were hidden from the vector index; they are queued to be
  indexed again.

Nothing is deleted. The `memory_privacy` table and the `sensitivity` column of
`memory_web_grants` stay in the database, unused, so an older release can still open
it. Records that had a non-default classification may be re-processed once by the
organizer because their derived state hash changes.
