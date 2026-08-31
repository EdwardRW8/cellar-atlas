/**
 * Schema-versioned local cache with a hydration guard.
 *
 * This is the direct descendant of the bug that destroyed the V1 collection:
 * a save effect fired on mount, before any successful load, and wrote an
 * empty array over real data.
 *
 * The guard here is structural rather than a flag someone must remember to
 * check. A CacheWriter does not exist until hydration has succeeded, so
 * "write before read" is not an available operation.
 */

import { get, set, del } from "idb-keyval";
import type { CacheEnvelope } from "./types";

/** Bump when the cached shape changes. Mismatched caches are discarded. */
export const CACHE_SCHEMA_VERSION = 1;

export type HydrationSource = "server" | "cache" | "empty";

export interface HydrationResult<T> {
  data: T;
  source: HydrationSource;
  savedAt: string | null;
}

export class CacheWriter<T> {
  private constructor(
    private readonly key: string,
    private readonly cellarId: string,
  ) {}

  /** Only obtainable from hydrate(). This is what makes the guard structural. */
  static __create<T>(key: string, cellarId: string): CacheWriter<T> {
    return new CacheWriter<T>(key, cellarId);
  }

  async write(data: T): Promise<void> {
    const envelope: CacheEnvelope<T> = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      cellarId: this.cellarId,
      savedAt: new Date().toISOString(),
      data,
    };
    try {
      await set(this.key, envelope);
    } catch {
      // A cache write failure is not fatal — the server remains the source
      // of truth and the queue holds anything unsent.
    }
  }

  async clear(): Promise<void> {
    try {
      await del(this.key);
    } catch {
      /* non-fatal */
    }
  }
}

async function readCache<T>(
  key: string,
  cellarId: string,
): Promise<CacheEnvelope<T> | null> {
  try {
    const raw = await get<CacheEnvelope<T>>(key);
    if (!raw || typeof raw !== "object") return null;
    if (raw.schemaVersion !== CACHE_SCHEMA_VERSION) return null; // stale shape
    if (raw.cellarId !== cellarId) return null; // wrong cellar
    if (raw.data === undefined || raw.data === null) return null;
    return raw;
  } catch {
    return null;
  }
}

export interface HydrateOptions<T> {
  key: string;
  cellarId: string;
  /** Fetch from the server. Throwing means unavailable, not empty. */
  fetchFromServer: () => Promise<T>;
  /** Shape check. A cache failing this is discarded rather than trusted. */
  validate: (value: unknown) => value is T;
}

/**
 * Server first, cache as fallback.
 *
 * Returns a writer ONLY when hydration produced trustworthy data. If the
 * server is unreachable and no valid cache exists, no writer is issued and
 * the caller cannot persist anything — which is the correct outcome, and
 * exactly what V1 got wrong.
 */
export async function hydrate<T>(
  opts: HydrateOptions<T>,
): Promise<
  { result: HydrationResult<T>; writer: CacheWriter<T> } | { result: null; error: Error }
> {
  const { key, cellarId, fetchFromServer, validate } = opts;

  try {
    const fresh = await fetchFromServer();
    const writer = CacheWriter.__create<T>(key, cellarId);
    await writer.write(fresh); // safe: the server confirmed this
    return {
      result: { data: fresh, source: "server", savedAt: new Date().toISOString() },
      writer,
    };
  } catch (serverError) {
    const cached = await readCache<T>(key, cellarId);

    if (cached && validate(cached.data)) {
      return {
        result: { data: cached.data, source: "cache", savedAt: cached.savedAt },
        writer: CacheWriter.__create<T>(key, cellarId),
      };
    }

    // No server, no usable cache. Report failure. Do NOT invent an empty
    // dataset and do NOT hand out a writer.
    return {
      result: null,
      error:
        serverError instanceof Error
          ? serverError
          : new Error("Unable to load data and no local copy is available."),
    };
  }
}
