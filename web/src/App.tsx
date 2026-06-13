// Top-level shell. AuthProvider hydrates from /me on mount; while
// that's in flight we show nothing (a fast roundtrip avoids flash).
// Once resolved we render the routed authed surface for an authed
// user or the AuthPage otherwise.
//
// Module routes are mounted here as well. Each first-party module
// imports its UI from "@cobblr/<name>/ui"; the host wires it under
// /<module>/* and the module's own internal routes take over.

import { lazy, Suspense , useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { PlatformWebProvider } from "@cobblr/platform-web";
import { InventoryUI } from "@cobblr/inventory/ui";
import { LabelsBasket, LabelsUI } from "@cobblr/labels/ui";
import { ProjectsUI } from "@cobblr/projects/ui";
import { ListsUI } from "@cobblr/lists/ui";
import { TrackingUI } from "@cobblr/tracking/ui";
// Side-effect import: registers the UNIVERSAL file renderers (svg, …).
// The FABRICATION renderers (stl/gcode) are gated by FilePreviewGate.
import "@cobblr/core-file-preview/ui";
import { FilePreviewGate } from "./components/FilePreviewGate";
import { InstalledRenderers } from "./components/InstalledRenderers";
import { PairsWellWith } from "./components/PairsWellWith";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { ActiveOrgProvider, useActiveOrg, pickDefaultOrg, urlHandleFor } from "./auth/ActiveOrgContext";
import { AuthPage, MagicConsumePage } from "./pages/AuthPage";
import { FeedbackWidget } from "./components/FeedbackWidget";
import { Dashboard } from "./pages/Dashboard";
import { InviteAcceptPage } from "./pages/InviteAcceptPage";
import { JoinPage } from "./pages/JoinPage";
import { PublicSurfacePage } from "./pages/PublicSurfacePage";
import { QrResolvePage } from "./pages/QrResolvePage";
import { ResetPasswordPage } from "./pages/ResetPasswordPage";
import { VerifyEmailPage } from "./pages/VerifyEmailPage";
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
const CommunicationPreferencesPage = lazy(() => import("./pages/CommunicationPreferencesPage").then((m) => ({ default: m.CommunicationPreferencesPage })));
const MyFeedbackPage = lazy(() => import("./pages/MyFeedbackPage").then((m) => ({ default: m.MyFeedbackPage })));
const DriveSettingsPage = lazy(() => import("./pages/DriveSettingsPage").then((m) => ({ default: m.DriveSettingsPage })));
const ConnectionsPage = lazy(() => import("./pages/ConnectionsPage").then((m) => ({ default: m.ConnectionsPage })));
const ApiTokensPage = lazy(() => import("./pages/ApiTokensPage").then((m) => ({ default: m.ApiTokensPage })));
const ActivityPage = lazy(() => import("./pages/ActivityPage").then((m) => ({ default: m.ActivityPage })));
const SurfacesPage = lazy(() => import("./pages/SurfacesPage").then((m) => ({ default: m.SurfacesPage })));
const DigifabPage = lazy(() => import("./pages/DigifabPage").then((m) => ({ default: m.DigifabPage })));
const PrintPage = lazy(() => import("./pages/PrintPage").then((m) => ({ default: m.PrintPage })));
const MaintenancePage = lazy(() => import("./pages/MaintenancePage").then((m) => ({ default: m.MaintenancePage })));
const UnitsPage = lazy(() => import("./pages/UnitsPage").then((m) => ({ default: m.UnitsPage })));
const CalendarPage = lazy(() => import("./pages/CalendarPage").then((m) => ({ default: m.CalendarPage })));
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
const AdminConsole = lazy(() => import("./pages/AdminConsole").then((m) => ({ default: m.AdminConsole })));
const RolesPage = lazy(() => import("./pages/RolesPage").then((m) => ({ default: m.RolesPage })));
import { AppLayout } from "./components/AppLayout";
import { AdminLayout } from "./components/AdminLayout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { PortalLayout } from "./components/PortalLayout";
import { ToastProvider, ConfirmProvider } from "@cobblr/platform-web";
import { api, getToken } from "./lib/api";
import { InstancePage } from "./pages/InstancePage";

function RouteFallback() {
  return (
    <div className="text-xs font-mono text-faint dark:text-slate-500 p-6">
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

  // The operator console is INSTANCE-wide, not workspace-scoped — it gets
  // its own top-level mount at /admin (no /w/:slug prefix, no tenant
  // context, reachable by a platform admin with ZERO workspaces). Console
  // audit 2026-06-11: the old workspace-nested mount made every console URL
  // contradict the cross-tenant story it tells.
  if (window.location.pathname === "/admin" || window.location.pathname.startsWith("/admin/")) {
    return (
      <BrowserRouter>
        <OperatorRoutes />
      </BrowserRouter>
    );
  }

  // The active workspace lives in the URL: /w/:slug/… . We read it from the
  // raw path (it isn't a route param — it's the router *basename*) and mount
  // the authed app under that basename, so every flat route and absolute link
  // resolves to /w/:slug/… untouched. Each tab's URL owns its workspace.
  const ws = window.location.pathname.match(/^\/w\/([^/]+)/);
  if (ws) {
    return (
      <BrowserRouter basename={`/w/${ws[1]}`}>
        <WorkspaceRoutes urlHandle={ws[1]!} />
      </BrowserRouter>
    );
  }
  // No workspace in the URL: public/token routes, plus a landing redirect
  // that sends an authed user into /w/:default/… (preserving any deep path).
  return (
    <BrowserRouter>
      <PublicRoutes />
    </BrowserRouter>
  );
}

// The operator console's own router branch — top-level /admin/*, no
// workspace basename. Unauthed/non-admin exits happen via full page
// navigations (window.location) in AdminLayout: an in-router <Navigate to="/">
// would loop back into the catch-all here.
function OperatorRoutes() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<Navigate to="/admin/overview" replace />} />
          <Route path=":section" element={<AdminConsole />} />
        </Route>
        <Route path="*" element={<Navigate to="/admin/overview" replace />} />
      </Routes>
    </Suspense>
  );
}

