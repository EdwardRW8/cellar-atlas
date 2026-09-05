-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 4 — LIVE RLS VERIFICATION
--
-- This is the check that PGlite cannot do for you. It exercises Supabase's
-- real JWT → auth.uid() path with genuine authenticated users.
--
-- ── WHY IT MUST BE YOU AND NOT ME ────────────────────────────────────────
-- I have no credentials for your project and no network route to it. Every
-- statement below must run as a REAL signed-in user, because RLS decides
-- everything from auth.uid(), which comes from the bearer token.
--
-- ⚠️  THE SQL EDITOR RUNS AS A PRIVILEGED ROLE AND BYPASSES RLS.
--     Pasting these into the SQL Editor while signed in as yourself proves
--     NOTHING. Use one of the two methods below.
--
-- ── METHOD A (recommended) — the browser console of your deployed app ────
-- Your app already holds a real authenticated session. Open the deployed
-- site, sign in as each test user in turn, and run the JavaScript snippets
-- in PART 2 from the browser console. Requests carry that user's JWT, so RLS
-- applies exactly as it will in production.
--
-- ── METHOD B — impersonation in the SQL Editor ───────────────────────────
-- Wrap each statement as shown in PART 1. This sets the role and the JWT
-- claim, which makes auth.uid() resolve. Less faithful than Method A because
-- it does not exercise PostgREST, but far better than nothing.
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════
-- SETUP — run ONCE as yourself in the SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Create two more accounts through the APP's sign-up screen:
--       editor@yourdomain.test
--       viewer@yourdomain.test
--    and one that will belong to no cellar:
--       outsider@yourdomain.test
--
-- 2. Find the ids:
select id, email from auth.users order by created_at;

-- 3. Find your cellar:
select c.id as cellar_id, c.name, m.user_id, m.role
from cellars c join cellar_members m on m.cellar_id = c.id;

-- 4. Add the two test users to YOUR cellar (run as owner):
--    Replace the placeholders.
/*
insert into cellar_members (cellar_id, user_id, role) values
  ('<CELLAR_ID>', '<EDITOR_USER_ID>', 'editor'),
  ('<CELLAR_ID>', '<VIEWER_USER_ID>', 'viewer');
*/

-- 5. Create a SECOND cellar owned by the outsider, for isolation testing:
/*
insert into cellars (name, created_by) values ('Outsider Cellar', '<OUTSIDER_USER_ID>');
*/


-- ═══════════════════════════════════════════════════════════════════════════
-- PART 1 — METHOD B: impersonation template
--
-- Every test below follows this shape. Run each in its own query window.
-- ═══════════════════════════════════════════════════════════════════════════

/*
begin;
  select set_config('request.jwt.claims',
    json_build_object('sub','<USER_ID>','role','authenticated')::text, true);
  set local role authenticated;

  -- ... the statement under test ...

rollback;   -- ALWAYS rollback. These tests must leave no trace.
*/


-- ═══════════════════════════════════════════════════════════════════════════
-- TEST MATRIX
--
-- Record the result of each. Expected outcomes:
--   DENIED-ERROR  = raises 42501 (INSERT refused by WITH CHECK)
--   DENIED-ZERO   = affects 0 rows, no error (UPDATE/DELETE refused by USING)
--   ALLOWED       = succeeds
--
-- ⚠️  A denied UPDATE does NOT raise an error. It silently affects zero rows.
--     If you only watch for exceptions you will wrongly record a pass.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- OWNER — everything allowed
-- ───────────────────────────────────────────────────────────────────────────
/*
begin;
  select set_config('request.jwt.claims',
    json_build_object('sub','<OWNER_ID>','role','authenticated')::text, true);
  set local role authenticated;

  -- O1 read                                          EXPECT: ALLOWED, > 0 rows
  select count(*) from wine_definitions;

  -- O2 create a wine via RPC                          EXPECT: ALLOWED
  select create_wine_definition(gen_random_uuid(), '<CELLAR_ID>',
    '{"producer":"RLS Owner Test","name":"Owner Wine","colour":"Red"}'::jsonb);

  -- O3 create storage via RPC                         EXPECT: ALLOWED
  select create_storage_layout(gen_random_uuid(), '<CELLAR_ID>',
    'Owner Test Grid', 'grid', '{"rows":2,"columns":2}'::jsonb);

  -- O4 manage membership                              EXPECT: ALLOWED
  insert into cellar_members (cellar_id, user_id, role)
  values ('<CELLAR_ID>', '<OUTSIDER_ID>', 'viewer');

  -- O5 change a role                                  EXPECT: ALLOWED
  update cellar_members set role='editor'
  where cellar_id='<CELLAR_ID>' and user_id='<OUTSIDER_ID>';

  -- O6 remove a member                                EXPECT: ALLOWED
  delete from cellar_members
  where cellar_id='<CELLAR_ID>' and user_id='<OUTSIDER_ID>';

  -- O7 write the cellar profile                       EXPECT: ALLOWED
  insert into cellar_profiles (cellar_id, bottles_per_month)
  values ('<CELLAR_ID>', 6)
  on conflict (cellar_id) do update set bottles_per_month = 6;
rollback;
*/

