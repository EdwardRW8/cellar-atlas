import type { SyncStatus } from "@/data/sync/types";

const MAP: Record<SyncStatus, { colour: string; label: string }> = {
  idle: { colour: "var(--status-ready)", label: "Synced" },
  syncing: { colour: "var(--accent-gold)", label: "Syncing" },
  offline: { colour: "var(--status-approaching)", label: "Offline" },
  error: { colour: "var(--status-past)", label: "Sync issue" },
};

export function SyncBadge({ status, pending }: { status: SyncStatus; pending: number }) {
  const { colour, label } = MAP[status];
  const text = pending > 0 ? `${label} · ${pending} pending` : label;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }} role="status">
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: colour,
          boxShadow: `0 0 6px ${colour}`,
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontSize: "0.6875rem",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--text-tertiary)",
        }}
      >
        {text}
      </span>
    </div>
  );
}
