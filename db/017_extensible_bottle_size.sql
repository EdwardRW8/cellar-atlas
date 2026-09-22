-- ═══════════════════════════════════════════════════════════════════════════
-- 017 — EXTENSIBLE BOTTLE SIZE
--
-- Bottle size was a closed list of five values, enforced in three places:
--   • acquisition_items.bottle_size   inline, unnamed CHECK   (migration 006)
--   • bottles.bottle_size             inline, unnamed CHECK   (migration 007)
--   • correct_bottle()                an explicit IN (...) test (migration 012)
-- A real 200ml bottle could not be recorded without falsifying it.
--
-- A bottle size is now any canonical positive whole number of millilitres:
-- `<n>ml`, n from 1 to 50,000. Common sizes remain UI shortcuts; they are no
-- longer the set of permitted values. All existing values stay valid, no row
-- is rewritten, 750ml stays the default, and neither table is rebuilt.
--
-- ── WHY THE UPPER BOUND IS 50,000 ────────────────────────────────────────
-- The largest named wine formats (Melchizedek, Midas) are about 30 litres.
-- 50 litres leaves headroom for anything that is still plausibly a bottle,
-- while refusing the obvious slip — an extra zero on a 6-litre bottle.
-- ═══════════════════════════════════════════════════════════════════════════


/**
 * The single definition of a valid bottle size, shared by both CHECKs and
 * correct_bottle(). Mirrors isBottleSize() in src/domain/bottle-size.ts.
 *
 * The CASE guards the cast: only a string that already matches the pattern
 * is converted to an integer, so malformed input returns false rather than
 * raising a cast error. {0,4} caps the digits at five, so the cast can never
 * overflow.
 */
create or replace function is_valid_bottle_size(p_size text)
returns boolean
language sql immutable as $$
  select case
    when p_size ~ '^[1-9][0-9]{0,4}ml$' then left(p_size, -2)::integer <= 50000
    else false
  end;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- REPLACE THE TWO UNNAMED CHECK CONSTRAINTS
--
-- The originals were declared inline without names, so Postgres generated
-- them. A generated name is not a contract this repository controls, so it is
-- never assumed. Each constraint is identified by STRUCTURE instead:
--
--   contype = 'c'                a CHECK constraint
--   conkey  = [bottle_size]      constraining bottle_size AND NOTHING ELSE
--
-- Other CHECKs on these tables — quantity, format, unit_price, line_total,
-- status, current_value, label_condition — have a different conkey and are
-- never selected. As a second guard, a selected constraint is dropped only if
-- its definition is recognisably the old whitelist; anything else aborts the
-- migration rather than dropping a constraint nobody expected.
--
-- Exactly one old constraint must be found per table, or the migration stops.
-- Re-running is harmless: once the named replacement exists, nothing is
-- dropped and nothing is added twice.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  t       text;
  col     smallint;
  c       record;
  dropped integer;
  target  text;
begin
  foreach t in array array['acquisition_items', 'bottles'] loop
    target := t || '_bottle_size_canonical';

    select attnum into col
    from pg_attribute
    where attrelid = t::regclass and attname = 'bottle_size' and not attisdropped;

    if col is null then
      raise exception 'bottle_size column not found on %', t;
    end if;

    dropped := 0;
    for c in
      select conname, pg_get_constraintdef(oid) as def
      from pg_constraint
      where conrelid = t::regclass
        and contype = 'c'
        and conkey = array[col]
        and conname <> target
    loop
      if position('375ml' in c.def) = 0 or position('6000ml' in c.def) = 0 then
        raise exception
          'Unexpected CHECK constraint % on %.bottle_size (%) — refusing to drop it',
          c.conname, t, c.def;
      end if;
      execute format('alter table %I drop constraint %I', t, c.conname);
      dropped := dropped + 1;
    end loop;

    if not exists (
      select 1 from pg_constraint where conrelid = t::regclass and conname = target
    ) then
      if dropped <> 1 then
        raise exception
          'Expected exactly one finite bottle_size CHECK on %, found %', t, dropped;
      end if;
      execute format(
        'alter table %I add constraint %I check (is_valid_bottle_size(bottle_size))',
        t, target);
    end if;
  end loop;
end $$;


/**
 * correct_bottle — the migration-012 body verbatim, with ONLY the bottle-size
 * test changed from a closed IN (...) list to is_valid_bottle_size().
 * Signature, SECURITY INVOKER, operation-id idempotency, version check,
 * position validation and the immutable 'corrected' event are all unchanged.
 */
