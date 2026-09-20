/**
 * HARNESS SELF-TEST
 *
 * Proves the restRequest callback shape is serialisable by Playwright,
 * without needing Supabase. It reproduces the exact structure of the real
 * helper: values passed as arguments, session read from localStorage, a
 * bearer token attached.
 *
 * If someone reintroduces `import.meta` or a Node-scope closure inside a
 * page.evaluate callback, this fails immediately rather than at 3am against
 * the live site.
 */

import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SPEC = readFileSync(join(process.cwd(), "tests/e2e/rls-jwt.spec.ts"), "utf8");

/** Strip comments so documentation about the rule is not read as a breach. */
function code(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("the restRequest callback shape serialises", async ({ page }) => {
  // A real http origin — localStorage is disabled on data: URLs.
  await page.route("**/stub", (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>stub</h1>" }),
  );
  await page.goto("http://localhost/stub");
  await page.evaluate(() =>
    localStorage.setItem("cellar_v3_auth-x", JSON.stringify({ access_token: "fake-jwt" })),
  );

  // Exactly the shape the real helper uses: everything passed in.
  const result = await page.evaluate(
    async (args: { url: string; apikey: string; path: string; method: string }) => {
      const authKey = Object.keys(localStorage).find((k) => k.startsWith("cellar_v3_auth"));
      if (!authKey) throw new Error("No session");
      const session = JSON.parse(localStorage.getItem(authKey)!) as {
        access_token: string;
      };
      return {
        built: args.url + "/rest/v1/" + args.path,
        method: args.method,
        auth: "Bearer " + session.access_token,
        apikey: args.apikey,
      };
    },
    {
      url: "https://example.supabase.co",
      apikey: "public-anon-key",
      path: "wine_definitions?select=id",
      method: "GET",
    },
  );

  expect(result.built).toBe(
    "https://example.supabase.co/rest/v1/wine_definitions?select=id",
  );
  expect(result.auth).toBe("Bearer fake-jwt");
});

test("no page.evaluate callback in the spec references import.meta", () => {
  expect(code(SPEC)).not.toMatch(/import\.meta/);
});

test("the spec reads Supabase config from Node scope, not the browser", () => {
  expect(SPEC).toMatch(/const SUPABASE_URL = process\.env\.E2E_SUPABASE_URL/);
  expect(SPEC).toMatch(/const SUPABASE_KEY = process\.env\.E2E_SUPABASE_ANON_KEY/);
});

test("credentials are trimmed", () => {
  expect(SPEC).toMatch(/E2E_\$\{role\}_EMAIL`\]\?\.trim\(\)/);
  expect(SPEC).toMatch(/E2E_\$\{role\}_PASSWORD`\]\?\.trim\(\)/);
});

test("sign-in clears storage before each attempt", () => {
  expect(SPEC).toMatch(/localStorage\.clear\(\)/);
  expect(SPEC).toMatch(/sessionStorage\.clear\(\)/);
});

test("sign-in surfaces the app's own error instead of timing out blindly", () => {
  expect(SPEC).toMatch(/getByRole\("alert"\)/);
  expect(SPEC).toMatch(/Supabase rejected the sign-in/);
});

test("no password or token is ever logged", () => {
  const c = code(SPEC);
  expect(c).not.toMatch(/console\.log[\s\S]{0,120}password/i);
  expect(c).not.toMatch(/console\.log[\s\S]{0,120}access_token/i);
  // Emails are masked in failure messages.
  expect(SPEC).toMatch(/function maskEmail/);
  expect(SPEC).not.toMatch(/\$\{acct\.email\}/);
});

test("no service-role key, no mocked auth, no test-only bypass", () => {
  const c = code(SPEC);
  expect(c).not.toMatch(/service_role|SERVICE_ROLE|serviceRole/);
  expect(c).not.toMatch(/mock|stub|fakeAuth|bypass/i);
  // Sign-in still goes through the real form.
  expect(SPEC).toMatch(/getByRole\("button", \{ name: \/\^sign in\$\/i \}\)\.click\(\)/);
});

test("every security assertion is still present", () => {
  for (const assertion of [
    "CANNOT insert a wine directly",
    "CANNOT mutate via RPC",
    "CANNOT invite members",
    "CANNOT write the cellar profile",
    "cannot READ a cellar they do not belong to",
    "cannot WRITE into a cellar they do not belong to",
    "cannot call an RPC against another cellar",
    "even the owner cannot rewrite an event",
    "even the owner cannot delete an event",
  ]) {
    expect(SPEC, `missing assertion: ${assertion}`).toContain(assertion);
  }
});

test("no test is skipped by hard-coding", () => {
  const c = code(SPEC);
  expect(c).not.toMatch(/test\.skip\(true/);
  expect(c).not.toMatch(/test\.only\(/);
  expect(c).not.toMatch(/\.fixme\(/);
});

test("immutable-history tests create their own event, never skip", () => {
  const c = code(SPEC);

  // The old conditional skip must be gone.
  expect(c).not.toMatch(/test\.skip\(!event/);
  expect(c).not.toMatch(/No events exist yet/);

  // Both tests use the shared fixture.
  const uses = c.match(/await createEventFixture\(page\)/g) ?? [];
  expect(uses.length).toBe(2);
});

test("the fixture builds its subject through the real RPCs", () => {
  const c = code(SPEC);
  expect(c).toMatch(/rpc\/create_wine_definition/);
  expect(c).toMatch(/rpc\/create_acquisition_with_items/);
  expect(c).toMatch(/quantity: 1/);
  expect(c).toMatch(/bottle_size: "750ml"/);
  expect(c).toMatch(/format: "loose"/);
});

test("the fixture targets ITS OWN event via source_operation_id", () => {
  const c = code(SPEC);
  expect(c).toMatch(/source_operation_id=eq\.\$\{operationId\}/);
  // Never fall back to an arbitrary pre-existing event.
  expect(c).not.toMatch(/bottle_events\?select=id&limit=1/);
});

test("fixture data is clearly marked as test data", () => {
  expect(SPEC).toMatch(/\[E2E-TEST\]/);
});

test("immutable assertions still check BOTH denial modes", () => {
  const c = code(SPEC);
  // 42501 for a refused write, zero rows for a filtered UPDATE/DELETE.
  expect(c).toMatch(/PATCH should have affected zero rows/);
  expect(c).toMatch(/DELETE should have affected zero rows/);
  expect(c).toMatch(/the event must survive the delete attempt/);
});

// ═══════════════════════════════════════════════════════════════════════════
// MOBILE SPEC GUARDS
// ═══════════════════════════════════════════════════════════════════════════

const MOBILE = readFileSync(
  join(process.cwd(), "tests/e2e/mobile-workflows.spec.ts"),
  "utf8",
);

test("the badge neutraliser survives LATE iframe injection", async ({ page }) => {
  // Reproduces the real condition: the CSS rule is installed via
  // addInitScript BEFORE any page script runs, then Netlify injects its
  // iframe afterwards. CSS matches elements added later, so the rule applies.
  await page.addInitScript(() => {
    const RULE =
      '#nl-badge-frame, iframe[title="Powered by Netlify"] ' +
      "{ pointer-events: none !important; }";

    const install = () => {
      if (document.getElementById("e2e-badge-neutraliser")) return;
      const style = document.createElement("style");
      style.id = "e2e-badge-neutraliser";
      style.textContent = RULE;
      document.head.appendChild(style);
    };

    // MUST wait for DOMContentLoaded. addInitScript runs at document-start,
    // and anything appended then is discarded when the parser builds the DOM
    // — verified: the style element simply is not there afterwards.
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", install, { once: true });
    } else {
      install();
    }
  });

  await page.route("**/badge-stub", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<body style="margin:0">
        <button id="target" aria-label="Add wine"
          style="position:fixed;bottom:20px;right:20px;width:56px;height:56px">+</button>
      </body>`,
    }),
  );
  await page.goto("http://localhost/badge-stub");

  // Inject the badge AFTER load, exactly as Netlify does.
  await page.evaluate(() => {
    const f = document.createElement("iframe");
    f.id = "nl-badge-frame";
    f.title = "Powered by Netlify";
    f.style.cssText =
      "position:fixed;bottom:0;right:0;width:114px;height:52px;border:0;z-index:9999";
    document.body.appendChild(f);
  });

  const intercepted = await page.evaluate(() => {
    const btn = document.getElementById("target")!;
    const r = btn.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return top?.id ?? null;
  });

  // Without the rule this returns "nl-badge-frame".
  expect(intercepted).toBe("target");
});

test("the mobile spec installs the neutraliser via addInitScript", () => {
  expect(MOBILE).toMatch(/addInitScript/);
  expect(MOBILE).toMatch(/e2e-badge-neutraliser/);
  expect(MOBILE).toMatch(/pointer-events: none !important/);
});

test("the mobile spec never uses force clicks", () => {
  const c = code(MOBILE);
  expect(c).not.toMatch(/force:\s*true/);
  expect(c).not.toMatch(/dispatchEvent\(new MouseEvent/);
});

test("the search test seeds deterministic data instead of skipping", () => {
  const c = code(MOBILE);
  expect(c).not.toMatch(/test\.skip\(!visible/);
  expect(c).not.toMatch(/Cellar is empty/);
  expect(c).toMatch(/seedSearchableWine/);
  expect(c).toMatch(/rpc\/create_acquisition_with_items/);
});

test("the search test still asserts both directions", () => {
  const c = code(MOBILE);
  expect(c).toMatch(/zzzznomatchzzzz/);
  expect(c).toMatch(/no wines match/);
  expect(c).toMatch(/toHaveCount\(0\)/);
});

test("the mobile spec keeps real browser authentication", () => {
  const c = code(MOBILE);
  expect(c).toMatch(/getByLabel\("Email"\)/);
  expect(c).toMatch(/getByRole\("button", \{ name: \/\^sign in\$\/i \}\)\.click\(\)/);
  expect(c).not.toMatch(/service_role|serviceRole|mockAuth|setStorageState/);
});

test("the only mobile skip is the credential guard", () => {
  const skips = code(MOBILE).match(/test\.skip\(/g) ?? [];
  expect(skips.length).toBe(1);
  expect(MOBILE).toMatch(/E2E_OWNER_EMAIL \/ E2E_OWNER_PASSWORD not set/);
});

// ═══════════════════════════════════════════════════════════════════════════
// RACK SPEC GUARDS
// ═══════════════════════════════════════════════════════════════════════════

const RACK = readFileSync(join(process.cwd(), "tests/e2e/rack.spec.ts"), "utf8");

test("the rack spec does not infer layout type from visible text", () => {
  const c = code(RACK);
  // The original bug: matching button text against layout type names.
  expect(c).not.toMatch(/textContent\(\)/);
  expect(c).not.toMatch(/\/staircase\|grid\|shelving\|fridge\/i/);
});

test("it selects by storage_layouts.type from real data", () => {
  const c = code(RACK);
  expect(c).toMatch(/storage_layouts\(type\)/);
  expect(c).toMatch(/POSITIONED_TYPES\.includes\(type\)/);
});

test("it only accepts the four positioned types", () => {
  expect(RACK).toMatch(
    /POSITIONED_TYPES = \[\s*"staircase",\s*"grid",\s*"shelving",\s*"fridge",?\s*\]/,
  );
});

test("it requires a live bottle, because the rack needs one to render", () => {
  const c = code(RACK);
  expect(c).toMatch(/status === "in_cellar"/);
});

test("it navigates by id rather than clicking a guessed row", () => {
  const c = code(RACK);
  expect(c).toMatch(/\/storage\/\$\{location!\.id\}/);
});

test("no location name is hard-coded", () => {
  const c = code(RACK);
  expect(c).not.toMatch(/E2E Rack|Home Cellar|Berry Bros|Wine Society/);
});

test("all four rack assertions are preserved", () => {
  for (const assertion of [
    "a positioned location offers a visual rack",
    "does not introduce horizontal page scroll",
    "dragging changes the rack orientation",
    "switching to the list view still works",
  ]) {
    expect(RACK, `missing: ${assertion}`).toContain(assertion);
  }
});

test("the drag test does not judge rotation by a single slot", () => {
  const c = code(RACK);
  // Rotation is per slot; a slot on the axis legitimately does not move.
  expect(c).toMatch(/querySelectorAll\("rect, polygon"\)/);
  expect(c).not.toMatch(
    /locator\("rect, polygon"\)\.first\(\)[\s\S]{0,80}getAttribute\("x"\)/,
  );
});

test("the drag test captures x, y AND points", () => {
  const c = code(RACK);
  expect(c).toMatch(/getAttribute\("x"\)/);
  expect(c).toMatch(/getAttribute\("y"\)/);
  expect(c).toMatch(/getAttribute\("points"\)/);
});

test("the drag test proves React state changed via the Face on control", () => {
  const c = code(RACK);
  expect(c).toMatch(/toBeDisabled\(\)/);
  expect(c).toMatch(/toBeEnabled\(/);
});

test("the drag stays inside the viewport", () => {
  const c = code(RACK);
  // A tall rack's midpoint can sit below the fold.
  expect(c).toMatch(/scrollIntoViewIfNeeded\(\)/);
  expect(c).toMatch(/viewport!\.height/);
});

test("the drag uses real pointer input, never state manipulation", () => {
  const c = code(RACK);
  expect(c).toMatch(/page\.mouse\.down\(\)/);
  expect(c).toMatch(/page\.mouse\.up\(\)/);
  expect(c).not.toMatch(/setRotation|dispatchEvent|__REACT/);
  expect(c).not.toMatch(/force:\s*true/);
});

test("the rack spec uses no force clicks and no service-role key", () => {
  const c = code(RACK);
  expect(c).not.toMatch(/force:\s*true/);
  expect(c).not.toMatch(/service_role|serviceRole/);
});

test("the rack spec's evaluate callback is serialisable", () => {
  expect(code(RACK)).not.toMatch(/import\.meta/);
});

// ═══════════════════════════════════════════════════════════════════════════
// BASE URL NORMALISATION
//
// `E2E_BASE_URL` ending in "/" produced `//storage/:id`, which does not
// resolve. The fix has been lost twice to wholesale regeneration of
// rack.spec.ts, so it is guarded here rather than trusted to survive.
// ═══════════════════════════════════════════════════════════════════════════

test("the rack spec strips trailing slashes from BASE", () => {
  expect(RACK, "rack.spec.ts must normalise E2E_BASE_URL before appending a route").toMatch(
    /const BASE = \(process\.env\.E2E_BASE_URL \?\? "[^"]+"\)\.replace\(\s*\/\\\/\+\$\/,\s*""/,
  );
});

test("BASE is never assigned without normalisation", () => {
  // The exact line that regressed twice.
  expect(code(RACK)).not.toMatch(/const BASE = process\.env\.E2E_BASE_URL \?\? "[^"]*";/);
});

test("the normalisation logic is correct", () => {
  // Exercise the same expression the spec uses.
  const normalise = (v: string) => v.replace(/\/+$/, "");
  expect(normalise("https://site.netlify.app/")).toBe("https://site.netlify.app");
  expect(normalise("https://site.netlify.app///")).toBe("https://site.netlify.app");
  expect(normalise("https://site.netlify.app")).toBe("https://site.netlify.app");
  expect(normalise("http://localhost:5173/")).toBe("http://localhost:5173");
  // A route appended to a normalised base has exactly one slash.
  expect(`${normalise("https://site.netlify.app/")}/storage/abc`).toBe(
    "https://site.netlify.app/storage/abc",
  );
});

test("every spec that appends a route normalises its base", () => {
  const specs = ["rack.spec.ts", "mobile-workflows.spec.ts", "rls-jwt.spec.ts"];
  for (const name of specs) {
    const source = readFileSync(join(process.cwd(), "tests/e2e", name), "utf8");
    const concatenates = /\$\{BASE\}\//.test(code(source));
    if (!concatenates) continue;
    expect(source, `${name} appends a route to BASE but does not normalise it`).toMatch(
      /E2E_BASE_URL \?\? "[^"]+"\)\.replace\(/,
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// HOME SPEC GUARDS
// ═══════════════════════════════════════════════════════════════════════════

const HOME_SPEC = readFileSync(join(process.cwd(), "tests/e2e/home.spec.ts"), "utf8");

test("the home spec normalises BASE like every other spec", () => {
  expect(HOME_SPEC).toMatch(
    /const BASE = \(process\.env\.E2E_BASE_URL \?\? "[^"]+"\)\.replace\(/,
  );
});

test("the home spec asserts Home is the default route", () => {
  expect(code(HOME_SPEC)).toMatch(/default route/);
});

test("the home spec guards against Phase 8 language", () => {
  const c = code(HOME_SPEC);
  expect(c).toMatch(/tonight/);
  expect(c).toMatch(/longevity/);
});

test("the home spec checks mobile overflow", () => {
  expect(code(HOME_SPEC)).toMatch(/scrollWidth/);
});

// ═══════════════════════════════════════════════════════════════════════════
// HOME SPEC — LOAD-STATE AND DETERMINISM GUARDS
//
// The Home spec failed live because it asserted while the skeleton was still
// on screen: the heading renders in every state, so waiting for it proved
// nothing about the data.
// ═══════════════════════════════════════════════════════════════════════════

test("the home spec waits for loading to finish before asserting data", () => {
  const c = code(HOME_SPEC);
  expect(c).toMatch(/waitForHomeLoaded/);
  // The actual signal: the skeleton's role="status" aria-label="Loading".
  expect(c).toMatch(/getByRole\("status", \{ name: \/loading\/i \}\)/);
  expect(c).toMatch(/toHaveCount\(0/);
});

test("no data assertion relies on the heading alone", () => {
  const c = code(HOME_SPEC);
  // The heading renders during loading, error and ready alike.
  expect(c).not.toMatch(
    /getByRole\("heading", \{ name: "Home" \}\)\)\.toBeVisible\(\);\s*\n\s*\/\/ Either/,
  );
});

test("the home spec uses no fixed delays", () => {
  const c = code(HOME_SPEC);
  expect(c).not.toMatch(/waitForTimeout|setTimeout|sleep\(/);
});

test("the assertion was not weakened to just a heading check", () => {
  const c = code(HOME_SPEC);
  expect(c).toMatch(/nothing to report yet/);
  expect(c).toMatch(/your cellar is empty/);
  expect(c).toMatch(/bottles\? · /);
});

test("the navigation test seeds its own data instead of skipping", () => {
  const c = code(HOME_SPEC);
  expect(c).toMatch(/seedReadyWine/);
  expect(c).toMatch(/rpc\/create_wine_definition/);
  expect(c).toMatch(/rpc\/create_acquisition_with_items/);
  expect(c).not.toMatch(/No bottles are currently ready/);
});

test("seeded rows are marked as test data", () => {
  expect(HOME_SPEC).toMatch(/\[E2E-TEST\]/);
});

test("the navigation test proves the FILTER arrived, not just the route", () => {
  const c = code(HOME_SPEC);
  expect(c).toMatch(/Filters, 1 active/);
});

test("the only home skip is the credential guard", () => {
  const skips = code(HOME_SPEC).match(/test\.skip\(/g) ?? [];
  expect(skips.length).toBe(1);
  expect(HOME_SPEC).toMatch(/E2E_OWNER credentials not set/);
});

test("the home spec adds no service-role access", () => {
  const c = code(HOME_SPEC);
  expect(c).not.toMatch(/service_role|serviceRole/);
  expect(c).toMatch(/E2E_SUPABASE_ANON_KEY/);
});

// ═══════════════════════════════════════════════════════════════════════════
// ATLAS SPEC GUARDS
// ═══════════════════════════════════════════════════════════════════════════

const ATLAS_SPEC = readFileSync(join(process.cwd(), "tests/e2e/atlas.spec.ts"), "utf8");

test("the atlas spec normalises BASE", () => {
  expect(ATLAS_SPEC).toMatch(
    /const BASE = \(process\.env\.E2E_BASE_URL \?\? "[^"]+"\)\.replace\(/,
  );
});

test("the atlas spec waits for loading before asserting", () => {
  const c = code(ATLAS_SPEC);
  expect(c).toMatch(/waitForAtlasLoaded/);
  expect(c).toMatch(/getByRole\("status", \{ name: \/loading\/i \}\)/);
  expect(c).not.toMatch(/waitForTimeout|setTimeout/);
});

test("the atlas spec seeds CANONICAL geography rather than skipping", () => {
  const c = code(ATLAS_SPEC);
  expect(c).toMatch(/seedMappedWine/);
  // The region id is read from geo_regions, never invented.
  expect(c).toMatch(/geo_regions\?select=/);
  expect(c).toMatch(/geo_region_id: region!\.id/);
});

test("seeded atlas rows are marked as test data", () => {
  expect(ATLAS_SPEC).toMatch(/\[E2E-TEST\]/);
});

test("the atlas spec asserts FULL world context, not just owned countries", () => {
  expect(code(ATLAS_SPEC)).toMatch(/toBeGreaterThan\(100\)/);
});

test("the atlas spec asserts circles are described as locations", () => {
  expect(code(ATLAS_SPEC)).toMatch(/locations, not territory boundaries/);
});

test("the only atlas skip is the credential guard", () => {
  const skips = code(ATLAS_SPEC).match(/test\.skip\(/g) ?? [];
  expect(skips.length).toBe(1);
});

test("the atlas spec uses no service-role credential", () => {
  const c = code(ATLAS_SPEC);
  expect(c).not.toMatch(/service_role|serviceRole/);
  expect(c).toMatch(/E2E_SUPABASE_ANON_KEY/);
});

// ═══════════════════════════════════════════════════════════════════════════
// INTELLIGENCE SPEC GUARDS
// ═══════════════════════════════════════════════════════════════════════════

const INTEL_SPEC = readFileSync(
  join(process.cwd(), "tests/e2e/intelligence.spec.ts"),
  "utf8",
);

test("the intelligence spec normalises BASE", () => {
  expect(INTEL_SPEC).toMatch(
    /const BASE = \(process\.env\.E2E_BASE_URL \?\? "[^"]+"\)\.replace\(/,
  );
});

test("it waits for real loading states, never a fixed delay", () => {
  const c = code(INTEL_SPEC);
  expect(c).toMatch(/waitForLoaded/);
  expect(c).toMatch(/getByRole\("status", \{ name: \/loading\/i \}\)/);
  expect(c).not.toMatch(/waitForTimeout|setTimeout|sleep\(/);
});

test("it uses no timeout-then-catch branching", () => {
  const c = code(INTEL_SPEC);
  expect(c).not.toMatch(/\.catch\(async/);
  expect(c).not.toMatch(/toBeVisible\([^)]*\)\s*\.catch\(/);
});

test("it navigates the real hierarchy — both screens live under More", () => {
  const c = code(INTEL_SPEC);
  expect(c).toMatch(/getByRole\("link", \{ name: "More" \}\)/);
});

test("it asserts the absence of opaque scoring", () => {
  const c = code(INTEL_SPEC);
  expect(c).toMatch(/cellar score/);
  expect(c).toMatch(/legacy risk/);
});

test("it asserts Home stayed unchanged", () => {
  expect(code(INTEL_SPEC)).toMatch(/Home is visually unchanged/);
});

test("the only intelligence skip is the credential guard", () => {
  const skips = code(INTEL_SPEC).match(/test\.skip\(/g) ?? [];
  expect(skips.length).toBe(1);
});

// ═══════════════════════════════════════════════════════════════════════════
// HISTORY / TASTING SPEC GUARDS
// ═══════════════════════════════════════════════════════════════════════════

const HISTORY_SPEC = readFileSync(
  join(process.cwd(), "tests/e2e/history-tasting.spec.ts"),
  "utf8",
);

test("the history spec normalises BASE", () => {
  expect(HISTORY_SPEC).toMatch(
    /const BASE = \(process\.env\.E2E_BASE_URL \?\? "[^"]+"\)\.replace\(/,
  );
});

test("the history spec waits for real loading states", () => {
  const c = code(HISTORY_SPEC);
  expect(c).toMatch(/waitForLoaded/);
  expect(c).toMatch(/getByRole\("status", \{ name: \/loading\/i \}\)/);
  expect(c).not.toMatch(/waitForTimeout|setTimeout|sleep\(/);
});

test("the history spec uses no timeout-then-catch branching", () => {
  const c = code(HISTORY_SPEC);
  expect(c).not.toMatch(/\.catch\(async/);
  expect(c).not.toMatch(/force:\s*true/);
});

test("the history spec navigates the real hierarchy under More", () => {
  expect(code(HISTORY_SPEC)).toMatch(/getByRole\("link", \{ name: "More" \}\)/);
});

test("the history spec asserts History exposes no mutation control", () => {
  const c = code(HISTORY_SPEC);
  expect(c).toMatch(/\^edit\$/);
  expect(c).toMatch(/toHaveCount\(0\)/);
});

test("the history spec asserts the Pairings placeholder is gone", () => {
  expect(code(HISTORY_SPEC)).toMatch(/pairings/);
});

test("the only history skip is the credential guard", () => {
  const skips = code(HISTORY_SPEC).match(/test\.skip\(/g) ?? [];
  expect(skips.length).toBe(1);
});

test("the history spec uses no service-role credential", () => {
  expect(code(HISTORY_SPEC)).not.toMatch(/service_role|serviceRole/);
});

// ═══════════════════════════════════════════════════════════════════════════
// E2E CELLAR SAFETY
//
// Mutating E2E tests must never target the real cellar. This guard is
// source-level: any spec that seeds data has to assert the cellar it resolved
// is the dedicated E2E one before it writes anything.
// ═══════════════════════════════════════════════════════════════════════════

const MUTATING_SPECS = ["home.spec.ts", "atlas.spec.ts"];

test("every mutating E2E spec guards its target cellar", () => {
  for (const name of MUTATING_SPECS) {
    const src = readFileSync(join(process.cwd(), "tests/e2e", name), "utf8");
    const seeds = /rpc\/create_(wine_definition|acquisition_with_items)/.test(src);
    if (!seeds) continue;
    expect(
      src,
      `${name} seeds data but does not assert E2E_CELLAR_ID before mutating`,
    ).toMatch(/E2E_CELLAR_ID/);
  }
});

test("no spec hard-codes the real cellar id", () => {
  const REAL_CELLAR = "a7283598-c94f-40b0-983a-871027c67867";
  for (const name of readdirSync(join(process.cwd(), "tests/e2e"))) {
    const src = readFileSync(join(process.cwd(), "tests/e2e", name), "utf8");
    expect(src, `${name} references the real cellar`).not.toContain(REAL_CELLAR);
  }
});
