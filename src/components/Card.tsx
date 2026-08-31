import type { ReactNode, HTMLAttributes } from "react";

interface Props extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  interactive?: boolean;
}

export function Card({ children, interactive, style, ...rest }: Props) {
  return (
    <div
      style={{
        background: "var(--surface-raised)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 14,
        padding: "1rem",
        cursor: interactive ? "pointer" : undefined,
        transition: "border-color 200ms",
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}
