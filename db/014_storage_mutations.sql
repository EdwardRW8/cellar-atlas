-- ═══════════════════════════════════════════════════════════════════════════
-- 014 — STORAGE MUTATIONS (Phase 4)
--
-- Adds update and soft-delete for storage locations and layouts. Purely
-- additive: no existing table, policy, function or migration is altered.
--
-- All functions are SECURITY INVOKER, so RLS applies with the caller's own
-- rights. All follow the established operation-id and expected-version
-- conventions.
--
-- ── THE TWO SAFETY GUARANTEES ────────────────────────────────────────────
--
-- 1. GEOMETRY CHANGES ARE VALIDATED PER BOTTLE, NOT BY CAPACITY.
--
--    Comparing capacities is not sufficient. Reshaping a 4x4 grid into an
--    8x2 grid leaves capacity at 16 while destroying every position with
--    y > 2. Every live bottle's stored position is therefore re-validated
--    against the PROPOSED config using validate_position() — the same
--    authoritative rules the write path uses.
--
-- 2. SOFT DELETE REFUSES WHILE OCCUPIED.
--
--    `on delete restrict` only protects a physical DELETE. A soft delete is
--    an UPDATE, so the foreign key never fires. The check is explicit here.
--    The row is never physically removed and bottle_events is untouched.
-- ═══════════════════════════════════════════════════════════════════════════


/**
 * Validate a position without raising.
 *
 * validate_position() raises on failure, which is right for a single write
 * but useless when checking many bottles and reporting all the problems.
 * This wraps it so the caller can collect failures.
 */
create or replace function try_validate_position(
  p_layout_type text,
  p_config      jsonb,
  p_position    jsonb
) returns table (ok boolean, position_key text, reason text)
language plpgsql stable as $$
begin
  begin
    position_key := validate_position(p_layout_type, p_config, p_position);
    ok := true;
    reason := null;
  exception when others then
    ok := false;
    position_key := null;
    reason := SQLERRM;
  end;
  return next;
end $$;


/**
 * Which live bottles would a proposed layout config invalidate?
 *
 * Read-only. Returns one row per bottle whose CURRENT position would no
 * longer be valid, so the caller can name them in an error rather than
 * saying only that something went wrong.
 *
 * Only `status = 'in_cellar'` bottles matter — a consumed bottle holds no
 * position and its history is immutable regardless.
 */
create or replace function layout_change_conflicts(
  p_layout_id uuid,
  p_new_type  text,
  p_new_config jsonb
-- NOTE: the column is `bottle_position`, not `position`. POSITION is a
-- reserved keyword in Postgres — the POSITION(substring IN string) function —
-- and using it as an output column name is a syntax error.
) returns table (
  bottle_id       uuid,
  location_name   text,
  bottle_position jsonb,
  position_key    text,
  reason          text
)
language sql stable as $$
  select
    b.id,
    sl.name,
    b.position,
    b.position_key,
    v.reason
  from bottles b
  join storage_locations sl on sl.id = b.storage_location_id
  cross join lateral try_validate_position(p_new_type, p_new_config, b.position) v
  where sl.storage_layout_id = p_layout_id
    and b.status = 'in_cellar'
    and b.position is not null
    and not v.ok;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- UPDATE A STORAGE LOCATION
-- Rename, reorder, change the merchant reference. Geometry lives on the
-- layout, so this never touches positions.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function update_storage_location(
  p_operation_id     uuid,
  p_location_id      uuid,
  p_expected_version integer,
  p_patch            jsonb,
  p_device_id        text default null
) returns void
language plpgsql security invoker as $$
declare
  v_cellar uuid;
  v_version integer;
  v_new_name text;
