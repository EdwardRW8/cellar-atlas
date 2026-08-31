import type { ReactNode } from "react";

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div style={{ textAlign: "center", padding: "3rem 1.5rem" }}>
      <h2
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "1.5rem",
          fontStyle: "italic",
          color: "var(--text-secondary)",
          marginBottom: description ? "0.5rem" : "1.5rem",
        }}
      >
        {title}
      </h2>
      {description && (
        <p
          style={{
            color: "var(--text-tertiary)",
            fontSize: "0.875rem",
            marginBottom: "1.5rem",
            maxWidth: 380,
            marginInline: "auto",
          }}
        >
          {description}
        </p>
      )}
      {action}
    </div>
  );
}
