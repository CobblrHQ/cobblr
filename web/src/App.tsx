// Top-level shell. The AuthProvider hydrates from /me on mount;
// while that's in flight we show nothing (a fast roundtrip avoids
// flash). Once resolved we render the Dashboard for an authed user
// or the AuthPage otherwise. Routing graduates to React Router when
// Phase 1 introduces multiple authenticated pages.

import { AuthProvider, useAuth } from "./auth/AuthContext";
import { AuthPage } from "./pages/AuthPage";
import { Dashboard } from "./pages/Dashboard";

export function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}

function Shell() {
  const { user, loading } = useAuth();
  if (loading) return <BootScrim />;
  return user ? <Dashboard /> : <AuthPage />;
}

function BootScrim() {
  return (
    <div className="min-h-full flex items-center justify-center text-slate-400 font-mono text-xs">
      …
    </div>
  );
}
