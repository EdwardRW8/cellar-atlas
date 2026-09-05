-- ═══════════════════════════════════════════════════════════════════════════
-- 012 — MUTATION FUNCTIONS
--
-- Every domain write goes through here. The client never runs INSERT or
-- UPDATE against a domain table.
--
-- Each function, in ONE transaction:
--   1. records the operation_id  → a duplicate returns 'duplicate', not an error
--   2. checks the expected version → a mismatch raises a conflict
--   3. validates domain invariants → including position geometry
--   4. mutates the row
--   5. appends the immutable event
--
-- State and history therefore cannot diverge. There is no path that moves a
-- bottle without recording it, or records a move that did not happen.
--
-- SECURITY INVOKER throughout: RLS still applies. These are transactional
-- wrappers, not privilege escalation.
-- ═══════════════════════════════════════════════════════════════════════════

-- Conflict signalling. P0001 + 'version' is mapped to 'conflict' by the
-- client's classifyError; 23514 maps to 'permanent'.
create or replace function raise_version_conflict(p_expected int, p_actual int)
returns void language plpgsql as $$
begin
  raise exception 'version conflict: expected %, found %', p_expected, p_actual
    using errcode = 'P0001';
end $$;


/**
 * Record an operation. Returns TRUE if this is the first time we have seen it,
 * FALSE if it has already been applied.
 *
 * This is what makes retries safe. A lost response on a flaky connection is
 * indistinguishable from a failure; without this, the retry conflicts and
 * jams the queue permanently.
 */
create or replace function claim_operation(
  p_operation_id uuid,
  p_cellar_id    uuid,
  p_entity       text,
  p_entity_id    uuid,
  p_operation    text,
  p_device_id    text default null
) returns boolean
language plpgsql security invoker as $$
begin
  insert into applied_operations
    (operation_id, cellar_id, user_id, device_id, entity, entity_id, operation)
  values
    (p_operation_id, p_cellar_id, auth.uid(), p_device_id, p_entity, p_entity_id, p_operation);
  return true;
exception
  when unique_violation then
    return false;   -- already applied; caller reports success
end $$;



/**
 * The entity id recorded for an operation we have already applied.
 *
 * Without this, a replayed create returns a freshly generated uuid and the
 * client ends up holding a reference to a row that does not exist. The data
 * stays correct; the return value does not. Found by SQL integration test.
 */
create or replace function claimed_entity_id(p_operation_id uuid)
returns uuid language sql stable security invoker as $$
  select entity_id from applied_operations where operation_id = p_operation_id;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- WINE DEFINITIONS
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function create_wine_definition(
  p_operation_id uuid,
  p_cellar_id    uuid,
  p_wine         jsonb,
  p_device_id    text default null
) returns uuid
language plpgsql security invoker as $$
declare
  v_id uuid := coalesce((p_wine->>'id')::uuid, gen_random_uuid());
begin
  if not claim_operation(p_operation_id, p_cellar_id, 'wine_definition', v_id, 'create', p_device_id) then
    return claimed_entity_id(p_operation_id);   -- idempotent replay: ORIGINAL id
  end if;

  insert into wine_definitions (
    id, cellar_id, producer, name, vintage, colour, grapes,
    geo_region_id, country_code, region_text,
    drink_from, drink_until, enrichment_source, enrichment_confidence, notes,
    created_by, updated_by
  ) values (
    v_id, p_cellar_id,
    p_wine->>'producer', p_wine->>'name',
    nullif(p_wine->>'vintage','')::int,
    nullif(p_wine->>'colour',''),
    coalesce((select array_agg(value::text) from jsonb_array_elements_text(p_wine->'grapes')), '{}'),
    nullif(p_wine->>'geo_region_id','')::uuid,
    nullif(p_wine->>'country_code',''),
    nullif(p_wine->>'region_text',''),
    nullif(p_wine->>'drink_from','')::int,
    nullif(p_wine->>'drink_until','')::int,
    coalesce(nullif(p_wine->>'enrichment_source',''), 'manual'),
    nullif(p_wine->>'enrichment_confidence','')::numeric,
    nullif(p_wine->>'notes',''),
    auth.uid(), auth.uid()
  );

  return v_id;
