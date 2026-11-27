# Disaster recovery

How the Cellar Atlas database is backed up, how to restore it, and — stated
first, because it is the part most easily misread — exactly how much of that
is currently true.

## Status: what is proven, and what is not

These four things are different, and only the first is true today. Nothing in
this document should be read as saying the collection is backed up.

| # | State | Now | What would make it true |
|---|-------|-----|------------------------|
| 1 | **Code tested** — the backup scripts are implemented, their logic is covered by tests that run in CI, and the dump/restore has been exercised end to end against a real PostgreSQL 16 | **Yes** | Done. See "Evidence" below |
| 2 | **Infrastructure configured** — an age key pair exists, a private bucket exists, the secrets and variables are set | **No** | The owner actions below. Until `BACKUP_ENABLED` is `true` the workflow exits without doing anything |
| 3 | **Backups succeeding** — a scheduled run has actually dumped production, encrypted it, uploaded it and verified the upload | **No** | One green scheduled run, with a manifest in the bucket whose `dumpRowCounts` are plausible for the live cellar |
| 4 | **Restore verified** — an encrypted backup has been decrypted and restored into a scratch **Supabase** project, and the application ran against it | **No** | The restore drill below, completed once and dated in the log at the end of this file |

A system at state 1 protects nothing. A system at state 3 is still only a
belief: an untested backup is one that has never been shown to restore, and
the first attempt should not happen during an outage. **State 4 is the only
state that means the collection is safe.**

### Evidence behind state 1

The dump and restore have been exercised against a disposable **vanilla**
PostgreSQL 16.15 cluster, using the same `pg_dump` version Supabase's server
major matches:

- all four dumps produced; plaintext destroyed; only `*.age` plus the manifest
  remained
- every encrypted file decrypted and matched its recorded SHA-256
- restore completed under `ON_ERROR_STOP=1` in the order documented below
- restored row counts matched the manifest's `dumpRowCounts` for every table
- a value containing a newline and a tab survived unchanged
- the `bottles → wine_definitions → cellars → auth.users` foreign-key chain
  was intact after the restore

`tests/unit/backup-dump-integration.test.ts` reproduces all of that; see
"Local integration test".

**This was not a Supabase project.** Vanilla Postgres does not have Supabase's
pre-created roles, extensions or platform-managed `auth` schema, which is
where the real friction lives — see "Supabase-managed roles and schemas". So
this evidence supports state 1 and says nothing about state 4.

The migration count is unchanged by this gate. Nothing here touches the
application, the schema, RLS, or production data.

## What is backed up

A daily run produces five files, all named from one UTC timestamp —
`cellar-atlas-2026-11-26T031700Z`:

| File | Contents |
|------|----------|
| `….roles.sql.age` | Database roles, without their password hashes |
| `….schema-public.sql.age` | DDL for the `public` schema — the application's own |
| `….schema-auth.sql.age` | DDL for the `auth` schema, kept separate on purpose |
| `….data.sql.age` | Row data for `public` **and** `auth`, from one `pg_dump` run |
| `….manifest.json` | Counts, SHA-256 of each file, timestamp, sslmode, source — **not encrypted** |

### Why the data is one file and one run

Every `pg_dump` invocation takes its own repeatable-read snapshot. Two runs
are two snapshots, so dumping `public` and `auth` separately could capture a
bottle whose owning user is absent, or a membership referencing a user created
after the first dump finished. Referential integrity between the two is
exactly what a restore depends on, so the data dump is a **single invocation
covering both schemas**: one transaction, one snapshot, consistent by
construction.

### Why the auth DDL is a separate file

A new Supabase project creates the `auth` schema itself, from GoTrue's own
migrations, before you can restore anything. Replaying our `auth` DDL over
that conflicts object by object, and those errors are indistinguishable from
real failures — so an operator either stops on noise or, worse, learns to
ignore errors during a restore. Keeping it separate lets the procedure below
be exact about which files to apply where.

### Why auth is dumped at all

Without it, a restored database holds a collection whose every `created_by`
and cellar membership points at a user who no longer exists. That is not a
recovered application, and an outage is the wrong time to find out.

**Because `auth` is included, the data dump contains email addresses and
password hashes.** That is why encryption is not optional at any point in this
design, and why the dump is encrypted on the runner before it goes anywhere.

