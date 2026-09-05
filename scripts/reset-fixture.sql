-- ═══════════════════════════════════════════════════════════════════════════
-- RESET DEVELOPMENT FIXTURE
--
-- Removes ONLY rows created by the fixture, identified by the [DEV-FIXTURE]
-- marker. Anything else in the cellar is untouched.
--
-- ⚠️  DEVELOPMENT ONLY. Never run against a cellar holding real data.
--
-- Bottles and history are immutable through the normal API by design, so a
-- reset must be run here with elevated rights rather than from the app.
--
-- USAGE: replace the cellar id, then run.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_cellar uuid := '00000000-0000-0000-0000-000000000000';  -- ← SET THIS
  v_marker text := '%[DEV-FIXTURE]%';
  v_wines uuid[];
  v_bottles uuid[];
  v_real int;
begin
  if v_cellar = '00000000-0000-0000-0000-000000000000' then
    raise exception 'Set v_cellar to your development cellar id first';
  end if;

  -- Refuse if the cellar holds anything the fixture did not create.
  select count(*) into v_real from wine_definitions
  where cellar_id = v_cellar and (notes is null or notes not like v_marker);

  if v_real > 0 then
    raise exception
      'Cellar contains % non-fixture wine(s). Refusing to reset.', v_real;
  end if;

  select array_agg(id) into v_wines from wine_definitions
  where cellar_id = v_cellar and notes like v_marker;

  if v_wines is null then
    raise notice 'Nothing to remove.';
    return;
  end if;

  select array_agg(id) into v_bottles from bottles
  where cellar_id = v_cellar and wine_definition_id = any(v_wines);

  -- Children first.
  delete from bottle_events     where bottle_id = any(coalesce(v_bottles, '{}'));
  delete from tasting_records   where wine_definition_id = any(v_wines);
  delete from valuation_records where wine_definition_id = any(v_wines)
                                   or bottle_id = any(coalesce(v_bottles, '{}'));
  delete from bottles           where id = any(coalesce(v_bottles, '{}'));
  delete from acquisition_items where wine_definition_id = any(v_wines);
  delete from acquisitions      where cellar_id = v_cellar and notes like v_marker;
  delete from wine_definitions  where id = any(v_wines);

  delete from storage_locations where cellar_id = v_cellar
    and name in ('Home Cellar','Berry Bros & Rudd','The Wine Society')
    and not exists (select 1 from bottles b where b.storage_location_id = storage_locations.id);

  delete from storage_layouts where cellar_id = v_cellar
    and name = 'Staircase Rack'
    and not exists (select 1 from storage_locations sl where sl.storage_layout_id = storage_layouts.id);

  delete from applied_operations where cellar_id = v_cellar;

  raise notice 'Removed % wines and % bottles.',
    array_length(v_wines,1), coalesce(array_length(v_bottles,1),0);
end $$;