end $$;


create or replace function update_wine_definition(
  p_operation_id     uuid,
  p_wine_id          uuid,
  p_expected_version integer,
  p_patch            jsonb,
  p_device_id        text default null
) returns void
language plpgsql security invoker as $$
declare
  v_cellar uuid;
  v_version integer;
begin
  select cellar_id, version into v_cellar, v_version
  from wine_definitions where id = p_wine_id for update;

  if v_cellar is null then
    raise exception 'Wine not found' using errcode = '23503';
  end if;

  if not claim_operation(p_operation_id, v_cellar, 'wine_definition', p_wine_id, 'update', p_device_id) then
    return;
  end if;

  if v_version <> p_expected_version then
    perform raise_version_conflict(p_expected_version, v_version);
  end if;

  update wine_definitions set
    producer      = coalesce(p_patch->>'producer', producer),
    name          = coalesce(p_patch->>'name', name),
    vintage       = case when p_patch ? 'vintage' then nullif(p_patch->>'vintage','')::int else vintage end,
    colour        = coalesce(nullif(p_patch->>'colour',''), colour),
    grapes        = case when p_patch ? 'grapes'
                    then coalesce((select array_agg(value::text) from jsonb_array_elements_text(p_patch->'grapes')), '{}')
                    else grapes end,
    geo_region_id = case when p_patch ? 'geo_region_id' then nullif(p_patch->>'geo_region_id','')::uuid else geo_region_id end,
    country_code  = case when p_patch ? 'country_code' then nullif(p_patch->>'country_code','') else country_code end,
    region_text   = case when p_patch ? 'region_text' then nullif(p_patch->>'region_text','') else region_text end,
    drink_from    = case when p_patch ? 'drink_from' then nullif(p_patch->>'drink_from','')::int else drink_from end,
    drink_until   = case when p_patch ? 'drink_until' then nullif(p_patch->>'drink_until','')::int else drink_until end,
    notes         = case when p_patch ? 'notes' then nullif(p_patch->>'notes','') else notes end,
    version       = version + 1,
    updated_by    = auth.uid()
  where id = p_wine_id;
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- STORAGE
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function create_storage_layout(
  p_operation_id uuid,
  p_cellar_id    uuid,
  p_name         text,
  p_type         text,
  p_config       jsonb,
  p_device_id    text default null
) returns uuid
language plpgsql security invoker as $$
declare
  v_id uuid := gen_random_uuid();
begin
  if not claim_operation(p_operation_id, p_cellar_id, 'storage_layout', v_id, 'create', p_device_id) then
    return claimed_entity_id(p_operation_id);   -- replay: ORIGINAL id
  end if;

  insert into storage_layouts (id, cellar_id, name, type, config, capacity, created_by, updated_by)
  values (v_id, p_cellar_id, p_name, p_type, p_config,
          layout_capacity(p_type, p_config), auth.uid(), auth.uid());

  return v_id;
end $$;


create or replace function create_storage_location(
  p_operation_id uuid,
  p_cellar_id    uuid,
  p_name         text,
  p_kind         text,
  p_layout_id    uuid default null,
  p_is_external  boolean default false,
  p_merchant_ref text default null,
  p_device_id    text default null
) returns uuid
language plpgsql security invoker as $$
declare
  v_id uuid := gen_random_uuid();