// Routes reachable WITHOUT a workspace in the URL. /invite, /join, /p work
// signed-in or signed-out (the token is the secret). Everything else is a
// landing redirect into the user's workspace.
function PublicRoutes() {
  return (
    <Routes>
      <Route path="/invite/:token" element={<InviteAcceptPage />} />
      {/* /join/:token — redeem a single-use signup invite into a NEW
          account + workspace, even when public signup is disabled. */}
      <Route path="/join/:token" element={<JoinPage />} />
      {/* Password reset + email verification from emailed links — public,
          the token is the secret. */}
      <Route path="/reset/:token" element={<ResetPasswordPage />} />
      <Route path="/verify/:token" element={<VerifyEmailPage />} />
      {/* Emailed magic-link landing: consumes ?token= and signs in. Without it
          the link falls to the catch-all and nothing consumes the token. */}
      <Route path="/auth/magic" element={<MagicConsumePage />} />
      {/* /p/:token is the un-auth'd public surface render. Reachable
          signed-in or signed-out — the token is the secret. */}
      <Route path="/p/:token" element={<PublicSurfacePage />} />
      {/* /qr/:token — printed QR-label resolve (phone-camera scans land
          here bare, signed-in or signed-out). Navigate-mode forwards to
          /w/<org>/<detail>; the workspace shell handles login from there. */}
      <Route path="/qr/:token" element={<QrResolvePage />} />
      {/* Legacy un-prefixed member-portal links → workspace-scoped portal. */}
      <Route path="/portal/:slug/*" element={<PortalSlugRedirect />} />
      <Route path="*" element={<LandingRedirect />} />
    </Routes>
  );
}

// Escape hatch from the workspace router to the top-level operator console.
// Inside the basename router location.pathname is already basename-stripped
// ("/admin/overview"), so replacing with it lands on the top-level mount.
function ConsoleEscape() {
  const loc = useLocation();
  useEffect(() => {
    const path = loc.pathname.startsWith("/admin") ? loc.pathname : "/admin";
    window.location.replace(path + loc.search + loc.hash);
  }, [loc]);
  return <BootScrim />;
}

