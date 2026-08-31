import { describe, it, expect, vi } from "vitest";
import { createMemoryQueue } from "@/data/sync/queue";
import { createSyncEngine } from "@/data/sync/engine";
import type { Operation, OperationHandler, OperationResult } from "@/data/sync/types";
import { MAX_ATTEMPTS } from "@/data/sync/types";

let seq = 0;
const nextId = () => `op-${++seq}`;

function op(
  overrides: Partial<Operation> = {},
): Omit<Operation, "attempts" | "lastAttemptAt" | "lastError" | "status"> {
  return {
    operationId: nextId(),
    entity: "test",
    entityId: "entity-1",
    type: "create",
    payload: { value: 1 },
    clientTime: new Date().toISOString(),
    deviceId: "dev-test",
    ...overrides,
  };
}

function handler(
  impl: (o: Operation) => Promise<OperationResult> | OperationResult,
  entity = "test",
): OperationHandler {
  return { entity, apply: async (o) => impl(o) };
}

describe("queue", () => {
  it("removes only the ids given, never the whole queue", async () => {
    const q = createMemoryQueue();
    await q.add({
      ...op({ operationId: "a" }),
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
      status: "pending",
    });
    await q.add({
      ...op({ operationId: "b" }),
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
      status: "pending",
    });
    await q.add({
      ...op({ operationId: "c" }),
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
      status: "pending",
    });

    await q.removeByIds(["a", "c"]);

    const rest = await q.all();
    expect(rest.map((o) => o.operationId)).toEqual(["b"]);
  });

  it("will not enqueue the same operationId twice", async () => {
    const q = createMemoryQueue();
    const o = {
      ...op({ operationId: "dup" }),
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
      status: "pending" as const,
    };
    await q.add(o);
    await q.add(o);
    expect(await q.count()).toBe(1);
  });
});

describe("sync engine — the V2 data-loss bug", () => {
  /**
   * THE REGRESSION TEST THAT MATTERS.
   *
   * V2 replaced the entire queue after a flush with its pre-flight snapshot.
   * An edit made while the flush awaited the network was silently destroyed.
   * Here we enqueue during the flush and assert it survives.
   */
  it("preserves operations enqueued DURING a flush", async () => {
    const queue = createMemoryQueue();
    let engine: ReturnType<typeof createSyncEngine>;

    const slow = handler(async (o) => {
      // While this awaits, the user makes another edit.
      if (o.operationId === "first") {
        await engine.enqueue(op({ operationId: "during-flush", entityId: "entity-2" }));
      }
      return { operationId: o.operationId, outcome: "applied" };
    });

    engine = createSyncEngine({ queue, isOnline: () => true });
    engine.register(slow);

    await engine.enqueue(op({ operationId: "first" }));
    await engine.flush();

    const remaining = await queue.all();
    expect(remaining.map((o) => o.operationId)).toContain("during-flush");
    expect(remaining).toHaveLength(1);
  });

  it("treats a duplicate as success and clears it", async () => {
    const queue = createMemoryQueue();
    const engine = createSyncEngine({ queue, isOnline: () => true });
    engine.register(handler((o) => ({ operationId: o.operationId, outcome: "duplicate" })));

    await engine.enqueue(op({ operationId: "already-applied" }));
    await engine.flush();

    expect(await queue.count()).toBe(0);
  });

  it("is safe to replay: applying the same op twice equals once", async () => {
    const queue = createMemoryQueue();
    const applied = new Set<string>();

    const engine = createSyncEngine({ queue, isOnline: () => true });
    engine.register(
      handler((o) => {
        if (applied.has(o.operationId)) {
          return { operationId: o.operationId, outcome: "duplicate" };
        }
        applied.add(o.operationId);
        return { operationId: o.operationId, outcome: "applied" };
      }),
    );

    await engine.enqueue(op({ operationId: "replay-me" }));
    await engine.flush();
    // Simulate the op somehow being re-queued (lost ack, restored backup).
    await engine.enqueue(op({ operationId: "replay-me" }));
    await engine.flush();

    expect(applied.size).toBe(1);
    expect(await queue.count()).toBe(0);
  });
});

