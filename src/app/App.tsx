import { AuthProvider } from "./providers/AuthProvider";
import { AppRouter } from "./router";
import { ErrorBoundary } from "./ErrorBoundary";

export function App() {
  return (
    <ErrorBoundary area="Cellar Atlas">
      <AuthProvider>
        <AppRouter />
      </AuthProvider>
    </ErrorBoundary>
  );
}
