# Live RLS Verification Checklist

## Why this exists

Phase 2.1 proves RLS enforcement against a real PostgreSQL engine with genuine
non-superuser role separation. Every policy behaves correctly there.

**One thing it cannot cover: Supabase's JWT → `auth.uid()` plumbing.**

In the test harness `auth.uid()` reads a session setting. On Supabase it
derives from the bearer token in the request. The *policies* are byte-identical
— only the identity source differs. This checklist closes that gap.

## Setup

1. Apply migrations `001`–`013` in order
2. Confirm all 16 tables report `rowsecurity = true`
3. Create a second account, add it to your cellar as `viewer`
4. Run each block below **signed in as the stated role**

## As VIEWER

```sql
-- Must FAIL with 42501
insert into wine_definitions (cellar_id, producer, name)
values ('<CELLAR_ID>', 'Should Fail', 'Should Fail');

-- Must affect 0 rows (no error — this is how RLS denies UPDATE)
update bottles set notes = 'should not persist' where cellar_id = '<CELLAR_ID>';
select count(*) from bottles where notes = 'should not persist';  -- expect 0

-- Must FAIL
select create_wine_definition(
  gen_random_uuid(), '<CELLAR_ID>',
  '{"producer":"X","name":"Y"}'::jsonb);

-- Must SUCCEED — viewers read
select count(*) from wine_definitions where cellar_id = '<CELLAR_ID>';
```

## As EDITOR

```sql
-- Must SUCCEED
select create_wine_definition(
  gen_random_uuid(), '<CELLAR_ID>',
  '{"producer":"Editor Test","name":"Editor Test","vintage":2020}'::jsonb);

-- Must FAIL with 42501 — membership is owner-only
insert into cellar_members (cellar_id, user_id, role)
values ('<CELLAR_ID>', '<SOME_USER_ID>', 'editor');

-- Must affect 0 rows — cannot self-promote
update cellar_members set role = 'owner'
where cellar_id = '<CELLAR_ID>' and user_id = auth.uid();
select role from cellar_members where user_id = auth.uid();  -- still 'editor'

-- Must FAIL — profile is owner-only
insert into cellar_profiles (cellar_id, bottles_per_month)
values ('<CELLAR_ID>', 5);
```

## As OWNER

```sql
-- Must SUCCEED
insert into cellar_members (cellar_id, user_id, role)
values ('<CELLAR_ID>', '<SOME_USER_ID>', 'viewer');

update cellar_members set role = 'editor'
where cellar_id = '<CELLAR_ID>' and user_id = '<SOME_USER_ID>';

delete from cellar_members
where cellar_id = '<CELLAR_ID>' and user_id = '<SOME_USER_ID>';
```

## Immutable history — as EVERY role

```sql
-- All must FAIL or affect 0 rows. Run as owner, editor AND viewer.
update bottle_events set notes = 'rewritten' where id = '<EVENT_ID>';
delete from bottle_events where id = '<EVENT_ID>';
update valuation_records set amount = 1 where id = '<VALUATION_ID>';
delete from valuation_records where id = '<VALUATION_ID>';
delete from bottles where id = '<BOTTLE_ID>';
update applied_operations set entity = 'x' where operation_id = '<OP_ID>';

-- Confirm nothing changed
select notes from bottle_events where id = '<EVENT_ID>';  -- not 'rewritten'
```

## Cross-cellar isolation

Sign in as an account belonging to **no** cellar:

```sql
select count(*) from wine_definitions;   -- expect 0
select count(*) from bottles;            -- expect 0
select count(*) from bottle_events;      -- expect 0
select count(*) from cellars;            -- expect 0

-- Must FAIL
insert into wine_definitions (cellar_id, producer, name)
values ('<CELLAR_ID>', 'Outsider', 'Outsider');
```

## Interpreting results

| Outcome | Meaning |
|---|---|
| `42501` | Denied — correct for INSERT |
| 0 rows affected, no error | Denied — correct for UPDATE/DELETE |
| `42P17` | **Policy recursion. Stop and report.** |
| Succeeds when it should not | **Stop and report.** |

A `42P17` would mean the recursion fix in `001_foundation.sql` was not applied.
