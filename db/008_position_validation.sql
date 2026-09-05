-- ═══════════════════════════════════════════════════════════════════════════
-- 008 — POSITION VALIDATION
--
-- Amendment 2. Every positioned mutation must load its layout, validate the
-- position against that layout's config, and generate the canonical key —
-- transactionally, inside the database, so an invalid position can never be
-- written even by a client that skips the TypeScript checks.
--
-- This mirrors src/domain/storage/layout.ts exactly. Both are tested against
-- the same cases so they cannot drift apart.
-- ═══════════════════════════════════════════════════════════════════════════

-- Is this a positive integer?
create or replace function is_pos_int(v jsonb)
returns boolean language sql immutable as $$
  select v is not null
     and jsonb_typeof(v) = 'number'
     and (v::text ~ '^\d+$')
     and (v::text)::int >= 1;
$$;


/**
 * Validate a position against a layout and return its canonical key.
 *
 * Returns NULL for unpositioned layouts (which is correct — they store no key).
 * RAISES for any invalid position, which rolls back the surrounding
 * transaction. Errors use SQLSTATE 23514 (check violation) so the client's
 * existing classifyError maps them to 'permanent' rather than retrying.
 */
create or replace function validate_position(
  p_layout_type text,
  p_config      jsonb,
  p_position    jsonb
) returns text
language plpgsql immutable as $$
declare
  v_col int; v_row int; v_x int; v_y int;
  v_shelf int; v_index int; v_zone int;
  v_columns int; v_rows int; v_height int; v_cap int;
  v_shelves jsonb; v_zones jsonb; v_z jsonb;