begin
  select cellar_id, version into v_cellar, v_version
  from storage_locations
  where id = p_location_id and deleted_at is null
  for update;

  if v_cellar is null then
    raise exception 'Storage location not found' using errcode = '23503';
  end if;

  if not claim_operation(p_operation_id, v_cellar, 'storage_location',
                         p_location_id, 'update', p_device_id) then
    return;   -- idempotent replay
  end if;

  if v_version <> p_expected_version then
    perform raise_version_conflict(p_expected_version, v_version);
  end if;

  v_new_name := nullif(btrim(coalesce(p_patch->>'name', '')), '');
  if p_patch ? 'name' and v_new_name is null then
    raise exception 'A storage location needs a name' using errcode = '23514';
  end if;

  update storage_locations set
    name               = coalesce(v_new_name, name),
    kind               = coalesce(nullif(p_patch->>'kind',''), kind),
    merchant_reference = case when p_patch ? 'merchant_reference'
                         then nullif(p_patch->>'merchant_reference','')
                         else merchant_reference end,
    sort_order         = coalesce(nullif(p_patch->>'sort_order','')::int, sort_order),
    is_external        = coalesce(nullif(p_patch->>'is_external','')::boolean, is_external),
    version            = version + 1,
    updated_by         = auth.uid()
  where id = p_location_id;
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- UPDATE A STORAGE LAYOUT
--
-- Renames are always safe. A geometry change is accepted ONLY if every
-- currently occupied position remains valid under the proposed config.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function update_storage_layout(
  p_operation_id     uuid,
  p_layout_id        uuid,
  p_expected_version integer,
  p_patch            jsonb,
  p_device_id        text default null
) returns void
language plpgsql security invoker as $$
declare
  v_cellar uuid;
  v_version integer;
  v_type text;
  v_config jsonb;
  v_new_type text;
  v_new_config jsonb;
  v_new_name text;
  v_conflicts int;
  v_detail text;
