-- ═══════════════════════════════════════════════════════════════════════════
-- 013 — ROW LEVEL SECURITY
--
-- The publishable key is public by design. RLS is the ONLY thing between it
-- and every row. Enabled on every table before any data exists.
--
-- NO TABLE HAS A DELETE POLICY. Removal is always a soft update, or a status
-- change for bottles. The application is structurally incapable of destroying
-- a record.
--
-- IMMUTABLE TABLES ARE PROTECTED BY OMISSION, not by trigger. bottle_events,
-- valuation_records and applied_operations have SELECT and INSERT policies
-- only. With no policy permitting update or delete, Postgres refuses
-- regardless of what the client sends.
-- ═══════════════════════════════════════════════════════════════════════════

-- is_cellar_owner() is defined in 001_foundation.sql, because the
-- cellar_members policy there depends on it to avoid 42P17 recursion.

alter table wine_definitions  enable row level security;
alter table storage_layouts   enable row level security;
alter table storage_locations enable row level security;
alter table acquisitions      enable row level security;
alter table acquisition_items enable row level security;
alter table bottles           enable row level security;
alter table bottle_events     enable row level security;
alter table tasting_records   enable row level security;
alter table valuation_records enable row level security;
alter table cellar_profiles   enable row level security;

-- ── READ: any member. WRITE: editor or owner. DELETE: nobody. ─────────────
do $$
declare t text;
begin
  foreach t in array array[
    'wine_definitions','storage_layouts','storage_locations',
    'acquisitions','acquisition_items','bottles','tasting_records'
  ] loop
    execute format('drop policy if exists "read %1$s" on %1$I', t);
    execute format(
      'create policy "read %1$s" on %1$I for select using (is_cellar_member(cellar_id))', t);

    execute format('drop policy if exists "insert %1$s" on %1$I', t);
    execute format(
      'create policy "insert %1$s" on %1$I for insert with check (can_edit_cellar(cellar_id))', t);

    execute format('drop policy if exists "update %1$s" on %1$I', t);
    execute format(
      'create policy "update %1$s" on %1$I for update using (can_edit_cellar(cellar_id))', t);
    -- No delete policy. Deliberate.
  end loop;
end $$;

-- ── IMMUTABLE: select + insert only ───────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['bottle_events','valuation_records'] loop
    execute format('drop policy if exists "read %1$s" on %1$I', t);
    execute format(
      'create policy "read %1$s" on %1$I for select using (is_cellar_member(cellar_id))', t);

    execute format('drop policy if exists "append %1$s" on %1$I', t);
    execute format(
      'create policy "append %1$s" on %1$I for insert with check (can_edit_cellar(cellar_id))', t);
    -- No update policy. No delete policy. History cannot be rewritten.
  end loop;
end $$;

-- ── CELLAR PROFILE: read any member, write owner only ─────────────────────
drop policy if exists "read cellar_profiles" on cellar_profiles;
create policy "read cellar_profiles" on cellar_profiles
  for select using (is_cellar_member(cellar_id));

drop policy if exists "insert cellar_profiles" on cellar_profiles;
create policy "insert cellar_profiles" on cellar_profiles
  for insert with check (is_cellar_owner(cellar_id));

drop policy if exists "update cellar_profiles" on cellar_profiles;
create policy "update cellar_profiles" on cellar_profiles
  for update using (is_cellar_owner(cellar_id));


-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFY — every table must report true.
-- ═══════════════════════════════════════════════════════════════════════════
-- select tablename, rowsecurity from pg_tables
-- where schemaname = 'public' order by tablename;
--
-- Expect 16 tables, all true:
--   acquisition_items, acquisitions, applied_operations, bottle_events,
--   bottles, cellar_members, cellar_profiles, cellars, geo_regions,
--   heartbeat, profiles, storage_layouts, storage_locations,
--   tasting_records, valuation_records, wine_definitions
