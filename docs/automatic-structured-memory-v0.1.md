# Automatic Structured Memory v0.1

> Public specification and example configuration only. Personal deployment records and acceptance evidence are retained privately. This document is not proof of production readiness; `production_ready=false` remains the release boundary.

## Status

This document defines the feature contract and required acceptance checks. Deployment-specific results are not published.

## Purpose

Mnemuron already preserves Raw Events and immutable Checkpoints. This phase adds conservative automatic promotion of explicit, source-backed statements into long-lived Structured Memory so project and Resume previews can retrieve useful facts without requiring every item to be saved manually.

## Extraction contract

Automatic extraction runs only after a new Checkpoint is created. It reads non-expired `user_message` and `assistant_message` Events in that Checkpoint window and accepts only statements with one of these explicit labels followed by `:` or `：`:

| Memory type | Accepted labels |
|---|---|
| `goal` | `目标`, `Goal` |
| `fact` | `事实`, `结论`, `Fact` |
| `constraint` | `约束`, `Constraint` |
| `decision` | `决定`, `决策`, `Decision` |
| `completed` | `已完成`, `完成`, `Completed` |
| `blocker` | `阻塞`, `Blocker` |
| `remaining` | `未完成`, `Remaining`, `TODO` |
| `next_step` | `下一步`, `Next step(s)` |

Unlabelled conversation is not converted into Structured Memory. Empty blocker values such as `无`, `none`, or `no` are ignored.

## Provenance and confidence

Every automatically created memory stores:

- source Event IDs and source Checkpoint ID;
- Project, Task, Workstream, and Session;
- server-derived device, Agent, and Agent Instance identity;
- generation method `strict-labeled-statements-v0.1`;
- memory type, lifecycle status, confidence, and warnings.

User-authored statements receive `high / 0.95`. Assistant-authored statements receive `medium / 0.75` and an explicit warning that they have not been promoted to Canonical Task state. Existing explicit saves remain supported as `explicit-user-save-v0.1 / high / 1.0`.

## Branch and conflict boundary

Automatic memories are scoped to the source Workstream. Their idempotency fingerprint includes user, scope, Project, Task, Workstream, memory type, and normalized content. Therefore:

- exact retry in the same Workstream does not duplicate a memory;
- the same statement from another Workstream remains a separate source fact;
- no cross-Workstream merge, supersession, conflict resolution, or Canonical Task update is performed automatically.

Resume branch selection continues to control which Workstream memories are returned. Project Memory Preview returns active memories from all included project sources with provenance intact.

## Schema migration

The `memories` table gains additive metadata columns for type, status, source Event IDs, source Checkpoint, generation method, confidence, warnings, fingerprint, and update time. Existing rows are not deleted or rewritten; absent metadata is exposed through compatible defaults (`fact`, `active`, empty source lists, and original creation time).

## Retention behavior

Raw retention pruning still clears only Event content and raw payload. A Structured Memory keeps its text and immutable source identifiers after its source Raw Event expires. The preview can therefore retain the useful fact while the source Event separately reports its Raw availability state.

## Acceptance gates

Local/isolated tests must prove:

1. labelled user and assistant statements create typed memories;
2. ordinary unlabelled conversation creates none;
3. `阻塞：无` does not create a blocker;
4. retry is idempotent;
5. identical text in another Workstream remains separate;
6. Resume and Project previews expose source and generation metadata;
7. Raw pruning does not remove the derived memory;
8. explicit memory saves remain compatible;
9. a legacy database migrates additively without removing or rewriting its memory row;
10. the full repository regression remains green.
