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

---

## 7. Smaller open items

Recorded from the 12.1–12.4 instruction and from review. None blocks a gate;
each is a real gap. Priority is my assessment, not a decision.

| # | Item | Risk | Priority |
|---|---|---|---|
| 7a | **No in-app reset-password screen.** A user who forgets their password has no route back in from the app. | Lock-out; support burden | High once there is more than one user |
| 7b | **An expired JWT is classified as a permission failure.** `classifyLoadError` matches `jwt` under `permission`, so an expired session reads as "You do not have permission" rather than "Please sign in again". | Misleading; user may think access was revoked | Medium |
| 7c | **Only Home has the distinct load-error headings.** Collection, Atlas and Intelligence still show one generic heading over the raw error. | Inconsistent diagnosis | Medium |
| 7d | **Add Wine mounts a second `CellarProvider`.** It is gated correctly, but the cellar is loaded twice — once per provider — on every visit. | Duplicate queries; two sources of truth | Medium |
| 7e | **Possible missing memo dependencies elsewhere.** One omitted-dependency bug was found and fixed in `useCellar`; no audit has been done of the other memoised values. | Silent staleness, as with `creatingCellar` | Medium |
| 7f | **README CSV import section is stale.** It does not match the allowed values now read from `mappings.ts` and `parse.ts`. | Users follow wrong guidance | Low, until the importer is used by others |
| 7g | **Master project context document is stale.** It states 12.0 awaits commit and production is `f8fb682`. | Misleads a future session | Low, but cheap to fix |
| 7h | **GitHub push token expiry.** Credential maintenance is manual and undocumented. | Blocks deployment at the worst moment | Low |
| 7i | **Ordinary mutations mint a fresh operation id per call.** Only `changeStatus`, `recordTasting` and `recordValuation` accept a caller-supplied id, and only the CSV importer passes one. So `claim_operation` cannot deduplicate a user-initiated retry of `commitDraft`, `updateWine`, `moveBottle`, `correctBottle`, `upsertProfile` or `createLocation`. | A retry after a lost response can double-apply; 12.1's `NOT_CONFIRMED` wording exists precisely because this cannot be promised away | **High before community bottle transfers.** A transfer moves a bottle between cellars, so a duplicated transfer is a duplicated or vanished physical bottle in someone else's collection |
| 7j | **Stale comment in `useCellar.run()`.** It still says the pending slot lets the UI "show it as queued", which is the vocabulary 12.1 removed everywhere else — there is no queue. The code is correct; only the comment misleads. | A future reader implements against a queue that does not exist | Low, but it is the same class of defect as the "treated as permitted" comment the audit caught |
| 7k | **`mutationFailureMessage(undefined)` returns `NOT_SAVED`.** When an outcome is `ok: false` with no error detail, the app states definitively that nothing was recorded. That is the right default for a server rejection, but an outcome carrying no detail is arguably unknown rather than known-failed. | A false guarantee in the one case where there is least evidence | Low — it needs an audit of which mutation paths can return `ok: false` with no error, which is why it was recorded rather than changed |

### Note on 7i

Recorded from the 12.3 audit. The asymmetry is deliberate and tested — see
`tests/unit/mutation-messaging.test.tsx`, which pins that ordinary mutations
generate a fresh id while the importer supplies a stable one. Closing it means
threading a stable id from each screen's submit handler, which changes every
mutation entry point and so belongs in its own gate, not folded into another.

### Note on 7b

The fix is small — classify an expired or missing session as its own kind and
prompt a re-sign-in — but it changes how `classifyLoadError` behaves, which
12.1 tests pin. It belongs in its own change, not folded into another gate.

---

## 8. Backups are implemented but protect nothing until the owner acts

**Found:** gate 12.3, by design rather than as a defect.

`docs/disaster-recovery.md` opens with four states: code tested,
infrastructure configured, backups succeeding, restore verified. **Only the
first is true.** The scripts and their tests exist; no age key pair exists, no
bucket exists, and `BACKUP_ENABLED` is unset, so the workflow exits without
doing anything.

This is deliberate — the gate was explicitly not permitted to provision
infrastructure — but it means **the collection is still unbacked up today**.
Until the owner completes the five steps in that document and records a dated
restore drill, 12.3 has changed nothing about the actual risk.

**Suggested closure:** do the owner actions, then the drill, then date the log
table at the end of `docs/disaster-recovery.md`. Treat an undated drill log as
proof the drill never happened.

---

## 9. A disabled scheduled workflow stops backups silently

**Found:** gate 12.3.

GitHub disables scheduled workflows in repositories with no activity for 60
days, and does so **without failing them**. The failure alerting in
`backup.yml` cannot catch this, because nothing runs to raise the alert. A
repository that goes quiet therefore stops being backed up, and the only
visible symptom is an absence.

**Mitigation today:** documented as a monthly manual check of the bucket's
newest manifest.

**Suggested closure:** an external dead-man's-switch — a monitor that alerts on
the *absence* of a fresh manifest rather than on a failure. That is new
infrastructure and was out of scope here.

---

## 10. The restore path is documented but has never been executed

**Found:** gate 12.3.

The decrypt-and-restore procedure in `docs/disaster-recovery.md` is written
from Supabase's and `age`'s documented behaviour, not from a performed restore.
The encryption round-trip **is** genuinely tested, with a real key pair, in
`tests/unit/backup-safety.test.ts`. The `pg_dump`/`psql` sequence is not: it
needs a live Postgres server and a real project, and neither was available or
permitted here.

Expect friction on first attempt, particularly around pre-existing Supabase
roles and extensions on the schema step. **Do not let the first attempt be
during an outage.**
