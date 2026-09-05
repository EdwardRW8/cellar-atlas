-- ═══════════════════════════════════════════════════════════════════════════
--
--   ⚠️⚠️⚠️  DESTRUCTIVE — V3 DEVELOPMENT PROJECT ONLY  ⚠️⚠️⚠️
--
--   THIS SCRIPT DROPS EVERY APPLICATION TABLE IN THE CURRENT DATABASE.
--
--   BEFORE RUNNING, CONFIRM ALL OF THE FOLLOWING:
--
--     [ ] The Supabase project selector reads  cellar-atlas  (the V3 project)
--     [ ] It does NOT read the V2 project (iadaahmjvzctwmtnixpq)
--     [ ] You have run 01-inspect-current-state.sql and read the output
--     [ ] You accept that everything except auth.users will be destroyed
--
--   V2 LIVES IN A SEPARATE SUPABASE PROJECT AND MUST NEVER SEE THIS SCRIPT.
--   Running it against V2 would destroy that database.
--
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT IT DOES
--   1. Refuses outright if this looks like the V2 database
--   2. Counts every domain table and PRINTS the result
--   3. Refuses if ANY meaningful user or domain data exists
--   4. Only then drops tables and functions
--
-- WHAT IT PRESERVES
--   auth.users — your login survives. Migration 001 backfills public.profiles
--   for every existing user, so no account is left without one.
--
-- WHAT IT IGNORES when deciding whether to proceed
--   geo_regions — shared reference data, recreated by migration 003
--   heartbeat   — operational keep-alive rows, no user meaning
--   profiles    — derived from auth.users and rebuilt by 001's backfill
--
-- AFTER RUNNING: apply migrations 001 -> 013 in order.
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════
-- PREFLIGHT FUNCTIONS
--
-- Defined as real functions rather than inline logic so they are testable in
-- isolation, and so you can inspect the report before anything is dropped.
-- They are removed again at the end of this script.
-- ═══════════════════════════════════════════════════════════════════════════

/** Row count for a table, or NULL if the table does not exist. */
create or replace function preflight_row_count(p_table text)
returns bigint language plpgsql stable as $$
declare n bigint;
begin
  if to_regclass('public.' || quote_ident(p_table)) is null then
    return null;
  end if;
  execute format('select count(*) from public.%I', p_table) into n;
  return n;
end $$;


/**
 * Does this database look like V2 rather than V3?
 *
 * V2's schema had `wines` and `change_log`. V3 has `wine_definitions` and
 * `bottle_events`. If the V2 signature tables are present, this is the wrong
 * project and the script must abort before touching anything.
 */
create or replace function preflight_looks_like_v2()
returns boolean language sql stable as $$
  select to_regclass('public.wines') is not null
      or to_regclass('public.change_log') is not null;
$$;


/**
 * Every table whose contents represent real user or domain data.
 *
 * Deliberately comprehensive. A project can hold meaningful state with no
 * bottles and no wines at all — a cellar with members and configured storage
 * is real work that must not be silently destroyed.
 */
create or replace function preflight_rebuild_report()
returns table (object text, row_count bigint, blocks_rebuild boolean)
language plpgsql stable as $$
declare
  v_domain text[] := array[
    'cellars', 'cellar_members', 'cellar_profiles',
    'storage_layouts', 'storage_locations',
    'wine_definitions', 'acquisitions', 'acquisition_items',
    'bottles', 'bottle_events',
    'tasting_records', 'valuation_records',
    'applied_operations'
  ];
  -- Present but NOT grounds for refusal. See header for reasoning.
  v_ignored text[] := array['geo_regions', 'heartbeat', 'profiles'];
  t text;
  n bigint;
begin
  foreach t in array v_domain loop
    n := preflight_row_count(t);
    object := t;
    row_count := n;
    blocks_rebuild := coalesce(n, 0) > 0;
    return next;
  end loop;

  foreach t in array v_ignored loop
    n := preflight_row_count(t);
    object := t || ' (ignored)';
    row_count := n;
    blocks_rebuild := false;
    return next;
  end loop;

  -- Reported for context. Preserved, never a blocker.
  object := 'auth.users (preserved)';
  row_count := (select count(*) from auth.users);
  blocks_rebuild := false;
  return next;
end $$;


/** Raises unless a destructive rebuild is safe. */
create or replace function preflight_assert_rebuild_safe()
returns void language plpgsql as $$
declare
  v_blocking text;
  v_total bigint;