// A bare URL (no /w/:slug): once authed, redirect into the user's default
// workspace, preserving any deep path so old bookmarks keep working.
function LandingRedirect() {
  const { user, orgs } = useAuth();
  if (!user) return <AuthPage />;
  if (user.must_reset_password) return <ForcePasswordResetPage />;
  const org = pickDefaultOrg(orgs);
  if (!org) {
    // No workspace yet (admin-minted account with no org). A platform admin
    // can still operate — the console is instance-wide, not workspace-bound.
    return (
      <div className="min-h-full flex flex-col items-center justify-center gap-3 text-faint font-mono text-xs">
        <span>no workspace yet — ask an admin to add you to one.</span>
        {user.is_platform_admin && (
          <a href="/admin" className="text-accent underline">
            open the operator console
          </a>
        )}
      </div>
    );
  }
  const { pathname, search, hash } = window.location;
  const rest = pathname === "/" ? "/" : pathname; // preserve a deep-linked path
  window.location.replace(`/w/${urlHandleFor(org, orgs)}${rest}${search}${hash}`);
  return <BootScrim />;
}

// /portal/:slug/… (legacy, un-prefixed) → /w/:slug/portal/:slug/… so the
// member portal lives under the workspace basename like everything else.
function PortalSlugRedirect() {
  const { pathname, search, hash } = window.location;
  const m = pathname.match(/^\/portal\/([^/]+)/);
  const slug = m?.[1];
  if (slug) window.location.replace(`/w/${slug}${pathname}${search}${hash}`);
  return <BootScrim />;
}

function WorkspaceRoutes({ urlHandle }: { urlHandle: string }) {
  const { user } = useAuth();
  if (!user) return <AuthPage />;
  // Force-password-reset gate: if the admin minted this account with
  // a temp password, the user must pick a new one before anything
  // else. /me/force-password-reset is rendered standalone (no portal,
  // no admin shell, no nav) so the user can't navigate around it.
  // See docs/operations/PRODUCTION_DEPLOY.md (no-email onboarding).
  if (user.must_reset_password) return <ForcePasswordResetPage />;
  return (
    <ActiveOrgProvider urlHandle={urlHandle}>
      <ActiveOrgScopedRoutes />
    </ActiveOrgProvider>
  );
}

/** /w/:slug/app/:appSlug → the portal app player for the active workspace,
 *  so deep-links don't need to embed the slug. */
function WorkspaceAppRedirect() {
  const { appSlug } = useParams<{ appSlug: string }>();
  const { activeSlug } = useActiveOrg();
  return <Navigate to={`/portal/${activeSlug}/app/${appSlug}`} replace />;
}

