-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 1 — INSPECT CURRENT V3 SUPABASE STATE
--
-- COMPLETELY READ ONLY. Creates nothing, alters nothing, drops nothing.
--
-- Safe against ANY schema state: empty, partially migrated, or fully
-- migrated. No table is read until its existence has been established via
-- pg_catalog, so a missing relation reports NOT PRESENT rather than
-- aborting the inspection.
--
-- Returns ONE result set. Read it top to bottom; the verdict is at the end.
-- ═══════════════════════════════════════════════════════════════════════════

with

-- ── Every table V3 expects, with the migration that creates it ────────────
expected(ord, tbl, migration, category) as (values
  ( 1, 'cellars',            '001', 'domain'),
  ( 2, 'cellar_members',     '001', 'domain'),
  ( 3, 'profiles',           '001', 'derived'),
  ( 4, 'applied_operations', '001', 'domain'),
  ( 5, 'heartbeat',          '001', 'operational'),
  ( 6, 'geo_regions',        '002', 'reference'),
  ( 7, 'wine_definitions',   '004', 'domain'),
  ( 8, 'storage_layouts',    '005', 'domain'),
  ( 9, 'storage_locations',  '005', 'domain'),
  (10, 'acquisitions',       '006', 'domain'),
  (11, 'acquisition_items',  '006', 'domain'),
  (12, 'bottles',            '007', 'domain'),
  (13, 'bottle_events',      '009', 'domain'),
  (14, 'tasting_records',    '010', 'domain'),
  (15, 'valuation_records',  '010', 'domain'),
  (16, 'cellar_profiles',    '011', 'domain')
),

-- ── Which of them actually exist? Catalog only — always safe. ─────────────
existing as (
  select e.ord, e.tbl, e.migration, e.category, t.rowsecurity
  from expected e
  join pg_tables t on t.schemaname = 'public' and t.tablename = e.tbl
),

-- ── Row counts, computed ONLY for tables proven to exist ──────────────────
-- query_to_xml lets pure SQL count a dynamically-named table. It is only
-- ever handed rows from `existing`, so it never sees a missing relation.
counted as (
  select x.tbl,
         (xpath('/row/c/text()',
            query_to_xml(format('select count(*) as c from public.%I', x.tbl),
                         false, true, '')))[1]::text::bigint as n
  from existing x
),

-- ── auth.users, guarded the same way ──────────────────────────────────────
auth_users as (
  select case
           when to_regclass('auth.users') is null then null::bigint
           else (xpath('/row/c/text()',
                   query_to_xml('select count(*) as c from auth.users',
                                false, true, '')))[1]::text::bigint
         end as n
),

-- ── Summary numbers used by the verdict ───────────────────────────────────
summary as (
  select
    (select count(*) from existing)                                   as tables_present,
    (select count(*) from expected)                                   as tables_expected,
    (select count(*) from existing where rowsecurity = false)          as rls_off,
    (select coalesce(sum(c.n), 0)
       from counted c join expected e on e.tbl = c.tbl
      where e.category = 'domain')                                    as domain_rows,
    (select coalesce(n, 0) from auth_users)                           as user_count,
    (to_regclass('public.wines') is not null
     or to_regclass('public.change_log') is not null)                 as looks_like_v2,
    (select count(*) from information_schema.columns
      where table_schema='public' and table_name='bottle_events'
        and column_name='source_operation_id')                        as has_source_op,
    (select count(*) from information_schema.columns
      where table_schema='public' and table_name='bottle_events'
        and column_name='operation_id')                               as has_old_op,
    (select count(*) from information_schema.columns
      where table_schema='public' and table_name='bottles'
        and column_name='deleted_at')                                 as has_soft_delete,
    (select count(*) from pg_policies
      where schemaname='public' and tablename='cellar_members'
        and policyname='owners manage members'
        and qual ilike '%is_cellar_owner%')                           as recursion_fixed,
    (select count(*) from pg_policies
      where schemaname='public' and tablename='cellar_members'
        and policyname='owners manage members'
        and qual ilike '%from cellar_members%')                       as recursion_broken
),

-- ═════════════════════════════════════════════════════════════════════════
-- REPORT SECTIONS
-- ═════════════════════════════════════════════════════════════════════════

s0_header as (
  select 0 as sect, 0 as ord,
         'INSPECTION' as item,
         'read-only; no changes made' as detail
),

-- ── 1. WRONG PROJECT? ────────────────────────────────────────────────────
-- to_regclass returns NULL for a missing table, so this is safe even when
-- neither V2 nor V3 tables exist.
s1_project as (
  select 1, 1,
         'Project identity',
         case when (select looks_like_v2 from summary)
              then 'STOP — V2 signature found (public.wines / public.change_log). '
                   'You are in the WRONG Supabase project.'
              else 'OK — no V2 signature tables present' end
),

