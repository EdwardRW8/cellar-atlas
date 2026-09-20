/**
 * READ-ONLY validation of the Phase 10a valuation currency read.
 *
 * Answers one question: does PostgREST round-trip `timestamptz` precisely
 * enough for an `in` filter, or is the bounded-range fallback needed?
 *
 * ── SAFETY ───────────────────────────────────────────────────────────────
 * Every data request is a GET. No INSERT, UPDATE, DELETE or RPC call is made.
 * Nothing in your cellar is created, changed or removed.
 *
 * No token, key, password or session is ever printed. Only strategy, verdict
 * and non-sensitive counts are reported.
 *
 * ── AUTHENTICATION ───────────────────────────────────────────────────────
 * Preferred: SUPABASE_ACCESS_TOKEN — a user access token you already hold, so
 * no password is needed or handled here.
 *
 *   NOTE: this must be a USER access token (the JWT from a signed-in session),
 *   not a Supabase CLI management token. They share a name and are not
 *   interchangeable.
 *
 * Fallback: SUPABASE_EMAIL + SUPABASE_PASSWORD, retained for convenience.
 *
 * Never supply a service-role key. The publishable key plus your own session
 * is all this needs, and RLS stays in force throughout.
 */

const URL_ = process.env.VITE_SUPABASE_URL?.replace(/\/+$/, "");

// The Netlify environment names this PUBLISHABLE_KEY; older local .env files
// may still use ANON_KEY. Both denote the same public frontend key.
const KEY =
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN?.trim();
const EMAIL = process.env.SUPABASE_EMAIL?.trim();
const PASSWORD = process.env.SUPABASE_PASSWORD;

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!URL_) fail("VITE_SUPABASE_URL is not set.");
if (!KEY) fail("VITE_SUPABASE_PUBLISHABLE_KEY is not set.");

if (KEY.includes("service_role")) {
  fail("That looks like a service-role key. Use the publishable key only.");
}

// ── Obtain a user token, without echoing anything sensitive ───────────────

let accessToken = TOKEN;
let authMethod = "SUPABASE_ACCESS_TOKEN";

if (!accessToken) {
  if (!EMAIL || !PASSWORD) {
    fail(
      "No credentials. Set SUPABASE_ACCESS_TOKEN (preferred), or " +
        "SUPABASE_EMAIL and SUPABASE_PASSWORD as a fallback.",
    );
  }

  const signIn = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });

  if (!signIn.ok) {
    // Status only — never the response body, which echoes request detail.
    fail(`Sign-in failed (HTTP ${signIn.status}).`);
  }

  const session = await signIn.json();
  accessToken = session.access_token;
  authMethod = "email + password";
  if (!accessToken) fail("Sign-in returned no access token.");
}

console.log(`Authenticated via: ${authMethod}`);
console.log("Mode: READ-ONLY (GET requests only)\n");

