# Deployment

## Order of operations

| Step | Script | Destructive? |
|---|---|---|
| 1 | `db/deploy/01-inspect-current-state.sql` | No — read only |
| 2 | `db/deploy/02-clean-rebuild.sql` | **Yes** — only if step 1 says so |
| 3 | Migrations `001` → `013` in order | Creates |
| 4 | `db/deploy/03-post-deploy-verify.sql` | No — 18 checks |
| 5 | `db/deploy/04-live-rls-verification.sql` | No — RLS testing |
| 6 | Development fixture | Creates test data |

## The rebuild interlock

`02-clean-rebuild.sql` refuses to run if **any** of these hold rows:

```
cellars              cellar_members       cellar_profiles
storage_layouts      storage_locations
wine_definitions     acquisitions         acquisition_items
bottles              bottle_events
tasting_records      valuation_records    applied_operations
```

**Not just bottles and wines.** A cellar with members and configured storage
is real work, even with no wine in it yet. The earlier version of this script
checked only two tables and would have destroyed that silently.

Ignored when deciding: `geo_regions` (reference data, recreated by 003),
`heartbeat` (operational), `profiles` (derived — see below).

It also refuses outright if `public.wines` or `public.change_log` exists,
since those are V2's tables and their presence means you are in the wrong
Supabase project.

The report prints before anything is dropped.

## Why profiles is dropped and rebuilt

The rebuild preserves `auth.users` so your login survives, but drops
`public.profiles`.

**The hazard:** migration 001 creates an `AFTER INSERT` trigger on
`auth.users` that populates `profiles`. Triggers do not fire retrospectively.
An account created before a rebuild would come back with no profile row — and
nothing would obviously break until something dereferenced it.

**Two options were available:**

**A — preserve `profiles` alongside `auth.users`.** Fewer moving parts, but it
leaves a table that migrations no longer own. If the profiles schema ever
changes, `create table if not exists` silently skips it and you are left with
a stale shape. That failure is quiet and would surface much later.

**B — drop it, and backfill in migration 001.** Chosen.

The backfill lives in `001_foundation.sql`, immediately after the trigger:

```sql
insert into profiles (user_id, email)
select u.id, u.email from auth.users u
on conflict (user_id) do nothing;
```

Three properties make this the cleaner option:

1. **Self-healing.** It is part of the migration, not a manual step someone
   must remember after a rebuild.
2. **Idempotent.** `on conflict do nothing` means running 001 any number of
   times produces exactly one profile per user.
3. **Schema-correct.** `profiles` is always the shape 001 defines, because 001
   is the only thing that creates it.

It also fixes a case unrelated to rebuilds: any user who existed before this
migration was first applied.

Covered by 8 tests in `tests/unit/rebuild-preflight.test.ts`, including
multiple pre-existing users, repeated application of 001, and the trigger
still working for users created afterwards.

## Netlify credits

Netlify Free is credit-based with a monthly allowance that does not roll over,
and production deploys consume credits.

Develop on a branch and minimise production deploys. Branch and preview
deploys may or may not consume credits under current terms — **verify against
your account's usage page before relying on them being free.**
