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

---

## 4. The harness cellar-guard check is per FILE, not per test

**Found:** 12.0 audit.

`tests/harness/serialization.spec.ts` decides whether a spec mutates by reading
the whole file, then checks that the same file mentions a guard somewhere. Two
consequences follow, and neither is a defect in what it does check:

- **It is file-level.** A spec can be marked guarded because one test calls the
  guard, while another test in the same file mutates without it. That is
  exactly the gap found in `mobile-workflows.spec.ts`, where the guard sat in a
  seed helper that the click-driven test never called. A dedicated assertion
  now pins the guard inside that file's `beforeEach`, but the general check
  remains per file.
- **It only catches what its patterns recognise.** Mutations are detected by
  write RPCs, non-GET methods, file uploads, and clicks on buttons whose names
  match a list of verbs. A mutation reached another way — a verb outside the
  list, a programmatic form submit, a navigation that writes — would not be
  detected, and the spec would be silently treated as read-only.

**Mitigation in place:** the detector has a negative self-test proving it is
not vacuous, and the hand-maintained `MUTATING_SPECS` list is asserted to be a
subset of what the detector finds, so the two cross-check each other.

**Suggested improvement:** assert the guard runs per test — for example by
requiring it in `beforeEach` for every mutating spec — rather than anywhere in
the file. Not done in 12.0: it would change several specs at once.

---

## 5. Two tabs could still create two cellars

**Found:** fresh-user hotfix.

`useCellar.createCellar` holds a re-entrancy guard in a ref, so a double-click
in one tab creates exactly one cellar. That guard is **per tab**. Two tabs (or
two devices) clicking "Create my cellar" at the same moment would both see no
membership and both insert, leaving the user with two cellars and an arbitrary
one opening afterwards — see follow-up 2.

The client cannot close this: it needs the check and the insert to happen under
one lock, server-side. A `create_first_cellar()` RPC — SECURITY INVOKER, taking
an advisory lock or relying on a unique constraint on `cellar_members
(user_id)` where the user is an owner — would do it, and would need a
migration.

**Not fixed in the hotfix:** the window is small, it needs a migration, and
migrations were explicitly out of scope. Worth closing before onboarding is
used by more than a handful of people.

---

## 6. `src/data/sync/` is built, tested, and never runs

**Found:** 12.1 audit.

`src/data/sync/` contains an IndexedDB mutation queue (`queue.ts`), a sync
engine (`engine.ts`) and a cache (`cache.ts`). All are implemented and covered
by unit tests. **None of them is wired into the application** — the only
imports from outside that directory are type-only.

Consequences:

- there is no outbox: a mutation that fails is not retried and not stored, and
  nothing is replayed on reconnect
- `pending` in `useCellar` is ordinary React state, lost on reload
- the tests covering these modules pass while testing code no user ever reaches

Gate 12.7 wires `cache.ts` for read-only offline viewing. The queue and engine
remain unused after that, since durable offline writes are out of scope for
Phase 12. **Decide deliberately:** wire them in a later phase, or delete them.
Leaving tested-but-dead code in place implies a capability the app does not
have — which is what made the false "your change is queued" messaging
plausible in the first place.
