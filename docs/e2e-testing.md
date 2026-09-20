# End-to-End Testing

## Why these exist

Phase 2 proved RLS enforcement using PostgreSQL role simulation. It did **not**
exercise the Supabase browser token path. These tests close that gap:

```
browser sign-in → Supabase JWT → auth.uid() → RLS
    → SECURITY INVOKER RPC → database
```

## Credentials — never committed

Environment variables only. No passwords in source, no service-role key
anywhere, nothing in browser code.

```bash
export E2E_BASE_URL="https://your-site.netlify.app"

export E2E_OWNER_EMAIL="owner@example.com"
export E2E_OWNER_PASSWORD="..."
export E2E_EDITOR_EMAIL="editor@example.com"
export E2E_EDITOR_PASSWORD="..."
export E2E_VIEWER_EMAIL="viewer@example.com"
export E2E_VIEWER_PASSWORD="..."
export E2E_OUTSIDER_EMAIL="outsider@example.com"
export E2E_OUTSIDER_PASSWORD="..."
export E2E_FOREIGN_CELLAR_ID="uuid-of-a-cellar-they-do-not-belong-to"
```

Tests **skip** rather than fail when variables are absent, so CI without
secrets stays green.

## Running

```bash
npx playwright install          # once
npx playwright test             # all 42
npx playwright test tests/e2e/rls-jwt.spec.ts
npx playwright test --project=mobile
npx playwright show-report
```

## What is covered

**`rls-jwt.spec.ts`** — the security gap

| Role | Proves |
|---|---|
| Owner | signs in · reads own cellar · mutates via RPC |
| Editor | reads · mutates inventory · **cannot** invite members · **cannot** write the profile |
| Viewer | reads · **cannot** insert · **cannot** call mutation RPCs · UPDATE affects zero rows |
| Outsider | **cannot** read, write, or RPC against a foreign cellar |
| All roles | **cannot** update or delete a `bottle_event` |

**`mobile-workflows.spec.ts`** — iPhone 13 viewport

Five-destination navigation · add a wine end to end · search narrows and
clears · touch targets ≥ 44px · no horizontal scroll at 390px.

## The silent-denial trap

RLS refuses an INSERT with `42501` but refuses an UPDATE by **affecting zero
rows with no error at all**. Tests that only watch for exceptions record false
passes on every update path. The viewer update test asserts the row count,
not the status code.
