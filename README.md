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

| Phase | Status |
|---|---|
| 0 — Audit V2 | Complete |
| 1 — Foundation | Complete |
| 2 — Domain & data | Not started |
| 3–12 | Not started |