begin
  if not claim_operation(p_operation_id, p_cellar_id, 'storage_location', v_id, 'create', p_device_id) then
    return claimed_entity_id(p_operation_id);   -- replay: ORIGINAL id
  end if;

  insert into storage_locations
    (id, cellar_id, name, kind, storage_layout_id, is_external, merchant_reference,
     created_by, updated_by)
  values
    (v_id, p_cellar_id, p_name, p_kind, p_layout_id, p_is_external, p_merchant_ref,
     auth.uid(), auth.uid());

  return v_id;
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- ACQUISITION — creates order, lines AND bottles in one transaction
--
-- Buying a case creates 1 acquisition + 1 item + 12 bottles + 12 'added'
-- events under ONE operation id. Retry after a dropped connection and you
-- get twelve bottles, not twenty-four.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function create_acquisition_with_items(
  p_operation_id uuid,
  p_cellar_id    uuid,
  p_acquisition  jsonb,   -- {purchased_on, source, storage_location_id, reference, total_amount, currency, notes}
  p_items        jsonb,   -- [{wine_definition_id, quantity, bottle_size, format, unit_price,
                          --   storage_location_id, positions:[{col,row}|null,...]}]
  p_device_id    text default null
) returns uuid
language plpgsql security invoker as $$
declare
  v_acq_id  uuid := gen_random_uuid();
  v_item    jsonb;
  v_item_id uuid;
  v_i       int;
  v_qty     int;
  v_loc     uuid;
  v_pos     jsonb;
  v_key     text;
  v_bottle  uuid;
  v_ltype   text;
  v_lconfig jsonb;
begin
  if not claim_operation(p_operation_id, p_cellar_id, 'acquisition', v_acq_id, 'create', p_device_id) then
    return claimed_entity_id(p_operation_id);   -- replay: ORIGINAL id
  end if;

  insert into acquisitions
    (id, cellar_id, purchased_on, source, storage_location_id, reference,
     total_amount, currency, notes, created_by, updated_by)
  values
    (v_acq_id, p_cellar_id,
     nullif(p_acquisition->>'purchased_on','')::date,
     nullif(p_acquisition->>'source',''),
     nullif(p_acquisition->>'storage_location_id','')::uuid,
     nullif(p_acquisition->>'reference',''),
     nullif(p_acquisition->>'total_amount','')::numeric,
     coalesce(nullif(p_acquisition->>'currency',''), 'GBP'),
     nullif(p_acquisition->>'notes',''),
     auth.uid(), auth.uid());

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_item_id := gen_random_uuid();
    v_qty := (v_item->>'quantity')::int;
    v_loc := nullif(v_item->>'storage_location_id','')::uuid;

    insert into acquisition_items
      (id, cellar_id, acquisition_id, wine_definition_id, quantity,
       bottle_size, format, unit_price, line_total, duty_paid, created_by, updated_by)
    values
      (v_item_id, p_cellar_id, v_acq_id, (v_item->>'wine_definition_id')::uuid, v_qty,
       coalesce(nullif(v_item->>'bottle_size',''), '750ml'),
       coalesce(nullif(v_item->>'format',''), 'loose'),
       nullif(v_item->>'unit_price','')::numeric,
       nullif(v_item->>'line_total','')::numeric,
       coalesce((v_item->>'duty_paid')::boolean, true),
       auth.uid(), auth.uid());

    -- Resolve the destination layout once per line.
    v_ltype := 'unpositioned'; v_lconfig := '{}'::jsonb;
    if v_loc is not null then
      select layout_type, config into v_ltype, v_lconfig from location_layout(v_loc);
    end if;

    -- ONE ROW PER PHYSICAL BOTTLE.
    for v_i in 1 .. v_qty loop
      v_bottle := gen_random_uuid();
      v_pos := case
                 when v_item ? 'positions'
                 then v_item->'positions'->(v_i - 1)
                 else null
               end;
      if v_pos = 'null'::jsonb then v_pos := null; end if;

      -- Validate geometry transactionally. An invalid position rolls back
      -- the entire acquisition.
      v_key := validate_position(v_ltype, v_lconfig, v_pos);

      insert into bottles
        (id, cellar_id, wine_definition_id, acquisition_item_id, bottle_size,
         storage_location_id, position, position_key, status, status_changed_at,
         created_by, updated_by)
      values
        (v_bottle, p_cellar_id, (v_item->>'wine_definition_id')::uuid, v_item_id,
         coalesce(nullif(v_item->>'bottle_size',''), '750ml'),
         v_loc, v_pos, v_key, 'in_cellar', now(), auth.uid(), auth.uid());

      -- All bottles from this acquisition share ONE source operation.
      insert into bottle_events
        (cellar_id, bottle_id, event_type, new_state, actor_id, device_id,
         source_operation_id)
      values
        (p_cellar_id, v_bottle, 'added',
         jsonb_build_object('storage_location_id', v_loc, 'position', v_pos,
                            'status', 'in_cellar', 'acquisition_item_id', v_item_id),
         auth.uid(), p_device_id, p_operation_id);
    end loop;
  end loop;

  return v_acq_id;
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- BOTTLE MUTATIONS
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function move_bottle(
  p_operation_id     uuid,
  p_bottle_id        uuid,
  p_expected_version integer,
  p_location_id      uuid,
  p_position         jsonb default null,
  p_event_type       text default 'moved',
  p_notes            text default null,
  p_device_id        text default null
) returns void
language plpgsql security invoker as $$
declare
  v_cellar uuid; v_version int; v_status text;
  v_old_loc uuid; v_old_pos jsonb;
  v_ltype text; v_lconfig jsonb; v_key text;
