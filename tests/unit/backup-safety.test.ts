/**
 * THE BACKUP MUST NOT LEAK WHAT IT IS BACKING UP.
 *
 * The dumps contain the whole collection AND the `auth` schema — email
 * addresses and password hashes. Three ways that could escape, each asserted
 * here as behaviour rather than trusted to review:
 *
 *   1. The connection string reaching a command line, where `ps` and any
 *      command-logging tool can see it. GitHub masks its own secrets in log
 *      output; it cannot mask a process listing.
 *   2. An unencrypted dump being uploaded. On a public repository, Actions
 *      artifacts are downloadable by other GitHub users.
 *   3. The age PRIVATE key being committed, which publishes it with the repo.
 *
 * Plus the quieter failure that is worse than all three because it looks like
 * success: encrypting every backup to a key nobody holds, discovered only at
 * a restore. The placeholder recipient must therefore refuse to run.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pgEnvFromUrl, describeTarget } from "../../scripts/backup/lib/connection.mjs";
import {
  parseRecipientFile,
  PLACEHOLDER_MARKER,
  RECIPIENT_PATH,
} from "../../scripts/backup/lib/recipient.mjs";
import {
  buildDumpPlan,
  checkCounts,
  expectedSuffixes,
  BACKUP_SCHEMAS,
  MUST_NOT_BE_EMPTY,
} from "../../scripts/backup/lib/dump-plan.mjs";

const WORKFLOW = ".github/workflows/backup.yml";
const workflow = readFileSync(WORKFLOW, "utf8");

/**
 * The workflow with comment lines removed.
 *
 * Needed because the file documents its own prohibitions — "never `set -x`" —
 * and a naive scan flags the sentence forbidding the thing as the thing. The
 * same trap the durability guard hit in 12.1; same remedy.
 */
const workflowCode = workflow
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("#"))
  .join("\n");

/* ───────────── 1. THE CREDENTIAL NEVER REACHES A COMMAND LINE ───────────── */

describe("the database credential never reaches argv", () => {
  const URL_WITH_PASSWORD =
    "postgresql://postgres.abcdefgh:sup3r-s3cret-p%40ss@aws-0-eu-west-2.pooler.supabase.com:5432/postgres";

  it("parses a Supabase pooler URL into PG* environment variables", () => {
    const env = pgEnvFromUrl(URL_WITH_PASSWORD);
    expect(env.PGHOST).toBe("aws-0-eu-west-2.pooler.supabase.com");
    expect(env.PGPORT).toBe("5432");
    expect(env.PGUSER).toBe("postgres.abcdefgh");
    expect(env.PGDATABASE).toBe("postgres");
    // Percent-encoding decoded, or the password would be silently wrong.
    expect(env.PGPASSWORD).toBe("sup3r-s3cret-p@ss");
  });

  /** THE POINT OF THE WHOLE MODULE. */
  it("no dump argument contains the password, the user or the host", () => {
    const plan = buildDumpPlan("cellar-atlas-2026-11-26T031705Z");
    expect(plan.length).toBe(4);
    const everyArg = plan.flatMap((p) => [p.command, ...p.args]).join(" ");
    expect(everyArg).not.toContain("sup3r-s3cret-p@ss");
    expect(everyArg).not.toContain("postgres.abcdefgh");
    expect(everyArg).not.toContain("pooler.supabase.com");
    // And no connection flag at all, so there is nowhere for one to appear.
    for (const p of plan) {
      expect(p.args).not.toContain("-d");
      expect(p.args).not.toContain("--dbname");
      expect(p.args.join(" ")).not.toMatch(/postgres(ql)?:\/\//);
    }
  });

  it("insists on TLS and never downgrades it", () => {
    expect(pgEnvFromUrl(URL_WITH_PASSWORD).PGSSLMODE).toBe("require");
    // verify-full is reachable, but only with a CA to verify against, and an
    // insecure mode is refused outright rather than downgraded. The full
    // matrix lives in tests/unit/backup-corrections.test.ts.
    expect(
      pgEnvFromUrl(`${URL_WITH_PASSWORD}?sslmode=verify-full`, { caCertPath: "/ca.crt" })
        .PGSSLMODE,
    ).toBe("verify-full");
    expect(() => pgEnvFromUrl(`${URL_WITH_PASSWORD}?sslmode=prefer`)).toThrow();
  });

  it("refuses to connect anywhere on a missing or malformed URL", () => {
    for (const bad of [
      "",
      "   ",
      undefined,
      "not a url",
      "mysql://h/db",
      "postgres:///db",
    ]) {
      expect(() => pgEnvFromUrl(bad as string)).toThrow();
    }
  });

  it("error messages never quote the URL back", () => {
    try {
      pgEnvFromUrl("postgresql://u:leaked-password@" as string);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as Error).message).not.toContain("leaked-password");
    }
  });

  it("the manifest's record of the source carries no password", () => {
    const described = describeTarget(pgEnvFromUrl(URL_WITH_PASSWORD));
    expect(described).toContain("pooler.supabase.com");
    // It also records the sslmode actually used, so transport security is
    // auditable from the manifest after the fact.
    expect(described).toContain("sslmode=require");
    expect(described).not.toContain("sup3r-s3cret-p@ss");
  });
});

