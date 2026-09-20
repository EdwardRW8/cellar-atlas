-- ═══════════════════════════════════════════════════════════════════════════
-- 016 — MANDATORY WINE TYPE (Cleanup Phase A)
--
-- Production use showed a wine could be created with no type at all. This
-- closes that at the mutation boundary, where the UI cannot bypass it.
--
-- Purely additive: no table, column, policy or earlier migration is altered.
-- Both functions are replaced with `create or replace`, keeping their exact
-- existing signatures, SECURITY INVOKER, operation-id idempotency, version
-- checks, client-supplied id handling and enrichment columns. The bodies are
-- the migration-012 originals with validation inserted — nothing else changed.
--
-- ── WHY NOT `alter table ... set not null` ───────────────────────────────
-- Production already contains wine_definitions with a null colour, created
-- before this rule existed. A NOT NULL constraint would fail to apply, and
-- forcing it through would mean either destroying those rows or inventing a
-- type for wine nobody classified. Both are worse than the problem.
--
-- So the invariant is enforced where new data enters:
--
--   CREATE  a type is required. No new wine can be typeless.
--   UPDATE  if the caller supplies `colour`, it must be valid. Supplying
--           null or an unknown value is REJECTED rather than silently
--           ignored, so "clear the type" fails loudly instead of quietly
--           doing nothing.
--
-- An existing typeless wine stays readable and openable. Editing it through
-- the app supplies a colour — the form requires one — and it becomes valid.
-- Nothing guesses on the user's behalf.
--
-- The `colour` CHECK constraint from migration 004 remains the final backstop;
-- this adds the presence rule it never covered.
-- ═══════════════════════════════════════════════════════════════════════════


/**
 * The canonical wine types.
 *
 * Deliberately identical to the CHECK constraint in migration 004 and to
 * `WineColour` in the domain. No new taxonomy is invented.
 */
create or replace function is_valid_wine_colour(p_colour text)
returns boolean
language sql immutable as $$
  select p_colour in ('Red','White','Rosé','Sparkling','Dessert','Fortified');
$$;


create or replace function create_wine_definition(
  p_operation_id uuid,
  p_cellar_id    uuid,
  p_wine         jsonb,
  p_device_id    text default null
) returns uuid
language plpgsql security invoker as $$
declare
  v_id uuid := coalesce((p_wine->>'id')::uuid, gen_random_uuid());
  v_colour text;
begin
  -- ── MANDATORY WINE TYPE (migration 016) ────────────────────────────────
  v_colour := nullif(p_wine->>'colour', '');

  if v_colour is null then
    raise exception 'A wine type is required' using errcode = '23514';
  end if;

  if not is_valid_wine_colour(v_colour) then
    raise exception 'Unknown wine type: %', v_colour using errcode = '23514';
  end if;
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
    v_colour,
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
  v_colour text;
begin
  -- ── WINE TYPE MAY BE CORRECTED, NEVER CLEARED (migration 016) ──────────
  if p_patch ? 'colour' then
    v_colour := nullif(p_patch->>'colour', '');
    if v_colour is null then
      raise exception 'A wine type is required and cannot be removed'
        using errcode = '23514';
    end if;
    if not is_valid_wine_colour(v_colour) then
      raise exception 'Unknown wine type: %', v_colour using errcode = '23514';
    end if;
  end if;

  -- A window that closes before it opens is not a window.
  if p_patch ? 'drink_from' and p_patch ? 'drink_until'
     and nullif(p_patch->>'drink_from','') is not null
     and nullif(p_patch->>'drink_until','') is not null
     and (p_patch->>'drink_from')::int > (p_patch->>'drink_until')::int then
    raise exception 'Drink from cannot be later than drink until'
      using errcode = '23514';
  end if;
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
    colour        = coalesce(v_colour, colour),
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
-- VERIFY — all three must be SECURITY INVOKER (prosecdef = false)
-- ═══════════════════════════════════════════════════════════════════════════
-- select proname, prosecdef from pg_proc
-- where pronamespace = 'public'::regnamespace
--   and proname in ('create_wine_definition','update_wine_definition',
--                   'is_valid_wine_colour')
-- order by proname;
--
-- Existing typeless wines, which stay readable and correctable:
-- select count(*) from wine_definitions where colour is null;