begin
  if p_event_type not in ('moved','delivered') then
    raise exception 'move_bottle only accepts moved or delivered' using errcode = '23514';
  end if;

  select cellar_id, version, status, storage_location_id, position
    into v_cellar, v_version, v_status, v_old_loc, v_old_pos
  from bottles where id = p_bottle_id for update;

  if v_cellar is null then
    raise exception 'Bottle not found' using errcode = '23503';
  end if;

  if not claim_operation(p_operation_id, v_cellar, 'bottle', p_bottle_id, 'update', p_device_id) then
    return;
  end if;

  if v_version <> p_expected_version then
    perform raise_version_conflict(p_expected_version, v_version);
  end if;

  if v_status <> 'in_cellar' then
    raise exception 'Cannot move a bottle that is %', v_status using errcode = '23514';
  end if;

  select layout_type, config into v_ltype, v_lconfig from location_layout(p_location_id);
  if v_ltype is null then
    raise exception 'Storage location not found' using errcode = '23503';
  end if;

  -- Geometry validated here. Invalid → 23514 → rolls back.
  -- Occupied → unique violation on idx_bottle_slot_unique → 23505.
  v_key := validate_position(v_ltype, v_lconfig, p_position);

  update bottles set
    storage_location_id = p_location_id,
    position            = p_position,
    position_key        = v_key,
    version             = version + 1,
    updated_by          = auth.uid()
  where id = p_bottle_id;

  insert into bottle_events
    (cellar_id, bottle_id, event_type, previous_state, new_state, notes,
     actor_id, device_id, source_operation_id)
  values
    (v_cellar, p_bottle_id, p_event_type,
     jsonb_build_object('storage_location_id', v_old_loc, 'position', v_old_pos),
     jsonb_build_object('storage_location_id', p_location_id, 'position', p_position),
     p_notes, auth.uid(), p_device_id, p_operation_id);
end $$;


/**
 * Change a bottle's status: consumed, gifted, sold, lost or removed.
 * Location and position are cleared, which frees the slot.
 * `removed` requires a reason (amendment 3).
 */
create or replace function change_bottle_status(
  p_operation_id     uuid,
  p_bottle_id        uuid,
  p_expected_version integer,
  p_status           text,
  p_occurred_at      timestamptz default now(),
  p_reason           text default null,
  p_notes            text default null,
  p_device_id        text default null
) returns void
language plpgsql security invoker as $$
declare
  v_cellar uuid; v_version int; v_old_status text;
  v_old_loc uuid; v_old_pos jsonb;