### Two kinds of row count, and only one of them is authoritative

This distinction matters for recovery verification, so the manifest keeps them
in separate fields:

- **`dumpRowCounts` — authoritative.** Counted from the dump's own bytes, by
  parsing the `COPY` blocks in the data dump. They describe *this backup*.
  `pg_dump --format=plain` writes one line per row and escapes newlines inside
  values, so the count is exact. A truncated `COPY` block makes the backup
  fail rather than report a plausible short number.
- **`observedRowCounts` — observational only.** A separate `SELECT count(*)`
  against the live database, run *after* the dump. That is a different
  snapshot, so on a live database these are *expected* to differ occasionally.
  `snapshotDifferences` records any divergence for a human. A failure to
  observe does not fail the backup, because the dump is already verified by
  its own counts.

> **Verify a restore against `dumpRowCounts`, never against
> `observedRowCounts`.** Comparing a restore to the observed numbers would
> raise false alarms when nothing is wrong, and could mask real loss.

The manifest is left in clear on purpose, so backup freshness and file
integrity can be checked without the private key. It holds counts, hashes, a
host name and the sslmode used — no credentials, no wine data, no personal
data.

### Transport security

The connection is never allowed to be unencrypted. `sslmode=disable`, `allow`
and `prefer` are **rejected outright** for any non-loopback host — `prefer` in
particular sounds cautious and is not: libpq attempts TLS and then silently
falls back to plaintext if the server declines, which would stream the whole
collection and every password hash across the internet with nothing in the
log.

Resolution order: an explicit `sslmode` in the URL → `verify-full` when a CA
certificate is configured → `require`. Set the repository variable
`BACKUP_CA_CERT_PATH` to a downloaded Supabase CA certificate to get
`verify-full`, which authenticates the server rather than merely encrypting to
it. The mode actually used is recorded in every manifest.

`sslmode=disable` is accepted for `localhost`/`127.0.0.1` only, so the local
integration test can run. A Supabase pooler host is never a loopback address,
so that exemption cannot reach production however the URL is written.

### What is *not* backed up

- **Supabase platform state**: Storage buckets, Realtime, Vault, project
  settings, Edge Functions, and the API keys themselves. These are not
  restorable from a `pg_dump` into a new project and are not dumped. If the
  app ever uses Supabase Storage, add `storage` to `BACKUP_SCHEMAS` in
  `scripts/backup/lib/dump-plan.mjs` and re-run the drill.
- **Role passwords.** `--no-role-passwords` keeps them out. End-user
  passwords live in `auth.users` and *are* included.
- **Point-in-time recovery.** This is a daily snapshot. Up to 24 hours of
  changes can be lost. Supabase Pro's PITR is the fix if that becomes
  unacceptable; this gate exists because Free keeps no backups at all.

## Owner actions, in order

Nothing works until all five are done. Steps 1 and 2 cannot be done for you:
they involve a key that must never reach CI, and an account only you control.

**1. Create the age key pair — on your own machine, never in CI.**

```sh
age-keygen -o cellar-atlas-backup.key
```

It prints `Public key: age1…` and writes the private key to that file.

**Store `cellar-atlas-backup.key` offline.** A password manager, or printed
and in a safe. Prefer both.

> **If you lose this file, every backup becomes permanently unreadable.**
> There is no recovery path and no reset. That is the property that makes it
> safe to store encrypted dumps somewhere less trusted than the database —
> and it cuts both ways.

Never commit it, never paste it into a GitHub secret, never put it on the
runner. The runner only ever needs the public key, which can encrypt but not
decrypt.

**2. Commit the public key.** Replace the placeholder line in
`backup/age-recipient.txt` with the `age1…` key. While the placeholder is
there, `run-backup.mjs` refuses to dump anything — deliberately, so a
half-finished setup cannot produce either an unencrypted dump or a pile of
files encrypted to a key nobody holds. The second is the dangerous one: it
looks like success for months.

**3. Create the private bucket and the credentials.**

- A Cloudflare R2 bucket. **Private** — no public access, no custom domain.
- An R2 API token scoped to that one bucket, with object read/write/delete.
  Read is required: the upload is verified by reading the objects back.