-- ───────────────────────────────────────────────────────────────────────────
-- EDITOR — inventory yes, membership no
-- ───────────────────────────────────────────────────────────────────────────
/*
begin;
  select set_config('request.jwt.claims',
    json_build_object('sub','<EDITOR_ID>','role','authenticated')::text, true);
  set local role authenticated;

  -- E1 read                                           EXPECT: ALLOWED
  select count(*) from wine_definitions;

  -- E2 create a wine via RPC                          EXPECT: ALLOWED
  select create_wine_definition(gen_random_uuid(), '<CELLAR_ID>',
    '{"producer":"RLS Editor Test","name":"Editor Wine","colour":"Red"}'::jsonb);

  -- E3 create an acquisition with bottles             EXPECT: ALLOWED
  select create_acquisition_with_items(gen_random_uuid(), '<CELLAR_ID>',
    '{"source":"Editor Test"}'::jsonb,
    ('[{"wine_definition_id":"<ANY_WINE_ID>","quantity":2}]')::jsonb);

  -- E4 invite a member                                EXPECT: DENIED-ERROR 42501
  insert into cellar_members (cellar_id, user_id, role)
  values ('<CELLAR_ID>', '<OUTSIDER_ID>', 'editor');

  -- E5 self-promote to owner                          EXPECT: DENIED-ZERO
  update cellar_members set role='owner'
  where cellar_id='<CELLAR_ID>' and user_id='<EDITOR_ID>';
  --    then CONFIRM it did not take:
  select role from cellar_members
  where cellar_id='<CELLAR_ID>' and user_id='<EDITOR_ID>';   -- must be 'editor'

  -- E6 remove the owner                               EXPECT: DENIED-ZERO
  delete from cellar_members
  where cellar_id='<CELLAR_ID>' and user_id='<OWNER_ID>';

  -- E7 write the cellar profile                       EXPECT: DENIED
  insert into cellar_profiles (cellar_id, bottles_per_month)
  values ('<CELLAR_ID>', 99);
rollback;
*/

