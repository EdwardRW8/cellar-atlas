/**
 * INTERACTIVE RACK — LIVE ACCEPTANCE
 *
 * Additive. Every existing Phase 3/4 assertion is untouched.
 *
 * ── WHY THIS DOES NOT READ THE SCREEN ────────────────────────────────────
 * The first version found a rack by matching button text against
 * /staircase|grid|shelving|fridge/i. That was wrong twice over:
 *
 *   1. The storage list renders the location NAME, its occupancy label and
 *      its KIND (home / merchant / fridge / other). `kind` is not
 *      `layoutType` — a grid rack with kind "home" contains none of those
 *      words, so it was never found.
 *
 *   2. Even a correct match could open an EMPTY location. The rack only
 *      renders when the location holds at least one live bottle
 *      (`view === "rack" && contents.length > 0`), so an empty positioned
 *      location shows the empty state and every assertion would fail.
 *
 * The location is therefore discovered from real data over the authenticated
 * REST path — the same JWT the app uses — and opened by id. That reflects
 * actual app state rather than inferring it from pixels.
 *
 * Requires E2E_OWNER credentials plus E2E_SUPABASE_URL and
 * E2E_SUPABASE_ANON_KEY. Never a service-role key.
 */

import { test, expect, devices, type Page } from "@playwright/test";

/**
 * Trailing slashes are stripped BEFORE any route is appended.
 *
 * `E2E_BASE_URL="https://site.netlify.app/"` would otherwise produce
 * `https://site.netlify.app//storage/<id>`, which does not resolve. This is
 * the only spec that concatenates a route onto BASE; the others call
 * `page.goto(BASE)` directly and are unaffected.
 *
 * Guarded in tests/harness/serialization.spec.ts — it has been lost twice.
 */
const BASE = (process.env.E2E_BASE_URL ?? "http://localhost:5173").replace(/\/+$/, "");
const EMAIL = process.env.E2E_OWNER_EMAIL?.trim();
const PASSWORD = process.env.E2E_OWNER_PASSWORD?.trim();
const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.E2E_SUPABASE_ANON_KEY ?? "";

/** The layout types that actually have slots. Must match the domain. */
const POSITIONED_TYPES = ["staircase", "grid", "shelving", "fridge"];

test.use({ ...devices["iPhone 13"] });