- In the repository, add these **secrets** (Settings → Secrets and variables
  → Actions). Names only; never put a value in a file, an issue or a commit:
  - `DATABASE_URL` — Supabase Postgres connection string. Use the **session
    pooler** string: GitHub runners have no IPv6, and Supabase's direct
    connection host is IPv6-only. Verify this at the first run; if the dump
    cannot connect, this is the first thing to check.
  - `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`
    (`https://<account-id>.r2.cloudflarestorage.com`)
- And these **variables** (same page, Variables tab):
  - `R2_BUCKET` — the bucket name
  - `BACKUP_CA_CERT_PATH` — optional; a path to a Supabase CA certificate
    checked into the runner's workspace, to get `verify-full`
  - `BACKUP_ENABLED` — set to `true` **last**

**4. Run the local integration test** (below) before enabling anything. It
proves the dump and restore work in your environment, against a disposable
database, with no production credential involved.

**5. Run it once by hand** — Actions → *Encrypted database backup* → Run
workflow, with *dry run* ticked. That validates the recipient, the secrets and
the plan without touching the database. Then run it again unticked, and check
the bucket holds five objects and that the manifest's `dumpRowCounts` are
plausible for the cellar. You are now at state 3.

**6. Do the restore drill.** Until you have, you are not at state 4.

### Known issues to expect at the first run

- **AWS CLI checksums.** Recent AWS CLI versions send additional-checksum
  headers that R2 has historically rejected. The workflow sets
  `AWS_REQUEST_CHECKSUM_CALCULATION=when_required` for this. If an upload
  fails with a checksum or `NotImplemented` error, that is the cause.
- **`pg_dump` version.** A `pg_dump` older than the server refuses to run.
  The workflow pins `postgresql-client-16`; if Supabase moves to a newer
  major, raise it.
- **Scheduled workflows get disabled.** GitHub disables scheduled workflows
  in repositories with no activity for 60 days, *without failing them*. A
  repository that goes quiet therefore stops being backed up silently. This
  is the one failure the alerting cannot catch, because nothing runs to
  alert. **Check the bucket's newest manifest once a month.**

## Local integration test

This is how the dump and restore are exercised without a production
credential. It needs `pg_dump`, `psql`, `age` and `age-keygen` on the path,
and a disposable PostgreSQL 16 server.

The test **skips** unless `BACKUP_TEST_DATABASE_URL` is set, so CI does not
need a database — and it refuses any host that is not loopback, so it cannot
be aimed at production by accident. It creates and drops
`cellar_backup_src` and `cellar_backup_restored`.

```sh
# Any disposable PostgreSQL 16 will do. One way, with no system install:
npm i --no-save embedded-postgres
BIN=node_modules/@embedded-postgres/linux-x64/native/bin
# initdb refuses to run as root; use an unprivileged account.
"$BIN/initdb" -D /tmp/pgdata -U cellar_test --pwfile=<(echo testpass) -A scram-sha-256
"$BIN/pg_ctl" -D /tmp/pgdata -o '-p 55432 -c listen_addresses=127.0.0.1' -w start

BACKUP_TEST_DATABASE_URL='postgresql://cellar_test:testpass@127.0.0.1:55432/postgres?sslmode=disable' \
  npx vitest run tests/unit/backup-dump-integration.test.ts

"$BIN/pg_ctl" -D /tmp/pgdata stop
```

Twelve assertions run: the four dumps and the manifest are produced, no
plaintext survives, `dumpRowCounts` match the dump's contents, the manifest
carries no credential, every file decrypts to its recorded hash, the restore
completes under `ON_ERROR_STOP=1`, the restored counts match the manifest,
values with newlines and tabs survive, and the cross-schema foreign-key chain
is intact.

**The workflow stays disabled until this passes in your environment.**

## Restoring

Read this once before you need it.

### Decrypt

On the machine holding the private key — never on a shared or CI machine:

```sh
aws s3 cp "s3://$R2_BUCKET/cellar-atlas-2026-11-26T031700Z.data.sql.age" . \
  --endpoint-url "$R2_ENDPOINT"

age --decrypt --identity cellar-atlas-backup.key \
  -o cellar-atlas-2026-11-26T031700Z.data.sql \
  cellar-atlas-2026-11-26T031700Z.data.sql.age
```