-- ───────────────────────────────────────────────────────────────────────────
-- VIEWER — read only
-- ───────────────────────────────────────────────────────────────────────────
/*
begin;
  select set_config('request.jwt.claims',
    json_build_object('sub','<VIEWER_ID>','role','authenticated')::text, true);
  set local role authenticated;

  -- V1 read                                           EXPECT: ALLOWED, > 0 rows
  select count(*) from wine_definitions;
  select count(*) from bottles;
  select count(*) from bottle_events;

  -- ── DIRECT TABLE ACCESS ──
  -- V2 insert a wine                                  EXPECT: DENIED-ERROR 42501
  insert into wine_definitions (cellar_id, producer, name)
  values ('<CELLAR_ID>', 'Viewer Hack', 'Should Fail');

  -- V3 update a wine                                  EXPECT: DENIED-ZERO
  update wine_definitions set notes='hacked' where cellar_id='<CELLAR_ID>';
  --    CONFIRM nothing changed:
  select count(*) from wine_definitions where notes='hacked';   -- must be 0

  -- V4 insert a bottle                                EXPECT: DENIED-ERROR
  insert into bottles (cellar_id, wine_definition_id)
  values ('<CELLAR_ID>', '<ANY_WINE_ID>');

  -- V5 update a bottle                                EXPECT: DENIED-ZERO
  update bottles set notes='hacked' where cellar_id='<CELLAR_ID>';

  -- V6 insert an event directly                       EXPECT: DENIED-ERROR
  insert into bottle_events (cellar_id, bottle_id, event_type)
  values ('<CELLAR_ID>', '<ANY_BOTTLE_ID>', 'moved');

  -- V7 insert a valuation                             EXPECT: DENIED-ERROR
  insert into valuation_records (cellar_id, wine_definition_id, amount, valuation_basis)
  values ('<CELLAR_ID>', '<ANY_WINE_ID>', 1, 'manual_estimate');

  -- V8 insert a storage location                      EXPECT: DENIED-ERROR
  insert into storage_locations (cellar_id, name) values ('<CELLAR_ID>', 'Sneaky');

  -- ── RPC ACCESS ── the path the app actually uses
  -- V9  create a wine                                 EXPECT: DENIED
  select create_wine_definition(gen_random_uuid(), '<CELLAR_ID>',
    '{"producer":"Viewer","name":"Should Fail"}'::jsonb);

  -- V10 create an acquisition                         EXPECT: DENIED
  select create_acquisition_with_items(gen_random_uuid(), '<CELLAR_ID>',
    '{"source":"Viewer"}'::jsonb,
    ('[{"wine_definition_id":"<ANY_WINE_ID>","quantity":1}]')::jsonb);

  -- V11 move a bottle                                 EXPECT: DENIED
  select move_bottle(gen_random_uuid(), '<ANY_BOTTLE_ID>', 1, '<ANY_LOCATION_ID>', null);

  -- V12 change a bottle status                        EXPECT: DENIED
  select change_bottle_status(gen_random_uuid(), '<ANY_BOTTLE_ID>', 1, 'consumed', now());

  -- V13 record a valuation                            EXPECT: DENIED
  select record_valuation(gen_random_uuid(), '<CELLAR_ID>',
    '{"wine_definition_id":"<ANY_WINE_ID>","amount":999,"valuation_basis":"manual_estimate"}'::jsonb);

  -- V14 manage membership                             EXPECT: DENIED-ERROR
  insert into cellar_members (cellar_id, user_id, role)
  values ('<CELLAR_ID>', '<VIEWER_ID>', 'owner');
rollback;
*/

-- ───────────────────────────────────────────────────────────────────────────
-- OUTSIDER — belongs to no cellar of yours
-- ───────────────────────────────────────────────────────────────────────────
/*
begin;
  select set_config('request.jwt.claims',
    json_build_object('sub','<OUTSIDER_ID>','role','authenticated')::text, true);
  set local role authenticated;

  -- X1 read anything of yours                         EXPECT: 0 rows, every time
  select count(*) from wine_definitions;      -- 0
  select count(*) from bottles;               -- 0
  select count(*) from bottle_events;         -- 0
  select count(*) from storage_locations;     -- 0
  select count(*) from cellars;               -- only their own, not yours

  -- X2 read your cellar explicitly                    EXPECT: 0 rows
  select count(*) from wine_definitions where cellar_id='<CELLAR_ID>';

  -- X3 write into your cellar                         EXPECT: DENIED-ERROR
  insert into wine_definitions (cellar_id, producer, name)
  values ('<CELLAR_ID>', 'Outsider', 'Should Fail');

  -- X4 RPC against your cellar                        EXPECT: DENIED
  select create_wine_definition(gen_random_uuid(), '<CELLAR_ID>',
    '{"producer":"Outsider","name":"Should Fail"}'::jsonb);

  -- X5 move YOUR bottle into THEIR storage            EXPECT: DENIED
  select move_bottle(gen_random_uuid(), '<YOUR_BOTTLE_ID>', 1,
                     '<OUTSIDER_LOCATION_ID>', null);

  -- X6 move THEIR bottle into YOUR storage            EXPECT: DENIED
  select move_bottle(gen_random_uuid(), '<OUTSIDER_BOTTLE_ID>', 1,
                     '<YOUR_LOCATION_ID>', null);
rollback;
*/

