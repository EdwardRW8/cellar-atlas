import { useEffect, useRef, type ReactNode } from "react";

/**
 * Bottom sheet on mobile, centred dialog on desktop.
 *
 * Traps focus, restores it on close, closes on Escape. Modal depth is capped
 * at two by convention — screen → sheet, never sheet → sheet → dialog.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement as HTMLElement;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab" || !ref.current) return;
      const focusable = ref.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    const t = setTimeout(() => {
      ref.current?.querySelector<HTMLElement>("button, input")?.focus();
    }, 50);

    return () => {
      document.removeEventListener("keydown", onKey);
      clearTimeout(t);
      restoreTo.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        background: "rgba(0,0,0,0.7)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
      }}
    >
      <div
        ref={ref}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(560px, 100%)",
          maxHeight: "88vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--surface-overlay)",
          border: "1px solid var(--border-strong)",
          borderRadius: "18px 18px 0 0",
          paddingBottom: "var(--safe-bottom)",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "1rem 1.25rem",
            borderBottom: "1px solid var(--border-subtle)",
          }}
        >
          <h2
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "1.25rem",
              fontStyle: "italic",
            }}
          >
            {title}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              minWidth: 44,
              minHeight: 44,
              color: "var(--text-tertiary)",
              fontSize: "1.25rem",
            }}
          >
            ✕
          </button>
        </header>

        <div style={{ flex: 1, overflowY: "auto", padding: "1.25rem" }}>{children}</div>

        {footer && (
          <div
            style={{ padding: "1rem 1.25rem", borderTop: "1px solid var(--border-subtle)" }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