function ActiveOrgScopedRoutes() {
  const { activeSlug, activeOrg } = useActiveOrg();
  const location = useLocation();

  // Shell routing: members + guests land in the portal; owners, admins, and
  // editors get the full builder shell. If a non-builder lands on a builder
  // route via direct link, the redirect below bounces them. They can navigate
  // freely once in the portal. See docs/modules/member-portal-and-permissions.md.
  const role = activeOrg?.role;
  // basename-relative (react-router strips the /w/:slug base) — NOT
  // window.location.pathname, which still carries the base.
  const onPortal = location.pathname.startsWith("/portal/");
  // The operator console is a separate shell — workspace chrome (the
  // feedback bubble, the label-print basket + its module polling) must not
  // leak into it. Audit 2026-06-11: LabelsBasket polled /modules/labels/queue
  // (409 noise on every /admin page) and the operator got a "send feedback"
  // bubble pointed at themselves.
  const onAdmin = location.pathname === "/admin" || location.pathname.startsWith("/admin/");
  const shouldRedirectToPortal =
    activeSlug &&
    role &&
    role !== "owner" &&
    role !== "admin" &&
    role !== "editor" &&
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
        listUnits: (slug) => api.listUnits(slug),
        addUnit: (slug, unit) => api.addUnit(slug, unit),
        deleteUnit: (slug, code) => api.deleteUnit(slug, code).then(() => undefined),
        setUnitDisplayMode: (slug, mode) => api.setUnitDisplayMode(slug, mode),
      }}
    >
      <Suspense fallback={<RouteFallback />}>
      {/* Host gate: turns the fabrication file renderers on/off with the
          active workspace's machine domains. core-file-preview stays
          domain-agnostic; this is the integrator wiring (see the file). */}
      <FilePreviewGate />
      <InstalledRenderers />
      {/* Always-on feedback button for every signed-in user — except the
          operator console, where the operator IS the recipient. */}
      {!onAdmin && <FeedbackWidget />}
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
          <Route
            path="/lists/*"
            element={
              <>
                <ListsUI orgSlug={activeSlug} getToken={getToken} />
                <div className="max-w-4xl"><PairsWellWith module="lists" orgSlug={activeSlug} /></div>
              </>
            }
          />
          <Route
            path="/tracking/*"
            element={
              <>
                <TrackingUI orgSlug={activeSlug} getToken={getToken} />
                <div className="max-w-4xl"><PairsWellWith module="tracking" orgSlug={activeSlug} /></div>
              </>
            }
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
          <Route path="/configuration/print" element={<PrintPage />} />
          <Route path="/configuration/maintenance" element={<MaintenancePage />} />
          <Route path="/configuration/units" element={<UnitsPage />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/configuration/qr-tokens" element={<QrTokensPage />} />
          <Route path="/configuration/health" element={<HealthPage />} />
          <Route path="/configuration/locations" element={<LocationsPage />} />
          <Route path="/configuration/locations/:id" element={<LocationDetailPage />} />
          <Route path="/configuration/templates" element={<TemplatesPage />} />
          <Route path="/scan" element={<ScanPage />} />
          <Route path="/scan/camera" element={<ScanCameraPage />} />
          {/* QR-label resolve inside the workspace: the in-app scanner
              navigates here on a label hit, and LandingRedirect rewrites
              bare /qr/<token> URLs into /w/<default>/qr/<token>. */}
          <Route path="/qr/:token" element={<QrResolvePage />} />
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
          <Route path="/configuration/openapi" element={<OpenApiPage />} />
          <Route path="/configuration/queue" element={<QueuePage />} />
          <Route path="/configuration/links" element={<LinksPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/me/activity" element={<MeActivityPage />} />
          <Route path="/me/notifications" element={<MeNotificationsPage />} />
          <Route path="/me/notification-channels" element={<MeNotificationChannelsPage />} />
          <Route path="/me/communication" element={<CommunicationPreferencesPage />} />
          <Route path="/me/feedback" element={<MyFeedbackPage />} />
          <Route path="/me/drive" element={<DriveSettingsPage />} />
          {/* /me is canonical; /me/profile redirects so old bookmarks keep working. */}
          <Route path="/me/profile" element={<Navigate to="/me" replace />} />
          <Route path="/me" element={<MeProfilePage />} />
          <Route path="/me/connections" element={<ConnectionsPage />} />
          <Route path="/core-files" element={<FilesPage />} />
          <Route path="/core-views" element={<ViewsPage />} />
          <Route path="/core-tags" element={<TagsPage />} />
          {/* Short aliases for human-friendly URLs. */}
          <Route path="/files" element={<FilesPage />} />
          <Route path="/views" element={<ViewsPage />} />
          <Route path="/tags" element={<TagsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
        {/* Convenience deep-link: /w/:slug/app/:appSlug → the portal app
            player (so a bundle's "Open the X app" next-step + dashboard
            setup card resolve without knowing the slug). */}
        <Route path="/app/:appSlug" element={<WorkspaceAppRedirect />} />
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
        {/* The operator console now lives at TOP-LEVEL /admin (instance-wide,
            no workspace prefix — see Shell). Old workspace-nested URLs
            (/w/:slug/admin/…, /w/:slug/super-admin) escape with a full
            navigation so bookmarks keep working. */}
        <Route path="/admin/*" element={<ConsoleEscape />} />
        <Route path="/super-admin" element={<ConsoleEscape />} />
      </Routes>
      </Suspense>
      {!onAdmin && <LabelsBasket orgSlug={activeSlug} getToken={getToken} />}
    </PlatformWebProvider>
  );
}

function BootScrim() {
  return (
    <div className="min-h-full flex items-center justify-center text-faint font-mono text-xs">
      …
    </div>
  );
}
