import type { ReactNode } from "react";
import { BottomNav } from "./BottomNav";
import { SideNav } from "./SideNav";
import { useIsDesktop } from "@/hooks/useMediaQuery";

/**
 * Responsive shell. Same routes, different chrome:
 * bottom bar on mobile, sidebar on desktop. Not a shrunken desktop UI.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const desktop = useIsDesktop();

  if (desktop) {
    return (
      <div style={{ display: "flex", minHeight: "100vh" }}>
        <SideNav />
        <main style={{ flex: 1, minWidth: 0, maxWidth: 1100, padding: "1.5rem" }}>
          {children}
        </main>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <main
        style={{
          flex: 1,
          paddingBottom: "calc(4.5rem + var(--safe-bottom))",
        }}
      >
        {children}
      </main>
      <BottomNav />
    </div>
  );
}