-- ───────────────────────────────────────────────────────────────────────────
-- IMMUTABLE HISTORY — run as OWNER, EDITOR and VIEWER in turn.
-- All three must be denied. Owner being denied is the point.
-- ───────────────────────────────────────────────────────────────────────────
/*
begin;
  select set_config('request.jwt.claims',
    json_build_object('sub','<ROLE_USER_ID>','role','authenticated')::text, true);
  set local role authenticated;

  -- H1 update an event                                EXPECT: DENIED-ZERO
  update bottle_events set notes='rewritten' where id='<EVENT_ID>';
  select notes from bottle_events where id='<EVENT_ID>';   -- must NOT be 'rewritten'

  -- H2 delete an event                                EXPECT: DENIED-ZERO
  delete from bottle_events where id='<EVENT_ID>';
  select count(*) from bottle_events where id='<EVENT_ID>';   -- must still be 1

  -- H3 update a valuation                             EXPECT: DENIED-ZERO
  update valuation_records set amount=1 where id='<VALUATION_ID>';

  -- H4 delete a valuation                             EXPECT: DENIED-ZERO
  delete from valuation_records where id='<VALUATION_ID>';

  -- H5 delete a bottle                                EXPECT: DENIED-ZERO
  delete from bottles where id='<BOTTLE_ID>';
  select count(*) from bottles where id='<BOTTLE_ID>';   -- must still be 1

  -- H6 rewrite the operation ledger                   EXPECT: DENIED-ZERO
  update applied_operations set entity='tampered' where operation_id='<OP_ID>';
  delete from applied_operations where operation_id='<OP_ID>';
rollback;
*/


-- ═══════════════════════════════════════════════════════════════════════════
-- PART 2 — METHOD A: browser console (the faithful test)
--
-- Sign in to the deployed app as each user, open DevTools → Console, paste.
-- This exercises PostgREST and the real JWT path end to end.
-- ═══════════════════════════════════════════════════════════════════════════

/*
// Paste once to get a handle on the client the app already created.
const url  = "<YOUR_SUPABASE_URL>";
const key  = "<YOUR_PUBLISHABLE_KEY>";
const sb   = supabase.createClient(url, key);
const CELLAR = "<CELLAR_ID>";

// Confirm WHO you are before testing anything.
const { data: { user } } = await sb.auth.getUser();
console.log("signed in as:", user?.email);

// ── AS VIEWER ────────────────────────────────────────────────────────────
// Read: expect data
console.log("read:", (await sb.from("wine_definitions").select("id")).data?.length);

// Direct insert: expect error 42501
console.log("insert:", await sb.from("wine_definitions")
  .insert({ cellar_id: CELLAR, producer: "Hack", name: "Hack" }));

// Direct update: expect NO error but ZERO rows returned
console.log("update:", await sb.from("bottles")
  .update({ notes: "hacked" }).eq("cellar_id", CELLAR).select());

// RPC: expect error
console.log("rpc:", await sb.rpc("create_wine_definition", {
  p_operation_id: crypto.randomUUID(), p_cellar_id: CELLAR,
  p_wine: { producer: "Hack", name: "Hack" } }));

// ── AS EDITOR ────────────────────────────────────────────────────────────
// Inventory RPC: expect success
console.log("create wine:", await sb.rpc("create_wine_definition", {
  p_operation_id: crypto.randomUUID(), p_cellar_id: CELLAR,
  p_wine: { producer: "Editor Test", name: "Editor Wine", colour: "Red" } }));

// Membership: expect error 42501
console.log("invite:", await sb.from("cellar_members")
  .insert({ cellar_id: CELLAR, user_id: "<SOME_ID>", role: "editor" }));

// ── AS OUTSIDER ──────────────────────────────────────────────────────────
// Expect 0 rows, not an error. RLS filters silently.
console.log("outsider read:", (await sb.from("wine_definitions").select("id")).data);
*/


-- ═══════════════════════════════════════════════════════════════════════════
-- RECORD YOUR RESULTS
--
-- OWNER      O1 __ O2 __ O3 __ O4 __ O5 __ O6 __ O7 __
-- EDITOR     E1 __ E2 __ E3 __ E4 __ E5 __ E6 __ E7 __
-- VIEWER     V1 __ V2 __ V3 __ V4 __ V5 __ V6 __ V7 __ V8 __
--            V9 __ V10 __ V11 __ V12 __ V13 __ V14 __
-- OUTSIDER   X1 __ X2 __ X3 __ X4 __ X5 __ X6 __
-- IMMUTABLE  H1 __ H2 __ H3 __ H4 __ H5 __ H6 __  (× 3 roles)
--
-- Send me anything that does not match its EXPECT line.
--
-- ⚠️  If you see 42P17 (infinite recursion) anywhere, STOP. It means the
--     recursion fix in 001_foundation.sql was not applied.
-- ═══════════════════════════════════════════════════════════════════════════