begin
  if preflight_looks_like_v2() then
    raise exception
      'ABORTED - this looks like the V2 database. Found public.wines or '
      'public.change_log, which V3 does not have. You are almost certainly '
      'in the wrong Supabase project.'
      using errcode = '42501';
  end if;

  select string_agg(object || '=' || row_count, ', ' order by object),
         sum(row_count)
    into v_blocking, v_total
  from preflight_rebuild_report()
  where blocks_rebuild;

  if v_blocking is not null then
    raise exception
      'ABORTED - this database contains % row(s) of real domain data. '
      'Blocking: %. A cellar, a membership or a configured storage location '
      'is real work. Export first, or remove this interlock deliberately.',
      v_total, v_blocking
      using errcode = '23514';
  end if;
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- PREFLIGHT REPORT - read this before the script proceeds
-- ═══════════════════════════════════════════════════════════════════════════

select
  object,
  coalesce(row_count::text, '(table absent)') as rows,
  case when blocks_rebuild then 'BLOCKS REBUILD' else 'ok' end as verdict
from preflight_rebuild_report()
order by blocks_rebuild desc, object;


-- ═══════════════════════════════════════════════════════════════════════════
-- INTERLOCK - raises and stops the script if anything above blocks
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  perform preflight_assert_rebuild_safe();
  raise notice 'Preflight passed. No domain data found. Proceeding with rebuild.';
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- ===                    DESTRUCTIVE SECTION BELOW                       ===
-- ===     Nothing above this line modifies the database in any way.      ===
-- ═══════════════════════════════════════════════════════════════════════════

-- Children before parents.
drop table if exists bottle_events      cascade;
drop table if exists valuation_records  cascade;
drop table if exists tasting_records    cascade;
drop table if exists bottles            cascade;
drop table if exists acquisition_items  cascade;
drop table if exists acquisitions       cascade;
drop table if exists wine_definitions   cascade;
drop table if exists storage_locations  cascade;
drop table if exists storage_layouts    cascade;
drop table if exists cellar_profiles    cascade;
drop table if exists applied_operations cascade;
drop table if exists cellar_members     cascade;
drop table if exists cellars            cascade;
drop table if exists geo_regions        cascade;
drop table if exists heartbeat          cascade;

-- profiles IS dropped, and migration 001 recreates it AND backfills every
-- existing auth.users row. Dropping it guarantees the schema matches 001
-- rather than leaving a stale table that `create table if not exists` would
-- silently skip. See docs/deployment.md for the reasoning.
drop table if exists profiles           cascade;

-- Functions.
drop function if exists is_cellar_member(uuid) cascade;
drop function if exists can_edit_cellar(uuid) cascade;
drop function if exists is_cellar_owner(uuid) cascade;
drop function if exists add_creator_as_owner() cascade;
drop function if exists handle_new_user() cascade;
drop function if exists touch_updated_at() cascade;
drop function if exists ping() cascade;
drop function if exists geo_ancestry(uuid) cascade;
drop function if exists is_pos_int(jsonb) cascade;
drop function if exists validate_position(text, jsonb, jsonb) cascade;
drop function if exists layout_capacity(text, jsonb) cascade;
drop function if exists location_layout(uuid) cascade;
drop function if exists raise_version_conflict(int, int) cascade;
drop function if exists claim_operation(uuid, uuid, text, uuid, text, text) cascade;
drop function if exists claimed_entity_id(uuid) cascade;
drop function if exists create_wine_definition(uuid, uuid, jsonb, text) cascade;
drop function if exists update_wine_definition(uuid, uuid, integer, jsonb, text) cascade;
drop function if exists create_storage_layout(uuid, uuid, text, text, jsonb, text) cascade;
drop function if exists create_storage_location(uuid, uuid, text, text, uuid, boolean, text, text) cascade;
drop function if exists create_acquisition_with_items(uuid, uuid, jsonb, jsonb, text) cascade;
drop function if exists move_bottle(uuid, uuid, integer, uuid, jsonb, text, text, text) cascade;
drop function if exists change_bottle_status(uuid, uuid, integer, text, timestamptz, text, text, text) cascade;
drop function if exists correct_bottle(uuid, uuid, integer, text, jsonb, text) cascade;
drop function if exists record_tasting(uuid, uuid, jsonb, text) cascade;
drop function if exists record_valuation(uuid, uuid, jsonb, text) cascade;
drop function if exists upsert_cellar_profile(uuid, uuid, jsonb, text) cascade;
drop function if exists invite_member(uuid, text, text) cascade;
drop function if exists list_members(uuid) cascade;

-- The auth.users trigger goes with handle_new_user() cascade; be explicit.
drop trigger if exists trg_new_user on auth.users;

-- Preflight helpers are no longer needed.
drop function if exists preflight_assert_rebuild_safe() cascade;
drop function if exists preflight_rebuild_report() cascade;
drop function if exists preflight_looks_like_v2() cascade;
drop function if exists preflight_row_count(text) cascade;

do $$
declare v_users int;
begin
  select count(*) into v_users from auth.users;
  raise notice 'Rebuild complete. % auth user(s) preserved.', v_users;
  raise notice 'Now apply migrations 001 through 013 in order.';
  raise notice '001 will recreate public.profiles and backfill all % user(s).', v_users;
end $$;
