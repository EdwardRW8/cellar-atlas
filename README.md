# Cellar Atlas

An intelligent model of your wine collection.

V3 is a complete rebuild. It shares no code and no database with V2, which
remains deployed and untouched as a frozen reference.

---

## For the owner — plain English

You do not need a computer, a terminal or Node.js. Netlify builds the app on
their servers whenever you commit to GitHub.

**To change something:**

1. Open the repository on GitHub
2. Press the `.` key — this opens a full code editor in your browser that
   works on a tablet
3. Make your change, then commit
4. Netlify rebuilds and publishes in about 90 seconds

**Important — Netlify's free plan is credit-based.** You get 300 credits a
month and a production deploy costs 15, so roughly **20 published deploys per
month**. Deploy previews and branch deploys cost nothing. If you are trying
things out, work on a branch and only merge when you are happy.

---

## Environment variables

Set these in **Netlify → Site settings → Environment variables**. They are
never committed to the repository.

| Variable | Where to find it |
|---|---|
| `VITE_SUPABASE_URL` | Supabase → Project Settings → Data API |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Supabase → Project Settings → API Keys → publishable |

Never add the **service role** or **secret** key. Those bypass all security.

---

## Database setup

In the V3 Supabase project: **SQL Editor → New query**, paste `db/001_foundation.sql`, Run.

Then verify security is on — this is the step that matters most:

```sql
select tablename, rowsecurity from pg_tables
where schemaname = 'public' order by tablename;
```

All five tables must show `true`. The publishable key is public by design;
row-level security is the only thing standing between it and your data.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Local development server |
| `npm run build` | Type-check then build for production |
| `npm test` | Run the test suite |
| `npm run typecheck` | Type-check only |
| `npm run lint` | Check code quality |
| `npm run format` | Auto-format code |

---

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — how it fits together
- [`docs/data-model.md`](docs/data-model.md) — wines, bottles, acquisitions
- [`docs/sync.md`](docs/sync.md) — offline safety, and the bugs it prevents
- [`docs/storage-model.md`](docs/storage-model.md) — configurable racks
- [`docs/atlas.md`](docs/atlas.md) — geography approach
- [`docs/scaling-roadmap.md`](docs/scaling-roadmap.md) — free now, paid later

---

## Phase status

| Phase | Status | Notes |
|---|---|---|
| 0 — Audit V2 | ✅ Complete | V2 frozen as reference |
| 1 — Foundation | ✅ Complete | Deployed and verified on Mac + phone |
| 2 — Domain & data | ✅ Complete | 13 migrations, 10 mutation RPCs |
| 2.1 — Verification & hardening | ✅ Complete | Traceability, RLS enforcement, fixture |
| 2.2 — Deployment gate | 🟡 Awaiting owner action | Scripts ready in `db/deploy/` |
| 3 — Core cellar management | ⬜ Not started | Next |
| 4 — Flexible storage | ⬜ Not started | |
| 5 — Interactive rack | ⬜ Not started | |
| 6 — Home dashboard | ⬜ Not started | |
| 7 — Atlas | ⬜ Not started | |
| 8 — Profile & intelligence | ⬜ Not started | |
| 9 — History, tasting, delivery | ⬜ Not started | |
| 10 — Valuation & enrichment | ⬜ Not started | |
| 11 — PWA, performance, a11y | ⬜ Not started | |
| 12 — Release readiness | ⬜ Not started | |

### Current state

**345 tests passing** across 14 files. TypeScript strict with zero errors.
Production build clean.

Phase 1 is **deployed**. Phases 2 and 2.1 are schema and domain logic — built
and tested locally, **migrations not yet applied to the live Supabase
project**.

| Layer | Status |
|---|---|
| App shell, routing, auth | Deployed and working |
| Sync infrastructure | Built and tested, not yet carrying wine data |
| Database schema (13 migrations) | **Awaiting deployment** |
| Domain logic | Built and tested |
| Wine UI | Phase 3 |

### Outstanding before Phase 3 — owner action required

These need your Supabase credentials, which are held only in Netlify
environment variables. Run in order:

| Step | Script | Purpose |
|---|---|---|
| 1 | `db/deploy/01-inspect-current-state.sql` | Read-only. Determines what is already applied |
| 2 | `db/deploy/02-clean-rebuild.sql` | Only if step 1 says so. Has a safety interlock |
| 3 | migrations `001`–`013` in order | **`001` changed** — carries the RLS recursion fix |
| 4 | `db/deploy/03-post-deploy-verify.sql` | 18 checks, all must read PASS |
| 5 | `db/deploy/04-live-rls-verification.sql` | Real auth roles. The check PGlite cannot do |
| 6 | Development fixture | Only after step 5 passes |

### Storage-agnosticism guarantee

The owner's 13-column staircase rack is **one user's configuration**, never a
default. Enforced by 41 tests in `tests/unit/layout-agnostic.test.ts`:

- Applying every migration to an empty database creates **zero** storage rows
- No product file contains the owner's geometry, `130`, or `13 columns`
- No layout type receives special-case branching
- A cellar can exist with no rack, or no storage at all
- Four cellars run staircase / grid / fridge+shelving / merchant-only side by side
- Capacity and valid positions derive from configuration in every case
