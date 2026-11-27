import { useState } from "react";
import { useCellar, mutationBlock, MUTATION_BLOCK_MESSAGE } from "@/hooks/useCellar";
import { TOUCH_TARGET_MIN_PX } from "@/styles/tokens";

/**
 * SAYS WHY A CONTROL IS DISABLED, AND OFFERS THE ONE RECOVERY THAT EXISTS.
 *
 * Before this, a disabled control either said nothing or said "You're
 * offline" regardless of the real reason — so an online viewer was told to
 * check their connection, and a user whose permission check had failed was
 * stranded read-only with no way back short of reloading the whole app. The
 * provider had `permissionState` and `recheckPermission` for exactly this,
 * and nothing rendered either of them.
 *
 * Retry appears for ONE reason — a failed permission lookup — because that is
 * the only state a retry can clear. Retrying while offline cannot succeed, a
 * check still in flight needs no help, and a confirmed viewer's role is not a
 * transient fault. Offering a button that cannot work is its own small lie.
 *
 * This reads the provider directly rather than taking props: the reason is
 * global state, and threading four more props through fourteen call sites
 * would be four more chances for one screen to explain it differently.
 */
export function MutationBlockedNotice({ compact }: { compact?: boolean } = {}) {
  const { online, permissionState, role, recheckPermission } = useCellar();
  const [rechecking, setRechecking] = useState(false);

  const block = mutationBlock({ online, permissionState, role });
  if (!block) return null;

  const colour =
    block === "permission-failed" ? "var(--status-past)" : "var(--status-approaching)";

  return (
    <div
      role="status"
      style={{
        padding: compact ? "0.5rem 0" : "0.75rem 1rem",
        borderRadius: compact ? 0 : 10,
        background: compact ? "none" : "rgba(255,255,255,0.03)",
        border: compact ? "none" : `1px solid ${colour}`,
        color: colour,
        fontSize: "0.8125rem",
        lineHeight: 1.6,
      }}
    >
      {MUTATION_BLOCK_MESSAGE[block]}
      {block === "permission-failed" && (
        <button
          onClick={async () => {
            setRechecking(true);
            try {
              await recheckPermission();
            } finally {
              setRechecking(false);
            }
          }}
          disabled={rechecking}
          style={{
            display: "block",
            marginTop: 8,
            minHeight: TOUCH_TARGET_MIN_PX,
            padding: "0 0.875rem",
            borderRadius: 8,
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.12)",
            color: "var(--text-primary)",
            fontSize: "0.8125rem",
          }}
        >
          {rechecking ? "Checking…" : "Retry"}
        </button>
      )}
    </div>
  );
}