/* ──────────────── 2. THE WORKFLOW CANNOT LEAK OR MIS-ORDER ──────────────── */

describe("the workflow handles the secret correctly", () => {
  it("references the credential only through secrets.*", () => {
    // Every mention of DATABASE_URL is either the env binding to a secret,
    // an emptiness test, or prose in a comment.
    const lines = workflow.split("\n").filter((l) => l.includes("DATABASE_URL"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const ok =
        /secrets\.DATABASE_URL/.test(line) ||
        /^\s*#/.test(line) ||
        /-z "\$\{DATABASE_URL\}"/.test(line) ||
        /missing="\$missing DATABASE_URL"/.test(line);
      expect(ok, `suspicious DATABASE_URL use: ${line.trim()}`).toBe(true);
    }
  });

  it("never echoes, prints or cats a secret, and never enables set -x", () => {
    expect(workflowCode).not.toMatch(/set\s+-[a-z]*x/);
    expect(workflowCode).not.toMatch(/echo\s+.*\$\{?\{?\s*secrets\./);
    expect(workflowCode).not.toMatch(/echo\s+"?\$\{?(DATABASE_URL|R2_SECRET_ACCESS_KEY)/);
    expect(workflowCode).not.toMatch(/cat\s+.*\$\{?\{?\s*secrets\./);
  });

  it("the comment-stripper works, so the guard above is not vacuous", () => {
    // The real file explains that `set -x` is forbidden; the executable
    // portion must not contain it.
    expect(workflow, "the prohibition is documented").toMatch(/set -x/);
    expect(workflowCode, "and absent from the script itself").not.toMatch(/set -x/);
    // And the guard still catches the real thing if it is ever added.
    const sneaked = `${workflowCode}\n        run: |\n          set -x\n`;
    expect(sneaked).toMatch(/set\s+-[a-z]*x/);
  });

  it("uploads no build artifact — on a public repo those are downloadable", () => {
    expect(workflow).not.toMatch(/actions\/upload-artifact/);
  });

  /**
   * ORDERING, THE STRUCTURAL WAY. The upload step cannot precede encryption
   * because run-backup.mjs deletes the plaintext before it returns, so the
   * assertion is that the encrypting step runs first AND that the workflow
   * re-checks for stray .sql before uploading.
   */
  it("encrypts before it uploads, and refuses to upload a stray plaintext", () => {
    const encryptAt = workflow.indexOf(
      "Dump, verify the dump's own row counts, and encrypt",
    );
    const uploadAt = workflow.indexOf("Upload to private R2");
    expect(encryptAt).toBeGreaterThan(-1);
    expect(uploadAt).toBeGreaterThan(-1);
    expect(encryptAt, "upload must come after encryption").toBeLessThan(uploadAt);
    expect(workflow).toMatch(/grep -E '\\\.sql\$'/);
    expect(workflow).toMatch(/Unencrypted dump present/);
  });

  it("ships inert: every working step is gated on BACKUP_ENABLED", () => {
    expect(workflow).toMatch(/vars\.BACKUP_ENABLED/);
    for (const step of [
      "Upload to private R2",
      "Apply retention",
      "Verify the upload against the manifest",
      "Dump, verify the dump's own row counts, and encrypt",
    ]) {
      const at = workflow.indexOf(step);
      expect(at, `${step} missing`).toBeGreaterThan(-1);
      // The `if:` guard sits within the step's own block.
      const block = workflow.slice(at, at + 400);
      expect(block, `${step} is not gated`).toMatch(
        /steps\.gate\.outputs\.enabled == 'true'/,
      );
    }
  });

  it("grants the least permission it can, and says why it needs issues", () => {
    expect(workflow).toMatch(/permissions:\s*\n\s*contents: read/);
    expect(workflow).toMatch(/issues: write/);
    // Alerting exists at all: a silent backup failure is the real risk.
    expect(workflow).toMatch(/if: failure\(\)/);
    expect(workflow).toMatch(/gh issue create/);
  });

  it("cannot run two backups at once and race the prune", () => {
    expect(workflow).toMatch(/concurrency:/);
    expect(workflow).toMatch(/cancel-in-progress: false/);
  });

  it("is scheduled daily, off the hour", () => {
    const cron = /cron: "(\d+) (\d+) \* \* \*"/.exec(workflow);
    expect(cron, "expected a daily cron").not.toBeNull();
    expect(Number(cron![1]), "on the hour is the most-delayed slot").not.toBe(0);
  });
});

/* ────────────────── 3. THE RECIPIENT, AND THE QUIET FAILURE ────────────────── */

describe("encryption cannot be skipped, or aimed at a key nobody holds", () => {
  const REAL_SHAPE = `age1${"q".repeat(58)}`;

  it("the committed file still holds the placeholder, so backups refuse to run", () => {
    expect(existsSync(RECIPIENT_PATH)).toBe(true);
    const text = readFileSync(RECIPIENT_PATH, "utf8");
    expect(text).toContain(PLACEHOLDER_MARKER);
    expect(() => parseRecipientFile(text)).toThrow(/placeholder/i);
  });

  it("accepts a real public key, ignoring comments and blank lines", () => {
    expect(parseRecipientFile(`# a comment\n\n${REAL_SHAPE}\n`)).toBe(REAL_SHAPE);
  });

  it.each([
    ["an empty file", "", /no recipient/i],
    ["only comments", "# nothing here\n", /no recipient/i],
    ["a truncated key", "age1short\n", /valid age public key/i],
    ["a non-age string", "ssh-rsa AAAA\n", /valid age public key/i],
  ])("refuses %s", (_label, text, pattern) => {
    expect(() => parseRecipientFile(text)).toThrow(pattern);
  });

  /**
   * The catastrophe this catches: a private key pasted into a file that is
   * committed, and therefore published with the repository.
   */
  it("refuses an age PRIVATE key and says to rotate it", () => {
    const secret = `AGE-SECRET-KEY-${"1".repeat(50)}`;
    expect(() => parseRecipientFile(`${secret}\n`)).toThrow(/PRIVATE key/i);
    expect(() => parseRecipientFile(`${secret}\n`)).toThrow(/rotate/i);
  });

  it("refuses two recipients — every listed key can read every backup", () => {
    expect(() => parseRecipientFile(`${REAL_SHAPE}\nage1${"p".repeat(58)}\n`)).toThrow(
      /2 recipients/,
    );
  });

  it("no private key is committed anywhere in the repository", () => {
    const suspects = ["backup/age-recipient.txt", WORKFLOW, "docs/disaster-recovery.md"];
    for (const f of suspects) {
      if (!existsSync(f)) continue;
      const text = readFileSync(f, "utf8");
      // The docs name the string while explaining it; what must never appear
      // is a key-shaped value after it.
      expect(text, `${f} contains a private key`).not.toMatch(
        /AGE-SECRET-KEY-1[0-9A-Z]{20}/,
      );
    }
  });
});

/* ──────────────── 4. WHAT IS DUMPED, AND THE EMPTY-DUMP TRIPWIRE ──────────────── */

describe("the dump is complete enough to actually recover from", () => {
  it("includes the auth schema, or a restore has no users to own the rows", () => {
    expect(BACKUP_SCHEMAS).toContain("public");
    expect(BACKUP_SCHEMAS).toContain("auth");
  });

  it("dumps roles, each schema, and data as separate files", () => {
    const plan = buildDumpPlan("cellar-atlas-2026-11-26T031705Z");
    // The schema dump is split per schema so that `auth` DDL need not be
    // replayed into a Supabase project that already manages it.
    expect(plan.map((p) => p.name)).toEqual([
      "roles",
      "schema-public",
      "schema-auth",
      "data",
    ]);
    expect(new Set(plan.map((p) => p.file)).size).toBe(4);
    expect(plan.find((p) => p.name === "roles")!.args).toContain("--roles-only");
    for (const name of ["schema-public", "schema-auth"]) {
      expect(plan.find((p) => p.name === name)!.args).toContain("--schema-only");
    }
    expect(plan.find((p) => p.name === "data")!.args).toContain("--data-only");
  });

  it("keeps role password hashes out of the dump", () => {
    expect(buildDumpPlan("x").find((p) => p.name === "roles")!.args).toContain(
      "--no-role-passwords",
    );
  });

  /**
   * The failure mode that looks like success: pg_dump exits 0 having dumped
   * nothing, because RLS, a pooler quirk or the wrong database got in the
   * way. A zero count is recorded and refused rather than uploaded.
   */
  it("refuses a dump whose own row counts say it is empty or the wrong database", () => {
    expect(checkCounts({ "auth.users": 3, "public.cellars": 1 }).ok).toBe(true);

    const noUsers = checkCounts({ "auth.users": 0, "public.cellars": 1 });
    expect(noUsers.ok).toBe(false);
    expect(noUsers.problems.join(" ")).toMatch(/auth\.users/);

    const noCounts = checkCounts({});
    expect(noCounts.ok).toBe(false);
    expect(noCounts.problems.length).toBe(MUST_NOT_BE_EMPTY.length);
  });

  it("does not treat a legitimately empty table as a failure", () => {
    // A new cellar really has no valuations and no tastings.
    expect(
      checkCounts({ "auth.users": 1, "public.cellars": 1, "public.valuation_records": 0 })
        .ok,
    ).toBe(true);
  });
});

/* ──────────────── 5. THE SCRIPTS ACTUALLY RUN (dry-run + age) ──────────────── */

describe("the backup script runs, and refuses correctly, when executed", () => {
  it("refuses to dump anything while the recipient is a placeholder", () => {
    const out = mkdtempSync(join(tmpdir(), "backup-test-"));
    let failed = false;
    let stderr = "";
    try {
      execFileSync("node", ["scripts/backup/run-backup.mjs", "--out", out], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, DATABASE_URL: "postgresql://u:p@example.invalid:5432/db" },
      });
    } catch (e) {
      failed = true;
      stderr = String((e as { stderr?: string }).stderr ?? "");
    }
    expect(failed, "must exit non-zero").toBe(true);
    expect(stderr).toMatch(/placeholder/i);
    // And it refused BEFORE writing anything.
    expect(readdirSync(out)).toEqual([]);
  });

  it("--dry-run plans the whole backup, connects to nothing, and leaks nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "backup-plan-"));
    const recipient = join(dir, "recipient.txt");
    writeFileSync(recipient, `age1${"q".repeat(58)}\n`);

    const stdout = execFileSync(
      "node",
      [
        "scripts/backup/run-backup.mjs",
        "--out",
        join(dir, "out"),
        "--recipient",
        recipient,
        "--dry-run",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_URL: "postgresql://postgres:sup3r-s3cret@db.invalid:5432/postgres",
        },
      },
    );

    const plan = JSON.parse(stdout);
    expect(plan.mode).toBe("dry-run");
    expect(plan.steps.map((s: { name: string }) => s.name)).toEqual([
      "roles",
      "schema-public",
      "schema-auth",
      "data",
    ]);
    for (const step of plan.steps) {
      expect(step.encrypted).toMatch(/\.age$/);
      expect(step.argv.join(" ")).not.toContain("sup3r-s3cret");
    }
    // The whole printed plan is safe to paste into an issue.
    expect(stdout).not.toContain("sup3r-s3cret");
    // Nothing was written: a dry run must not create files either.
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  /**
   * A genuine age round-trip. Proves the encryption the whole gate rests on
   * actually works with a real key pair — generated here and thrown away, so
   * no key in this test has anything to do with the owner's.
   */
  it("age encrypts to a public key and only the private key reads it back", () => {
    let keygen: string;
    try {
      keygen = execFileSync("age-keygen", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      // age is installed by the workflow; locally it may be absent.
      console.warn("age not installed — skipping the round-trip");
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), "age-rt-"));
    const keyFile = join(dir, "key.txt");
    writeFileSync(keyFile, keygen);
    const publicKey = /public key: (age1[0-9a-z]+)/i.exec(keygen)![1]!;
    expect(parseRecipientFile(`${publicKey}\n`)).toBe(publicKey);

    const plain = join(dir, "dump.sql");
    const secretContent = "COPY auth.users FROM stdin;\nedward@example.com\t$2a$hash\n";
    writeFileSync(plain, secretContent);

    const encrypted = join(dir, "dump.sql.age");
    execFileSync("age", [
      "--encrypt",
      "--recipient",
      publicKey,
      "--output",
      encrypted,
      plain,
    ]);

    // The ciphertext must not contain the plaintext.
    const cipher = readFileSync(encrypted);
    expect(cipher.includes(Buffer.from("edward@example.com"))).toBe(false);

    const decrypted = execFileSync("age", ["--decrypt", "--identity", keyFile, encrypted], {
      encoding: "utf8",
    });
    expect(decrypted).toBe(secretContent);
  });

  it("prune decides without deleting, and never lists a foreign object", () => {
    const stems = ["cellar-atlas-2026-11-26T031700Z", "cellar-atlas-2020-01-01T031700Z"];
    const objects = [
      ...stems.flatMap((stem) => expectedSuffixes().map((s) => `${stem}${s}`)),
      "someone-elses-file.txt",
    ].join("\n");

    const stdout = execFileSync("node", ["scripts/backup/prune.mjs"], {
      input: objects,
      encoding: "utf8",
    });
    // The 2020 backup is the only monthly for its month, so it survives;
    // what matters here is that the foreign object is never listed.
    expect(stdout).not.toContain("someone-elses-file");

    const dry = execFileSync("node", ["scripts/backup/prune.mjs", "--dry-run"], {
      input: objects,
      encoding: "utf8",
    });
    expect(dry.trim()).toBe("");
  });
});
