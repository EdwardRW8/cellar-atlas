/**
 * HOSTING CONFIGURATION IS CODE, AND IT FAILS QUIETLY.
 *
 * `netlify.toml` carried the security headers and the SPA redirect. 12.4
 * moves to Cloudflare Pages, and the risk in that move is not that something
 * errors — it is that everything appears to work while a header is silently
 * absent, or while deep links 404 for everyone except whoever tested the
 * front page.
 *
 * So each header is asserted, and the one Cloudflare-specific trap — a
 * top-level 404.html switching Pages out of single-page-app mode — is pinned
 * as a hard failure rather than left as a line in a document.
 *
 * `_headers` is only read by the host, so these are static assertions. They
 * cannot prove the deployed response; `docs/deployment.md` carries the `curl`
 * check for that, and the four-state honesty in docs/disaster-recovery.md
 * applies here too: configured is not verified.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const HEADERS_PATH = "public/_headers";
const headers = readFileSync(HEADERS_PATH, "utf8");

/** The file without its `#` commentary, so prose cannot satisfy an assertion. */
const directives = headers
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("#"))
  .join("\n");

describe("public/_headers carries every header netlify.toml used to set", () => {
  it.each([
    ["X-Frame-Options", /^\s*X-Frame-Options:\s*DENY\s*$/im],
    ["X-Content-Type-Options", /^\s*X-Content-Type-Options:\s*nosniff\s*$/im],
    ["Referrer-Policy", /^\s*Referrer-Policy:\s*strict-origin-when-cross-origin\s*$/im],
  ])("sets %s", (_name, pattern) => {
    expect(directives).toMatch(pattern);
  });

  it("applies those to every path, not just the root", () => {
    // The rule they live under must be the catch-all.
    const firstRule = directives.split(/\n(?=\S)/).find((b) => b.trim().startsWith("/*"));
    expect(firstRule, "no /* rule found").toBeTruthy();
    expect(firstRule!).toMatch(/X-Frame-Options/);
    expect(firstRule!).toMatch(/X-Content-Type-Options/);
    expect(firstRule!).toMatch(/Referrer-Policy/);
  });

  it("caches fingerprinted assets immutably for a year", () => {
    const assetRule = directives
      .split(/\n(?=\S)/)
      .find((b) => b.trim().startsWith("/assets/*"));
    expect(assetRule, "no /assets/* rule found").toBeTruthy();
    expect(assetRule!).toMatch(/Cache-Control:\s*public,\s*max-age=31536000,\s*immutable/i);
  });

  /**
   * Setting the same header under two matching rules makes the result depend
   * on match order. One Cache-Control rule, scoped to hashed assets, is
   * unambiguous; an HTML rule would not be.
   */
  it("sets Cache-Control exactly once, so no rule can override another", () => {
    const occurrences = directives.match(/Cache-Control:/gi) ?? [];
    expect(occurrences.length).toBe(1);
  });
});

