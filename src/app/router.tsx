import { lazy, Suspense } from "react";
import { createBrowserRouter, Outlet, RouterProvider } from "react-router-dom";
import { AppShell } from "./layout/AppShell";
import { ErrorBoundary } from "./ErrorBoundary";
import { AuthGate } from "@/features/auth/AuthGate";
import { Spinner } from "@/components/Spinner";

// Lazy so heavy features (rack, atlas) never enter the initial bundle.
const Home = lazy(() => import("@/features/home"));
const Cellar = lazy(() => import("@/features/cellar"));
const Storage = lazy(() => import("@/features/storage"));
const Atlas = lazy(() => import("@/features/atlas"));
const More = lazy(() => import("@/features/more"));

function Route({ area, children }: { area: string; children: React.ReactNode }) {
  return (
    <ErrorBoundary area={area}>
      <Suspense fallback={<Spinner />}>{children}</Suspense>
    </ErrorBoundary>
  );
}

function Root() {
  return (
    <AuthGate>
      <AppShell>
        <Outlet />
      </AppShell>
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
            <Cellar />
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
        path: "atlas",
        element: (
          <Route area="Atlas">
            <Atlas />
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
