# Testing

## SQL is tested against real Postgres

2,166 lines of schema and plpgsql cannot be verified by reading them. The
suite runs the **actual migration files** against **PGlite** — the Postgres
source compiled to WebAssembly — and calls the actual functions.

```bash
npm test              # everything
npx vitest run tests/unit/sql-integration.test.ts
```

This found two real bugs before deployment:

1. `correct_bottle` passed `'correct'` as an operation type, which the
   `applied_operations` check constraint rejects. Every correction failed.
2. Replayed creates returned a fresh uuid rather than the original entity id,
   leaving clients with dangling references.

Neither was visible by inspection.

## What the harness stubs

PGlite is bare Postgres. Supabase provides some things it does not:

- `auth.users` table and `auth.uid()` — stubbed
- `authenticated`, `anon`, `service_role` roles — created in setup

**PGlite runs as superuser, which bypasses RLS.** Policy *existence* and
shape are asserted via `pg_policies`; policy *enforcement* for viewer and
editor roles must be verified against the live Supabase project. That
checklist is in the Phase 2 report.

## Coverage

| Suite | Tests | Covers |
|---|---|---|
| `sql-integration` | 60 | Migrations, geometry, all 16 acceptance criteria |
| `storage-layout` | 34 | Capacity, position validation, canonical keys |
| `tokens.contrast` | 27 | WCAG AA — fails the build if breached |
| `drinking-window` | 16 | Seven states and their boundaries |
| `schemas` | 13 | Zod validation at the boundary |
| `sync` | 12 | Queue, idempotency, retry, the V2 bug |
| `cache` | 6 | Hydration guard, the V1 bug |
| `errors` | 6 | Error classification |
| `navigation` | 4 | Five destinations, Home default |
| **Total** | **178** | |

## Mutation testing

Tests that cannot fail are decoration. Two guards have been verified by
reintroducing the original bugs:

- Restoring V2's queue-clobbering → 6 sync tests fail
- Restoring a V2 colour as a content token → 4 contrast tests fail
