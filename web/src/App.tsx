// Top-level shell. AuthProvider hydrates from /me on mount; while
// that's in flight we show nothing (a fast roundtrip avoids flash).
// Once resolved we render the routed authed surface for an authed
// user or the AuthPage otherwise.
//
// Module routes are mounted here as well. Each first-party module
// imports its UI from "@cobblr/<name>/ui"; the host wires it under
// /<module>/* and the module's own internal routes take over.

import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { PlatformWebProvider } from "@cobblr/platform-web";
import { InventoryUI } from "@cobblr/inventory/ui";
import { LabelsBasket, LabelsUI } from "@cobblr/labels/ui";
import { ProjectsUI } from "@cobblr/projects/ui";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { ActiveOrgProvider, useActiveOrg } from "./auth/ActiveOrgContext";
import { AuthPage } from "./pages/AuthPage";
import { Dashboard } from "./pages/Dashboard";
import { BindingsPage } from "./pages/BindingsPage";
import { ActionsPage } from "./pages/ActionsPage";
import { BundlesPage } from "./pages/BundlesPage";
import { FieldsPage } from "./pages/FieldsPage";
import { InviteAcceptPage } from "./pages/InviteAcceptPage";
import { ApiTokensPage } from "./pages/ApiTokensPage";
import { ActivityPage } from "./pages/ActivityPage";
import { MachinesPage } from "./pages/MachinesPage";
import { AssetsPage } from "./pages/AssetsPage";
import { PurchasesPage } from "./pages/PurchasesPage";
import { ConfigurationPage } from "./pages/ConfigurationPage";
import { AppLayout } from "./components/AppLayout";
import { ToastProvider, ConfirmProvider } from "@cobblr/platform-web";
import { api, getToken } from "./lib/api";

export function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <ConfirmProvider>
          <Shell />
        </ConfirmProvider>
      </ToastProvider>
    </AuthProvider>
  );
}

function Shell() {
  const { loading } = useAuth();
  if (loading) return <BootScrim />;
  return (
    <BrowserRouter>
      <RootRoutes />
    </BrowserRouter>
  );
}

// /invite/:token is reachable signed-in OR signed-out (preview works
// either way; the page bounces unauth'd users through sign-in). All
// other paths fall through to the auth gate.
function RootRoutes() {
  return (
    <Routes>
      <Route path="/invite/:token" element={<InviteAcceptPage />} />
      <Route path="*" element={<AuthedOrLogin />} />
    </Routes>
  );
}

function AuthedOrLogin() {
  const { user } = useAuth();
  if (!user) return <AuthPage />;
  return <AuthedRoutes />;
}

function AuthedRoutes() {
  return (
    <ActiveOrgProvider>
      <ActiveOrgScopedRoutes />
    </ActiveOrgProvider>
  );
}

function ActiveOrgScopedRoutes() {
  const { activeSlug } = useActiveOrg();

  return (
    <PlatformWebProvider
      orgSlug={activeSlug}
      api={{
        listActions: (slug, kind) => api.listActions(slug, kind),
        invokeAction: (slug, body) => api.invokeAction(slug, body),
        lookupEntity: (slug, kind, id) => api.lookupEntity(slug, kind, id),
        listFieldDefs: (slug, kind) => api.listFieldDefs(slug, kind),
        appendFieldDefChoice: (slug, id, value) =>
          api.appendFieldDefChoice(slug, id, value),
      }}
    >
      <Routes>
        <Route element={<AppLayout activeSlug={activeSlug} />}>
          <Route index element={<Dashboard />} />
          <Route
            path="/inventory/*"
            element={<InventoryUI orgSlug={activeSlug} getToken={getToken} />}
          />
          <Route
            path="/labels/*"
            element={<LabelsUI orgSlug={activeSlug} getToken={getToken} />}
          />
          <Route
            path="/projects/*"
            element={<ProjectsUI orgSlug={activeSlug} getToken={getToken} />}
          />
          <Route path="/machines" element={<MachinesPage />} />
          <Route path="/machines/:id" element={<MachinesPage />} />
          <Route path="/assets" element={<AssetsPage />} />
          <Route path="/assets/:id" element={<AssetsPage />} />
          <Route path="/purchases" element={<PurchasesPage />} />
          <Route path="/purchases/:id" element={<PurchasesPage />} />
          <Route path="/configuration" element={<ConfigurationPage />} />
          <Route path="/bindings" element={<BindingsPage />} />
          <Route path="/actions" element={<ActionsPage />} />
          <Route path="/bundles" element={<BundlesPage />} />
          <Route path="/fields" element={<FieldsPage />} />
          <Route path="/configuration/tokens" element={<ApiTokensPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <LabelsBasket orgSlug={activeSlug} getToken={getToken} />
    </PlatformWebProvider>
  );
}

function BootScrim() {
  return (
    <div className="min-h-full flex items-center justify-center text-slate-400 font-mono text-xs">
      …
    </div>
  );
}