-- ── 2. TABLE PRESENCE ────────────────────────────────────────────────────
s2_tables as (
  select 2, e.ord,
         'Table: ' || e.tbl || '  (migration ' || e.migration || ', ' || e.category || ')',
         case when x.tbl is null then 'NOT PRESENT — migration ' || e.migration || ' not applied'
              else 'present' end
  from expected e
  left join existing x on x.tbl = e.tbl
),

s2_summary as (
  select 2, 99,
         'Tables present',
         (select tables_present::text || ' of ' || tables_expected::text from summary)
),

-- ── 3. ROW SECURITY ──────────────────────────────────────────────────────
s3_rls as (
  select 3, 1,
         'RLS enabled on all present tables',
         case
           when (select tables_present from summary) = 0 then 'n/a — no tables yet'
           when (select rls_off from summary) = 0 then 'yes — all present tables protected'
           else 'NO — RLS disabled on: ' ||
                (select string_agg(tbl, ', ' order by tbl) from existing where rowsecurity = false)
         end
),

-- ── 4. SCHEMA VERSION MARKERS ────────────────────────────────────────────
s4_event_model as (
  select 4, 1,
         'Event operation model',
         case
           when (select count(*) from existing where tbl='bottle_events') = 0
             then 'NOT PRESENT — migration 009 not applied'
           when (select has_source_op from summary) = 1 and (select has_old_op from summary) = 0
             then 'source_operation_id — Phase 2.1 applied'
           when (select has_old_op from summary) = 1
             then 'operation_id — OLD MODEL, Phase 2.1 NOT applied'
           else 'unrecognised — neither column found'
         end
),

s4_soft_delete as (
  select 4, 2,
         'bottles.deleted_at (must be absent)',
         case
           when (select count(*) from existing where tbl='bottles') = 0
             then 'NOT PRESENT — migration 007 not applied'
           when (select has_soft_delete from summary) = 0 then 'absent — correct'
           else 'PRESENT — Phase 2.1 not applied'
         end
),

s4_recursion as (
  select 4, 3,
         'Membership policy (RLS recursion fix)',
         case
           when (select count(*) from existing where tbl='cellar_members') = 0
             then 'NOT PRESENT — migration 001 not applied'
           when (select recursion_fixed from summary) > 0
             then 'FIXED — uses is_cellar_owner() SECURITY DEFINER helper'
           when (select recursion_broken from summary) > 0
             then 'BROKEN — inline subquery will raise 42P17 infinite recursion'
           else 'policy missing'
         end
),

-- ── 5. FUNCTIONS ─────────────────────────────────────────────────────────
s5_functions as (
  select 5, 1,
         'Mutation functions present',
         coalesce((
           select count(*)::text || ' of 16'
           from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname in (
               'create_wine_definition','update_wine_definition','create_storage_layout',
               'create_storage_location','create_acquisition_with_items','move_bottle',
               'change_bottle_status','correct_bottle','record_tasting','record_valuation',
               'upsert_cellar_profile','claim_operation','claimed_entity_id',
               'validate_position','layout_capacity','location_layout')
         ), '0 of 16')
),

s5_secdef as (
  select 5, 2,
         'Mutation functions wrongly SECURITY DEFINER',
         coalesce((
           select string_agg(proname, ', ' order by proname)
           from pg_proc
           where pronamespace = 'public'::regnamespace and prosecdef
             and proname in (
               'create_wine_definition','update_wine_definition','create_storage_layout',
               'create_storage_location','create_acquisition_with_items','move_bottle',
               'change_bottle_status','correct_bottle','record_tasting','record_valuation',
               'upsert_cellar_profile','claim_operation')
         ), 'none — all SECURITY INVOKER, correct')
),

-- ── 6. IMMUTABILITY ──────────────────────────────────────────────────────
s6_delete_policies as (
  select 6, 1,
         'DELETE policies (must be none)',
         coalesce((select string_agg(tablename || '.' || policyname, ', ')
                   from pg_policies where schemaname='public' and cmd='DELETE'),
                  'none — correct')
),

s6_update_policies as (
  select 6, 2,
         'UPDATE policies on immutable tables (must be none)',
         coalesce((select string_agg(tablename || '.' || policyname, ', ')
                   from pg_policies
                   where schemaname='public' and cmd='UPDATE'
                     and tablename in ('bottle_events','valuation_records','applied_operations')),
                  'none — correct')
),

