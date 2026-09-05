# Mutations

## No client writes directly to a table

Every domain write calls a Postgres function that, in **one transaction**:

1. Records the `operation_id` — a duplicate returns "already applied"
2. Checks the expected `version` — a mismatch raises a conflict
3. Validates domain invariants, including position geometry
4. Mutates the row
5. Appends the immutable event

State and history therefore **cannot diverge**. There is no path that moves a
bottle without recording it, or records a move that did not happen. A partial
failure rolls back both.

Functions are `SECURITY INVOKER`, so RLS still applies. They are transactional
wrappers, not privilege escalation.

## Idempotency

Every operation carries an `operation_id` distinct from the entity id.
`applied_operations` has it as a primary key, so a replay hits the constraint
and returns `duplicate` — which the client treats as success.

This matters because a lost response on a flaky connection is
indistinguishable from a failure. Without it, the retry conflicts and jams the
queue permanently.

**A replayed create returns the ORIGINAL entity id**, looked up from
`applied_operations`. Returning a freshly generated uuid would leave the
client holding a reference to a row that does not exist — a bug found by the
SQL integration suite, not by reading the code.

## Error classification

| SQLSTATE | Meaning | Sync outcome |
|---|---|---|
| `23505` | Unique violation — already applied | `duplicate` |
| `23514` | Check violation — invalid geometry or data | `permanent` |
| `23503` | FK violation — missing reference | `permanent` |
| `42501` | RLS denial | `permanent` |
| `P0001` + "version" | Optimistic concurrency failure | `conflict` |
| network / 5xx | Transient | `retryable` |

## Corrections are not a bypass

`correct_bottle` passes **exactly the same invariants** as an ordinary
mutation. Position geometry is validated, slot uniqueness enforced, bottle
sizes and statuses checked. It requires a reason, and appends a `corrected`
event carrying both the previous and new state.

`corrected` describes *why* something changed. It does not permit writing
something an ordinary mutation would reject.

## Functions

| Function | Creates |
|---|---|
| `create_wine_definition` | A wine |
| `create_storage_layout` | Geometry |
| `create_storage_location` | A place |
| `create_acquisition_with_items` | Order + lines + **all bottles** + events |
| `move_bottle` | Move or delivery |
| `change_bottle_status` | Consumed / gifted / sold / lost / removed |
| `correct_bottle` | A validated correction |
| `record_tasting` | Tasting + event |
| `record_valuation` | Valuation + denormalised value |
| `upsert_cellar_profile` | Behaviour profile |

`create_acquisition_with_items` is the important one: buying a case creates an
acquisition, an item, twelve bottles and twelve events under **one operation
id, one transaction**. Retry after a dropped connection and you get twelve
bottles, not twenty-four.
