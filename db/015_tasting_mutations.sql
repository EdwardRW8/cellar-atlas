-- ═══════════════════════════════════════════════════════════════════════════
-- 015 — TASTING MUTATIONS (Phase 9)
--
-- Adds update and soft delete for tasting records. Purely additive: no
-- existing table, policy, function or migration is altered.
--
-- `tasting_records` was created in migration 010 with `version`, `deleted_at`,
-- `deleted_by` and `delete_reason` — it was built expecting these operations,
-- but only `record_tasting` was ever written. This completes the set.
--
-- Both functions are SECURITY INVOKER, so RLS applies with the caller's own
-- rights, and both follow the established operation-id and expected-version
-- conventions.
--
-- ── THE CRITICAL SEPARATION ──────────────────────────────────────────────
-- A tasting is a SUBJECTIVE record and may be corrected. The `bottle_events`
-- row that recorded the tasting having happened is HISTORY and may not.
--
-- These functions touch `tasting_records` only. The `tasting_recorded` event
-- keeps its original timestamp and its original operation id for ever. The
-- fact that you tasted the bottle on the 4th does not change because you
-- later fixed a typo in the note.
--
-- A test asserts that editing a tasting leaves its bottle_events row byte
-- identical.
-- ═══════════════════════════════════════════════════════════════════════════


/**
 * Update a tasting record.
 *
 * Only the subjective fields are writable: rating, notes, when it was tasted
 * and in what context. The wine and bottle a tasting refers to are NOT
 * editable — that would silently reattach a memory to a different wine. A
 * mis-attributed tasting should be deleted and re-recorded, which leaves an
 * honest trail.
 */
create or replace function update_tasting_record(
  p_operation_id     uuid,
  p_tasting_id       uuid,
  p_expected_version integer,
  p_patch            jsonb,
  p_device_id        text default null
) returns void
language plpgsql security invoker as $$
declare
  v_cellar  uuid;
  v_version integer;
  v_rating  integer;
begin
  select cellar_id, version into v_cellar, v_version
  from tasting_records
  where id = p_tasting_id and deleted_at is null
  for update;

  if v_cellar is null then
    raise exception 'Tasting record not found' using errcode = '23503';
  end if;

  if not claim_operation(p_operation_id, v_cellar, 'tasting',
                         p_tasting_id, 'update', p_device_id) then
    return;   -- idempotent replay
  end if;

  if v_version <> p_expected_version then
    perform raise_version_conflict(p_expected_version, v_version);
  end if;

  -- The table's own constraint enforces 1..5, but failing here gives a
  -- message about the rating rather than a raw constraint name.
  if p_patch ? 'rating' and p_patch->>'rating' is not null then
    v_rating := (p_patch->>'rating')::integer;
    if v_rating < 1 or v_rating > 5 then
      raise exception 'A rating must be between 1 and 5' using errcode = '23514';
    end if;
  end if;

  update tasting_records set
    -- `p_patch ? 'key'` distinguishes "set this to null" from "leave alone".
    rating    = case when p_patch ? 'rating'
                     then nullif(p_patch->>'rating','')::integer
                     else rating end,
    notes     = case when p_patch ? 'notes'
                     then nullif(p_patch->>'notes','')
                     else notes end,
    tasted_on = case when p_patch ? 'tasted_on'
                     then coalesce(nullif(p_patch->>'tasted_on','')::date, tasted_on)
                     else tasted_on end,
    context   = case when p_patch ? 'context'
                     then nullif(p_patch->>'context','')
                     else context end,
    version    = version + 1,
    updated_at = now(),
    updated_by = auth.uid()
  where id = p_tasting_id;

  -- Deliberately NO bottle_events write. The tasting happened when it
  -- happened; correcting the note does not create a new fact about the wine.
end $$;


/**
 * Soft delete a tasting record.
 *
 * The row is never physically removed, so the `tasting_recorded` event that
 * references it keeps a valid target and history stays intact.
 *
 * A reason is required. Deleting a subjective record without saying why makes
 * the remaining log harder to trust later.
 */
create or replace function soft_delete_tasting_record(
  p_operation_id     uuid,
  p_tasting_id       uuid,
  p_expected_version integer,
  p_reason           text,
  p_device_id        text default null
) returns void
language plpgsql security invoker as $$
declare
  v_cellar  uuid;
  v_version integer;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'Removing a tasting requires a reason' using errcode = '23514';
  end if;

  select cellar_id, version into v_cellar, v_version
  from tasting_records
  where id = p_tasting_id and deleted_at is null
  for update;

  if v_cellar is null then
    raise exception 'Tasting record not found or already removed'
      using errcode = '23503';
  end if;

  if not claim_operation(p_operation_id, v_cellar, 'tasting',
                         p_tasting_id, 'delete', p_device_id) then
    return;
  end if;

  if v_version <> p_expected_version then
    perform raise_version_conflict(p_expected_version, v_version);
  end if;

  update tasting_records set
    deleted_at    = now(),
    deleted_by    = auth.uid(),
    delete_reason = p_reason,
    version       = version + 1,
    updated_at    = now(),
    updated_by    = auth.uid()
  where id = p_tasting_id;

  -- Again, no bottle_events write. The event recording that a tasting was
  -- made remains true even once the tasting note is withdrawn.
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- CELLAR-WIDE HISTORY
--
-- A read-only, paginated view of events across the whole cellar. Reading
-- events per bottle (as Phase 3 does) cannot answer "what happened last
-- week"; loading them all would not scale.
--
-- SECURITY INVOKER, so RLS on bottle_events applies unchanged: members read,
-- nobody writes.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function cellar_history(
  p_cellar_id  uuid,
  p_limit      integer default 50,
  p_before     timestamptz default null,
  p_event_types text[] default null
) returns table (
  id             uuid,
  bottle_id      uuid,
  event_type     text,
  occurred_at    timestamptz,
  reason         text,
  notes          text,
  wine_id        uuid,
  producer       text,
  wine_name      text,
  vintage        integer,
  location_name  text
)
language sql stable security invoker as $$
  select
    e.id,
    e.bottle_id,
    e.event_type,
    e.occurred_at,
    e.reason,
    e.notes,
    w.id,
    w.producer,
    w.name,
    w.vintage,
    sl.name
  from bottle_events e
  join bottles b            on b.id = e.bottle_id
  join wine_definitions w   on w.id = b.wine_definition_id
  left join storage_locations sl on sl.id = b.storage_location_id
  where e.cellar_id = p_cellar_id
    and (p_before is null or e.occurred_at < p_before)
    and (p_event_types is null or e.event_type = any(p_event_types))
  -- id breaks ties so pagination is stable when events share a timestamp,
  -- which a bulk acquisition guarantees.
  order by e.occurred_at desc, e.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFY — all three must be SECURITY INVOKER (prosecdef = false)
-- ═══════════════════════════════════════════════════════════════════════════
-- select proname, prosecdef from pg_proc
-- where pronamespace = 'public'::regnamespace
--   and proname in ('update_tasting_record','soft_delete_tasting_record',
--                   'cellar_history')
-- order by proname;