begin
  if p_status not in ('consumed','gifted','sold','lost','removed') then
    raise exception 'Invalid status %', p_status using errcode = '23514';
  end if;
  if p_status = 'removed' and (p_reason is null or btrim(p_reason) = '') then
    raise exception 'Removing a bottle requires a reason' using errcode = '23514';
  end if;

  select cellar_id, version, status, storage_location_id, position
    into v_cellar, v_version, v_old_status, v_old_loc, v_old_pos
  from bottles where id = p_bottle_id for update;

  if v_cellar is null then
    raise exception 'Bottle not found' using errcode = '23503';
  end if;

  if not claim_operation(p_operation_id, v_cellar, 'bottle', p_bottle_id, 'update', p_device_id) then
    return;
  end if;

  if v_version <> p_expected_version then
    perform raise_version_conflict(p_expected_version, v_version);
  end if;

  if v_old_status <> 'in_cellar' then
    raise exception 'Bottle is already %', v_old_status using errcode = '23514';
  end if;

  update bottles set
    status              = p_status,
    status_changed_at   = p_occurred_at,
    storage_location_id = null,
    position            = null,
    position_key        = null,
    version             = version + 1,
    updated_by          = auth.uid()
  where id = p_bottle_id;

  insert into bottle_events
    (cellar_id, bottle_id, event_type, occurred_at, previous_state, new_state,
     reason, notes, actor_id, device_id, source_operation_id)
  values
    (v_cellar, p_bottle_id, p_status, p_occurred_at,
     jsonb_build_object('status', v_old_status, 'storage_location_id', v_old_loc,
                        'position', v_old_pos),
     jsonb_build_object('status', p_status),
     p_reason, p_notes, auth.uid(), p_device_id, p_operation_id);
end $$;


