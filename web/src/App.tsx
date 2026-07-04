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
import { BuildsUI } from "@cobblr/builds/ui";
import { SalesUI } from "@cobblr/sales/ui";
import { TrackingUI } from "@cobblr/tracking/ui";
// Side-effect import: registers the UNIVERSAL file renderers (svg, …).
// The FABRICATION renderers (stl/gcode) are gated by FilePreviewGate.
import "@cobblr/core-file-preview/ui";
import { FilePreviewGate } from "./components/FilePreviewGate";
import { InstalledRenderers } from "./components/InstalledRenderers";
import { PairsWellWith } from "./components/PairsWellWith";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { useTheme } from "./theme/ThemeContext";
import { ActiveOrgProvider, useActiveOrg, pickDefaultOrg, urlHandleFor } from "./auth/ActiveOrgContext";
import { AuthPage, MagicConsumePage } from "./pages/AuthPage";
import { PairPage } from "./pages/PairPage";
import { StartAppPage } from "./pages/StartAppPage";
import { FeedbackWidget } from "./components/FeedbackWidget";
import { Dashboard } from "./pages/Dashboard";
import { InviteAcceptPage } from "./pages/InviteAcceptPage";
import { JoinPage } from "./pages/JoinPage";
import { JoinMachinesPage } from "./pages/JoinMachinesPage";
import { PublicSurfacePage } from "./pages/PublicSurfacePage";
import { ChangelogPage } from "./pages/ChangelogPage";
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
import { ConfigurationLayout } from "./components/ConfigurationLayout";
import { ConfigMembersPage, ConfigModulesPage, ConfigNewThingPage } from "./pages/ConfigLauncherPages";
// Lazy: rarely-visited admin / drill-down pages. Splitting these
// out keeps the dashboard's initial bundle smaller. Each becomes
// its own chunk; the chunk loads on first navigation.
const BindingsPage = lazy(() => import("./pages/BindingsPage").then((m) => ({ default: m.BindingsPage })));
const ActionsPage = lazy(() => import("./pages/ActionsPage").then((m) => ({ default: m.ActionsPage })));
const BundlesPage = lazy(() => import("./pages/BundlesPage").then((m) => ({ default: m.BundlesPage })));
const BuildPage = lazy(() => import("./pages/BuildPage").then((m) => ({ default: m.BuildPage })));
const FieldsPage = lazy(() => import("./pages/FieldsPage").then((m) => ({ default: m.FieldsPage })));
const FormBuilderPage = lazy(() => import("./pages/FormBuilderPage").then((m) => ({ default: m.FormBuilderPage })));
const MeActivityPage = lazy(() => import("./pages/MeActivityPage").then((m) => ({ default: m.MeActivityPage })));
const MeNotificationsPage = lazy(() => import("./pages/MeNotificationsPage").then((m) => ({ default: m.MeNotificationsPage })));
const MeNotificationChannelsPage = lazy(() => import("./pages/MeNotificationChannelsPage").then((m) => ({ default: m.MeNotificationChannelsPage })));
const MeProfilePage = lazy(() => import("./pages/MeProfilePage").then((m) => ({ default: m.MeProfilePage })));
const AppSettingsPage = lazy(() => import("./pages/AppSettingsPage").then((m) => ({ default: m.AppSettingsPage })));
const CommunicationPreferencesPage = lazy(() => import("./pages/CommunicationPreferencesPage").then((m) => ({ default: m.CommunicationPreferencesPage })));
const MyFeedbackPage = lazy(() => import("./pages/MyFeedbackPage").then((m) => ({ default: m.MyFeedbackPage })));
const DriveSettingsPage = lazy(() => import("./pages/DriveSettingsPage").then((m) => ({ default: m.DriveSettingsPage })));
const ConnectionsPage = lazy(() => import("./pages/ConnectionsPage").then((m) => ({ default: m.ConnectionsPage })));
const ApiTokensPage = lazy(() => import("./pages/ApiTokensPage").then((m) => ({ default: m.ApiTokensPage })));
const ActivityPage = lazy(() => import("./pages/ActivityPage").then((m) => ({ default: m.ActivityPage })));
const SurfacesPage = lazy(() => import("./pages/SurfacesPage").then((m) => ({ default: m.SurfacesPage })));
const DigifabPage = lazy(() => import("./pages/DigifabPage").then((m) => ({ default: m.DigifabPage })));
const EdgeBridgesPage = lazy(() => import("./pages/EdgeBridgesPage").then((m) => ({ default: m.EdgeBridgesPage })));
const PrintPage = lazy(() => import("./pages/PrintPage").then((m) => ({ default: m.PrintPage })));
const MaintenancePage = lazy(() => import("./pages/MaintenancePage").then((m) => ({ default: m.MaintenancePage })));
const UnitsPage = lazy(() => import("./pages/UnitsPage").then((m) => ({ default: m.UnitsPage })));
const BackupPage = lazy(() => import("./pages/BackupPage").then((m) => ({ default: m.BackupPage })));
const CalendarPage = lazy(() => import("./pages/CalendarPage").then((m) => ({ default: m.CalendarPage })));
const QrPage = lazy(() => import("./pages/QrPage").then((m) => ({ default: m.QrPage })));
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
// Generic renderer for hosted-only settings panels (billing/Slack live in the
// closed overlay and are returned as declarative views; no panel-specific code
// ships in open core).
const HostedPanelPage = lazy(() => import("./pages/HostedPanelPage").then((m) => ({ default: m.HostedPanelPage })));
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
import { ImpersonationBanner } from "./components/ImpersonationBanner";
import { AdminLayout } from "./components/AdminLayout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { PortalLayout } from "./components/PortalLayout";
import { ToastProvider, ConfirmProvider } from "@cobblr/platform-web";
import { api, getToken } from "./lib/api";
import { useQuery } from "@tanstack/react-query";
import { InstancePage } from "./pages/InstancePage";

