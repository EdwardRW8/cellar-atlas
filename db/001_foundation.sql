-- ═══════════════════════════════════════════════════════════════════════════
-- THE CELLAR V3 — Migration 001: Foundation
--
-- Phase 1 scope only: identity, tenancy and access. No wine tables yet —
-- those arrive in Phase 2 with the full domain model.
--
-- Run in the NEW V3 Supabase project:
--   Dashboard → SQL Editor → New query → paste → Run
--
-- This project is separate from V2. Nothing here touches V2's database.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- 1. CELLARS — the tenant boundary
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists cellars (
  id          uuid primary key default gen_random_uuid(),
  name        text not null default 'My Cellar',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid not null references auth.users(id),
  version     integer not null default 1
);


-- ───────────────────────────────────────────────────────────────────────────
-- 2. CELLAR MEMBERS — who may access which cellar
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists cellar_members (
  cellar_id   uuid not null references cellars(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null default 'editor'
              check (role in ('owner','editor','viewer')),
  created_at  timestamptz not null default now(),
  primary key (cellar_id, user_id)
);

create index if not exists idx_members_user on cellar_members(user_id);


-- ───────────────────────────────────────────────────────────────────────────
-- 3. PROFILES — per-user display data, mirrored from auth.users
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  email       text,
  display_name text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);


-- ───────────────────────────────────────────────────────────────────────────
-- 4. APPLIED OPERATIONS — the idempotency ledger
--
-- This is what makes retries safe. Every mutation records its operation id
-- here first; a duplicate hits the primary key and the operation is reported
-- as already applied rather than failing. Without this, a lost response on a
-- flaky connection permanently jams the sync queue — which is exactly what
-- V2 did.
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists applied_operations (
  operation_id uuid primary key,
  cellar_id    uuid not null references cellars(id) on delete cascade,
  user_id      uuid references auth.users(id),
  device_id    text,
  entity       text not null,
  entity_id    uuid not null,
  operation    text not null check (operation in ('create','update','delete')),
  applied_at   timestamptz not null default now()
);

create index if not exists idx_applied_cellar on applied_operations(cellar_id, applied_at desc);


-- ───────────────────────────────────────────────────────────────────────────
-- 5. HEARTBEAT — keeps the free tier from pausing after 7 days idle
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists heartbeat (
  id     bigserial primary key,
  pinged timestamptz not null default now()
);


-- ───────────────────────────────────────────────────────────────────────────
-- 6. MEMBERSHIP HELPERS
-- SECURITY DEFINER prevents infinite recursion when a policy on
-- cellar_members needs to query cellar_members.
-- ───────────────────────────────────────────────────────────────────────────
create or replace function is_cellar_member(target_cellar uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (
    select 1 from cellar_members
    where cellar_id = target_cellar and user_id = auth.uid()
  );
$$;

create or replace function can_edit_cellar(target_cellar uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (
    select 1 from cellar_members
    where cellar_id = target_cellar
      and user_id = auth.uid()
      and role in ('owner','editor')
  );
$$;


-- ───────────────────────────────────────────────────────────────────────────
-- 7. BOOTSTRAP — creating a cellar makes you its owner
-- Without this, the first membership insert is blocked by the very policy
-- that requires you to already be an owner.
-- ───────────────────────────────────────────────────────────────────────────
create or replace function add_creator_as_owner()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into cellar_members (cellar_id, user_id, role)
  values (new.id, new.created_by, 'owner')
  on conflict (cellar_id, user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_cellar_owner on cellars;
create trigger trg_cellar_owner
  after insert on cellars
  for each row execute function add_creator_as_owner();


-- ───────────────────────────────────────────────────────────────────────────
-- 8. PROFILE ON SIGN-UP
-- ───────────────────────────────────────────────────────────────────────────
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (user_id, email)
  values (new.id, new.email)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_new_user on auth.users;
create trigger trg_new_user
  after insert on auth.users
  for each row execute function handle_new_user();


-- ───────────────────────────────────────────────────────────────────────────
-- 9. TIMESTAMP MAINTENANCE
-- ───────────────────────────────────────────────────────────────────────────
create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_cellars_touch on cellars;
create trigger trg_cellars_touch before update on cellars
  for each row execute function touch_updated_at();

drop trigger if exists trg_profiles_touch on profiles;
create trigger trg_profiles_touch before update on profiles
  for each row execute function touch_updated_at();


-- ═══════════════════════════════════════════════════════════════════════════
-- 10. ROW LEVEL SECURITY
--
-- The publishable key is public by design. RLS is the ONLY thing standing
-- between it and every row in the database. Enabled on every table, with no
-- exceptions, before any data exists.
-- ═══════════════════════════════════════════════════════════════════════════

alter table cellars            enable row level security;
alter table cellar_members     enable row level security;
alter table profiles           enable row level security;
alter table applied_operations enable row level security;
alter table heartbeat          enable row level security;

-- CELLARS
drop policy if exists "read own cellars" on cellars;
create policy "read own cellars" on cellars
  for select using (is_cellar_member(id));

drop policy if exists "create cellars" on cellars;
create policy "create cellars" on cellars
  for insert with check (created_by = auth.uid());

drop policy if exists "owners update cellar" on cellars;
create policy "owners update cellar" on cellars
  for update using (
    exists (select 1 from cellar_members
            where cellar_id = cellars.id and user_id = auth.uid() and role = 'owner')
  );

-- CELLAR MEMBERS
drop policy if exists "read members of my cellars" on cellar_members;
create policy "read members of my cellars" on cellar_members
  for select using (is_cellar_member(cellar_id));

drop policy if exists "owners manage members" on cellar_members;
create policy "owners manage members" on cellar_members
  for all using (
    exists (select 1 from cellar_members m
            where m.cellar_id = cellar_members.cellar_id
              and m.user_id = auth.uid() and m.role = 'owner')
  );

-- PROFILES
drop policy if exists "read own profile" on profiles;
create policy "read own profile" on profiles
  for select using (user_id = auth.uid());

drop policy if exists "update own profile" on profiles;
create policy "update own profile" on profiles
  for update using (user_id = auth.uid());

-- APPLIED OPERATIONS — append only. No update or delete policy exists.
drop policy if exists "read own operation log" on applied_operations;
create policy "read own operation log" on applied_operations
  for select using (is_cellar_member(cellar_id));

drop policy if exists "append operations if editor" on applied_operations;
create policy "append operations if editor" on applied_operations
  for insert with check (can_edit_cellar(cellar_id));

-- HEARTBEAT
drop policy if exists "signed in can ping" on heartbeat;
create policy "signed in can ping" on heartbeat
  for insert to authenticated with check (true);

drop policy if exists "signed in can read ping" on heartbeat;
create policy "signed in can read ping" on heartbeat
  for select to authenticated using (true);


-- ───────────────────────────────────────────────────────────────────────────
-- 11. KEEP-ALIVE FUNCTION
-- ───────────────────────────────────────────────────────────────────────────
create or replace function ping()
returns timestamptz language plpgsql security definer set search_path = public as $$
declare t timestamptz;
begin
  insert into heartbeat default values returning pinged into t;
  delete from heartbeat where id < (select max(id) - 30 from heartbeat);
  return t;
end;
$$;

grant execute on function ping() to anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 12. VERIFY — run this separately. Every row must show rowsecurity = true.
-- ═══════════════════════════════════════════════════════════════════════════
-- select tablename, rowsecurity from pg_tables
-- where schemaname = 'public' order by tablename;
--
-- Expect 5 tables, all true:
--   applied_operations, cellar_members, cellars, heartbeat, profiles
