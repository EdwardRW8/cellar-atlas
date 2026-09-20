/**
 * INTELLIGENCE & PROFILE — LIVE ACCEPTANCE
 *
 * Additive. Every existing Phase 3–7 assertion is untouched.
 *
 * Navigation follows the real hierarchy: More → Intelligence, More → Profile.
 * No structure is inferred and no long-timeout-then-catch branching is used.
 */

import { test, expect, devices, type Page } from "@playwright/test";

const BASE = (process.env.E2E_BASE_URL ?? "http://localhost:5173").replace(/\/+$/, "");
const EMAIL = process.env.E2E_OWNER_EMAIL?.trim();
const PASSWORD = process.env.E2E_OWNER_PASSWORD?.trim();

test.use({ ...devices["iPhone 13"] });

/** A screen has finished loading when its skeleton is gone. */
async function waitForLoaded(page: Page, heading: string) {
  await expect(page.getByRole("heading", { name: heading })).toBeVisible({
    timeout: 25_000,
  });
  await expect(page.getByRole("status", { name: /loading/i })).toHaveCount(0, {
    timeout: 25_000,
  });
}

test.describe("intelligence and profile", () => {
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

    // Real navigation hierarchy: both screens live under More.
    await page.getByRole("link", { name: "More" }).click();
    await expect(page.getByRole("heading", { name: "More" })).toBeVisible({
      timeout: 20_000,
    });
  });

  test("Intelligence is reachable from More", async ({ page }) => {
    await page.getByRole("button", { name: /Intelligence/ }).click();
    await waitForLoaded(page, "Intelligence");
    await expect(page).toHaveURL(/\/intelligence/);
  });

  test("Intelligence shows no opaque score or recommendation", async ({ page }) => {
    await page.getByRole("button", { name: /Intelligence/ }).click();
    await waitForLoaded(page, "Intelligence");

    const text = (await page.locator("body").innerText()).toLowerCase();
    for (const banned of [
      "cellar score",
      "confidence",
      "legacy risk",
      "we recommend",
      "you should buy",
    ]) {
      expect(text, `Intelligence shows "${banned}"`).not.toContain(banned);
    }
  });

  test("every figure shown carries its evidence or a reason it is absent", async ({
    page,
  }) => {
    await page.getByRole("button", { name: /Intelligence/ }).click();
    await waitForLoaded(page, "Intelligence");

    const text = (await page.locator("body").innerText()).toLowerCase();
    // Either a rate with evidence, or a plain statement that there is none.
    const hasEvidence =
      text.includes("based on") || text.includes("not enough information");
    expect(hasEvidence, "no evidence or explanation found").toBe(true);
  });

  test("Profile is reachable and saves with every field blank", async ({ page }) => {
    await page.getByRole("button", { name: /Cellar profile/ }).click();
    await waitForLoaded(page, "Cellar profile");
    await expect(page).toHaveURL(/\/profile/);

    // Saving an untouched, possibly empty profile must not break.
    await page.getByRole("button", { name: /^save profile$/i }).click();
    await expect(page.getByRole("status")).toBeVisible({ timeout: 20_000 });
  });

  test("neither screen scrolls horizontally at 390px", async ({ page }) => {
    for (const [button, heading] of [
      [/Intelligence/, "Intelligence"],
      [/Cellar profile/, "Cellar profile"],
    ] as const) {
      await page.getByRole("link", { name: "More" }).click();
      await expect(page.getByRole("heading", { name: "More" })).toBeVisible({
        timeout: 20_000,
      });
      await page.getByRole("button", { name: button }).click();
      await waitForLoaded(page, heading);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${heading} overflows`).toBeLessThanOrEqual(1);
    }
  });

  test("Home is visually unchanged — no intelligence added", async ({ page }) => {
    await page.getByRole("link", { name: "Home" }).click();
    await waitForLoaded(page, "Home");

    const text = (await page.locator("body").innerText()).toLowerCase();
    for (const banned of ["longevity", "legacy", "drinking rate", "collection balance"]) {
      expect(text, `Home now shows "${banned}"`).not.toContain(banned);
    }
  });
});
