/**
 * PHASE 11 — CSV IMPORT — LIVE ACCEPTANCE
 *
 * Drives the real, user-facing import through the browser:
 *
 *   More → Import wines → choose CSV → preview → acknowledge → confirm →
 *   completion
 *
 * then verifies the result against the database through the user's own
 * session — the same RLS-bound path the app uses.
 *
 * ── CELLAR SAFETY ────────────────────────────────────────────────────────
 * This test WRITES. It refuses to run unless E2E_CELLAR_ID is set AND the
 * signed-in user's cellar is exactly that cellar. It never discovers an
 * arbitrary cellar, never falls back to another, and asserts the target
 * BEFORE the import is confirmed.
 *
 * ── TEST DATA ────────────────────────────────────────────────────────────
 * Every run uses a unique marker in the producer names, so this run's wines
 * never match a previous run's — no reuse, no accumulated bottle counts, and
 * the file fingerprint differs each time. Rows are left in place: bottle
 * history is append-only and is never deleted to tidy up, consistent with the
 * other mutating specs.
 *
 * ── WHAT IS DELIBERATELY NOT TESTED HERE ─────────────────────────────────
 * Storage positions. Asserting one would mean assuming a particular layout
 * and a free slot in the shared test cellar. Position resolution is covered,
 * layout-agnostically, by the unit and planner suites.
 */

import { test, expect, devices, type Page } from "@playwright/test";
import { buildPhase11Csv } from "./fixtures/phase11-csv";

const BASE = (process.env.E2E_BASE_URL ?? "http://localhost:5173").replace(/\/+$/, "");
const EMAIL = process.env.E2E_OWNER_EMAIL?.trim();
const PASSWORD = process.env.E2E_OWNER_PASSWORD?.trim();
const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.E2E_SUPABASE_ANON_KEY ?? "";

test.use({ ...devices["iPhone 13"] });

/** Unique per run: nothing here can collide with an earlier run's rows. */
const E2E_TEST_CELLAR_ID = "9830f90a-91a2-4eb4-a063-64f61b2d724c";
const RUN = `P11-${Date.now().toString(36)}`;

/**
 * The CSV is built by a shared fixture from arrays of exactly 29 values, and
 * `phase11-fixture.test.ts` parses these EXACT bytes through the real
 * importer. Every count and message asserted below is therefore verified
 * before this spec ever runs against a database.
 */
const { csv: CSV, producers } = buildPhase11Csv(RUN);
const PRODUCER_A = producers.a;
const PRODUCER_B = producers.b;
const PRODUCER_C = producers.c;
const PRODUCER_D = producers.d;

/** Authenticated REST call using the session the app already holds. */
async function restRequest(
  page: Page,
  path: string,
): Promise<{ status: number; body: unknown }> {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error(
      "E2E_SUPABASE_URL and E2E_SUPABASE_ANON_KEY must be set — the same " +
        "public values the deployed app uses. Never a service-role key.",
    );
  }

  return page.evaluate(
    async (args: { url: string; apikey: string; path: string }) => {
      const authKey = Object.keys(localStorage).find((k) => k.startsWith("cellar_v3_auth"));
      if (!authKey) throw new Error("No Supabase session found");
      const raw = localStorage.getItem(authKey);
      if (!raw) throw new Error("Session key present but empty");
      const session = JSON.parse(raw) as { access_token?: string };
      if (!session.access_token) throw new Error("Session has no access token");

      const res = await fetch(args.url + "/rest/v1/" + args.path, {
        method: "GET",
        headers: {
          apikey: args.apikey,
          Authorization: "Bearer " + session.access_token,
        },
      });

      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { status: res.status, body };
    },
    { url: SUPABASE_URL, apikey: SUPABASE_KEY, path },
  );
}

/**
 * Refuse to proceed unless this session is inside the dedicated E2E cellar.
 *
 * Called BEFORE confirming the import. A mismatch fails the test with the
 * cellar untouched.
 */
async function assertE2eCellar(page: Page): Promise<string> {
  const expected = process.env.E2E_CELLAR_ID?.trim();
  expect(
    expected,
    "E2E_CELLAR_ID must be set before any mutating E2E test runs",
  ).toBeTruthy();

expect(
  expected,
  "E2E_CELLAR_ID is not the dedicated E2E Test Cellar — refusing to mutate",
).toBe(E2E_TEST_CELLAR_ID);

  const res = await restRequest(page, "cellar_members?select=cellar_id");
  expect(res.status, "could not read cellar membership").toBe(200);

  const ids = (res.body as { cellar_id: string }[]).map((r) => r.cellar_id);
  expect(ids.length, "owner must belong to a cellar").toBeGreaterThan(0);
  // Exact membership, never "the first one found".
  expect(
    ids.includes(expected!),
    "the signed-in user is not a member of E2E_CELLAR_ID — refusing to mutate",
  ).toBe(true);
expect(
  ids,
  "the signed-in E2E user is not a member of the dedicated E2E Test Cellar — refusing to mutate",
).toContain(expected);

  return expected!;
}