function RouteFallback() {
  return (
    <div className="text-xs font-mono text-faint dark:text-slate-500 p-6">
      loading…
    </div>
  );
}

/** Applies the signed-in user's server-stored theme preference on login, so a
 *  fresh device follows the user's choice instead of the OS default. Renders
 *  nothing; lives inside AuthProvider (the ThemeProvider is an ancestor from
 *  main.tsx). Only syncs — the user's own toggle owns changes + persistence. */
function ThemeSync() {
  const { user } = useAuth();
  const { syncFromServer } = useTheme();
  useEffect(() => {
    syncFromServer(user?.theme_pref ?? null);
  }, [user?.theme_pref, syncFromServer]);
  return null;
}

export function App() {
  return (
    <ErrorBoundary scope="app">
      <AuthProvider>
        <ThemeSync />
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
        {/* Portaled to body — overlays whichever shell renders (AppLayout /
            PortalLayout / AppPlayer) while an operator is impersonating. */}
        <ImpersonationBanner />
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
      {/* /join-machines/:ownerOrg/:token — accept an invite to another
          workspace's edge-bridge machines; pick which of your workspaces. */}
      <Route path="/join-machines/:ownerOrg/:token" element={<JoinMachinesPage />} />
      {/* Password reset + email verification from emailed links — public,
          the token is the secret. */}
      <Route path="/reset/:token" element={<ResetPasswordPage />} />
      <Route path="/verify/:token" element={<VerifyEmailPage />} />
      {/* Emailed magic-link landing: consumes ?token= and signs in. Without it
          the link falls to the catch-all and nothing consumes the token. */}
      <Route path="/auth/magic" element={<MagicConsumePage />} />
      {/* /pair?code=… — phone-side QR pair-login landing. Claims the code the
          desktop minted and signs the phone in to that workspace. Reached
          unauthenticated (the code is the secret). */}
      <Route path="/pair" element={<PairPage />} />
      {/* /p/:token is the un-auth'd public surface render. Reachable
          signed-in or signed-out — the token is the secret. */}
      <Route path="/p/:token" element={<PublicSurfacePage />} />
      {/* Public "What's new" feed — reachable signed-in or signed-out. */}
      <Route path="/changelog" element={<ChangelogPage />} />
      {/* /qr/:token — printed QR-label resolve (phone-camera scans land
          here bare, signed-in or signed-out). Navigate-mode forwards to
          /w/<org>/<detail>; the workspace shell handles login from there. */}
      <Route path="/qr/*" element={<QrResolvePage />} />
      {/* Streamlined consumer signup for a managed app ("Cobblr for Yarn"). */}
      <Route path="/start/:app" element={<StartAppPage />} />
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
  // Only mount the labels print-basket when the labels module is actually
  // enabled. Otherwise its BasketWidget polls /modules/labels/queue every
  // render and floods the console with 409s (the module's routes aren't
  // mounted when it's off — e.g. managed apps like Cobblr-for-Yarn). Shares
  // the cached ["org-modules"] query the nav already fetches → no extra request.
  const orgModulesQ = useQuery({
    queryKey: ["org-modules", activeSlug],
    queryFn: () => api.orgModules(activeSlug),
    enabled: !!activeSlug,
    staleTime: 30_000,
  });
  // Named instances get a CLEAN top-level URL (`/3d-printers`, `/yarn`) — not
  // `/instances/3d-printers` — so a specialisation reads as its own first-class
  // thing in the address bar. Registered as explicit per-instance routes below
  // (the canonical `/instances/:name` stays for back-compat / old bookmarks).
  const instancesQ = useQuery({
    queryKey: ["instances", activeSlug],
    queryFn: () => api.listInstances(activeSlug),
    enabled: !!activeSlug,
    staleTime: 30_000,
  });
  const labelsEnabled = (orgModulesQ.data?.items ?? []).some(
    (m) => m.name === "labels" && m.enabled,
  );
  const shouldRedirectToPortal =
    activeSlug &&
    role &&
    role !== "owner" &&
    role !== "admin" &&
    role !== "editor" &&
    !onPortal;

  // Managed-app lock-down: when the active workspace is a managed vertical app
  // ("Cobblr for Yarn"), the user only ever sees the app — its instance tables,
  // the scanner, and their own account. Every other route (the dashboard,
  // marketplace, bundles, configuration, wires, fields, other modules) bounces
  // to the app home, so a non-technical user never reaches the platform. A
  // WHITELIST (not blacklist) so new platform pages are blocked by default.
  // See business-models/docs/18-managed-vertical-apps.md.
  const appMode = activeOrg?.app_mode ?? null;
  const APP_ALLOWED = ["/instances", "/scan", "/me"];
  const inAppSurface = APP_ALLOWED.some(
    (p) => location.pathname === p || location.pathname.startsWith(p + "/"),
  );
  const shouldRedirectToAppHome = !!appMode && !inAppSurface;

  return (
    <PlatformWebProvider
      orgSlug={activeSlug}
      appMode={!!appMode}
      api={{
        listActions: (slug, kind) => api.listActions(slug, kind),
        invokeAction: (slug, body) => api.invokeAction(slug, body),
        lookupEntity: (slug, kind, id) => api.lookupEntity(slug, kind, id),
        listEntities: (slug, kind, q) => api.listEntities(slug, kind, q),
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
      {shouldRedirectToAppHome && <Navigate to={appMode!.home_path} replace />}
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
            path="/builds/*"
            element={
              <>
                <BuildsUI orgSlug={activeSlug} getToken={getToken} />
                <div className="max-w-4xl"><PairsWellWith module="builds" orgSlug={activeSlug} /></div>
              </>
            }
          />
          <Route
            path="/sales/*"
            element={
              <>
                <SalesUI orgSlug={activeSlug} getToken={getToken} />
                <div className="max-w-4xl"><PairsWellWith module="sales" orgSlug={activeSlug} /></div>
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
          {/* Clean top-level alias per named instance: `/3d-printers` renders the
              instance directly (the prop overrides the route param). */}
          {(instancesQ.data?.items ?? [])
            .filter((i) => !i.is_default)
            .map((i) => (
              <Route
                key={i.instance_name}
                path={`/${i.instance_name}/*`}
                element={<InstancePage instanceName={i.instance_name} />}
              />
            ))}
          <Route path="/machines" element={<MachinesPage />} />
          <Route path="/machines/:id" element={<MachinesPage />} />
          <Route path="/assets" element={<AssetsPage />} />
          <Route path="/assets/:id" element={<AssetsPage />} />
          <Route path="/purchases" element={<PurchasesPage />} />
          <Route path="/purchases/:id" element={<PurchasesPage />} />
          {/* Every /configuration/* page renders inside ConfigurationLayout —
              a persistent grouped sidebar (2026-07 settings rework) so moving
              between settings never bounces back through the hub. Routes are
              unchanged; only the shell around them is new. */}
          <Route element={<ConfigurationLayout />}>
            <Route path="/configuration" element={<ConfigurationPage />} />
            {/* Launcher PAGES (settings-cohesion): the dialogs, in-flow. */}
            <Route path="/configuration/modules" element={<ConfigModulesPage />} />
            <Route path="/configuration/members" element={<ConfigMembersPage />} />
            <Route path="/configuration/new-thing" element={<ConfigNewThingPage />} />
            <Route path="/configuration/form-builder" element={<FormBuilderPage />} />
            <Route path="/configuration/tokens" element={<ApiTokensPage />} />
            <Route path="/configuration/surfaces" element={<SurfacesPage />} />
            <Route path="/configuration/digifab" element={<DigifabPage setupOnly />} />
            <Route path="/configuration/edge" element={<EdgeBridgesPage />} />
            <Route path="/configuration/print" element={<PrintPage />} />
            <Route path="/configuration/maintenance" element={<MaintenancePage />} />
            <Route path="/configuration/units" element={<UnitsPage />} />
            <Route path="/configuration/backup" element={<BackupPage />} />
            <Route path="/configuration/qr-tokens" element={<QrPage />} />
            {/* Consolidated into the QR codes page (External rules tab). */}
            <Route path="/configuration/scan-rules" element={<Navigate to="/configuration/qr-tokens?tab=rules" replace />} />
            <Route path="/configuration/health" element={<HealthPage />} />
            <Route path="/configuration/locations" element={<LocationsPage />} />
            <Route path="/configuration/locations/:id" element={<LocationDetailPage />} />
            <Route path="/configuration/templates" element={<TemplatesPage />} />
            <Route path="/configuration/presentation" element={<PresentationPage />} />
            <Route path="/configuration/integrations" element={<IntegrationsPage />} />
            <Route path="/configuration/ai" element={<AiPage />} />
            <Route path="/configuration/x/:panelId" element={<HostedPanelPage />} />
            <Route path="/configuration/catalogs" element={<CatalogsPage />} />
            <Route path="/configuration/catalogs/match" element={<CatalogMatchPage />} />
            <Route path="/configuration/catalogs/:id" element={<CatalogDetailPage />} />
            <Route path="/configuration/portal" element={<PortalConfigPage />} />
            <Route path="/configuration/apps" element={<AppsConfigPage />} />
            <Route path="/configuration/permissions" element={<PermissionsPage />} />
            <Route path="/configuration/users" element={<UsersPage />} />
            <Route path="/configuration/roles" element={<RolesPage />} />
            <Route path="/configuration/openapi" element={<OpenApiPage />} />
            <Route path="/configuration/queue" element={<QueuePage />} />
            <Route path="/configuration/links" element={<LinksPage />} />
            {/* The settings FAMILY pages that live outside /configuration/*
                (views, tags, fields, files, wires, actions, activity, bundles)
                render inside the same sidebar — feedback 2026-07-03: sidebar
                links must never drop the sidebar. Routes unchanged; only the
                shell around them. */}
            <Route path="/bindings" element={<BindingsPage />} />
            <Route path="/actions" element={<ActionsPage />} />
            <Route path="/bundles" element={<BundlesPage />} />
            <Route path="/bundles/compose" element={<BundleComposerPage />} />
            <Route path="/fields" element={<FieldsPage />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/files" element={<FilesPage />} />
            <Route path="/views" element={<ViewsPage />} />
            <Route path="/tags" element={<TagsPage />} />
          </Route>
          <Route path="/build" element={<BuildPage />} />
          {/* digifab is a domain (bare module name) → the navbar links to its
              top path `/digifab`. Route it there as well as the Configuration
              deep-link, or the nav entry falls through to the home redirect. */}
          <Route path="/digifab" element={<DigifabPage />} />
          <Route path="/calendar" element={<CalendarPage />} />
          {/* Nav alias — the synthetic "Locations" top routes here (useNavModules). */}
          <Route path="/locations" element={<LocationsPage />} />
          <Route path="/locations/:id" element={<LocationDetailPage />} />
          <Route path="/scan" element={<ScanPage />} />
          <Route path="/scan/camera" element={<ScanCameraPage />} />
          {/* QR-label resolve inside the workspace: the in-app scanner
              navigates here on a label hit, and LandingRedirect rewrites
              bare /qr/<token> URLs into /w/<default>/qr/<token>. */}
          <Route path="/qr/*" element={<QrResolvePage />} />
          <Route path="/bricklink-connector" element={<BrickLinkPage />} />
          {/* Legacy alias — pre-rename. Bookmarks keep working. */}
          <Route path="/bricklink" element={<BrickLinkPage />} />
          {/* "What's new" from the account menu. The authed app mounts under the
              /w/:slug BASENAME, so the menu's <Link to="/changelog"> resolves to
              /w/<slug>/changelog — which fell through to the workspace catch-all
              (the link "did nothing"). The un-auth'd top-level /changelog route
              (public feed) only serves signed-out visitors. Same page, workspace
              chrome kept. */}
          <Route path="/changelog" element={<ChangelogPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/me/activity" element={<MeActivityPage />} />
          <Route path="/me/notifications" element={<MeNotificationsPage />} />
          <Route path="/me/notification-channels" element={<MeNotificationChannelsPage />} />
          <Route path="/me/communication" element={<CommunicationPreferencesPage />} />
          <Route path="/me/feedback" element={<MyFeedbackPage />} />
          <Route path="/me/app-settings" element={<AppSettingsPage />} />
          <Route path="/me/drive" element={<DriveSettingsPage />} />
          {/* /me is canonical; /me/profile redirects so old bookmarks keep working. */}
          <Route path="/me/profile" element={<Navigate to="/me" replace />} />
          <Route path="/me" element={<MeProfilePage />} />
          <Route path="/me/connections" element={<ConnectionsPage />} />
          <Route path="/core-files" element={<FilesPage />} />
          <Route path="/core-views" element={<ViewsPage />} />
          <Route path="/core-tags" element={<TagsPage />} />
          {/* Short aliases for human-friendly URLs. */}
          {/* Catch-all. The clean per-instance routes above (`/3d-printers`) are
              registered from instancesQ, which is async — so on a FULL page load
              (refresh / direct link) the instance route doesn't exist yet and the
              URL would fall here and bounce to home before the query resolves.
              While instances are still loading, wait instead of redirecting; once
              loaded the instance route matches (or, if it's truly unknown, this
              redirects). */}
          <Route
            path="*"
            element={
              instancesQ.isLoading ? (
                <div className="p-8 text-sm text-muted dark:text-slate-400">Loading…</div>
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
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
      {!onAdmin && labelsEnabled && <LabelsBasket orgSlug={activeSlug} getToken={getToken} />}
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
