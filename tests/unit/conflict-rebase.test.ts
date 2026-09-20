import { describe, it, expect } from "vitest";
import {
  rebaseOperation,
  discardOperation,
  summariseConflict,
  type ConflictContext,
} from "@/domain/conflict-rebase";
import type { Operation } from "@/data/sync/types";

let n = 0;
const newId = () => `rebased-${++n}`;
const fixedNow = () => new Date("2026-06-01T12:00:00Z");

function op(payload: Record<string, unknown>): Operation {
  return {
    operationId: "original-op",
    entity: "bottle",
    entityId: "bottle-1",
    type: "update",
    payload,
    clientTime: "2026-05-01T10:00:00Z",
    deviceId: "dev-a",
    attempts: 1,
    lastAttemptAt: "2026-05-01T10:00:01Z",
    lastError: "version conflict",
    status: "failed",
  };
}

describe("Keep Mine REBASES — it never force-overwrites (amendment 4)", () => {
  it("creates a NEW operation with a NEW id", () => {
    const ctx: ConflictContext = {
      operation: op({ notes: "my note", version: 1 }),
      serverState: { notes: "their note", version: 3 },
      baseState: { notes: null, version: 1 },
    };
    const r = rebaseOperation(ctx, newId, fixedNow);
    expect(r.outcome).toBe("rebased");
    expect(r.operation!.operationId).not.toBe("original-op");
  });

  it("carries the CURRENT server version, not the stale one", () => {
    const ctx: ConflictContext = {
      operation: op({ notes: "mine", version: 1 }),
      serverState: { notes: "theirs", version: 7 },
      baseState: null,
    };
    const r = rebaseOperation(ctx, newId, fixedNow);
    expect((r.operation!.payload as Record<string, unknown>).version).toBe(7);
  });

  it("preserves the user's intent", () => {
    const ctx: ConflictContext = {
      operation: op({ storage_location_id: "loc-b", version: 1 }),
      serverState: { storage_location_id: "loc-c", version: 4 },
      baseState: null,
    };
    const r = rebaseOperation(ctx, newId, fixedNow);
    expect((r.operation!.payload as Record<string, unknown>).storage_location_id).toBe(
      "loc-b",
    );
  });

  it("resets retry state so it is attempted fresh", () => {
    const ctx: ConflictContext = {
      operation: op({ notes: "mine", version: 1 }),
      serverState: { notes: "theirs", version: 2 },
      baseState: null,
    };
    const r = rebaseOperation(ctx, newId, fixedNow);
    expect(r.operation!.attempts).toBe(0);
    expect(r.operation!.status).toBe("pending");
    expect(r.operation!.lastError).toBeNull();
  });

  it("NEVER reuses the original operation id — that would be a no-op duplicate", () => {
    const ctx: ConflictContext = {
      operation: op({ notes: "mine", version: 1 }),
      serverState: { notes: "theirs", version: 2 },
      baseState: null,
    };
    const r = rebaseOperation(ctx, newId, fixedNow);
    expect(r.operation!.operationId).toMatch(/^rebased-/);
  });

  it("explains what will happen in plain English", () => {
    const ctx: ConflictContext = {
      operation: op({ notes: "mine", version: 1 }),
      serverState: { notes: "theirs", version: 2 },
      baseState: null,
    };
    expect(rebaseOperation(ctx, newId, fixedNow).explanation).toMatch(/reapplied/);
  });
});

describe("cases that cannot be rebased", () => {
  it("recognises when the server already has the change", () => {
    const ctx: ConflictContext = {
      operation: op({ status: "consumed", version: 1 }),
      serverState: { status: "consumed", version: 2 },
      baseState: null,
    };
    const r = rebaseOperation(ctx, newId, fixedNow);
    expect(r.outcome).toBe("already-applied");
    expect(r.operation).toBeNull();
  });

  it("refuses to consume a bottle already gifted elsewhere", () => {
    const ctx: ConflictContext = {
      operation: op({ status: "consumed", version: 1 }),
      serverState: { status: "gifted", version: 2 },
      baseState: null,
    };
    const r = rebaseOperation(ctx, newId, fixedNow);
    expect(r.outcome).toBe("not-rebasable");
    expect(r.explanation).toMatch(/already been marked gifted/);
  });

  it("refuses when the server version is unknown", () => {
    const ctx: ConflictContext = {
      operation: op({ notes: "mine", version: 1 }),
      serverState: { notes: "theirs" },
      baseState: null,
    };
    expect(rebaseOperation(ctx, newId, fixedNow).outcome).toBe("not-rebasable");
  });

  it("refuses when there is no discernible intent", () => {
    const ctx: ConflictContext = {
      operation: op({ version: 1 }),
      serverState: { version: 2 },
      baseState: null,
    };
    expect(rebaseOperation(ctx, newId, fixedNow).outcome).toBe("not-rebasable");
  });
});

describe("Use Theirs discards without submitting anything", () => {
  it("produces no operation", () => {
    const r = discardOperation(op({ notes: "mine", version: 1 }));
    expect(r.outcome).toBe("discarded");
    expect(r.operation).toBeNull();
  });
});

describe("conflict summary for the UI", () => {
  it("shows both sides field by field", () => {
    const ctx: ConflictContext = {
      operation: op({ status: "consumed", version: 1 }),
      serverState: { status: "in_cellar", version: 2 },
      baseState: null,
    };
    const s = summariseConflict(ctx);
    expect(s.what).toBe("Mark bottle as consumed");
    expect(s.yours[0]).toEqual({ field: "Status", value: "consumed" });
    expect(s.theirs[0]).toEqual({ field: "Status", value: "in_cellar" });
    expect(s.canRebase).toBe(true);
  });

  it("marks an unrebasable conflict as such", () => {
    const ctx: ConflictContext = {
      operation: op({ status: "consumed", version: 1 }),
      serverState: { status: "sold", version: 2 },
      baseState: null,
    };
    expect(summariseConflict(ctx).canRebase).toBe(false);
  });

  it("describes a move", () => {
    const ctx: ConflictContext = {
      operation: op({ storage_location_id: "b", version: 1 }),
      serverState: { storage_location_id: "c", version: 2 },
      baseState: null,
    };
    expect(summariseConflict(ctx).what).toBe("Move bottle");
  });
});