begin
  -- ── Unpositioned layouts hold no slots ──────────────────────────────────
  if p_layout_type in ('unpositioned','external') then
    if p_position is null or p_position = 'null'::jsonb then
      return null;
    end if;
    raise exception 'A % location does not have slots, so a position cannot be set',
      p_layout_type using errcode = '23514';
  end if;

  if p_position is null or p_position = 'null'::jsonb then
    raise exception 'A % location requires a position', p_layout_type
      using errcode = '23514';
  end if;

  -- ── STAIRCASE ───────────────────────────────────────────────────────────
  if p_layout_type = 'staircase' then
    if not is_pos_int(p_position->'col') then
      raise exception 'Column must be a positive integer, got %', p_position->'col'
        using errcode = '23514';
    end if;
    if not is_pos_int(p_position->'row') then
      raise exception 'Row must be a positive integer, got %', p_position->'row'
        using errcode = '23514';
    end if;

    v_col := (p_position->>'col')::int;
    v_row := (p_position->>'row')::int;
    v_columns := coalesce((p_config->>'columns')::int, 0);

    if v_col > v_columns then
      raise exception 'Column % is outside this rack — it has % columns', v_col, v_columns
        using errcode = '23514';
    end if;

    v_height := (p_config->'heights'->(v_col - 1))::int;
    if v_height is null then
      raise exception 'Column % has no defined height', v_col using errcode = '23514';
    end if;
    if v_row > v_height then
      raise exception 'Row % is outside column % — that column holds % bottles',
        v_row, v_col, v_height using errcode = '23514';
    end if;

    return 'c' || v_col || 'r' || v_row;
  end if;

  -- ── GRID ────────────────────────────────────────────────────────────────
  if p_layout_type = 'grid' then
    if not is_pos_int(p_position->'x') then
      raise exception 'x must be a positive integer, got %', p_position->'x'
        using errcode = '23514';
    end if;
    if not is_pos_int(p_position->'y') then
      raise exception 'y must be a positive integer, got %', p_position->'y'
        using errcode = '23514';
    end if;

    v_x := (p_position->>'x')::int;
    v_y := (p_position->>'y')::int;
    v_columns := coalesce((p_config->>'columns')::int, 0);
    v_rows    := coalesce((p_config->>'rows')::int, 0);

    if v_x > v_columns then
      raise exception 'x % exceeds % columns', v_x, v_columns using errcode = '23514';
    end if;
    if v_y > v_rows then
      raise exception 'y % exceeds % rows', v_y, v_rows using errcode = '23514';
    end if;

    return 'x' || v_x || 'y' || v_y;
  end if;

  -- ── SHELVING ────────────────────────────────────────────────────────────
  if p_layout_type = 'shelving' then
    if not is_pos_int(p_position->'shelf') then
      raise exception 'Shelf must be a positive integer, got %', p_position->'shelf'
        using errcode = '23514';
    end if;
    if not is_pos_int(p_position->'index') then
      raise exception 'Index must be a positive integer, got %', p_position->'index'
        using errcode = '23514';
    end if;

    v_shelf := (p_position->>'shelf')::int;
    v_index := (p_position->>'index')::int;
    v_shelves := p_config->'shelves';

    if v_shelves is null or jsonb_typeof(v_shelves) <> 'array' then
      raise exception 'Shelving layout has no shelves configured' using errcode = '23514';
    end if;
    if v_shelf > jsonb_array_length(v_shelves) then
      raise exception 'Shelf % does not exist — there are % shelves',
        v_shelf, jsonb_array_length(v_shelves) using errcode = '23514';
    end if;

    v_cap := (v_shelves->(v_shelf - 1))::int;
    if v_index > v_cap then
      raise exception 'Index % is outside shelf % — it holds % bottles',
        v_index, v_shelf, v_cap using errcode = '23514';
    end if;

    return 's' || v_shelf || 'i' || v_index;
  end if;

  -- ── FRIDGE ──────────────────────────────────────────────────────────────
  if p_layout_type = 'fridge' then
    if not is_pos_int(p_position->'zone')
       or not is_pos_int(p_position->'shelf')
       or not is_pos_int(p_position->'index') then
      raise exception 'Fridge position requires positive integer zone, shelf and index'
        using errcode = '23514';
    end if;

    v_zone  := (p_position->>'zone')::int;
    v_shelf := (p_position->>'shelf')::int;
    v_index := (p_position->>'index')::int;
    v_zones := p_config->'zones';

    if v_zones is null or jsonb_typeof(v_zones) <> 'array' then
      raise exception 'Fridge layout has no zones configured' using errcode = '23514';
    end if;
    if v_zone > jsonb_array_length(v_zones) then
      raise exception 'Zone % does not exist — there are % zones',
        v_zone, jsonb_array_length(v_zones) using errcode = '23514';
    end if;

    v_z := v_zones->(v_zone - 1);
    if v_shelf > (v_z->>'shelves')::int then
      raise exception 'Shelf % is outside zone % — it has % shelves',
        v_shelf, v_zone, (v_z->>'shelves')::int using errcode = '23514';
    end if;
    if v_index > (v_z->>'perShelf')::int then
      raise exception 'Index % exceeds % bottles per shelf in zone %',
        v_index, (v_z->>'perShelf')::int, v_zone using errcode = '23514';
    end if;

    return 'z' || v_zone || 's' || v_shelf || 'i' || v_index;
  end if;

  raise exception 'Unknown layout type %', p_layout_type using errcode = '23514';
end $$;


/** Capacity of a layout. NULL means unbounded. */
create or replace function layout_capacity(p_type text, p_config jsonb)
returns integer language plpgsql immutable as $$
declare
  v_total int := 0;
  v_item jsonb;
begin
  if p_type = 'staircase' then
    select coalesce(sum(value::int), 0) into v_total
    from jsonb_array_elements(p_config->'heights');
    return v_total;

  elsif p_type = 'grid' then
    return coalesce((p_config->>'rows')::int, 0) * coalesce((p_config->>'columns')::int, 0);

  elsif p_type = 'shelving' then
    select coalesce(sum(value::int), 0) into v_total
    from jsonb_array_elements(p_config->'shelves');
    return v_total;

  elsif p_type = 'fridge' then
    for v_item in select * from jsonb_array_elements(p_config->'zones') loop
      v_total := v_total + (v_item->>'shelves')::int * (v_item->>'perShelf')::int;
    end loop;
    return v_total;

  else
    return null;   -- unpositioned / external are unbounded
  end if;
end $$;


/**
 * Resolve a storage location to its layout type and config.
 * A location with no layout behaves as 'unpositioned'.
 */
create or replace function location_layout(p_location_id uuid)
returns table (layout_type text, config jsonb)
language sql stable as $$
  select coalesce(l.type, 'unpositioned'), coalesce(l.config, '{}'::jsonb)
  from storage_locations sl
  left join storage_layouts l on l.id = sl.storage_layout_id
  where sl.id = p_location_id;
$$;
