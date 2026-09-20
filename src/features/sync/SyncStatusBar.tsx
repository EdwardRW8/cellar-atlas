import { useState } from "react";
import { useCellar } from "@/hooks/useCellar";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/Button";
import type { ConflictSummary } from "@/domain/conflict-rebase";
import { TOUCH_TARGET_MIN_PX } from "@/styles/tokens";

/**
 * The four states the UI must distinguish (amendment 3):
 *
 *   SYNCED      nothing outstanding
 *   PENDING     large transactions queued but not yet confirmed
 *   CONFLICTED  another device changed the row first — needs a decision
 *   FAILED      the server refused it outright
 *
 * A twelve-bottle acquisition is never shown as committed before the server
 * has validated its positions.
 */
export function SyncStatusBar() {
  const { pending, conflicts, failed, online } = useCellar();
  const [open, setOpen] = useState(false);

  const state =
    conflicts.length > 0
      ? "conflicted"
      : failed.length > 0
        ? "failed"
        : pending.length > 0
          ? "pending"
          : online
            ? "synced"
            : "offline";

  // Nothing to say when everything is fine and we are online.
  if (state === "synced") return null;

  const config = {
    pending: { colour: "var(--accent-gold)", label: `${pending.length} saving` },
    conflicted: {
      colour: "var(--status-approaching)",
      label: `${conflicts.length} need${conflicts.length === 1 ? "s" : ""} your decision`,
    },
    failed: { colour: "var(--status-past)", label: `${failed.length} could not save` },
    offline: { colour: "var(--status-approaching)", label: "Offline — changes will sync" },
    synced: { colour: "var(--status-ready)", label: "Synced" },
  }[state];

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label={`Sync status: ${config.label}`}
        style={{
          position: "sticky",
          top: 0,
          zIndex: 90,
          width: "100%",
          minHeight: 40,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          padding: "0.5rem 1rem",
          background: "var(--surface-overlay)",
          borderBottom: `1px solid ${config.colour}`,
          color: config.colour,
          fontSize: "0.75rem",
          letterSpacing: "0.04em",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: config.colour,
            flexShrink: 0,
          }}
        />
        {config.label}
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title="Sync status">
        <SyncDetail onClose={() => setOpen(false)} />
      </Sheet>
    </>
  );
}

function SyncDetail({ onClose }: { onClose: () => void }) {
  const { pending, conflicts, failed, online, dismissFailed } = useCellar();
  const [resolving, setResolving] = useState<ConflictSummary | null>(null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      {!online && (
        <p
          style={{
            padding: "0.75rem 1rem",
            borderRadius: 10,
            background: "rgba(245,181,68,0.08)",
            border: "1px solid rgba(245,181,68,0.25)",
            color: "var(--status-approaching)",
            fontSize: "0.8125rem",
            lineHeight: 1.6,
          }}
        >
          You are offline. Changes are saved on this device and will sync when you
          reconnect. Nothing is lost.
        </p>
      )}

      {conflicts.length > 0 && (
        <Section title="Needs your decision" colour="var(--status-approaching)">
          {conflicts.map((c) => (
            <button
              key={c.operationId}
              onClick={() => setResolving(c)}
              style={rowStyle("var(--status-approaching)")}
            >
              <span
                style={{
                  display: "block",
                  color: "var(--text-primary)",
                  fontSize: "0.875rem",
                }}
              >
                {c.what}
              </span>
              <span
                style={{
                  display: "block",
                  color: "var(--text-tertiary)",
                  fontSize: "0.75rem",
                  marginTop: 2,
                }}
              >
                Changed on another device — tap to resolve
              </span>
            </button>
          ))}
        </Section>
      )}

      {pending.length > 0 && (
        <Section title="Saving" colour="var(--accent-gold)">
          {pending.map((p) => (
            <div key={p.operationId} style={rowStyle("var(--accent-gold)")}>
              <span
                style={{
                  display: "block",
                  color: "var(--text-primary)",
                  fontSize: "0.875rem",
                }}
              >
                {p.description}
              </span>
              <span
                style={{
                  display: "block",
                  color: "var(--text-tertiary)",
                  fontSize: "0.75rem",
                  marginTop: 2,
                }}
              >
                Waiting for the server to confirm
              </span>
            </div>
          ))}
        </Section>
      )}

      {failed.length > 0 && (
        <Section title="Could not save" colour="var(--status-past)">
          {failed.map((f) => (
            <div key={f.operationId} style={rowStyle("var(--status-past)")}>
              <span
                style={{
                  display: "block",
                  color: "var(--text-primary)",
                  fontSize: "0.875rem",
                }}
              >
                {f.description}
              </span>
              <span
                style={{
                  display: "block",
                  color: "var(--text-tertiary)",
                  fontSize: "0.75rem",
                  marginTop: 2,
                }}
              >
                {f.reason}
              </span>
              <button
                onClick={() => dismissFailed(f.operationId)}
                style={{
                  marginTop: 8,
                  minHeight: 36,
                  fontSize: "0.75rem",
                  color: "var(--text-tertiary)",
                }}
              >
                Dismiss
              </button>
            </div>
          ))}
        </Section>
      )}

      {conflicts.length === 0 && pending.length === 0 && failed.length === 0 && (
        <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem" }}>
          Everything is saved.
        </p>
      )}

      <Button variant="ghost" fullWidth onClick={onClose}>
        Close
      </Button>

      {resolving && (
        <ConflictSheet conflict={resolving} onClose={() => setResolving(null)} />
      )}
    </div>
  );
}

