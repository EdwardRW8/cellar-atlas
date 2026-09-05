-- ═══════════════════════════════════════════════════════════════════════════
-- 011 — CELLAR PROFILE
--
-- Consumption behaviour, so Phase 8 intelligence has assumptions to reason
-- from. Every field is nullable: intelligence must degrade gracefully rather
-- than demanding a questionnaire before the app is usable.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists cellar_profiles (
  id        uuid primary key default gen_random_uuid(),
  cellar_id uuid not null unique references cellars(id) on delete cascade,

  bottles_per_month          numeric(6,2) check (bottles_per_month >= 0),
  bottles_purchased_per_year integer check (bottles_purchased_per_year >= 0),
  typical_purchase_quantity  integer check (typical_purchase_quantity > 0),
  prefers_ageing             boolean,
  collecting_horizon_years   integer check (collecting_horizon_years > 0),

  favourite_regions uuid[] not null default '{}',
  favourite_grapes  text[] not null default '{}',
  dislikes          text[] not null default '{}',

  typical_bottle_budget numeric(12,2) check (typical_bottle_budget >= 0),
  currency              char(3) not null default 'GBP',
  values_investment     boolean,

  onboarding_completed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  version    integer not null default 1
);

drop trigger if exists trg_profile_touch on cellar_profiles;
create trigger trg_profile_touch before update on cellar_profiles
  for each row execute function touch_updated_at();