/**
 * Authenticated REST call using the session the app already holds.
 *
 * Nothing from Node scope is referenced inside the browser callback, or
 * Playwright cannot serialise it.
 */
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
        headers: {
          apikey: args.apikey,
          Authorization: "Bearer " + session.access_token,
          "Content-Type": "application/json",
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

interface LocationRow {
  id: string;
  name: string;
  storage_layouts: { type: string } | null;
  bottles: { id: string; status: string }[] | null;
}

/**
 * A positioned location that actually holds bottles, or null.
 *
 * Selection is by `storage_layouts.type`, never by anything rendered.
 */
async function findRackLocation(page: Page): Promise<LocationRow | null> {
  const res = await restRequest(
    page,
    "storage_locations" +
      "?select=id,name,storage_layouts(type),bottles(id,status)" +
      "&deleted_at=is.null",
  );

  if (res.status !== 200 || !Array.isArray(res.body)) return null;

  const usable = (res.body as LocationRow[]).filter((l) => {
    const type = l.storage_layouts?.type;
    if (!type || !POSITIONED_TYPES.includes(type)) return false;
    // The rack only renders when the location holds a live bottle.
    return (l.bottles ?? []).some((b) => b.status === "in_cellar");
  });

  return usable[0] ?? null;
}

test.describe("interactive rack", () => {
  test.skip(!EMAIL || !PASSWORD, "E2E_OWNER credentials not set");

  test.beforeEach(async ({ page }) => {
    // Netlify's badge iframe sits over the bottom-right controls.
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
  });

  /**
   * Open a rack, or skip with a reason that says which condition failed.
   * Returns the rack locator once it is on screen.
   */
  async function openRack(page: Page) {
    const location = await findRackLocation(page);
    test.skip(
      location === null,
      "No positioned storage location holding a live bottle exists in this cellar",
    );

    await page.goto(`${BASE}/storage/${location!.id}`);
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible({
      timeout: 20_000,
    });

    // The Rack toggle only appears for a positioned location.
    await expect(
      page.getByRole("button", { name: "Rack", exact: true }),
      `${location!.name} should offer a rack view`,
    ).toBeVisible({ timeout: 20_000 });

    const rack = page.getByRole("group", { name: /interactive rack/i });
    await expect(rack).toBeVisible({ timeout: 20_000 });
    return rack;
  }

  test("a positioned location offers a visual rack", async ({ page }) => {
    const rack = await openRack(page);
    // Slots are drawn, not merely a container.
    await expect(rack.locator("rect, polygon").first()).toBeVisible();
    const slots = await rack.locator("rect, polygon").count();
    expect(slots).toBeGreaterThan(0);
  });

  test("the rack does not introduce horizontal page scroll at 390px", async ({ page }) => {
    await openRack(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("dragging changes the rack orientation", async ({ page }) => {
    const rack = await openRack(page);

    /**
     * Capture EVERY slot's geometry.
     *
     * Rotation is applied per slot, and a slot's displacement is proportional
     * to its distance from the rotation axis:
     *
     *   x = centreX + offsetFromAxis * cos(angle) - width / 2
     *   y = slot.y  + offsetFromAxis * sin(angle) * 0.14
     *
     * A slot sitting on or near the axis has `offsetFromAxis` close to zero
     * and legitimately barely moves. Comparing only the first slot could
     * therefore report "no rotation" when the rack had in fact turned — which
     * is exactly what happened. Both `x` and `y` are captured, and `points`
     * too, because a chamfered staircase slot is a <polygon> with no `x`.
     */
    const geometry = () =>
      rack.evaluate((svg) =>
        [...svg.querySelectorAll("rect, polygon")].map((el) =>
          [
            el.getAttribute("x") ?? "",
            el.getAttribute("y") ?? "",
            el.getAttribute("points") ?? "",
          ].join("|"),
        ),
      );

    const faceOn = page.getByRole("button", { name: /face on/i });

    // At rotation 0 the reset control is disabled. This is the app's own
    // signal for "not rotated", so it proves React state, not just pixels.
    await expect(faceOn, "Face on should start disabled at rotation 0").toBeDisabled();

    const before = await geometry();
    expect(before.length, "the rack should have drawn slots").toBeGreaterThan(0);

    // ── Real pointer interaction ─────────────────────────────────────────
    // The drag must happen INSIDE the viewport. A tall rack's midpoint can
    // sit below the fold, which would put the pointer outside the element.
    await rack.scrollIntoViewIfNeeded();
    const box = await rack.boundingBox();
    expect(box, "the rack should have a bounding box").toBeTruthy();

    const viewport = page.viewportSize();
    expect(viewport).toBeTruthy();

    const startX = box!.x + Math.min(box!.width * 0.5, viewport!.width * 0.5);
    const startY = Math.min(box!.y + box!.height / 2, viewport!.height - 80);

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // Past the 4px slop first, then a decisive rotation.
    await page.mouse.move(startX + 12, startY, { steps: 2 });
    await page.mouse.move(startX + 120, startY, { steps: 12 });
    await page.mouse.up();

    // ── 1. React rotation state changed ──────────────────────────────────
    await expect(
      faceOn,
      "Face on should become enabled once the rack has rotated",
    ).toBeEnabled({ timeout: 5_000 });

    // ── 2. Rendered geometry changed ─────────────────────────────────────
    const after = await geometry();
    expect(after.length, "slot count should not change under rotation").toBe(before.length);

    const changed = after.filter((g, i) => g !== before[i]).length;
    expect(
      changed,
      "at least one slot should have moved — rotation is per slot, so slots " +
        "near the axis may legitimately stay put",
    ).toBeGreaterThan(0);

    // ── 3. Rotation must not have widened the page ───────────────────────
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("Face on restores the unrotated view", async ({ page }) => {
    const rack = await openRack(page);
    const faceOn = page.getByRole("button", { name: /face on/i });

    const geometry = () =>
      rack.evaluate((svg) =>
        [...svg.querySelectorAll("rect, polygon")].map((el) =>
          [
            el.getAttribute("x") ?? "",
            el.getAttribute("y") ?? "",
            el.getAttribute("points") ?? "",
          ].join("|"),
        ),
      );

    const original = await geometry();

    await rack.scrollIntoViewIfNeeded();
    const box = await rack.boundingBox();
    const viewport = page.viewportSize();
    const startX = box!.x + Math.min(box!.width * 0.5, viewport!.width * 0.5);
    const startY = Math.min(box!.y + box!.height / 2, viewport!.height - 80);

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 12, startY, { steps: 2 });
    await page.mouse.move(startX + 120, startY, { steps: 12 });
    await page.mouse.up();

    await expect(faceOn).toBeEnabled({ timeout: 5_000 });
    await faceOn.click();

    await expect(faceOn).toBeDisabled({ timeout: 5_000 });
    expect(await geometry()).toEqual(original);
  });

  test("Face on is genuinely tappable, not overlapped by fixed UI", async ({ page }) => {
    const rack = await openRack(page);
    const faceOn = page.getByRole("button", { name: /face on/i });

    // Rotate first so the control is enabled and a real click is meaningful.
    await rack.scrollIntoViewIfNeeded();
    const rackBox = await rack.boundingBox();
    const vp = page.viewportSize();
    const sx = rackBox!.x + Math.min(rackBox!.width * 0.5, vp!.width * 0.5);
    const sy = Math.min(rackBox!.y + rackBox!.height / 2, vp!.height - 80);
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 12, sy, { steps: 2 });
    await page.mouse.move(sx + 120, sy, { steps: 12 });
    await page.mouse.up();
    await expect(faceOn).toBeEnabled({ timeout: 5_000 });

    await faceOn.scrollIntoViewIfNeeded();
    await expect(faceOn).toBeVisible();

    // Whatever sits at the control's centre must be the control itself.
    // The Add Wine button and the bottom navigation both float above the
    // content, so this is what caught the overlap.
    const box = await faceOn.boundingBox();
    expect(box, "Face on should have a bounding box").toBeTruthy();
    expect(box!.height).toBeGreaterThanOrEqual(44);

    const topmost = await page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        if (!el) return null;
        const owner = el.closest("button");
        return {
          label: owner?.getAttribute("aria-label") ?? null,
          text: owner?.textContent?.trim() ?? el.textContent?.trim() ?? "",
        };
      },
      { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
    );

    expect(topmost, "something should be at that point").toBeTruthy();
    expect(topmost!.label, "the Add Wine button must not cover Face on").not.toBe(
      "Add wine",
    );
    expect(topmost!.text.toLowerCase()).toContain("face on");

    // And it must actually click, without force.
    await faceOn.click();
    await expect(faceOn).toBeDisabled();
  });

  test("switching to the list view still works", async ({ page }) => {
    await openRack(page);
    await page.getByRole("button", { name: "List", exact: true }).click();
    await expect(page.getByRole("group", { name: /interactive rack/i })).toHaveCount(0);
  });
});
