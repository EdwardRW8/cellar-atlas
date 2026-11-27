/**
 * THE CONNECTION STRING MUST NEVER REACH A COMMAND LINE, AND THE CONNECTION
 * ITSELF MUST NEVER BE UNENCRYPTED.
 *
 * `pg_dump -d "postgresql://user:password@host/db"` works, and it puts the
 * production password into argv — where it is visible to `ps`, and where any
 * tool that logs the command it ran logs the password with it. GitHub masks
 * its own secrets in log output, but it cannot mask a process listing.
 *
 * So the URL is parsed once, here, and handed to pg_dump through the
 * environment instead. argv then carries no credential at all — a property a
 * test can assert, rather than a habit we have to keep remembering.
 *
 * ── SSLMODE IS NOT A PREFERENCE ──────────────────────────────────────────
 * libpq's `prefer` is the trap. It sounds cautious and it is not: it attempts
 * TLS and then **silently falls back to plaintext** if the server declines.
 * `allow` is worse, preferring plaintext. `disable` is explicit. All three
 * would stream the whole collection and every password hash in `auth` across
 * the public internet without a word in the log.
 *
 * Any of them is therefore REJECTED outright, not downgraded or warned about,
 * and the resolved mode is recorded in the manifest so an auditor can see
 * after the fact which was used.
 */

/** Modes that can transmit in clear. Never permitted off-loopback. */
const INSECURE_SSLMODES = new Set(["disable", "allow", "prefer"]);

/** Modes that guarantee encryption. `verify-*` also authenticates the server. */
const SECURE_SSLMODES = new Set(["require", "verify-ca", "verify-full"]);

/**
 * Hosts with no network hop, where TLS protects nothing.
 *
 * This exists so the integration test in docs/disaster-recovery.md can run
 * against a disposable local Postgres. It cannot weaken production: a
 * Supabase pooler host is never a loopback address, so the exemption can
 * never apply to the real database however the URL is written.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Split a Postgres URL into the PG* environment variables libpq reads.
 *
 * Returns ONLY the environment: the caller spreads it into the child's env and
 * passes no connection argument. Throws on anything unparseable, and on any
 * sslmode that could transmit in clear, rather than falling back to a default
 * that would quietly connect somewhere else or quietly connect insecurely.
 *
 * @param {string|undefined} url
 * @param {{caCertPath?: string|null}} [opts] A CA bundle, when one is
 *   configured. Its presence raises the DEFAULT to verify-full, because
 *   server authentication is only possible when there is something to verify
 *   against. Supabase publishes a downloadable CA certificate for this.
 */
export function pgEnvFromUrl(url, opts = {}) {
  if (typeof url !== "string" || url.trim() === "") {
    throw new Error("No database URL supplied. Expected the DATABASE_URL secret.");
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // Deliberately omits the URL: an unparseable string is still a secret,
    // and error messages reach logs.
    throw new Error("DATABASE_URL is not a valid URL.");
  }

  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    throw new Error(`Unsupported scheme ${parsed.protocol} — expected postgres:`);
  }
  if (!parsed.hostname) throw new Error("DATABASE_URL has no host.");

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, "")) || "postgres";
  const caCertPath = opts.caCertPath ?? null;
  const isLoopback = LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  const requested = parsed.searchParams.get("sslmode");

  let sslmode;
  if (requested === null) {
    // No mode asked for. Prefer VERIFIED TLS when a CA bundle makes
    // verification possible; otherwise encrypted-but-unauthenticated.
    sslmode = caCertPath ? "verify-full" : "require";
  } else {
    const mode = requested.trim().toLowerCase();
    if (INSECURE_SSLMODES.has(mode)) {
      if (!isLoopback) {
        throw new Error(
          `Refusing sslmode=${mode}: it permits an unencrypted connection, and the dump ` +
            `contains the auth schema. Use require, verify-ca or verify-full. ` +
            `(sslmode=${mode} is accepted only for a loopback host, for local testing.)`,
        );
      }
      sslmode = mode;
    } else if (SECURE_SSLMODES.has(mode)) {
      if (mode !== "require" && !caCertPath) {
        throw new Error(
          `sslmode=${mode} needs a CA certificate to verify against. Set BACKUP_CA_CERT ` +
            `to its path, or use sslmode=require. See docs/disaster-recovery.md.`,
        );
      }
      sslmode = mode;
    } else {
      // An unrecognised mode must not be passed through to libpq, which might
      // interpret it, nor silently replaced, which would hide the mistake.
      throw new Error(
        `Unrecognised sslmode=${requested}. Expected require, verify-ca or verify-full.`,
      );
    }
  }

  const env = {
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGDATABASE: database,
    PGUSER: decodeURIComponent(parsed.username || "postgres"),
    PGSSLMODE: sslmode,
    // libpq would otherwise prompt for a password and hang a non-interactive
    // runner until the job times out.
    PGCONNECT_TIMEOUT: "30",
  };

  if (caCertPath) env.PGSSLROOTCERT = caCertPath;
  if (parsed.password) env.PGPASSWORD = decodeURIComponent(parsed.password);
  return env;
}

/** True when this mode guarantees the connection is encrypted. */
export function isSecureSslmode(mode) {
  return SECURE_SSLMODES.has(String(mode).toLowerCase());
}

/**
 * A redacted description of where a dump came from, safe to print.
 *
 * Recorded in the manifest so a restore can be traced to its source — and so
 * the sslmode actually used is auditable afterwards — without the manifest
 * itself becoming a credential.
 */
export function describeTarget(env) {
  return `${env.PGUSER}@${env.PGHOST}:${env.PGPORT}/${env.PGDATABASE} (sslmode=${env.PGSSLMODE})`;
}