Check each file against the manifest before trusting it:

```sh
sha256sum cellar-atlas-2026-11-26T031700Z.data.sql
# compare with .files[].plaintextSha256 in the manifest
```

Delete the decrypted files when you are done. They are the whole collection
and every password hash, in clear.

### Restore, in order

Into a **new, empty** project — never over a live one.

```sh
TARGET="postgresql://…"   # the new project

# 1. Remove the target's empty public schema. NOT OPTIONAL — see below.
psql "$TARGET" -v ON_ERROR_STOP=1 -c 'drop schema public cascade;'

# 2. auth DDL — ONLY on a target that has no platform-managed auth schema.
#    On a Supabase target, SKIP this: Supabase created auth already.
psql "$TARGET" -v ON_ERROR_STOP=1 -f ….schema-auth.sql

# 3. public DDL — the application's own schema.
psql "$TARGET" -v ON_ERROR_STOP=1 -f ….schema-public.sql

# 4. Data for both schemas, from the single consistent snapshot.
psql "$TARGET" -v ON_ERROR_STOP=1 -f ….data.sql
```

> **Step 1 is not optional, and this was found by running it.**
> `schema-public.sql` contains `CREATE SCHEMA "public"`, and every PostgreSQL
> database already has a `public` schema, so under `ON_ERROR_STOP=1` the
> restore aborts on its first statement without the drop. Omitting
> `ON_ERROR_STOP=1` instead is worse: `psql` then continues past failures and
> leaves a half-restored database that looks finished.

`….roles.sql` is **reference material, not a step.** See below.

Then re-point the application: set `VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY` to the new project (see
[deployment.md](./deployment.md)). The anon key differs per project, so the
old one will not work.

### Supabase-managed roles and schemas

This is the part the vanilla-Postgres drill does **not** cover, and the reason
state 4 is still unproven. A Supabase project is not an empty database:

- **Roles.** Supabase pre-creates `anon`, `authenticated`, `service_role`,
  `supabase_admin`, `authenticator` and others. `roles.sql` contains
  `CREATE ROLE` for them, so replaying it produces `role … already exists`
  errors. Treat `roles.sql` as a record of what existed — useful for diffing
  grants — not as something to execute. Do not run it with
  `ON_ERROR_STOP=1` and conclude the backup is broken.
- **The `auth` schema is platform-managed.** GoTrue owns its DDL and migrates
  it on its own schedule. Skip `schema-auth.sql` on a Supabase target; it is
  kept so you can diff what the platform created against what was captured,
  and so a restore onto plain Postgres is possible at all.
- **`auth` data.** The data dump inserts into `auth.users`. On a fresh
  project those tables are empty, so the insert succeeds — but if anyone has
  signed in to the new project first, there will be conflicts. Restore
  before anyone uses it.
- **Extensions.** Supabase pre-installs `pgcrypto`, `uuid-ossp`, `pgjwt` and
  others. `CREATE EXTENSION` lines in the schema dump are written
  `IF NOT EXISTS` by `pg_dump`, so these are usually quiet, but ownership of
  extension objects may differ.
- **Ownership and grants.** Objects are restored owned by the connecting
  role. RLS policies come across with the schema, but verify them against
  [rls-verification.md](./rls-verification.md) after any restore — a policy
  that references a role that resolved differently is a silent hole.

**Until a drill against a real Supabase project passes, treat recovery as
plausible rather than verified.**

### After any restore

- `bottle_events` is append-only and its triggers block UPDATE and DELETE.
  The restore inserts, so this is fine — but it means a restore cannot be
  "corrected" afterwards by editing history. Restore into an empty project.
- The data dump uses `--disable-triggers`, which needs elevated rights on the
  **target**. On Supabase, connect as `postgres`.
- Users keep their existing passwords, because `auth.users` was restored.
- Row counts: compare against the manifest's `dumpRowCounts`.

## The restore drill

Do this once now, and again after any change to the schema, to
`BACKUP_SCHEMAS`, or to the age key. It is the only thing that moves the
system to state 4.

1. Create a throwaway **Supabase** project (Free is fine). Vanilla Postgres
   is covered by the integration test; what is unproven is Supabase.
