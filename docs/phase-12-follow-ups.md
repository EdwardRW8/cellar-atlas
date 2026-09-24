# Phase 12 — follow-up notes

Known issues recorded so they are not lost between gates. Nothing here is a
regression introduced by Phase 12; each was found during its analysis or
implementation. None is fixed yet.

---

## 1. `home.spec.ts` and `atlas.spec.ts` use the weaker cellar-guard pattern

**Found:** gate 12.0. **Deliberately not changed in 12.0**, whose scope named
only `mobile-workflows` and `rls-jwt`.

Both specs still resolve their target with:

```
cellar_members?select=cellar_id&limit=1
```

and then assert the result equals `E2E_CELLAR_ID`. They **are** guarded — an
unexpected cellar fails the assertion before any write — so this is a
consistency issue, not an open hole.

It is weaker than the shared guard in `tests/e2e/fixtures/cellar-guard.ts`
because:

- it depends on an unordered `limit=1` returning the expected row, so with a
  multi-membership account it can fail intermittently rather than safely
- the guard rules live inline in each spec instead of in one tested module

**Suggested fix:** move both to `verifyE2eCellar` / `guardedCellarId`, matching
`rls-jwt`. Small and low risk, but it edits two specs that currently pass, so it
belongs in its own commit.

---

## 2. The app picks its active cellar with an unordered `limit(1)`

**Found:** gate 12.0, while relaxing the guard to allow multiple memberships.

`CellarRepository.resolveCellar()` (`src/data/repositories/cellar-repository.ts`)
selects the active cellar with:

```ts
.from("cellar_members").select("cellar_id").limit(1)
```

No `order by`, so with more than one membership Postgres may return either row,
and the choice is not stable between calls or sessions.

**Consequences**

- *Testing:* a spec that mutates by clicking cannot guarantee which cellar the
  write lands in. This is why `verifyAppTargetsE2eCellar` requires a
  single-membership account for UI-mutating specs, while RPC-driven specs, which
  name `p_cellar_id` explicitly, allow several.
- *Product:* a real user who is ever a member of two cellars — a shared cellar,
  or a second one created later — could open the app and see, or write to, an
  arbitrary one of them. There is no cellar switcher, so they would have no way
  to correct it.

**Not a Phase 12 gate item as scoped.** It is an application behaviour, and a
multi-cellar selector is explicitly out of scope. Recording it because it
constrains the E2E account configuration today and is a latent product issue.

**Suggested minimum:** make the selection deterministic, for example ordering by
`created_at` or by role, so the same cellar is chosen every time. A real fix is
the multi-cellar selector, which is a separate phase.

---

## 3. `E2E_CELLAR_ID` is trusted

**Found:** gate 12.0.

Every guard ultimately trusts the configured value. If `E2E_CELLAR_ID` were set
to a real cellar's id, all guards would pass and mutating tests would run
against real data.

Closing this would need a runtime denylist of protected cellar ids — for example
`E2E_PROTECTED_CELLAR_IDS`, supplied by the operator and never committed, since
the harness already forbids real cellar ids from appearing in `tests/e2e`.

Out of scope for 12.0. Worth deciding before the final release-verification gate
(12.12), which runs the broadest E2E.
