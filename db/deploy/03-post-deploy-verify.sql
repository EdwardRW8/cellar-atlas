-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 3 — POST-DEPLOYMENT VERIFICATION
--
-- Run AFTER applying migrations 001 → 013.
-- Every row of output must say PASS. Anything else, stop and report.
-- ═══════════════════════════════════════════════════════════════════════════

with checks as (

  select 1 as n, 'All 16 tables exist' as check_name,
    case when count(*) = 16 then 'PASS' else 'FAIL — found ' || count(*) end as result
  from pg_tables where schemaname='public'

  union all select 2, 'RLS enabled on every table',
    case when count(*) = 0 then 'PASS' else 'FAIL — ' || string_agg(tablename, ', ') end
  from pg_tables where schemaname='public' and rowsecurity = false

  union all select 3, 'source_operation_id present',
    case when count(*) = 1 then 'PASS' else 'FAIL — Phase 2.1 not applied' end
  from information_schema.columns
  where table_name='bottle_events' and column_name='source_operation_id'

  union all select 4, 'old operation_id column removed',
    case when count(*) = 0 then 'PASS' else 'FAIL — old column still present' end
  from information_schema.columns
  where table_name='bottle_events' and column_name='operation_id'

  union all select 5, 'source_operation_id is NOT unique',
    case when count(*) = 0 then 'PASS' else 'FAIL — unique index would break acquisitions' end
  from pg_indexes
  where tablename='bottle_events' and indexdef ilike '%source_operation_id%'
    and indexdef ilike '%unique%'

  union all select 6, 'bottles has NO soft-delete column',
    case when count(*) = 0 then 'PASS' else 'FAIL — deleted_at present' end
  from information_schema.columns
  where table_name='bottles' and column_name='deleted_at'

  union all select 7, 'membership policy uses SECURITY DEFINER helper',
    case when bool_or(qual ilike '%is_cellar_owner%') then 'PASS'
         else 'FAIL — recursion bug present (42P17)' end
  from pg_policies where tablename='cellar_members' and policyname='owners manage members'

  union all select 8, 'no DELETE policy anywhere',
    case when count(*) = 0 then 'PASS' else 'FAIL — ' || string_agg(tablename,', ') end
  from pg_policies where cmd='DELETE'

  union all select 9, 'no UPDATE policy on immutable tables',
    case when count(*) = 0 then 'PASS' else 'FAIL — ' || string_agg(tablename,', ') end
  from pg_policies where cmd='UPDATE'
    and tablename in ('bottle_events','valuation_records','applied_operations')

  union all select 10, 'all mutation functions are SECURITY INVOKER',
    case when count(*) = 0 then 'PASS'
         else 'FAIL — SECURITY DEFINER on ' || string_agg(proname,', ') end
  from pg_proc where pronamespace='public'::regnamespace and prosecdef = true
    and proname in ('create_wine_definition','update_wine_definition',
      'create_storage_layout','create_storage_location','create_acquisition_with_items',
      'move_bottle','change_bottle_status','correct_bottle','record_tasting',
      'record_valuation','upsert_cellar_profile','claim_operation')

  union all select 11, 'membership helpers ARE SECURITY DEFINER',
    case when count(*) = 3 then 'PASS' else 'FAIL — recursion risk' end
  from pg_proc where pronamespace='public'::regnamespace and prosecdef = true
    and proname in ('is_cellar_member','can_edit_cellar','is_cellar_owner')

  union all select 12, 'storage_layouts has no default type or capacity',
    case when count(*) = 0 then 'PASS' else 'FAIL — a default layout is assumed' end
  from information_schema.columns
  where table_name='storage_layouts' and column_name in ('type','capacity')
    and column_default is not null

  union all select 13, 'NO storage seeded by migration',
    case when (select count(*) from storage_layouts) = 0
          and (select count(*) from storage_locations) = 0
         then 'PASS' else 'FAIL — migrations created storage' end

  union all select 14, 'geography seeded with provenance',
    case when count(*) > 150 and count(*) filter (where source is null) = 0
         then 'PASS — ' || count(*) || ' rows'
         else 'FAIL — ' || count(*) || ' rows, ' ||
              count(*) filter (where source is null) || ' missing source' end
  from geo_regions

  union all select 15, 'no geography claims boundary data',
    case when count(*) = 0 then 'PASS' else 'FAIL — ' || count(*) || ' claim boundaries' end
  from geo_regions where has_boundary = true

  union all select 16, 'no hand-curated centroid claims exact precision',
    case when count(*) = 0 then 'PASS' else 'FAIL — ' || count(*) || ' overclaim' end
  from geo_regions where source='manual-curation' and centroid_precision='exact'

  union all select 17, 'slot uniqueness index exists',
    case when count(*) = 1 then 'PASS' else 'FAIL — duplicate slots possible' end
  from pg_indexes
  where tablename='bottles' and indexname='idx_bottle_slot_unique'

  union all select 18, 'position and position_key travel together',
    case when count(*) = 1 then 'PASS' else 'FAIL' end
  from pg_constraint where conname='chk_bottle_position_pair'
)
select n, check_name, result from checks order by n;

-- Every row must read PASS.
