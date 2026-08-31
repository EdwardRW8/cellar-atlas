import { NavLink } from "react-router-dom";
import { NAV } from "./navigation";

export function SideNav() {
  return (
    <nav
      aria-label="Primary"
      style={{
        width: 220,
        flexShrink: 0,
        borderRight: "1px solid var(--border-subtle)",
        padding: "1.5rem 0.75rem",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div style={{ padding: "0 0.75rem 1.5rem" }}>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "1.5rem",
            fontStyle: "italic",
            color: "var(--text-primary)",
            whiteSpace: "nowrap",
          }}
        >
          Cellar Atlas
        </h1>
      </div>
      {NAV.map((item) => (
        <NavLink
          key={item.path}
          to={item.path}
          end={item.path === "/"}
          style={({ isActive }) => ({
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            padding: "0.75rem",
            borderRadius: 10,
            textDecoration: "none",
            fontSize: "0.875rem",
            background: isActive ? "rgba(217,174,85,0.10)" : "transparent",
            color: isActive ? "var(--accent-gold)" : "var(--text-secondary)",
          })}
        >
          <span aria-hidden>{item.icon}</span>
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