/**
 * Conflict resolution.
 *
 * KEEP MINE rebases: it fetches the current server state, reconstructs the
 * intent against it, creates a NEW operation and submits it through the
 * normal version check. It is not a force overwrite, and it can conflict
 * again if a third change lands — which is correct.
 */
function ConflictSheet({
  conflict,
  onClose,
}: {
  conflict: ConflictSummary;
  onClose: () => void;
}) {
  const { dismissConflict, repository, run } = useCellar();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const keepMine = async () => {
    if (!repository) return;
    setBusy(true);

    const server = await repository.fetchBottleState(conflict.entityId);
    if (!server) {
      setNote("That bottle no longer exists. Your change cannot be reapplied.");
      setBusy(false);
      return;
    }

    // Reapply the intent against the CURRENT version, through the normal
    // version check. Never a bypass.
    const version = server.version as number;
    const intent = Object.fromEntries(
      conflict.yours.map((y) => [y.field.toLowerCase(), y.value]),
    );

    if (intent.status) {
      const r = await run(
        `Reapply: ${conflict.what}`,
        (m) =>
          m.changeStatus({
            bottleId: conflict.entityId,
            version,
            status: intent.status as "consumed",
          }),
        { bottleId: conflict.entityId },
      );
      setNote(
        r.ok
          ? "Your change was reapplied to the latest version."
          : (r.error ?? "Could not reapply — please try again."),
      );
    } else {
      setNote("This change must be made again manually against the current state.");
    }

    setBusy(false);
    if (!note) {
      dismissConflict(conflict.operationId);
      onClose();
    }
  };

  const useTheirs = () => {
    dismissConflict(conflict.operationId);
    onClose();
  };

  return (
    <Sheet open onClose={onClose} title="Changed on another device">
      <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
        <p
          style={{ color: "var(--text-secondary)", fontSize: "0.875rem", lineHeight: 1.6 }}
        >
          Someone changed this while your change was waiting to save. Choose which should
          apply.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Column title="Yours" rows={conflict.yours} accent="var(--accent-gold)" />
          <Column title="Theirs" rows={conflict.theirs} accent="var(--text-secondary)" />
        </div>

        {note && (
          <p
            role="status"
            style={{
              padding: "0.75rem 1rem",
              borderRadius: 10,
              background: "rgba(255,255,255,0.04)",
              border: "1px solid var(--border-subtle)",
              color: "var(--text-secondary)",
              fontSize: "0.8125rem",
            }}
          >
            {note}
          </p>
        )}

        {!conflict.canRebase && (
          <p
            style={{
              padding: "0.75rem 1rem",
              borderRadius: 10,
              background: "rgba(245,181,68,0.08)",
              border: "1px solid rgba(245,181,68,0.25)",
              color: "var(--status-approaching)",
              fontSize: "0.8125rem",
              lineHeight: 1.6,
            }}
          >
            Your change cannot be reapplied automatically on top of theirs. Review the
            current state and make it again if you still want it.
          </p>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Button disabled={busy || !conflict.canRebase} onClick={() => void keepMine()}>
            {busy ? "Reapplying…" : "Keep mine — reapply to the latest version"}
          </Button>
          <Button variant="ghost" onClick={useTheirs}>
            Use theirs — discard my change
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

function Column({
  title,
  rows,
  accent,
}: {
  title: string;
  rows: { field: string; value: string }[];
  accent: string;
}) {
  return (
    <div
      style={{
        padding: "0.875rem",
        borderRadius: 10,
        background: "rgba(255,255,255,0.03)",
        border: "1px solid var(--border-subtle)",
      }}
    >
      <h3
        style={{
          fontSize: "0.6875rem",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: accent,
          marginBottom: "0.5rem",
        }}
      >
        {title}
      </h3>
      {rows.map((r) => (
        <div key={r.field} style={{ marginBottom: 6 }}>
          <span
            style={{
              display: "block",
              fontSize: "0.6875rem",
              color: "var(--text-tertiary)",
            }}
          >
            {r.field}
          </span>
          <span
            style={{ display: "block", fontSize: "0.875rem", color: "var(--text-primary)" }}
          >
            {r.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function Section({
  title,
  colour,
  children,
}: {
  title: string;
  colour: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3
        style={{
          fontSize: "0.6875rem",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: colour,
          marginBottom: "0.5rem",
        }}
      >
        {title}
      </h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{children}</div>
    </section>
  );
}

function rowStyle(accent: string): React.CSSProperties {
  return {
    width: "100%",
    textAlign: "left",
    minHeight: TOUCH_TARGET_MIN_PX,
    padding: "0.75rem 0.875rem",
    borderRadius: 10,
    background: "var(--surface-raised)",
    border: `1px solid ${accent}33`,
  };
}