/** Every data request goes through here, and every one is a GET. */
async function get(path) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    method: "GET",
    headers: { apikey: KEY, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    // Status only. A PostgREST error body can contain the query and values.
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

const toInstant = (v) => (v instanceof Date ? v.getTime() : Date.parse(v));

// ── 1. Bottles carrying a cached valuation ────────────────────────────────

console.log("── Bottles with a cached valuation ──");
let bottles;
try {
  bottles = await get(
    "bottles?select=id,wine_definition_id,current_value,current_value_at" +
      "&current_value_at=not.is.null&limit=500",
  );
} catch (e) {
  fail(
    `Could not read bottles (${e.message}). ` +
      "If this is 401, the token may have expired — fetch a fresh one.",
  );
}

console.log(`  valued bottles visible: ${bottles.length}`);

if (bottles.length === 0) {
  console.log(
    "\n  No valued bottles yet, so there is nothing to validate.\n" +
      "  Record one valuation in the app and run this again.",
  );
  process.exit(0);
}

const raw = [...new Set(bottles.map((b) => b.current_value_at))];
const canonical = [...new Set(raw.map((t) => new Date(t).toISOString()))];
console.log(`  distinct valuation timestamps: ${raw.length}`);
// Shape only — a timestamp is not sensitive, but keep the output minimal.
console.log(`  timestamp format: ${typeof raw[0]} (${String(raw[0]).length} chars)`);

const wanted = new Set(raw.map(toInstant));

// ── 1b. Exact app path: canonical ISO timestamps ─────────────────────────
console.log("\n── App path: canonical ISO timestamps ──");

try {
  const canonicalList = canonical.map((t) => `"${t}"`).join(",");
  const canonicalRows = await get(
    `valuation_records?select=${"id,bottle_id,wine_definition_id,currency,amount,valuation_basis,source,created_at"}` +
      `&created_at=in.(${encodeURIComponent(canonicalList)})`,
  );
  console.log(`  canonical timestamps: ${canonical.length}`);
  console.log(`  rows returned: ${canonicalRows.length}`);

  let resolved = 0;
  let unmatched = 0;

  for (const bottle of bottles) {
    const bottleAt = toInstant(bottle.current_value_at);
    const matches = canonicalRows.filter((row) => {
      if (toInstant(row.created_at) !== bottleAt) return false;
      if (row.bottle_id !== null) return row.bottle_id === bottle.id;
      return row.wine_definition_id === bottle.wine_definition_id;
    });

    if (matches.length === 1) resolved++;
    else unmatched++;
  }

  console.log(`  bottle matches: ${resolved} resolved, ${unmatched} unmatched`);
} catch (e) {
  console.log(`  canonical query rejected: ${e.message}`);
}

// ── 2. Primary path: .in(created_at, [...]) ───────────────────────────────

console.log("\n── Primary path: created_at=in.(...) ──");
const LEDGER_COLUMNS =
  "id,bottle_id,wine_definition_id,currency,amount," +
  "valuation_basis,source,created_at";

let inRows = [];
let inFailed = false;
try {
  const list = raw.map((t) => `"${t}"`).join(",");
  inRows = await get(
    `valuation_records?select=${LEDGER_COLUMNS}` +
      `&created_at=in.(${encodeURIComponent(list)})`,
  );
  console.log(`  rows returned: ${inRows.length}`);
} catch (e) {
  inFailed = true;
  console.log(`  query rejected: ${e.message}`);
}

const inGot = new Set(inRows.map((r) => toInstant(r.created_at)));
const inCovered = !inFailed && [...wanted].every((t) => inGot.has(t));
console.log(`  covers every timestamp: ${inCovered}`);
if (!inCovered && !inFailed) {
  const missing = [...wanted].filter((t) => !inGot.has(t)).length;
  console.log(`  timestamps missed: ${missing} of ${wanted.size}`);
}

// ── 3. Fallback path: bounded range, matched exactly client-side ──────────

console.log("\n── Fallback path: bounded range ──");
const sorted = [...raw].sort();
let rangeCovered = false;
try {
  const rangeRows = await get(
    `valuation_records?select=${LEDGER_COLUMNS}` +
      `&created_at=gte.${encodeURIComponent(sorted[0])}` +
      `&created_at=lte.${encodeURIComponent(sorted[sorted.length - 1])}`,
  );
  const rangeGot = new Set(rangeRows.map((r) => toInstant(r.created_at)));
  rangeCovered = [...wanted].every((t) => rangeGot.has(t));
  console.log(`  rows returned: ${rangeRows.length}`);
  console.log(`  covers every timestamp: ${rangeCovered}`);
} catch (e) {
  console.log(`  query rejected: ${e.message}`);
}


// ── 4. Bottle → valuation row matching ───────────────────────────────────

console.log("\n── Bottle → ledger matching ──");

function matches(row, bottle) {
  const bottleAt = toInstant(bottle.current_value_at);
  const rowAt = toInstant(row.created_at);

  if (!Number.isFinite(bottleAt) || !Number.isFinite(rowAt)) return false;
  if (rowAt !== bottleAt) return false;

  if (row.bottle_id !== null) {
    return row.bottle_id === bottle.id;
  }

  return row.wine_definition_id === bottle.wine_definition_id;
}

let resolved = 0;
let unmatched = 0;
let ambiguous = 0;

for (const bottle of bottles) {
  const candidates = inRows.filter((row) => matches(row, bottle));
  const bottleLevel = candidates.filter((row) => row.bottle_id !== null);
  const preferred = bottleLevel.length > 0 ? bottleLevel : candidates;

  let result;
  if (preferred.length === 0) {
    result = "UNMATCHED";
    unmatched++;
  } else if (preferred.length > 1) {
    result = "AMBIGUOUS";
    ambiguous++;
  } else {
    result = "RESOLVED";
    resolved++;
  }

  console.log(
    `  bottle ${String(bottle.id).slice(0, 8)}…: ${result}` +
      ` | candidates=${candidates.length}` +
      ` | preferred=${preferred.length}` +
      ` | value=${bottle.current_value}`
  );
}

console.log(
  `  summary: ${resolved} resolved, ${unmatched} unmatched, ${ambiguous} ambiguous`
);

// ── Verdict ───────────────────────────────────────────────────────────────

console.log("\n═══ VERDICT ═══");
if (inCovered) {
  console.log("  strategy: in");
  console.log("  .in() round-trips timestamps reliably. Primary path is used.");
} else if (rangeCovered) {
  console.log("  strategy: range");
  console.log(
    "  .in() is not reliable here. The fallback engages automatically —\n" +
      "  no code change needed, but worth reporting.",
  );
} else {
  console.log("  strategy: NONE");
  console.log(
    "  Neither path covered every timestamp. Report this: the approved\n" +
      "  design needs revisiting before Phase 10 continues.",
  );
}

console.log("\nNothing was created, updated or deleted.");
