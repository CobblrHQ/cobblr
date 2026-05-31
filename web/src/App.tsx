// Top-level shell. AuthProvider hydrates from /me on mount; while
// that's in flight we show nothing (a fast roundtrip avoids flash).
// Once resolved we render the routed authed surface for an authed
// user or the AuthPage otherwise.
//
// Module routes are mounted here as well. Each first-party module
// imports its UI from "@cobblr/<name>/ui"; the host wires it under
// /<module>/* and the module's own internal routes take over.

import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { PlatformWebProvider } from "@cobblr/platform-web";
import { InventoryUI } from "@cobblr/inventory/ui";
import { LabelsBasket, LabelsUI } from "@cobblr/labels/ui";
import { ProjectsUI } from "@cobblr/projects/ui";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { ActiveOrgProvider, useActiveOrg } from "./auth/ActiveOrgContext";
import { AuthPage } from "./pages/AuthPage";
import { Dashboard } from "./pages/Dashboard";
import { InviteAcceptPage } from "./pages/InviteAcceptPage";
import { PublicSurfacePage } from "./pages/PublicSurfacePage";
// Eager: nav-linked pages users hit from the dashboard frequently.
import { MachinesPage } from "./pages/MachinesPage";
import { AssetsPage } from "./pages/AssetsPage";
import { PurchasesPage } from "./pages/PurchasesPage";
import { SearchPage } from "./pages/SearchPage";
import { TagsPage } from "./pages/TagsPage";
import { FilesPage } from "./pages/FilesPage";
import { ViewsPage } from "./pages/ViewsPage";
import { ConfigurationPage } from "./pages/ConfigurationPage";
// Lazy: rarely-visited admin / drill-down pages. Splitting these
// out keeps the dashboard's initial bundle smaller. Each becomes
// its own chunk; the chunk loads on first navigation.
const BindingsPage = lazy(() => import("./pages/BindingsPage").then((m) => ({ default: m.BindingsPage })));
const ActionsPage = lazy(() => import("./pages/ActionsPage").then((m) => ({ default: m.ActionsPage })));
const BundlesPage = lazy(() => import("./pages/BundlesPage").then((m) => ({ default: m.BundlesPage })));
const BuildPage = lazy(() => import("./pages/BuildPage").then((m) => ({ default: m.BuildPage })));
const FieldsPage = lazy(() => import("./pages/FieldsPage").then((m) => ({ default: m.FieldsPage })));
const MeActivityPage = lazy(() => import("./pages/MeActivityPage").then((m) => ({ default: m.MeActivityPage })));
const MeNotificationsPage = lazy(() => import("./pages/MeNotificationsPage").then((m) => ({ default: m.MeNotificationsPage })));
const MeNotificationChannelsPage = lazy(() => import("./pages/MeNotificationChannelsPage").then((m) => ({ default: m.MeNotificationChannelsPage })));
const MeProfilePage = lazy(() => import("./pages/MeProfilePage").then((m) => ({ default: m.MeProfilePage })));
const ApiTokensPage = lazy(() => import("./pages/ApiTokensPage").then((m) => ({ default: m.ApiTokensPage })));
const ActivityPage = lazy(() => import("./pages/ActivityPage").then((m) => ({ default: m.ActivityPage })));
const SurfacesPage = lazy(() => import("./pages/SurfacesPage").then((m) => ({ default: m.SurfacesPage })));
const DigifabPage = lazy(() => import("./pages/DigifabPage").then((m) => ({ default: m.DigifabPage })));
const MaintenancePage = lazy(() => import("./pages/MaintenancePage").then((m) => ({ default: m.MaintenancePage })));
const QrTokensPage = lazy(() => import("./pages/QrTokensPage").then((m) => ({ default: m.QrTokensPage })));
const HealthPage = lazy(() => import("./pages/HealthPage").then((m) => ({ default: m.HealthPage })));
const OpenApiPage = lazy(() => import("./pages/OpenApiPage").then((m) => ({ default: m.OpenApiPage })));
const QueuePage = lazy(() => import("./pages/QueuePage").then((m) => ({ default: m.QueuePage })));
const LinksPage = lazy(() => import("./pages/LinksPage").then((m) => ({ default: m.LinksPage })));
const LocationsPage = lazy(() => import("./pages/LocationsPage").then((m) => ({ default: m.LocationsPage })));
const LocationDetailPage = lazy(() => import("./pages/LocationDetailPage").then((m) => ({ default: m.LocationDetailPage })));
const TemplatesPage = lazy(() => import("./pages/TemplatesPage").then((m) => ({ default: m.TemplatesPage })));
const ScanPage = lazy(() => import("./pages/ScanPage").then((m) => ({ default: m.ScanPage })));
const ScanCameraPage = lazy(() => import("./pages/ScanCameraPage").then((m) => ({ default: m.ScanCameraPage })));
const BundleComposerPage = lazy(() => import("./pages/BundleComposerPage").then((m) => ({ default: m.BundleComposerPage })));
const CatalogsPage = lazy(() => import("./pages/CatalogsPage").then((m) => ({ default: m.CatalogsPage })));
const CatalogDetailPage = lazy(() => import("./pages/CatalogDetailPage").then((m) => ({ default: m.CatalogDetailPage })));
const CatalogMatchPage = lazy(() => import("./pages/CatalogMatchPage").then((m) => ({ default: m.CatalogMatchPage })));
const PresentationPage = lazy(() => import("./pages/PresentationPage").then((m) => ({ default: m.PresentationPage })));
const IntegrationsPage = lazy(() => import("./pages/IntegrationsPage").then((m) => ({ default: m.IntegrationsPage })));
const AiPage = lazy(() => import("./pages/AiPage").then((m) => ({ default: m.AiPage })));
const PortalConfigPage = lazy(() => import("./pages/PortalConfigPage").then((m) => ({ default: m.PortalConfigPage })));
const AppsConfigPage = lazy(() => import("./pages/AppsConfigPage").then((m) => ({ default: m.AppsConfigPage })));
const PermissionsPage = lazy(() => import("./pages/PermissionsPage").then((m) => ({ default: m.PermissionsPage })));
const PortalHomePage = lazy(() => import("./pages/PortalHomePage").then((m) => ({ default: m.PortalHomePage })));
const PortalViewPage = lazy(() => import("./pages/PortalViewPage").then((m) => ({ default: m.PortalViewPage })));
const AppPlayerPage = lazy(() => import("./pages/AppPlayerPage").then((m) => ({ default: m.AppPlayerPage })));
const AppRecordPage = lazy(() => import("./pages/AppPlayerPage").then((m) => ({ default: m.AppRecordPage })));
const BrickLinkPage = lazy(() => import("./pages/BrickLinkPage").then((m) => ({ default: m.BrickLinkPage })));
import { ForcePasswordResetPage } from "./pages/ForcePasswordResetPage";
const UsersPage = lazy(() => import("./pages/UsersPage").then((m) => ({ default: m.UsersPage })));
const SuperAdminPage = lazy(() => import("./pages/SuperAdminPage").then((m) => ({ default: m.SuperAdminPage })));
const RolesPage = lazy(() => import("./pages/RolesPage").then((m) => ({ default: m.RolesPage })));
import { AppLayout } from "./components/AppLayout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { PortalLayout } from "./components/PortalLayout";
import { ToastProvider, ConfirmProvider } from "@cobblr/platform-web";
import { api, getToken } from "./lib/api";
import { InstancePage } from "./pages/InstancePage";

