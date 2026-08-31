export interface NavItem {
  path: string;
  label: string;
  /** Short label for the mobile bar. */
  short: string;
  icon: string;
}

/**
 * Five destinations. Five is the practical ceiling for a mobile bottom bar.
 *
 * Rack deliberately lives INSIDE Storage rather than at top level — it is
 * one layout of one location, and promoting it would re-encode the V2
 * assumption that every user has exactly one rack.
 */
export const NAV: NavItem[] = [
  { path: "/", label: "Home", short: "Home", icon: "◉" },
  { path: "/cellar", label: "Cellar", short: "Cellar", icon: "◈" },
  { path: "/storage", label: "Storage", short: "Storage", icon: "▤" },
  { path: "/atlas", label: "Atlas", short: "Atlas", icon: "◍" },
  { path: "/more", label: "More", short: "More", icon: "⋯" },
];