2. Take the newest backup from the bucket and decrypt it.
3. Verify each file's SHA-256 against the manifest.
4. Restore in the order above, skipping `schema-auth.sql`, and record every
   error you had to ignore and why.
5. Compare row counts against the manifest's `dumpRowCounts` for every table
   it lists.
6. Point a **local** dev build at the throwaway project and sign in as
   yourself. Confirm: the collection loads, bottle history is present,
   valuations and tastings are there, and storage positions resolve.
7. Re-run the RLS verification against the restored project.
8. Delete the throwaway project.
9. **Record the result in the log below.** An undated drill is a drill nobody
   can prove happened.

### Rotating the age key

The private key is the single point of failure, so rotation is deliberate and
leaves the old key usable until you choose otherwise.

1. Generate a new pair. Keep **both** private keys offline: the old one is the
   only way to read every existing backup.
2. Replace the public key in `backup/age-recipient.txt` and commit. New
   backups use the new key from the next run.
3. Run the drill against a backup taken **after** the change, to prove the new
   key works before you rely on it.
4. Only once every backup encrypted to the old key has aged out of retention —
   at most 12 months, given the monthly tier — may the old private key be
   destroyed. Destroying it earlier makes those backups unreadable.

Never list two recipients to "ease" a rotation: every listed key can decrypt
every backup, and `recipient.mjs` refuses more than one so that sharing
decryption is always an explicit decision.

## Retention, and why it cannot eat a good backup

7 daily, 4 weekly, 12 monthly, pruned by the job. Three properties matter more
than the arithmetic:

- **Retention reasons about complete sets, not filenames.** A set is the five
  objects above. An interrupted upload leaves some of them; such a set can
  never satisfy a retention tier, so it cannot displace a complete backup. It
  is reported for a human and **never deleted automatically** — it may be an
  upload still in flight.
- **The upload is verified before anything is pruned.** Every object is read
  back out of the bucket and hashed against the manifest. "The object exists"
  and "the object is intact" are different claims: a truncated upload exists.
  If verification fails, the job fails and retention does not run — today's
  backup may be incomplete, but nothing old was deleted.
- **Deletion is by exact object name.** `prune.mjs` emits full object names
  and the workflow deletes one key per call, with no `--recursive`, no
  `--include` and no glob. A wildcard on a shared prefix could match an
  unrelated object.

The newest complete set is never pruned, and nothing is pruned if that would
leave no complete set.

## If a backup fails

A failed run opens an issue labelled `backup-failure` and GitHub emails the
repository owner. What each failure means:

| Failure | Meaning |
|---------|---------|
| Recipient placeholder / invalid | Setup incomplete. **No backup was taken, and none will be** until the public key is committed |
| Missing secret or variable | Same: nothing ran |
| `sslmode` rejected | The URL asked for an unencrypted connection. Fix the URL; do not weaken the check |
| `pg_dump` cannot connect | Wrong connection string, or the direct host instead of the session pooler |
| Dump row-count check refused the dump | `pg_dump` exited 0 having dumped nothing — wrong database, or RLS/pooler interference. **This is the failure that would otherwise look like success** |
| Truncated COPY block | The dump is incomplete. Nothing is kept; re-run |
| Upload failed | Backup exists on the runner and is discarded when the job ends. Encrypted, never uploaded. Re-run |
| **Upload verification failed** | Today's backup is absent or corrupt in the bucket. **Retention did not run, so nothing old was deleted.** Re-run, then check the bucket for a leftover incomplete set |
| Retention step failed | Today's backup is safe and verified; only pruning did not run. Extra files cost pennies |

An **empty issue list is not evidence of success.** Nothing runs to raise an
issue if the workflow was disabled. Check the bucket monthly.

## Drill log

| Date | Backup restored | Target | By | Result |
|------|-----------------|--------|----|--------|
| 2026-11-26 | synthetic fixture | **vanilla PostgreSQL 16.15**, not Supabase | implementation | Dump, decrypt, hash-verify and restore all passed; counts matched `dumpRowCounts`; FK chain intact. **Supports state 1 only** |
| _(pending)_ | | throwaway **Supabase** project | | Required for state 4 |