-- ── 7. GEOGRAPHY (guarded — this is the check that previously aborted) ────
s7_geo as (
  select 7, 1,
         'Geography reference data',
         case
           when (select count(*) from existing where tbl='geo_regions') = 0
             then 'NOT PRESENT — migration 002 not applied'
           when (select coalesce(n,0) from counted where tbl='geo_regions') = 0
             then 'table exists but empty — migration 003 not applied'
           else (select n::text from counted where tbl='geo_regions') || ' rows'
         end
),

s7_geo_provenance as (
  select 7, 2,
         'Geography provenance & precision',
         case
           when (select count(*) from existing where tbl='geo_regions') = 0
             then 'NOT PRESENT'
           when (select count(*) from information_schema.columns
                  where table_schema='public' and table_name='geo_regions'
                    and column_name='source') = 0
             then 'geo_regions exists but has no source column — old schema'
           else (
             select 'missing source: ' ||
                    (xpath('/row/c/text()', query_to_xml(
                      'select count(*) as c from public.geo_regions where source is null',
                      false, true, '')))[1]::text ||
                    ', claiming boundaries: ' ||
                    (xpath('/row/c/text()', query_to_xml(
                      'select count(*) as c from public.geo_regions where has_boundary',
                      false, true, '')))[1]::text
           )
         end
),

-- ── 8. DATA — the counts that decide patch vs rebuild ────────────────────
s8_data as (
  select 8, e.ord,
         'Data: ' || e.tbl,
         case
           when c.n is null then 'NOT PRESENT'
           when c.n = 0 then '0'
           else c.n::text || case when e.category = 'domain' then '   <-- DOMAIN DATA' else '' end
         end
  from expected e
  left join counted c on c.tbl = e.tbl
  where e.category in ('domain','reference','operational','derived')
),

s8_auth as (
  select 8, 90,
         'Data: auth.users (always preserved)',
         coalesce((select n::text from auth_users), 'auth schema not accessible')
),

s8_total as (
  select 8, 99,
         'TOTAL DOMAIN ROWS',
         (select domain_rows::text from summary) ||
         case when (select domain_rows from summary) > 0
              then '   <-- REBUILD WILL BE REFUSED'
              else '   <-- clean, rebuild permitted' end
),

-- ── 9. VERDICT ───────────────────────────────────────────────────────────
s9_verdict as (
  select 9, 1,
         'RECOMMENDED ACTION',
         case
           when (select looks_like_v2 from summary)
             then 'STOP. This is the V2 project. Change projects before doing anything.'
           when (select tables_present from summary) = 0
             then 'PATH A — nothing deployed. Apply migrations 001 to 013 in order. '
                  'No rebuild needed.'
           when (select domain_rows from summary) > 0
             then 'PATH D — domain data present. Do NOT rebuild. '
                  'Send me this output and we will patch instead.'
           when (select tables_present from summary) < (select tables_expected from summary)
             then 'PATH B — partial deployment, no data. Run 02-clean-rebuild.sql, '
                  'then apply 001 to 013 in order.'
           when (select has_old_op from summary) = 1
                or (select has_soft_delete from summary) = 1
                or (select recursion_broken from summary) > 0
             then 'PATH C — fully deployed but on an OLD schema, no data. '
                  'Run 02-clean-rebuild.sql, then apply 001 to 013 in order.'
           else 'PATH E — schema is current and empty. Skip the rebuild. '
                'Go straight to 03-post-deploy-verify.sql, then 04-live-rls-verification.sql.'
         end
),

s9_note as (
  select 9, 2,
         'Reminder',
         'This script changed nothing. The rebuild script has its own '
         'independent preflight and will refuse if any domain data exists.'
)

-- ═════════════════════════════════════════════════════════════════════════
select
  case sect
    when 0 then '0. START'
    when 1 then '1. PROJECT'
    when 2 then '2. TABLES'
    when 3 then '3. SECURITY'
    when 4 then '4. SCHEMA VERSION'
    when 5 then '5. FUNCTIONS'
    when 6 then '6. IMMUTABILITY'
    when 7 then '7. GEOGRAPHY'
    when 8 then '8. DATA'
    when 9 then '9. VERDICT'
  end as section,
  item,
  detail
from (
  select * from s0_header
  union all select * from s1_project
  union all select * from s2_tables
  union all select * from s2_summary
  union all select * from s3_rls
  union all select * from s4_event_model
  union all select * from s4_soft_delete
  union all select * from s4_recursion
  union all select * from s5_functions
  union all select * from s5_secdef
  union all select * from s6_delete_policies
  union all select * from s6_update_policies
  union all select * from s7_geo
  union all select * from s7_geo_provenance
  union all select * from s8_data
  union all select * from s8_auth
  union all select * from s8_total
  union all select * from s9_verdict
  union all select * from s9_note
) report(sect, ord, item, detail)
order by sect, ord;
