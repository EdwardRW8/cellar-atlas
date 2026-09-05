-- ═══════════════════════════════════════════════════════════════════════════
-- 009 — BOTTLE EVENTS  ·  IMMUTABLE LEDGER
--
-- Strategically the most important table. It becomes the dataset for
-- consumption rate, holding period, purchase-to-drink lag and preference
-- analysis in Phase 8. You cannot retrofit history you did not capture.
--
-- No UPDATE or DELETE policy exists for any role. A mistake is corrected by
-- APPENDING a `corrected` event, never by editing history — so the record
-- shows both what you originally believed and what you later established.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists bottle_events (
  id         uuid primary key default gen_random_uuid(),
  cellar_id  uuid not null references cellars(id) on delete cascade,
  bottle_id  uuid not null references bottles(id) on delete restrict,

  event_type text not null check (event_type in (
    'acquired','added','moved','delivered','consumed','gifted',
    'sold','lost','removed','valued','tasting_recorded','corrected'
  )),

  -- When it happened in reality vs when we learned of it. Consumption-rate
  -- analysis needs the real date — you might log on Tuesday a bottle drunk
  -- on Saturday.
  occurred_at timestamptz not null default now(),
  recorded_at timestamptz not null default now(),

  previous_state jsonb,
  new_state      jsonb,
  reason         text,      -- required for 'removed' and 'corrected'
  notes          text,

  actor_id   uuid references auth.users(id),
  device_id  text,

  -- ── OPERATION TRACEABILITY (Phase 2.1) ────────────────────────────────
  -- Which user action caused this event. NOT unique: one user operation
  -- legitimately produces many events — a 12-bottle acquisition creates 12
  -- 'added' events, all sharing one source operation.
  --
  -- Idempotency is enforced by applied_operations.operation_id (primary key),
  -- NOT by this column. Uniqueness here would have forced the acquisition
  -- function to write nulls, destroying the audit trail it exists to provide.
  source_operation_id uuid references applied_operations(operation_id)
                      on delete set null,

  created_at timestamptz not null default now()
);

-- Deliberately NOT unique. Grouping events by the operation that caused them
-- is the point; one operation may produce many events.
create index if not exists idx_event_source_operation
  on bottle_events(source_operation_id) where source_operation_id is not null;

create index if not exists idx_event_bottle on bottle_events(bottle_id, occurred_at desc);
create index if not exists idx_event_cellar on bottle_events(cellar_id, occurred_at desc);
create index if not exists idx_event_type on bottle_events(cellar_id, event_type);

-- Amendment 3: a 'removed' bottle must explain itself.
-- Amendment 4: a 'corrected' event must state why.
alter table bottle_events drop constraint if exists chk_event_reason;
alter table bottle_events add constraint chk_event_reason
  check (event_type not in ('removed','corrected') or reason is not null);

-- NOTE: no updated_at, no soft delete, no touch trigger. Append-only.