create or replace function correct_bottle(
  p_operation_id     uuid,
  p_bottle_id        uuid,
  p_expected_version integer,
  p_reason           text,
  p_patch            jsonb,
  p_device_id        text default null
) returns void
language plpgsql security invoker as $$
declare
  v_cellar uuid; v_version int; v_status text;
  v_old jsonb; v_new_loc uuid; v_new_pos jsonb; v_key text;
  v_ltype text; v_lconfig jsonb;
  v_new_size text; v_new_status text;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A correction requires a reason' using errcode = '23514';
  end if;

  select cellar_id, version, status,
         jsonb_build_object('storage_location_id', storage_location_id,
                            'position', position, 'status', status,
                            'bottle_size', bottle_size,
                            'acquisition_item_id', acquisition_item_id)
    into v_cellar, v_version, v_status, v_old
  from bottles where id = p_bottle_id for update;

  if v_cellar is null then
    raise exception 'Bottle not found' using errcode = '23503';
  end if;

  -- 'update', not 'correct': applied_operations.operation describes the
  -- mutation shape. The business meaning lives in bottle_events.event_type.
  if not claim_operation(p_operation_id, v_cellar, 'bottle', p_bottle_id, 'update', p_device_id) then
    return;
  end if;

  if v_version <> p_expected_version then
    perform raise_version_conflict(p_expected_version, v_version);
  end if;

  -- Status, if being corrected, must be a legal value.
  v_new_status := coalesce(nullif(p_patch->>'status',''), v_status);
  if v_new_status not in ('in_cellar','consumed','gifted','sold','lost','removed') then
    raise exception 'Invalid status %', v_new_status using errcode = '23514';
  end if;

  -- Bottle size, if being corrected, must be a valid canonical volume
  -- (migration 017). Previously a closed five-value list.
  v_new_size := nullif(p_patch->>'bottle_size','');
  if v_new_size is not null
     and not is_valid_bottle_size(v_new_size) then
    raise exception 'Invalid bottle size %', v_new_size using errcode = '23514';
  end if;

  -- Location and position go through THE SAME validation as move_bottle.
  if p_patch ? 'storage_location_id' or p_patch ? 'position' then
    v_new_loc := case when p_patch ? 'storage_location_id'
                 then nullif(p_patch->>'storage_location_id','')::uuid
                 else (v_old->>'storage_location_id')::uuid end;
    v_new_pos := case when p_patch ? 'position'
                 then p_patch->'position' else v_old->'position' end;
    if v_new_pos = 'null'::jsonb then v_new_pos := null; end if;

    if v_new_status <> 'in_cellar' then
      -- Out of inventory means no location, no position. Enforced, not assumed.
      v_new_loc := null; v_new_pos := null; v_key := null;
    elsif v_new_loc is null then
      if v_new_pos is not null then
        raise exception 'A position requires a storage location' using errcode = '23514';
      end if;
      v_key := null;
    else
      select layout_type, config into v_ltype, v_lconfig from location_layout(v_new_loc);
      if v_ltype is null then
        raise exception 'Storage location not found' using errcode = '23503';
      end if;
      v_key := validate_position(v_ltype, v_lconfig, v_new_pos);
    end if;

    update bottles set
      storage_location_id = v_new_loc,
      position            = v_new_pos,
      position_key        = v_key,
      status              = v_new_status,
      bottle_size         = coalesce(v_new_size, bottle_size),
      notes               = case when p_patch ? 'notes' then nullif(p_patch->>'notes','') else notes end,
      version             = version + 1,
      updated_by          = auth.uid()
    where id = p_bottle_id;
  else
    update bottles set
      status      = v_new_status,
      bottle_size = coalesce(v_new_size, bottle_size),
      notes       = case when p_patch ? 'notes' then nullif(p_patch->>'notes','') else notes end,
      version     = version + 1,
      updated_by  = auth.uid()
    where id = p_bottle_id;
  end if;

  insert into bottle_events
    (cellar_id, bottle_id, event_type, previous_state, new_state, reason,
     actor_id, device_id, source_operation_id)
  values
    (v_cellar, p_bottle_id, 'corrected', v_old, p_patch, p_reason,
     auth.uid(), p_device_id, p_operation_id);
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFY
-- ═══════════════════════════════════════════════════════════════════════════
-- Both named constraints present, no finite list left:
--   select conrelid::regclass, conname, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conname in ('acquisition_items_bottle_size_canonical',
--                     'bottles_bottle_size_canonical');
--
-- Every existing value still valid (expect 0):
--   select count(*) from bottles where not is_valid_bottle_size(bottle_size);
