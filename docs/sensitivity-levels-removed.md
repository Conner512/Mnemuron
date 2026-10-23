# Sensitivity levels removed

Mnemuron is used by a single owner whose memories are not shared with other people.
The per-memory sensitivity levels (`public`, `internal`, `sensitive`, `secret`) are
removed. Every memory is treated the same way. Core schema 12 carries existing data over.

## What changed

| Area | Before | Now |
| --- | --- | --- |
| ChatGPT reads, default policy | `public` visible; `internal`/`sensitive` need a grant or the legacy `read_all`; `secret` never | A per-revision grant, or the legacy `read_all` setting, which opens **every** record; an owner denial still wins |
| ChatGPT reads, active-uniform policy | Every active record except `secret` | Every active record |
| ChatGPT cloud writes (supersede/retract) | `public`, granted or (via read policies) readable records | Explicitly granted records only, never denied ones; read policies widen reads only |
| `cloud_read=keep_private` on a cloud save | No grant, plus a denial that hid it under every policy | No grant; readable wherever the account's read scope already allows it |
| Console "new memory" defaults | Default sensitivity; saved defaults denied ChatGPT every new console memory | Only "cloud default: not readable", which creates no grant and no denial |
| External models (organizer, entities, embeddings) | Only memories whose level the profile's `egress.sensitivities` allowed; `secret` never | Any memory once the model's egress is approved |
| Console | Sensitivity on create, "change sensitivity", the model "highest sensitivity" field | Removed |
| Portable export / import | Records carried `sensitivity` | Export omits it; import accepts and ignores it |
| Runtime config `egress.sensitivities`, console model `sensitivities` | Required | Optional, accepted and ignored |
| `mnemuron-memory sensitivity-set` | Set a level | Removed |

An owner's explicit denial (console/CLI `--deny`, or an imported `cloud_private` record) is
not a sensitivity level and keeps working: it hides the record under the default policy and
carries over to local corrections.

The model egress switch (`egress.approved`, and `query_approved` for query embedding) is now
the only gate for sending memory text to an external model. Keep it off for a provider you do
not trust with all of your memories.

To let ChatGPT read everything, set the operator runtime key
`memory.agent_read_policy: "active_uniform_v1"` and restart Core (see
[memory-read-policy-and-embedding-first-run.md](memory-read-policy-and-embedding-first-run.md)).

## Upgrade (Core schema 12, `retire-sensitivity-levels`)

Runs once when Core opens an existing database:

- Records classified `public` get a ChatGPT grant for their current revision, so they stay
  readable under the default policy. A record whose project is (effectively) deleted gets
  none. Like any grant, it ends when the record changes.
- Records classified `secret` were hidden from the vector index; they are queued to be
  indexed again.
- Denials Mnemuron created automatically (cloud `keep_private` saves and their backfill,
  console "new memory" defaults, imports of such records) are cleared. A denial the owner
  set explicitly (latest `memory.web_visibility` audit with `allow=false`) and the local
  corrections that inherited it are kept.

The `memory_privacy` table and the `sensitivity` column of `memory_web_grants` stay in the
database, unused. Records that had a non-default classification may be re-processed once by
the organizer because their derived state hash changes. Schema 12 is a boundary: an older
release refuses to open the database.
