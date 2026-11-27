# Deployment

## Order of operations

| Step | Script | Destructive? |
|---|---|---|
| 1 | `db/deploy/01-inspect-current-state.sql` | No — read only |
| 2 | `db/deploy/02-clean-rebuild.sql` | **Yes** — only if step 1 says so |
| 3 | Migrations `001` → `018` in order | Creates |
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

## Hosting: Cloudflare Pages

The app is hosted on Cloudflare Pages, which builds and deploys `main`
automatically. `netlify.toml` was removed in 12.4; its build settings,
redirect and headers now live in the Cloudflare dashboard and in
`public/_headers`.

### Build settings (Cloudflare dashboard)

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node version | Set `NODE_VERSION` to `20` in the Pages environment variables |

`npm run build` runs `tsc --noEmit` before `vite build`, so a type error fails
the deploy rather than shipping.

> **Set the Node version explicitly.** Pages' default has changed before, and
> a silent major-version bump at build time is the kind of thing that breaks a
> deploy on an unrelated day.

### Environment variables

Set in Pages → Settings → Environment variables, for **Production and
Preview** separately. Names only — the values belong in the dashboard, never
in the repository:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `NODE_VERSION`

Vite inlines `VITE_*` at build time, so **changing one requires a redeploy**;
it does not take effect on its own. If the app loads but reports that Supabase
is not configured, these are missing from the environment that built it —
most often set for Production but not Preview.

The publishable key is safe in the browser *only* because RLS is enabled on
every table. See [rls-verification.md](./rls-verification.md).

### Deep links work without a `_redirects` file

Cloudflare Pages serves `/` for any path that does not match a static asset,
treating the project as a single-page application — but, per Cloudflare's
documentation, **only when the project has no top-level `404.html`**.

> ⚠️ **Never add `public/404.html`.** Doing so switches Pages out of
> single-page-app mode, and every deep link — `/wine/<id>`, `/storage`,
> every emailed or bookmarked URL — starts returning the 404 page instead of
> the app. The site's front page would keep working, so this breaks quietly.
> `tests/unit/hosting-headers.test.ts` fails if that file appears.

### Security headers

`public/_headers` is copied to the deploy root by Vite and read by Pages. It
sets `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, a **report-only** CSP, and
a one-year immutable cache for `/assets/*` (safe because Vite fingerprints
every asset filename).

The CSP is report-only deliberately: an enforced policy that is wrong breaks
sign-in. Promote it to `Content-Security-Policy` only after signing in and
out, loading the Atlas, importing a CSV and recording a tasting all report
nothing in the browser console.

### Verify after deploying

```sh
curl -sI https://cellar-atlas.pages.dev/ | grep -iE 'x-frame|x-content|referrer|content-security'
curl -sI https://cellar-atlas.pages.dev/assets/ | grep -i cache-control
```

Expect all three security headers plus the report-only CSP on the first, and
`public, max-age=31536000, immutable` on a hashed asset. Then open a deep link
directly — paste `/storage` into a fresh tab — and confirm the app loads
rather than a 404.

### Rollback

Pages keeps every previous deployment: Deployments → the last good one →
*Rollback*. To undo only the headers, trim or delete `public/_headers` and
redeploy. The report-only CSP cannot break anything, so it is not a rollback
candidate.
