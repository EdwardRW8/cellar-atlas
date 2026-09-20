import { FIXED_UI_CLEARANCE_REM } from "@/styles/tokens";
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
        <main
          style={{
            flex: 1,
            minWidth: 0,
            maxWidth: 1100,
            padding: "1.5rem",
            // The Add Wine button floats on desktop too, with no bottom nav
            // beneath it. Reserve enough room that content can still be
            // reached; the rest of the desktop layout is unchanged.
            paddingBottom: `${FIXED_UI_CLEARANCE_REM}rem`,
          }}
        >
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
          paddingBottom: `calc(${FIXED_UI_CLEARANCE_REM}rem + var(--safe-bottom))`,
        }}
      >
        {children}
      </main>
      <BottomNav />
    </div>
  );
}
