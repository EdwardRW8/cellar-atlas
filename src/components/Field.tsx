import type { InputHTMLAttributes } from "react";
import { TOUCH_TARGET_MIN_PX } from "@/styles/tokens";

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  hint?: string;
}

let seq = 0;

export function Field({ label, error, hint, id, ...rest }: Props) {
  const fieldId = id ?? `field-${(seq += 1)}`;
  const describedBy = error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.375rem" }}>
      <label
        htmlFor={fieldId}
        style={{
          fontSize: "0.6875rem",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--text-tertiary)",
        }}
      >
        {label}
      </label>
      <input
        id={fieldId}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        style={{
          minHeight: TOUCH_TARGET_MIN_PX,
          background: "rgba(255,255,255,0.04)",
          border: `1px solid ${error ? "#FF8A7A" : "var(--border-strong)"}`,
          borderRadius: 10,
          padding: "0.6875rem 0.875rem",
          color: "var(--text-primary)",
          fontSize: "1rem",
          outline: "none",
        }}
        {...rest}
      />
      {hint && !error && (
        <span
          id={`${fieldId}-hint`}
          style={{ fontSize: "0.75rem", color: "var(--text-tertiary)" }}
        >
          {hint}
        </span>
      )}
      {error && (
        <span
          id={`${fieldId}-error`}
          role="alert"
          style={{ fontSize: "0.75rem", color: "#FF8A7A" }}
        >
          {error}
        </span>
      )}
    </div>
  );
}
