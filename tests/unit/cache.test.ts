import { describe, it, expect, vi, beforeEach } from "vitest";

// idb-keyval is backed by IndexedDB, which jsdom does not implement.
// A simple in-memory double exercises the logic we actually care about.
const store = new Map<string, unknown>();
vi.mock("idb-keyval", () => ({
  get: async (k: string) => store.get(k),
  set: async (k: string, v: unknown) => void store.set(k, v),
  del: async (k: string) => void store.delete(k),
}));

const { hydrate, CACHE_SCHEMA_VERSION } = await import("@/data/sync/cache");

interface Row {
  id: string;
}
const isRows = (v: unknown): v is Row[] => Array.isArray(v);

beforeEach(() => store.clear());

describe("hydration guard — the V1 data-loss bug", () => {
  /**
   * V1 ran a save effect on mount. If the load returned the empty default
   * for any reason, that empty array was written straight over the real
   * collection. Here, failing to load yields NO WRITER AT ALL, so writing
   * is not an available operation.
   */
  it("issues no writer when the server fails and no cache exists", async () => {
    const outcome = await hydrate<Row[]>({
      key: "k",
      cellarId: "c1",
      fetchFromServer: async () => {
        throw new Error("offline");
      },
      validate: isRows,
    });

    expect(outcome.result).toBeNull();
    expect("writer" in outcome).toBe(false);
    expect((outcome as { error: Error }).error.message).toBe("offline");
  });

  it("writes the cache after a successful server read", async () => {
    const rows: Row[] = [{ id: "a" }];
    const outcome = await hydrate<Row[]>({
      key: "k",
      cellarId: "c1",
      fetchFromServer: async () => rows,
      validate: isRows,
    });

    expect(outcome.result?.source).toBe("server");
    expect(store.get("k")).toMatchObject({
      schemaVersion: CACHE_SCHEMA_VERSION,
      cellarId: "c1",
      data: rows,
    });
  });

  it("falls back to a valid cache when the server is unreachable", async () => {
    store.set("k", {
      schemaVersion: CACHE_SCHEMA_VERSION,
      cellarId: "c1",
      savedAt: "2026-01-01T00:00:00Z",
      data: [{ id: "cached" }],
    });

    const outcome = await hydrate<Row[]>({
      key: "k",
      cellarId: "c1",
      fetchFromServer: async () => {
        throw new Error("offline");
      },
      validate: isRows,
    });

    expect(outcome.result?.source).toBe("cache");
    expect(outcome.result?.data).toEqual([{ id: "cached" }]);
  });

  it("discards a cache written by an older schema version", async () => {
    store.set("k", {
      schemaVersion: CACHE_SCHEMA_VERSION - 1,
      cellarId: "c1",
      savedAt: "2026-01-01T00:00:00Z",
      data: [{ id: "stale" }],
    });

    const outcome = await hydrate<Row[]>({
      key: "k",
      cellarId: "c1",
      fetchFromServer: async () => {
        throw new Error("offline");
      },
      validate: isRows,
    });

    // Stale shape is not trusted — better to fail loudly than read it wrong.
    expect(outcome.result).toBeNull();
  });

  it("never serves another cellar's cache", async () => {
    store.set("k", {
      schemaVersion: CACHE_SCHEMA_VERSION,
      cellarId: "SOMEONE-ELSE",
      savedAt: "2026-01-01T00:00:00Z",
      data: [{ id: "not-yours" }],
    });

    const outcome = await hydrate<Row[]>({
      key: "k",
      cellarId: "c1",
      fetchFromServer: async () => {
        throw new Error("offline");
      },
      validate: isRows,
    });

    expect(outcome.result).toBeNull();
  });

  it("discards a cache that fails validation", async () => {
    store.set("k", {
      schemaVersion: CACHE_SCHEMA_VERSION,
      cellarId: "c1",
      savedAt: "2026-01-01T00:00:00Z",
      data: { not: "an array" },
    });

    const outcome = await hydrate<Row[]>({
      key: "k",
      cellarId: "c1",
      fetchFromServer: async () => {
        throw new Error("offline");
      },
      validate: isRows,
    });

    expect(outcome.result).toBeNull();
  });
});