begin
  select cellar_id, version, type, config
    into v_cellar, v_version, v_type, v_config
  from storage_layouts
  where id = p_layout_id and deleted_at is null
  for update;

  if v_cellar is null then
    raise exception 'Storage layout not found' using errcode = '23503';
  end if;

  if not claim_operation(p_operation_id, v_cellar, 'storage_layout',
                         p_layout_id, 'update', p_device_id) then
    return;
  end if;

  if v_version <> p_expected_version then
    perform raise_version_conflict(p_expected_version, v_version);
  end if;

  v_new_type   := coalesce(nullif(p_patch->>'type',''), v_type);
  v_new_config := coalesce(p_patch->'config', v_config);
  v_new_name   := nullif(btrim(coalesce(p_patch->>'name','')), '');

  if p_patch ? 'name' and v_new_name is null then
    raise exception 'A storage layout needs a name' using errcode = '23514';
  end if;

  if v_new_type not in ('staircase','grid','shelving','fridge',
                        'unpositioned','external') then
    raise exception 'Unknown layout type %', v_new_type using errcode = '23514';
  end if;

  -- ── THE GUARANTEE ──────────────────────────────────────────────────────
  -- Only when the geometry actually changes. A rename skips this entirely.
  if v_new_type is distinct from v_type or v_new_config is distinct from v_config then
    select count(*),
           string_agg(
             coalesce(position_key, bottle_position::text)
               || ' (' || location_name || ')',
             ', ' order by position_key)
      into v_conflicts, v_detail
    from layout_change_conflicts(p_layout_id, v_new_type, v_new_config);

    if v_conflicts > 0 then
      raise exception
        'This change would leave % bottle(s) in positions that no longer '
        'exist: %. Move or consume them first, or choose a geometry that '
        'still contains them.',
        v_conflicts, v_detail
        using errcode = '23514';
    end if;
  end if;

  update storage_layouts set
    name       = coalesce(v_new_name, name),
    type       = v_new_type,
    config     = v_new_config,
    -- Always derived, never supplied by the caller.
    capacity   = layout_capacity(v_new_type, v_new_config),
    version    = version + 1,
    updated_by = auth.uid()
  where id = p_layout_id;
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- SOFT DELETE A STORAGE LOCATION
--
-- The row is never physically removed, so bottle_events and every historical
-- reference survive intact.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function soft_delete_storage_location(
  p_operation_id     uuid,
  p_location_id      uuid,
  p_expected_version integer,
  p_reason           text,
  p_device_id        text default null
) returns void
language plpgsql security invoker as $$
declare
  v_cellar uuid;
  v_version integer;
  v_name text;
  v_live int;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'Removing a storage location requires a reason'
      using errcode = '23514';
  end if;

  select cellar_id, version, name into v_cellar, v_version, v_name
  from storage_locations
  where id = p_location_id and deleted_at is null
  for update;

  if v_cellar is null then
    raise exception 'Storage location not found or already removed'
      using errcode = '23503';
  end if;

  if not claim_operation(p_operation_id, v_cellar, 'storage_location',
                         p_location_id, 'delete', p_device_id) then
    return;
  end if;

  if v_version <> p_expected_version then
    perform raise_version_conflict(p_expected_version, v_version);
  end if;

  -- ── THE GUARANTEE ──────────────────────────────────────────────────────
  -- `on delete restrict` protects a physical DELETE only. This is an UPDATE,
  -- so the foreign key never fires and the check must be explicit.
  select count(*) into v_live
  from bottles
  where storage_location_id = p_location_id and status = 'in_cellar';

  if v_live > 0 then
    raise exception
      '% still holds % bottle(s). Move or consume them before removing it.',
      v_name, v_live
      using errcode = '23514';
  end if;

  update storage_locations set
    deleted_at    = now(),
    deleted_by    = auth.uid(),
    delete_reason = p_reason,
    version       = version + 1,
    updated_by    = auth.uid()
  where id = p_location_id;
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- SOFT DELETE A STORAGE LAYOUT
-- Refused while any live location still references it.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function soft_delete_storage_layout(
  p_operation_id     uuid,
  p_layout_id        uuid,
  p_expected_version integer,
  p_reason           text,
  p_device_id        text default null
) returns void
language plpgsql security invoker as $$
declare
  v_cellar uuid;
  v_version integer;
  v_in_use int;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'Removing a storage layout requires a reason'
      using errcode = '23514';
  end if;

  select cellar_id, version into v_cellar, v_version
  from storage_layouts
  where id = p_layout_id and deleted_at is null
  for update;

  if v_cellar is null then
    raise exception 'Storage layout not found or already removed'
      using errcode = '23503';
  end if;

  if not claim_operation(p_operation_id, v_cellar, 'storage_layout',
                         p_layout_id, 'delete', p_device_id) then
    return;
  end if;

  if v_version <> p_expected_version then
    perform raise_version_conflict(p_expected_version, v_version);
  end if;

  select count(*) into v_in_use
  from storage_locations
  where storage_layout_id = p_layout_id and deleted_at is null;

  if v_in_use > 0 then
    raise exception
      'This layout is still used by % storage location(s). Remove them first.',
      v_in_use
      using errcode = '23514';
  end if;

  update storage_layouts set
    deleted_at    = now(),
    deleted_by    = auth.uid(),
    delete_reason = p_reason,
    version       = version + 1,
    updated_by    = auth.uid()
  where id = p_layout_id;
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- OCCUPANCY
-- Derived from the layout's own configuration. Null capacity means
-- unbounded — unpositioned and external storage.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function location_occupancy(p_location_id uuid)
returns table (
  occupied  integer,
  capacity  integer,
  free      integer,
  is_full   boolean
)
language sql stable as $$
  select
    (select count(*)::int from bottles b
      where b.storage_location_id = sl.id and b.status = 'in_cellar'),
    l.capacity,
    case when l.capacity is null then null
         else l.capacity - (select count(*)::int from bottles b
                             where b.storage_location_id = sl.id
                               and b.status = 'in_cellar') end,
    case when l.capacity is null then false
         else (select count(*) from bottles b
                where b.storage_location_id = sl.id
                  and b.status = 'in_cellar') >= l.capacity end
  from storage_locations sl
  left join storage_layouts l on l.id = sl.storage_layout_id
  where sl.id = p_location_id;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFY — all six should be SECURITY INVOKER (prosecdef = false)
-- ═══════════════════════════════════════════════════════════════════════════
-- select proname, prosecdef from pg_proc
-- where pronamespace = 'public'::regnamespace
--   and proname in ('update_storage_location','update_storage_layout',
--                   'soft_delete_storage_location','soft_delete_storage_layout',
--                   'layout_change_conflicts','location_occupancy',
--                   'try_validate_position')
-- order by proname;