/**
 * Correct a bottle record.
 *
 * AMENDMENT 4: this is NOT a validation bypass. Corrections pass exactly the
 * same domain invariants as an ordinary mutation — position geometry is
 * validated, slot uniqueness is enforced, status transitions are checked.
 * `corrected` describes the REASON and preserves the history; it does not
 * permit writing something an ordinary mutation would reject.
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

  -- Bottle size, if being corrected, must be a legal value.
  v_new_size := nullif(p_patch->>'bottle_size','');
  if v_new_size is not null
     and v_new_size not in ('375ml','750ml','1500ml','3000ml','6000ml') then
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
-- TASTINGS & VALUATIONS
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function record_tasting(
  p_operation_id uuid,
  p_cellar_id    uuid,
  p_tasting      jsonb,
  p_device_id    text default null
) returns uuid
language plpgsql security invoker as $$
declare
  v_id uuid := gen_random_uuid();
  v_bottle uuid := nullif(p_tasting->>'bottle_id','')::uuid;
begin
  if not claim_operation(p_operation_id, p_cellar_id, 'tasting', v_id, 'create', p_device_id) then
    return claimed_entity_id(p_operation_id);   -- replay: ORIGINAL id
  end if;

  insert into tasting_records
    (id, cellar_id, wine_definition_id, bottle_id, bottle_event_id,
     rating, notes, tasted_on, tasted_by, context, created_by, updated_by)
  values
    (v_id, p_cellar_id,
     (p_tasting->>'wine_definition_id')::uuid, v_bottle,
     nullif(p_tasting->>'bottle_event_id','')::uuid,
     nullif(p_tasting->>'rating','')::int,
     nullif(p_tasting->>'notes',''),
     coalesce(nullif(p_tasting->>'tasted_on','')::date, current_date),
     auth.uid(), nullif(p_tasting->>'context',''),
     auth.uid(), auth.uid());

  if v_bottle is not null then
    insert into bottle_events
      (cellar_id, bottle_id, event_type, new_state, actor_id, device_id,
       source_operation_id)
    values
      (p_cellar_id, v_bottle, 'tasting_recorded',
       jsonb_build_object('tasting_id', v_id, 'rating', p_tasting->>'rating'),
       auth.uid(), p_device_id, p_operation_id);
  end if;

  return v_id;
end $$;


create or replace function record_valuation(
  p_operation_id uuid,
  p_cellar_id    uuid,
  p_valuation    jsonb,
  p_device_id    text default null
) returns uuid
language plpgsql security invoker as $$
declare
  v_id uuid := gen_random_uuid();
  v_bottle uuid := nullif(p_valuation->>'bottle_id','')::uuid;
  v_wine   uuid := nullif(p_valuation->>'wine_definition_id','')::uuid;
  v_amount numeric := (p_valuation->>'amount')::numeric;
begin
  if not claim_operation(p_operation_id, p_cellar_id, 'valuation', v_id, 'create', p_device_id) then
    return claimed_entity_id(p_operation_id);   -- replay: ORIGINAL id
  end if;

  insert into valuation_records
    (id, cellar_id, wine_definition_id, bottle_id, amount, currency,
     valuation_basis, source, valued_on, confidence, notes, created_by)
  values
    (v_id, p_cellar_id, v_wine, v_bottle, v_amount,
     coalesce(nullif(p_valuation->>'currency',''), 'GBP'),
     p_valuation->>'valuation_basis',
     coalesce(nullif(p_valuation->>'source',''), 'manual'),
     coalesce(nullif(p_valuation->>'valued_on','')::date, current_date),
     nullif(p_valuation->>'confidence','')::numeric,
     nullif(p_valuation->>'notes',''),
     auth.uid());

  -- Denormalise onto affected bottles for fast aggregation.
  if v_bottle is not null then
    update bottles set current_value = v_amount, current_value_at = now()
    where id = v_bottle;

    insert into bottle_events
      (cellar_id, bottle_id, event_type, new_state, actor_id, device_id,
       source_operation_id)
    values (p_cellar_id, v_bottle, 'valued',
            jsonb_build_object('amount', v_amount, 'basis', p_valuation->>'valuation_basis'),
            auth.uid(), p_device_id, p_operation_id);
  elsif v_wine is not null then
    update bottles set current_value = v_amount, current_value_at = now()
    where wine_definition_id = v_wine and status = 'in_cellar';
  end if;

  return v_id;
end $$;


create or replace function upsert_cellar_profile(
  p_operation_id uuid,
  p_cellar_id    uuid,
  p_profile      jsonb,
  p_device_id    text default null
) returns uuid
language plpgsql security invoker as $$
declare
  v_id uuid;
begin
  if not claim_operation(p_operation_id, p_cellar_id, 'cellar_profile', p_cellar_id, 'update', p_device_id) then
    select id into v_id from cellar_profiles where cellar_id = p_cellar_id;
    return v_id;
  end if;

  insert into cellar_profiles (
    cellar_id, bottles_per_month, bottles_purchased_per_year,
    typical_purchase_quantity, prefers_ageing, collecting_horizon_years,
    favourite_grapes, dislikes, typical_bottle_budget, values_investment,
    onboarding_completed_at, created_by, updated_by
  ) values (
    p_cellar_id,
    nullif(p_profile->>'bottles_per_month','')::numeric,
    nullif(p_profile->>'bottles_purchased_per_year','')::int,
    nullif(p_profile->>'typical_purchase_quantity','')::int,
    nullif(p_profile->>'prefers_ageing','')::boolean,
    nullif(p_profile->>'collecting_horizon_years','')::int,
    coalesce((select array_agg(value::text) from jsonb_array_elements_text(p_profile->'favourite_grapes')), '{}'),
    coalesce((select array_agg(value::text) from jsonb_array_elements_text(p_profile->'dislikes')), '{}'),
    nullif(p_profile->>'typical_bottle_budget','')::numeric,
    nullif(p_profile->>'values_investment','')::boolean,
    nullif(p_profile->>'onboarding_completed_at','')::timestamptz,
    auth.uid(), auth.uid()
  )
  on conflict (cellar_id) do update set
    bottles_per_month          = excluded.bottles_per_month,
    bottles_purchased_per_year = excluded.bottles_purchased_per_year,
    typical_purchase_quantity  = excluded.typical_purchase_quantity,
    prefers_ageing             = excluded.prefers_ageing,
    collecting_horizon_years   = excluded.collecting_horizon_years,
    favourite_grapes           = excluded.favourite_grapes,
    dislikes                   = excluded.dislikes,
    typical_bottle_budget      = excluded.typical_bottle_budget,
    values_investment          = excluded.values_investment,
    onboarding_completed_at    = excluded.onboarding_completed_at,
    version                    = cellar_profiles.version + 1,
    updated_by                 = auth.uid()
  returning id into v_id;

  return v_id;
end $$;