describe("the CSP ships report-only, and admits what the app really loads", () => {
  it("is report-only — an enforced policy that is wrong breaks sign-in", () => {
    expect(directives).toMatch(/Content-Security-Policy-Report-Only:/);
    // No enforcing header yet. Promoting it is a later, deliberate gate.
    expect(directives).not.toMatch(/^\s*Content-Security-Policy:/im);
  });

  it("sends no violation reports to a third party", () => {
    expect(directives).not.toMatch(/report-uri|report-to/i);
  });

  it.each([
    ["Supabase REST and auth", /connect-src[^;]*https:\/\/\*\.supabase\.co/],
    [
      "the Google Fonts stylesheet global.css imports",
      /style-src[^;]*fonts\.googleapis\.com/,
    ],
    ["the font files that stylesheet references", /font-src[^;]*fonts\.gstatic\.com/],
    ["inline SVG data URIs", /img-src[^;]*data:/],
    ["framing denied, in the form browsers honour", /frame-ancestors 'none'/],
  ])("allows %s", (_label, pattern) => {
    expect(directives).toMatch(pattern);
  });

  /**
   * The built index.html has no inline script, so the policy must not weaken
   * script-src. 'unsafe-inline' or 'unsafe-eval' here would make the CSP
   * close to decorative.
   */
  it("never weakens script-src", () => {
    const csp = /Content-Security-Policy-Report-Only:(.*)/.exec(directives)?.[1] ?? "";
    expect(csp).toMatch(/script-src 'self'/);
    expect(csp).not.toMatch(/unsafe-inline/);
    expect(csp).not.toMatch(/unsafe-eval/);
  });

  it("the CSP's font and style sources match what the CSS actually imports", () => {
    // If the stylesheet stops importing Google Fonts, or starts importing
    // something else, this is where the mismatch surfaces.
    const css = readFileSync("src/styles/global.css", "utf8");
    const imported = [...css.matchAll(/url\(['"]?(https:\/\/[^'")]+)/g)].map((m) => m[1]!);
    for (const url of imported) {
      const host = new URL(url).host;
      expect(directives, `${host} is imported by CSS but absent from the CSP`).toContain(
        host,
      );
    }
  });
});

describe("Netlify is fully gone", () => {
  it("netlify.toml is deleted", () => {
    expect(existsSync("netlify.toml")).toBe(false);
  });

  it("no source file mentions Netlify", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx|css)$/.test(entry.name)) {
          if (/netlify/i.test(readFileSync(full, "utf8"))) offenders.push(full);
        }
      }
    };
    walk("src");
    expect(offenders).toEqual([]);
  });

  /**
   * The user-visible one. This message appears in front of someone looking at
   * an app that will not load; naming the wrong provider sends whoever is
   * fixing it to the wrong dashboard.
   */
  it("the runtime configuration error names no provider at all", () => {
    const client = readFileSync("src/data/supabase-client.ts", "utf8");
    const message = /missingConfigMessage =([\s\S]*?);/.exec(client)?.[1] ?? "";
    expect(message).toMatch(/VITE_SUPABASE_URL/);
    expect(message).toMatch(/VITE_SUPABASE_PUBLISHABLE_KEY/);
    for (const host of ["Netlify", "Cloudflare", "Vercel"]) {
      expect(message, `names ${host}`).not.toContain(host);
    }
  });
});

describe("deep links cannot be broken silently", () => {
  /**
   * THE TRAP THIS GATE EXISTS TO PREVENT.
   *
   * Cloudflare Pages serves `/` for any unmatched path — treating the project
   * as a single-page app — ONLY while there is no top-level 404.html. Adding
   * one switches that off, and every deep link starts returning the 404 page.
   * The front page keeps working, so nobody notices until a bookmark or an
   * emailed link fails.
   *
   * netlify.toml used to make this explicit with a `/* → /index.html 200`
   * redirect. On Pages the behaviour is a default, which means it can be lost
   * by ADDING a file rather than by removing one — much easier to do by
   * accident, and the reason this is a test and not a note.
   */
  it("no top-level 404.html exists to disable single-page-app fallback", () => {
    expect(existsSync("public/404.html"), "public/404.html disables SPA routing").toBe(
      false,
    );
    expect(existsSync("404.html")).toBe(false);
  });

  it("deployment.md records why, so the next person does not add one", () => {
    const docs = readFileSync("docs/deployment.md", "utf8");
    expect(docs).toMatch(/404\.html/);
    expect(docs).toMatch(/single-page/i);
  });
});

describe("the deployment documentation is usable without guessing", () => {
  const docs = readFileSync("docs/deployment.md", "utf8");

  it("gives the Cloudflare build command, output directory and Node version", () => {
    expect(docs).toMatch(/npm run build/);
    expect(docs).toMatch(/\bdist\b/);
    expect(docs).toMatch(/NODE_VERSION/);
  });

  it("names the environment variables without ever showing a value", () => {
    expect(docs).toMatch(/VITE_SUPABASE_URL/);
    expect(docs).toMatch(/VITE_SUPABASE_PUBLISHABLE_KEY/);
    // A real Supabase URL or a JWT would mean a credential in the repository.
    expect(docs).not.toMatch(/https:\/\/[a-z0-9]{20}\.supabase\.co/);
    expect(docs).not.toMatch(/eyJ[A-Za-z0-9_-]{20}/);
  });

  it("carries the post-deployment curl check, since a static file cannot prove a response", () => {
    expect(docs).toMatch(/curl -sI/);
  });
});