async function waitForLoaded(page: Page, heading: RegExp) {
  await expect(page.getByRole("heading", { name: heading })).toBeVisible({
    timeout: 25_000,
  });
  await expect(page.getByRole("status", { name: /loading/i })).toHaveCount(0, {
    timeout: 25_000,
  });
}

/** Wines this run created, looked up by the unique run marker. */
async function readRunWines(page: Page) {
  const res = await restRequest(
    page,
    "wine_definitions?select=id,producer,name,colour" +
      `&producer=like.${encodeURIComponent(`*${RUN}*`)}`,
  );
  expect(res.status).toBe(200);
  return res.body as { id: string; producer: string; name: string; colour: string }[];
}

async function readBottles(page: Page, wineId: string) {
  const res = await restRequest(
    page,
    `bottles?select=id,status,bottle_size&wine_definition_id=eq.${wineId}`,
  );
  expect(res.status).toBe(200);
  return res.body as { id: string; status: string; bottle_size: string }[];
}

test.describe("Phase 11 — CSV import live acceptance", () => {
  test.skip(!EMAIL || !PASSWORD, "E2E_OWNER credentials not set");

  test.beforeEach(async ({ page }) => {
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
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", install, { once: true });
      } else {
        install();
      }
    });

    await page.goto(BASE);
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.reload();

    await expect(page.getByLabel("Email")).toBeVisible({ timeout: 20_000 });
    await page.getByLabel("Email").fill(EMAIL!);
    await page.getByLabel("Password").fill(PASSWORD!);
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible({
      timeout: 25_000,
    });
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible({
  timeout: 25_000,
});

await expect
  .poll(
    () =>
      page.evaluate(() => {
        const key = Object.keys(localStorage).find((k) =>
          k.startsWith("cellar_v3_auth"),
        );
        if (!key) return false;

        const raw = localStorage.getItem(key);
        if (!raw) return false;

        try {
          const session = JSON.parse(raw) as { access_token?: string };
          return Boolean(session.access_token);
        } catch {
          return false;
        }
      }),
    { timeout: 10_000 },
  )
  .toBe(true);
  });

  test("imports a CSV through the real workflow and records it truthfully", async ({
    page,
  }) => {
    // ── Safety first: prove the target BEFORE anything can be written ──
    await assertE2eCellar(page);

    // ── Navigate as a user does ──
    await page.getByRole("link", { name: "More" }).click();
    await waitForLoaded(page, /^More$/);
    await page.getByRole("button", { name: /Import wines/ }).click();
    await waitForLoaded(page, /^Import wines$/);

    // ── Choose the file ──
    await page.getByLabel("Choose a CSV file").setInputFiles({
      name: `${RUN}.csv`,
      mimeType: "text/csv",
      buffer: Buffer.from(CSV, "utf8"),
    });

    // ── PREVIEW: the counts the user sees before any write ──
    const stat = (label: string) =>
      page.locator("li", { hasText: label }).locator("span").last();

    await expect(page.getByText("What will happen")).toBeVisible({ timeout: 20_000 });
    await expect(stat("Rows read"), "row count").toHaveText("4");
    // 2 + 1 + 1 + 2: quantity counts physical bottles, including consumed ones.
    await expect(stat("Bottles to create"), "bottle count").toHaveText("6");
    await expect(stat("Wines to create"), "four new wines").toHaveText("4");
    // Row D: created, then moved out — both bottles, not one.
    await expect(stat("Bottles leaving the cellar"), "two bottles leave").toHaveText("2");
    // Three truthful purchases, not one import-shaped acquisition.
    await expect(stat("Acquisitions to create"), "three purchases").toHaveText("3");
    await expect(stat("Rows with unknown purchase date"), "C and D").toHaveText("2");
    await expect(stat("Rows with unknown merchant"), "C and D").toHaveText("2");
    // Cost shown PER CURRENCY — never one combined figure.
    const costs = page.getByRole("list", { name: "Purchase cost by currency" });
    await expect(costs.getByText(/EUR 85\.00/), "EUR 42.50 × 2").toBeVisible();
    await expect(costs.getByText(/GBP 18\.00/), "GBP 18.00 × 1").toBeVisible();
    await expect(costs.locator("li"), "exactly one line per currency").toHaveCount(2);
    await expect(stat("Rows that cannot import"), "no blocking errors").toHaveText("0");
    // Row A's valuation only — row C's insurance value is not counted.
    await expect(stat("Valuations to record"), "one valuation").toHaveText("1");
    await expect(stat("Tastings to record"), "one tasting").toHaveText("1");

    // ── The mapping is SHOWN, not applied silently ──
    await expect(
      page.getByText(/"Sweet" will be recorded as "Dessert"/),
      "Sweet → Dessert must be visible in the preview",
    ).toBeVisible();

    // ── The unsupported valuation is REPORTED, not bent ──
    await expect(
      page.getByText(/The valuation will be skipped/),
      "insurance_value must be flagged as skipped",
    ).toBeVisible();

    // ── Confirmation is explicit ──
    const confirm = page.getByRole("button", { name: /^Import 6 bottles$/ });
    await expect(
      confirm,
      "warnings must block confirmation until acknowledged",
    ).toBeDisabled();

    await page.getByRole("checkbox").check();
    await expect(confirm).toBeEnabled();

    // Re-check the target immediately before writing.
    await assertE2eCellar(page);

    // ── SAME-ATTEMPT REPLAY: a double-click must not duplicate ──
    // Two rapid clicks on one confirmed attempt. The re-entry guard stops the
    // second at the source, and the deterministic operation ids would absorb
    // it regardless. The bottle count below proves which is irrelevant: the
    // outcome must be exactly six bottles and three acquisitions, never more.
    await confirm.dblclick();

    // ── COMPLETION ──
    await expect(page.getByRole("status", { name: "Importing" })).toHaveCount(0, {
      timeout: 60_000,
    });
    await expect(
      page.getByText("Import complete"),
      "import must complete without failed steps",
    ).toBeVisible({ timeout: 30_000 });

    // ── VERIFY THE DATA, not just the heading ──
    const wines = await readRunWines(page);
    expect(wines, "exactly four wines for this run").toHaveLength(4);

    const wineA = wines.find((w) => w.producer === PRODUCER_A)!;
    const wineB = wines.find((w) => w.producer === PRODUCER_B)!;
    const wineC = wines.find((w) => w.producer === PRODUCER_C)!;
    const wineD = wines.find((w) => w.producer === PRODUCER_D)!;
    expect(wineA && wineB && wineC && wineD, "all four wines were created").toBeTruthy();

    // UTF-8 and quoting survived the round trip.
    expect(wineA.name).toBe("Château Test, Grand Vin");
    expect(wineB.name).toBe("Rosé Doux");

    // Canonical type stored — never the workbook alias.
    expect(wineB.colour, "Sweet must be STORED as Dessert").toBe("Dessert");
    expect(wineA.colour).toBe("Red");

    // Quantity 2 → two physical rows, and the double-click added none.
    const bottlesA = await readBottles(page, wineA.id);
    expect(bottlesA, "quantity 2 must create exactly two bottle rows").toHaveLength(2);
    expect(bottlesA.every((b) => b.status === "in_cellar")).toBe(true);

    const bottlesB = await readBottles(page, wineB.id);
    expect(bottlesB).toHaveLength(1);
    expect(bottlesB[0]!.bottle_size).toBe("375ml");

    const bottlesC = await readBottles(page, wineC.id);
    expect(bottlesC, "row C's wine and bottle still import").toHaveLength(1);

    // Supported valuation, recorded once with its supplied provenance.
    const valA = await restRequest(
      page,
      `valuation_records?select=amount,currency,valuation_basis,source,valued_on` +
        `&wine_definition_id=eq.${wineA.id}`,
    );
    const valuationsA = valA.body as {
      amount: string;
      currency: string;
      valuation_basis: string;
      source: string;
      valued_on: string;
    }[];
    expect(valuationsA, "exactly one valuation — no replay duplicate").toHaveLength(1);
    expect(Number(valuationsA[0]!.amount)).toBe(75);
    expect(valuationsA[0]!.currency).toBe("GBP");
    expect(valuationsA[0]!.valuation_basis).toBe("market_estimate");
    // Provenance preserved, not overwritten with "import".
    expect(valuationsA[0]!.source).toBe("merchant");
    // The supplied historical date, not today.
    expect(valuationsA[0]!.valued_on).toBe("2025-01-15");

    // The unsupported insurance valuation was NOT silently created.
    const valC = await restRequest(
      page,
      `valuation_records?select=id&wine_definition_id=eq.${wineC.id}`,
    );
    expect(valC.body, "insurance_value must never be recorded").toHaveLength(0);

    // Tasting recorded once, with its supplied fields.
    const tasting = await restRequest(
      page,
      `tasting_records?select=rating,notes,tasted_on,context` +
        `&wine_definition_id=eq.${wineA.id}&deleted_at=is.null`,
    );
    const tastings = tasting.body as {
      rating: number;
      notes: string;
      tasted_on: string;
      context: string;
    }[];
    expect(tastings, "exactly one tasting — no replay duplicate").toHaveLength(1);
    expect(tastings[0]!.rating).toBe(4);
    expect(tastings[0]!.notes).toBe("Lovely structure");
    expect(tastings[0]!.tasted_on).toBe("2025-02-01");
    expect(tastings[0]!.context).toBe("With dinner");

    // Row B had no tasting data, so no empty tasting record exists.
    const tastingB = await restRequest(
      page,
      `tasting_records?select=id&wine_definition_id=eq.${wineB.id}`,
    );
    expect(tastingB.body, "blank tasting data must not create a record").toHaveLength(0);

    // ── Row D: consumed, quantity 2 ──
    const bottlesD = await readBottles(page, wineD.id);
    expect(bottlesD, "quantity 2 must create both physical bottles").toHaveLength(2);
    expect(
      bottlesD.every((b) => b.status === "consumed"),
      "BOTH bottles must leave the cellar, not one",
    ).toBe(true);

    // Each bottle's audit trail: added by the import, then consumed.
    for (const b of bottlesD) {
      const ev = await restRequest(
        page,
        `bottle_events?select=event_type,occurred_at,id&bottle_id=eq.${b.id}` +
          `&order=occurred_at.asc,id.asc`,
      );
      const types = (ev.body as { event_type: string }[]).map((e) => e.event_type);
      expect(types, "history must be added → consumed, once each").toEqual([
        "added",
        "consumed",
      ]);
    }

    // They are not active inventory.
    const activeD = await restRequest(
      page,
      `bottles?select=id&wine_definition_id=eq.${wineD.id}&status=eq.in_cellar`,
    );
    expect(activeD.body, "consumed bottles must not count as held").toHaveLength(0);

    // ── MULTI-ACQUISITION: each purchase recorded truthfully ──
    type Line = {
      unit_price: string | null;
      quantity: number;
      acquisition_id: string;
      acquisitions: {
        currency: string;
        purchased_on: string | null;
        source: string | null;
      };
    };
    const purchaseOf = async (wineId: string) => {
      const res = await restRequest(
        page,
        "acquisition_items?select=unit_price,quantity,acquisition_id," +
          `acquisitions(currency,purchased_on,source)&wine_definition_id=eq.${wineId}`,
      );
      const lines = res.body as Line[];
      expect(lines, "one purchase line per imported row").toHaveLength(1);
      return lines[0]!;
    };

    const pA = await purchaseOf(wineA.id);
    const pB = await purchaseOf(wineB.id);
    const pC = await purchaseOf(wineC.id);
    const pD = await purchaseOf(wineD.id);

    // EUR stays EUR, with ITS date and merchant — the GBP fallback is gone.
    expect(pA.acquisitions, "row A's purchase").toEqual({
      currency: "EUR",
      purchased_on: "2024-03-01",
      source: "Test Merchant",
    });
    expect(Number(pA.unit_price)).toBe(42.5);
    expect(pA.quantity).toBe(2);

    // GBP stays GBP, with ITS OWN, different date and merchant.
    expect(pB.acquisitions, "row B's purchase").toEqual({
      currency: "GBP",
      purchased_on: "2023-09-12",
      source: "Other Merchant",
    });
    expect(Number(pB.unit_price)).toBe(18);

    // A and B are separate acquisitions: costs are never mixed.
    expect(pA.acquisition_id, "EUR and GBP must be separate purchases").not.toBe(
      pB.acquisition_id,
    );

    // C and D had no purchase data: one unknown-provenance purchase, with
    // date and merchant NULL and no price — nothing invented to fill them.
    expect(pC.acquisition_id, "C and D share an unknown-provenance purchase").toBe(
      pD.acquisition_id,
    );
    for (const p of [pC, pD]) {
      expect(p.acquisitions.purchased_on, "unknown date stays unknown").toBeNull();
      expect(p.acquisitions.source, "unknown merchant stays unknown").toBeNull();
      expect(p.unit_price, "unknown price stays NULL, never zero").toBeNull();
    }

    // The double-click created three purchases, not six.
    const acquisitionIds = new Set([pA, pB, pC, pD].map((p) => p.acquisition_id));
    expect(acquisitionIds.size, "exactly three acquisitions for this run").toBe(3);

    // ── The imported wine is findable in the collection ──
    await page.getByRole("link", { name: "Cellar" }).click();
    await waitForLoaded(page, /^Cellar$/);
    await expect(
      page.getByText(PRODUCER_B).first(),
      "the imported Dessert wine appears in the collection",
    ).toBeVisible({ timeout: 20_000 });
  });
});
