import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import { TOUCH_TARGET_MIN_PX } from "@/styles/tokens";

type Variant = "primary" | "secondary" | "ghost" | "danger";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  fullWidth?: boolean;
  children: ReactNode;
}

const variants: Record<Variant, CSSProperties> = {
  primary: {
    background: "linear-gradient(135deg,#8B5E2C,#D9AE55)",
    color: "#0A0705",
    fontWeight: 600,
    border: "1px solid transparent",
  },
  secondary: {
    background: "rgba(217,174,85,0.10)",
    color: "#D9AE55",
    border: "1px solid rgba(217,174,85,0.28)",
  },
  ghost: {
    background: "rgba(255,255,255,0.04)",
    color: "#C9BCA8",
    border: "1px solid #241A12",
  },
  danger: {
    background: "rgba(255,138,122,0.10)",
    color: "#FF8A7A",
    border: "1px solid rgba(255,138,122,0.28)",
  },
};

export function Button({
  variant = "primary",
  fullWidth,
  children,
  disabled,
  style,
  ...rest
}: Props) {
  return (
    <button
      disabled={disabled}
      style={{
        ...variants[variant],
        minHeight: TOUCH_TARGET_MIN_PX,
        padding: "0.75rem 1.25rem",
        borderRadius: 10,
        fontSize: "0.8125rem",
        letterSpacing: "0.04em",
        width: fullWidth ? "100%" : undefined,
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "opacity 120ms",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.5rem",
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}
