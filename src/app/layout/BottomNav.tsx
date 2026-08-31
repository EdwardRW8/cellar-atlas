import { NavLink } from "react-router-dom";
import { NAV } from "./navigation";
import { TOUCH_TARGET_MIN_PX } from "@/styles/tokens";

export function BottomNav() {
  return (
    <nav
      aria-label="Primary"
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        display: "flex",
        background: "rgba(10,7,5,0.94)",
        backdropFilter: "blur(12px)",
        borderTop: "1px solid var(--border-subtle)",
        paddingBottom: "var(--safe-bottom)",
        zIndex: 100,
      }}
    >
      {NAV.map((item) => (
        <NavLink
          key={item.path}
          to={item.path}
          end={item.path === "/"}
          style={({ isActive }) => ({
            flex: 1,
            minHeight: TOUCH_TARGET_MIN_PX + 8,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 2,
            padding: "0.5rem 0.25rem",
            textDecoration: "none",
            color: isActive ? "var(--accent-gold)" : "var(--text-tertiary)",
          })}
        >
          {({ isActive }) => (
            <>
              <span aria-hidden style={{ fontSize: "1.05rem", lineHeight: 1 }}>
                {item.icon}
              </span>
              <span
                style={{
                  fontSize: "0.625rem",
                  letterSpacing: "0.06em",
                  fontWeight: isActive ? 600 : 400,
                }}
              >
                {item.short}
              </span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
