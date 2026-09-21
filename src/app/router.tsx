import { lazy, Suspense } from "react";
import { createBrowserRouter, Outlet, RouterProvider, useNavigate } from "react-router-dom";
import { AppShell } from "./layout/AppShell";
import { ErrorBoundary } from "./ErrorBoundary";
import { AuthGate } from "@/features/auth/AuthGate";
import { Spinner } from "@/components/Spinner";
import { CellarProvider } from "@/hooks/useCellar";
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
function AddWineButton() {
  const navigate = useNavigate();
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

function Root() {
  return (
    <AuthGate>
      <CellarProvider>
        <AppShell>
          <SyncStatusBar />
          <Outlet />
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
        <Route area="Add wine">
          <AddWine />
        </Route>
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
