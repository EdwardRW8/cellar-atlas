import { lazy, Suspense, type ReactNode } from "react";
import {
  createBrowserRouter,
  Outlet,
  RouterProvider,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { AppShell } from "./layout/AppShell";
import { ErrorBoundary } from "./ErrorBoundary";
import { AuthGate } from "@/features/auth/AuthGate";
import { Spinner } from "@/components/Spinner";
import { CellarProvider, useCellar } from "@/hooks/useCellar";
import { NoCellarNotice } from "@/components/NoCellarNotice";
import { SyncStatusBar } from "@/features/sync/SyncStatusBar";
import { ADD_BUTTON_OFFSET_REM, ADD_BUTTON_SIZE_PX } from "@/styles/tokens";

// Lazy so heavy features never enter the initial bundle.
const Home = lazy(() => import("@/features/home"));
const Collection = lazy(() => import("@/features/cellar/CollectionScreen"));
const WineDetail = lazy(() => import("@/features/cellar/WineDetailScreen"));
const BottleDetail = lazy(() => import("@/features/cellar/BottleDetailScreen"));
const AddWine = lazy(() => import("@/features/add-wine/AddWineScreen"));
const Storage = lazy(() => import("@/features/storage/StorageScreen"));
const StorageDetail = lazy(() => import("@/features/storage/StorageDetailScreen"));
const Atlas = lazy(() => import("@/features/atlas"));
const GeographyFix = lazy(() => import("@/features/atlas/GeographyFixScreen"));
const Intelligence = lazy(() => import("@/features/intelligence/IntelligenceScreen"));
const Profile = lazy(() => import("@/features/profile/ProfileScreen"));
const History = lazy(() => import("@/features/history/HistoryScreen"));
const TastingLog = lazy(() => import("@/features/tasting/TastingLogScreen"));
// Lazy: PapaParse and the planner only load when someone actually imports.
const ImportWines = lazy(() => import("@/features/import/ImportScreen"));
const More = lazy(() => import("@/features/more"));

function Route({ area, children }: { area: string; children: React.ReactNode }) {
  return (
    <ErrorBoundary area={area}>
      <Suspense fallback={<Spinner />}>{children}</Suspense>
    </ErrorBoundary>
  );
}

/** Add Wine is always one tap away — the most frequent action. */
/** Exported so the no-cellar behaviour can be tested directly. */
export function AddWineButton() {
  const navigate = useNavigate();
  const { state } = useCellar();

  // Nothing to add a wine to yet, and /add is gated anyway — so the button is
  // hidden rather than left as a route to a blocked screen.
  if (state === "no-cellar") return null;

  return (
    <button
      onClick={() => navigate("/add")}
      aria-label="Add wine"
      style={{
        position: "fixed",
        bottom: `calc(${ADD_BUTTON_OFFSET_REM}rem + var(--safe-bottom))`,
        right: "1rem",
        zIndex: 95,
        minWidth: ADD_BUTTON_SIZE_PX,
        minHeight: ADD_BUTTON_SIZE_PX,
        borderRadius: "50%",
        background: "linear-gradient(135deg,#8B5E2C,#D9AE55)",
        color: "#0A0705",
        fontSize: "1.5rem",
        fontWeight: 600,
        boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
        border: "none",
      }}
    >
      +
    </button>
  );
}

/**
 * Blocks every route except Home while the user has no cellar.
 *
 * Most screens only branch on `state === "loading"`, so in `no-cellar` they
 * rendered as though everything were ready with no cellar behind them —
 * Storage showed a create form whose button could do nothing. Gating once here
 * covers every route, including those added later. The per-screen branches
 * stay as a second layer.
 *
 * Home is exempt: it owns the onboarding that creates the cellar.
 */
export function NoCellarGate({ children }: { children: ReactNode }) {
  const { state } = useCellar();
  const { pathname } = useLocation();

  if (state === "no-cellar" && pathname !== "/") {
    return (
      <div style={{ padding: "1.25rem" }}>
        <NoCellarNotice what="This becomes available" />
      </div>
    );
  }
  return <>{children}</>;
}

function Root() {
  return (
    <AuthGate>
      <CellarProvider>
        <AppShell>
          <SyncStatusBar />
          <NoCellarGate>
            <Outlet />
          </NoCellarGate>
          <AddWineButton />
        </AppShell>
      </CellarProvider>
    </AuthGate>
  );
}

/** Add Wine is a full route, not a modal — it must survive a back swipe. */
function AddWineRoot() {
  return (
    <AuthGate>
      <CellarProvider>
        {/*
          Add Wine has its OWN provider and does not render through Root's
          Outlet, so Root's gate never sees it. Without this, a new user could
          reach the form with no cellar behind it.
        */}
        <NoCellarGate>
          <Route area="Add wine">
            <AddWine />
          </Route>
        </NoCellarGate>
      </CellarProvider>
    </AuthGate>
  );
}

function NotFound() {
  return (
    <div style={{ padding: "3rem 1.25rem", textAlign: "center" }}>
      <h1
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "1.5rem",
          fontStyle: "italic",
        }}
      >
        Page not found
      </h1>
    </div>
  );
}

export const router = createBrowserRouter([
  { path: "/add", element: <AddWineRoot /> },
  {
    path: "/",
    element: <Root />,
    children: [
      {
        index: true,
        element: (
          <Route area="Home">
            <Home />
          </Route>
        ),
      },
      {
        path: "cellar",
        element: (
          <Route area="Cellar">
            <Collection />
          </Route>
        ),
      },
      {
        path: "cellar/wine/:wineId",
        element: (
          <Route area="Wine">
            <WineDetail />
          </Route>
        ),
      },
      {
        path: "cellar/bottle/:bottleId",
        element: (
          <Route area="Bottle">
            <BottleDetail />
          </Route>
        ),
      },
      {
        path: "storage",
        element: (
          <Route area="Storage">
            <Storage />
          </Route>
        ),
      },
      {
        path: "storage/:locationId",
        element: (
          <Route area="Storage">
            <StorageDetail />
          </Route>
        ),
      },
      {
        path: "atlas",
        element: (
          <Route area="Atlas">
            <Atlas />
          </Route>
        ),
      },
      {
        path: "atlas/fix",
        element: (
          <Route area="Atlas">
            <GeographyFix />
          </Route>
        ),
      },
      {
        path: "intelligence",
        element: (
          <Route area="Intelligence">
            <Intelligence />
          </Route>
        ),
      },
      {
        path: "profile",
        element: (
          <Route area="Profile">
            <Profile />
          </Route>
        ),
      },
      {
        path: "import",
        element: (
          <Route area="Import wines">
            <ImportWines />
          </Route>
        ),
      },
      {
        path: "history",
        element: (
          <Route area="History">
            <History />
          </Route>
        ),
      },
      {
        path: "tastings",
        element: (
          <Route area="Tastings">
            <TastingLog />
          </Route>
        ),
      },
      {
        path: "more",
        element: (
          <Route area="More">
            <More />
          </Route>
        ),
      },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