describe("sync engine — retries and failures", () => {
  it("retains a retryable failure and counts the attempt", async () => {
    const queue = createMemoryQueue();
    const engine = createSyncEngine({ queue, isOnline: () => true });
    engine.register(
      handler((o) => ({
        operationId: o.operationId,
        outcome: "retryable",
        error: "network",
      })),
    );

    await engine.enqueue(op({ operationId: "flaky" }));
    await engine.flush();

    const [held] = await queue.all();
    expect(held?.operationId).toBe("flaky");
    expect(held?.attempts).toBe(1);
    expect(held?.status).toBe("pending");
  });

  it("parks a permanent failure without discarding it", async () => {
    const queue = createMemoryQueue();
    const engine = createSyncEngine({ queue, isOnline: () => true });
    engine.register(
      handler((o) => ({
        operationId: o.operationId,
        outcome: "permanent",
        error: "RLS denied",
      })),
    );

    await engine.enqueue(op({ operationId: "rejected" }));
    await engine.flush();

    const [parked] = await queue.all();
    expect(parked?.status).toBe("failed");
    expect(parked?.lastError).toBe("RLS denied");
    // Still present — a parked op is still the user's work.
    expect(await queue.count()).toBe(1);
  });

  it("parks after MAX_ATTEMPTS rather than retrying forever", async () => {
    const queue = createMemoryQueue();
    let clock = new Date("2026-01-01T00:00:00Z");
    const engine = createSyncEngine({
      queue,
      isOnline: () => true,
      now: () => clock,
    });
    engine.register(handler((o) => ({ operationId: o.operationId, outcome: "retryable" })));

    await engine.enqueue(op({ operationId: "doomed" }));
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
      clock = new Date(clock.getTime() + 120_000); // past any backoff
      await engine.flush();
    }

    const [parked] = await queue.all();
    expect(parked?.status).toBe("failed");
    expect(parked?.attempts).toBeLessThanOrEqual(MAX_ATTEMPTS);
  });

  it("parks an operation with no registered handler instead of losing it", async () => {
    const queue = createMemoryQueue();
    const engine = createSyncEngine({ queue, isOnline: () => true });
    // No handler registered at all.
    await engine.enqueue(op({ operationId: "orphan", entity: "unknown-entity" }));
    await engine.flush();

    const [parked] = await queue.all();
    expect(parked?.status).toBe("failed");
    expect(parked?.lastError).toMatch(/No handler/);
  });

  it("retryFailed re-arms parked operations", async () => {
    const queue = createMemoryQueue();
    const engine = createSyncEngine({ queue, isOnline: () => true });
    engine.register(handler((o) => ({ operationId: o.operationId, outcome: "permanent" })));

    await engine.enqueue(op({ operationId: "park-me" }));
    await engine.flush();
    expect((await queue.all())[0]?.status).toBe("failed");

    await engine.retryFailed();
    const [rearmed] = await queue.all();
    expect(rearmed?.status).toBe("pending");
    expect(rearmed?.attempts).toBe(0);
  });
});

describe("sync engine — offline and concurrency", () => {
  it("does not attempt anything while offline", async () => {
    const queue = createMemoryQueue();
    const apply = vi.fn();
    const engine = createSyncEngine({ queue, isOnline: () => false });
    engine.register({ entity: "test", apply: apply as never });

    await engine.enqueue(op());
    const state = await engine.flush();

    expect(apply).not.toHaveBeenCalled();
    expect(state.status).toBe("offline");
    expect(await queue.count()).toBe(1);
  });

  it("runs only one flush at a time", async () => {
    const queue = createMemoryQueue();
    let concurrent = 0;
    let maxConcurrent = 0;

    const engine = createSyncEngine({ queue, isOnline: () => true });
    engine.register(
      handler(async (o) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 10));
        concurrent -= 1;
        return { operationId: o.operationId, outcome: "applied" };
      }),
    );

    await engine.enqueue(op());
    await engine.enqueue(op());
    await Promise.all([engine.flush(), engine.flush(), engine.flush()]);

    expect(maxConcurrent).toBe(1);
  });
});