function RouteFallback() {
  return (
    <div className="text-xs font-mono text-slate-400 dark:text-slate-500 p-6">
      loading…
    </div>
  );
}

export function App() {
  return (
    <ErrorBoundary scope="app">
      <AuthProvider>
        <ToastProvider>
          <ConfirmProvider>
            <Shell />
          </ConfirmProvider>
        </ToastProvider>
      </AuthProvider>
    </ErrorBoundary>
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
      {/* /p/:token is the un-auth'd public surface render. Reachable
          signed-in or signed-out — the token is the secret. */}
      <Route path="/p/:token" element={<PublicSurfacePage />} />
      <Route path="*" element={<AuthedOrLogin />} />
    </Routes>
  );
}

function AuthedOrLogin() {
  const { user } = useAuth();
  if (!user) return <AuthPage />;
  // Force-password-reset gate: if the admin minted this account with
  // a temp password, the user must pick a new one before anything
  // else. /me/force-password-reset is rendered standalone (no portal,
  // no admin shell, no nav) so the user can't navigate around it.
  // See docs/PRODUCTION_DEPLOY.md (no-email onboarding).
  if (user.must_reset_password) return <ForcePasswordResetPage />;
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
  const { activeSlug, activeOrg } = useActiveOrg();

  // Shell routing: members + guests land in the portal, admins +
  // owners get the admin shell. If a non-admin lands on an admin
  // route via direct link, the redirect below bounces them. They can
  // navigate freely once in the portal.
  // See docs/design-decisions/member-portal-and-permissions.md.
  const role = activeOrg?.role;
  const onPortal = window.location.pathname.startsWith("/portal/");
  const shouldRedirectToPortal =
    activeSlug &&
    role &&
    role !== "owner" &&
    role !== "admin" &&
    !onPortal;

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
      <Suspense fallback={<RouteFallback />}>
      {shouldRedirectToPortal && <Navigate to={`/portal/${activeSlug}`} replace />}
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
          {/* Per-instance pages (user-created module instances). The
              /* suffix lets a packaged module UI mount its own nested
              routes (e.g. inventory's parts/:id) under the instance. */}
          <Route path="/instances/:name/*" element={<InstancePage />} />
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
          <Route path="/build" element={<BuildPage />} />
          <Route path="/bundles/compose" element={<BundleComposerPage />} />
          <Route path="/fields" element={<FieldsPage />} />
          <Route path="/configuration/tokens" element={<ApiTokensPage />} />
          <Route path="/configuration/surfaces" element={<SurfacesPage />} />
          <Route path="/configuration/digifab" element={<DigifabPage />} />
          <Route path="/configuration/maintenance" element={<MaintenancePage />} />
          <Route path="/configuration/qr-tokens" element={<QrTokensPage />} />
          <Route path="/configuration/health" element={<HealthPage />} />
          <Route path="/configuration/locations" element={<LocationsPage />} />
          <Route path="/configuration/locations/:id" element={<LocationDetailPage />} />
          <Route path="/configuration/templates" element={<TemplatesPage />} />
          <Route path="/scan" element={<ScanPage />} />
          <Route path="/scan/camera" element={<ScanCameraPage />} />
          <Route path="/configuration/presentation" element={<PresentationPage />} />
          <Route path="/configuration/integrations" element={<IntegrationsPage />} />
          <Route path="/configuration/ai" element={<AiPage />} />
          <Route path="/configuration/catalogs" element={<CatalogsPage />} />
          <Route path="/configuration/catalogs/match" element={<CatalogMatchPage />} />
          <Route path="/configuration/catalogs/:id" element={<CatalogDetailPage />} />
          <Route path="/bricklink-connector" element={<BrickLinkPage />} />
          {/* Legacy alias — pre-rename. Bookmarks keep working. */}
          <Route path="/bricklink" element={<BrickLinkPage />} />
          <Route path="/configuration/portal" element={<PortalConfigPage />} />
          <Route path="/configuration/apps" element={<AppsConfigPage />} />
          <Route path="/configuration/permissions" element={<PermissionsPage />} />
          <Route path="/configuration/users" element={<UsersPage />} />
          <Route path="/configuration/roles" element={<RolesPage />} />
          <Route path="/super-admin" element={<SuperAdminPage />} />
          <Route path="/configuration/openapi" element={<OpenApiPage />} />
          <Route path="/configuration/queue" element={<QueuePage />} />
          <Route path="/configuration/links" element={<LinksPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/me/activity" element={<MeActivityPage />} />
          <Route path="/me/notifications" element={<MeNotificationsPage />} />
          <Route path="/me/notification-channels" element={<MeNotificationChannelsPage />} />
          {/* /me is canonical; /me/profile redirects so old bookmarks keep working. */}
          <Route path="/me/profile" element={<Navigate to="/me" replace />} />
          <Route path="/me" element={<MeProfilePage />} />
          <Route path="/core-files" element={<FilesPage />} />
          <Route path="/core-views" element={<ViewsPage />} />
          <Route path="/core-tags" element={<TagsPage />} />
          {/* Short aliases for human-friendly URLs. */}
          <Route path="/files" element={<FilesPage />} />
          <Route path="/views" element={<ViewsPage />} />
          <Route path="/tags" element={<TagsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
        {/* Member portal — sibling route, not nested under AppLayout.
            Same auth + tenant context (PlatformWebProvider above),
            different chrome. /portal/:slug/* is open to every role;
            the page itself decides what to show. */}
        <Route path="/portal/:slug" element={<PortalLayout />}>
          <Route index element={<PortalHomePage />} />
          <Route path="views/:viewId" element={<PortalViewPage />} />
          <Route path="app/:appSlug" element={<AppPlayerPage />} />
          <Route path="app/:appSlug/r/:kind/:id" element={<AppRecordPage />} />
        </Route>
      </Routes>
      </Suspense>
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
