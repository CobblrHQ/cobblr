import { DeletedRecordUndo } from "./components/DeletedRecordUndo";
// Top-level shell. AuthProvider hydrates from /me on mount; while
// that's in flight we show nothing (a fast roundtrip avoids flash).
// Once resolved we render the routed authed surface for an authed
// user or the AuthPage otherwise.
//
// Module routes are mounted here as well. Each first-party module
// imports its UI from "@cobblr/<name>/ui"; the host wires it under
// /<module>/* and the module's own internal routes take over.

import { installRoutePrefetch } from "./lib/route-prefetch";
import { OfflineScreen } from "./components/OfflineScreen";
import { OPEN_RECORD_ROUTE } from "@cobblr/platform-contract/instance-detail";
import { lazy, Suspense, useEffect, useState } from "react";
import { lazyShellHost } from "./lib/lazyShellHost";
const VaultPage = lazy(() => import("./pages/VaultPage").then((m) => ({ default: m.VaultPage })));
const RecentlyDeletedPage = lazy(() => import("./pages/RecentlyDeletedPage").then((m) => ({ default: m.RecentlyDeletedPage })));
import { ScanFiledRefresh } from "./lib/scanFiled";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useParams } from "react-router-dom";
import { Boxes, FolderKanban } from "lucide-react";
import { ModuleOffGate } from "./components/ModuleOffGate";
import { InstanceHubGate } from "./components/InstanceHubGate";
const InventoryUI = lazy(() => import("@cobblr/inventory/ui").then((m) => ({ default: m.InventoryUI })));
import { LabelsBasket } from "./components/LabelsBasketLazy";
const LabelsUI = lazy(() => import("@cobblr/labels/ui").then((m) => ({ default: m.LabelsUI })));
import { useNavHasRow } from "./components/useNavModules";
const ProjectsUI = lazy(() => import("@cobblr/projects/ui").then((m) => ({ default: m.ProjectsUI })));
const ListsUI = lazy(() => import("@cobblr/lists/ui").then((m) => ({ default: m.ListsUI })));
const KnowledgeUI = lazy(() => import("@cobblr/knowledge/ui").then((m) => ({ default: m.KnowledgeUI })));
const BuildsUI = lazy(() => import("@cobblr/builds/ui").then((m) => ({ default: m.BuildsUI })));
const SalesUI = lazy(() => import("@cobblr/sales/ui").then((m) => ({ default: m.SalesUI })));
const TrackingUI = lazy(() => import("@cobblr/tracking/ui").then((m) => ({ default: m.TrackingUI })));
// Side-effect import: registers the UNIVERSAL file renderers (svg, …).
// The FABRICATION renderers (stl/gcode) are gated by FilePreviewGate.
import "@cobblr/core-file-preview/ui";
import { FilePreviewGate } from "./components/FilePreviewGate";
import { InstalledRenderers } from "./components/InstalledRenderers";
const WorksWith = lazy(() => import("./components/WorksWith").then((m) => ({ default: m.WorksWith })));
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { useTheme } from "./theme/ThemeContext";
import { themePrefToApply } from "./theme/pref-to-apply";
import { ActiveOrgProvider, useActiveOrg, pickDefaultOrg, urlHandleFor } from "./auth/ActiveOrgContext";
import {BrowserLaserProvider} from "./features/digifab/BrowserLaser";
import { shellForRole } from "@cobblr/platform-contract/org-roles";
import { deepPathAfterWorkspace } from "./lib/deep-path";
import { AuthPage } from "./pages/AuthPage";
const MagicConsumePage = lazy(() => import("./pages/AuthPage").then((m) => ({ default: m.MagicConsumePage })));
const IdentityCallbackPage = lazy(() => import("./pages/AuthPage").then((m) => ({ default: m.IdentityCallbackPage })));
const OidcSignInPage = lazy(() => import("./pages/OidcSignInPage").then((m) => ({ default: m.OidcSignInPage })));
import { nextFromQuery } from "./lib/landing-path";
const PairPage = lazy(() => import("./pages/PairPage").then((m) => ({ default: m.PairPage })));
const SandboxLanding = lazy(() => import("./pages/SandboxLanding").then((m) => ({ default: m.SandboxLanding })));
const TryJoinPage = lazy(() => import("./pages/TryJoinPage").then((m) => ({ default: m.TryJoinPage })));
const SandboxEnded = lazy(() => import("./pages/SandboxEnded").then((m) => ({ default: m.SandboxEnded })));
const CarryPage = lazy(() => import("./pages/CarryPage").then((m) => ({ default: m.CarryPage })));
import { pendingCarry, takeCarryGrant } from "./lib/carry-pending";
import { pendingBring, takeBringFile } from "./lib/bring-pending";
import { pendingShareInvite } from "./lib/share-invite-pending";
const BringPage = lazy(() => import("./pages/BringPage").then((m) => ({ default: m.BringPage })));
const EndingPreview = lazy(() => import("./pages/EndingPreview").then((m) => ({ default: m.EndingPreview })));
import { useSandboxEnded } from "./lib/sandbox-session";
import { useWorkspaceUnfinished } from "./lib/workspace-unfinished";
import { WorkspaceUnfinished } from "./pages/WorkspaceUnfinished";
const StartAppPage = lazy(() => import("./pages/StartAppPage").then((m) => ({ default: m.StartAppPage })));
const FeedbackWidget = lazyShellHost(() => import("./components/FeedbackWidget").then((m) => ({ default: m.FeedbackWidget })));
const Dashboard = lazy(() => import("./pages/Dashboard").then((m) => ({ default: m.Dashboard })));
const InviteAcceptPage = lazy(() => import("./pages/InviteAcceptPage").then((m) => ({ default: m.InviteAcceptPage })));
const JoinPage = lazy(() => import("./pages/JoinPage").then((m) => ({ default: m.JoinPage })));
const JoinMachinesPage = lazy(() => import("./pages/JoinMachinesPage").then((m) => ({ default: m.JoinMachinesPage })));
const NamedPublicPage = lazy(() => import("./pages/PublicSurfacePage").then((m) => ({ default: m.NamedPublicPage })));
const PublicSurfacePage = lazy(() => import("./pages/PublicSurfacePage").then((m) => ({ default: m.PublicSurfacePage })));
const StopMessagesPage = lazy(() => import("./pages/StopMessagesPage").then((m) => ({ default: m.StopMessagesPage })));
const ReplyToMessagePage = lazy(() => import("./pages/ReplyToMessagePage").then((m) => ({ default: m.ReplyToMessagePage })));
const ChangelogPage = lazy(() => import("./pages/ChangelogPage").then((m) => ({ default: m.ChangelogPage })));
const QrResolvePage = lazy(() => import("./pages/QrResolvePage").then((m) => ({ default: m.QrResolvePage })));
const ActionLabelPage = lazy(() => import("./pages/ActionLabelPage").then((m) => ({ default: m.ActionLabelPage })));
const ResetPasswordPage = lazy(() => import("./pages/ResetPasswordPage").then((m) => ({ default: m.ResetPasswordPage })));
const VerifyEmailPage = lazy(() => import("./pages/VerifyEmailPage").then((m) => ({ default: m.VerifyEmailPage })));
const EmailChangePage = lazy(() => import("./pages/EmailChangePage").then((m) => ({ default: m.EmailChangePage })));
// Eager: nav-linked pages users hit from the dashboard frequently.
const MachinesPage = lazy(() => import("./pages/MachinesPage").then((m) => ({ default: m.MachinesPage })));
const AssetsPage = lazy(() => import("./pages/AssetsPage").then((m) => ({ default: m.AssetsPage })));
const PurchasesPage = lazy(() => import("./pages/PurchasesPage").then((m) => ({ default: m.PurchasesPage })));
const SearchPage = lazy(() => import("./pages/SearchPage").then((m) => ({ default: m.SearchPage })));
const TagsPage = lazy(() => import("./pages/TagsPage").then((m) => ({ default: m.TagsPage })));
const TagDetailPage = lazy(() => import("./pages/TagDetailPage").then((m) => ({ default: m.TagDetailPage })));
const DiscussionInboxPage = lazy(() => import("./pages/DiscussionInboxPage").then((m) => ({ default: m.DiscussionInboxPage })));
const FilesPage = lazy(() => import("./pages/FilesPage").then((m) => ({ default: m.FilesPage })));
const FileDetailPage = lazy(() => import("./pages/FileDetailPage").then((m) => ({ default: m.FileDetailPage })));
const ViewsPage = lazy(() => import("./pages/ViewsPage").then((m) => ({ default: m.ViewsPage })));
const SavedViewPage = lazy(() => import("./pages/SavedViewPage").then((m) => ({ default: m.SavedViewPage })));
const TidySuggestionsPage = lazy(() => import("./pages/TidySuggestionsPage").then((m) => ({ default: m.TidySuggestionsPage })));
const ConfigurationPage = lazy(() => import("./pages/ConfigurationPage").then((m) => ({ default: m.ConfigurationPage })));
const ConfigurationLayout = lazy(() => import("./components/ConfigurationLayout").then((m) => ({ default: m.ConfigurationLayout })));
const AccountLayout = lazy(() => import("./components/AccountLayout").then((m) => ({ default: m.AccountLayout })));
const ConfigInvitePage = lazy(() => import("./pages/ConfigLauncherPages").then((m) => ({ default: m.ConfigInvitePage })));
const ConfigMembersPage = lazy(() => import("./pages/ConfigLauncherPages").then((m) => ({ default: m.ConfigMembersPage })));
const ConfigModulesPage = lazy(() => import("./pages/ConfigLauncherPages").then((m) => ({ default: m.ConfigModulesPage })));
const ConfigNewThingPage = lazy(() => import("./pages/ConfigLauncherPages").then((m) => ({ default: m.ConfigNewThingPage })));
const PeoplePage = lazy(() => import("./pages/PeoplePage").then((m) => ({ default: m.PeoplePage })));
const PersonThingsPage = lazy(() => import("./pages/PersonThingsPage").then((m) => ({ default: m.PersonThingsPage })));
// Lazy: rarely-visited admin / drill-down pages. Splitting these
// out keeps the dashboard's initial bundle smaller. Each becomes
// its own chunk; the chunk loads on first navigation.
// A Station (#4640): a tablet a barcode scanner drives. Outside the workspace
// shell: the tablet is approved, never signed in.
const StationPage = lazy(() => import("./pages/StationPage").then((m) => ({ default: m.StationPage })));
const StationHome = lazy(() => import("./pages/StationPage").then((m) => ({ default: m.StationHome })));
const BindingsPage = lazy(() => import("./pages/BindingsPage").then((m) => ({ default: m.BindingsPage })));
const RecordsPage = lazy(() => import("./pages/RecordsPage").then((m) => ({ default: m.RecordsPage })));
const ActionsPage = lazy(() => import("./pages/ActionsPage").then((m) => ({ default: m.ActionsPage })));
const BundlesPage = lazy(() => import("./pages/BundlesPage").then((m) => ({ default: m.BundlesPage })));
const BuildPage = lazy(() => import("./pages/BuildPage").then((m) => ({ default: m.BuildPage })));
const FieldsAndFormsPage = lazy(() => import("./pages/FieldsAndFormsPage").then((m) => ({ default: m.FieldsAndFormsPage })));
const ConfigSectionPage = lazy(() => import("./pages/ConfigSectionPage").then((m) => ({ default: m.ConfigSectionPage })));
const GeneralSettingsPage = lazy(() => import("./pages/GeneralSettingsPage").then((m) => ({ default: m.GeneralSettingsPage })));
const NotificationAudiencesPage = lazy(() => import("./pages/NotificationAudiencesPage").then((m) => ({ default: m.NotificationAudiencesPage })));
const DevicesPage = lazy(() => import("./pages/DevicesPage").then((m) => ({ default: m.DevicesPage })));
const ScanRulesPage = lazy(() => import("./pages/ScanRulesPage").then((m) => ({ default: m.ScanRulesPage })));
const MeActivityPage = lazy(() => import("./pages/MeActivityPage").then((m) => ({ default: m.MeActivityPage })));
const ServiceRunsPage = lazy(() => import("./pages/ServiceRunsPage").then((m) => ({ default: m.ServiceRunsPage })));
const ServiceRunPage = lazy(() => import("./pages/ServiceRunsPage").then((m) => ({ default: m.ServiceRunPage })));
const MeNotificationsPage = lazy(() => import("./pages/MeNotificationsPage").then((m) => ({ default: m.MeNotificationsPage })));
const MeNotificationChannelsPage = lazy(() => import("./pages/MeNotificationChannelsPage").then((m) => ({ default: m.MeNotificationChannelsPage })));
const MeProfilePage = lazy(() => import("./pages/MeProfilePage").then((m) => ({ default: m.MeProfilePage })));
const AccountSectionPage = lazy(() => import("./pages/AccountSectionPage").then((m) => ({ default: m.AccountSectionPage })));
const NoWorkspacePage = lazy(() => import("./pages/NoWorkspacePage").then((m) => ({ default: m.NoWorkspacePage })));
const MeIdentityPage = lazy(() => import("./pages/MeProfilePage").then((m) => ({ default: m.MeIdentityPage })));
const PrintPageLazy = lazy(() => import("./pages/PrintPage").then((m) => ({ default: m.PrintPage })));
const MeAppearancePage = lazy(() => import("./pages/MeProfilePage").then((m) => ({ default: m.MeAppearancePage })));
const AppSettingsPage = lazy(() => import("./pages/AppSettingsPage").then((m) => ({ default: m.AppSettingsPage })));
const CommunicationPreferencesPage = lazy(() => import("./pages/CommunicationPreferencesPage").then((m) => ({ default: m.CommunicationPreferencesPage })));
const PhotoConsentPage = lazy(() => import("./pages/PhotoConsentPage").then((m) => ({ default: m.PhotoConsentPage })));
const MyFeedbackPage = lazy(() => import("./pages/MyFeedbackPage").then((m) => ({ default: m.MyFeedbackPage })));
const DriveSettingsPage = lazy(() => import("./pages/DriveSettingsPage").then((m) => ({ default: m.DriveSettingsPage })));
const ConnectionsPage = lazy(() => import("./pages/ConnectionsPage").then((m) => ({ default: m.ConnectionsPage })));
const MailboxCheckPage = lazy(() => import("./pages/MailboxCheckPage").then((m) => ({ default: m.MailboxCheckPage })));
const ApiTokensPage = lazy(() => import("./pages/ApiTokensPage").then((m) => ({ default: m.ApiTokensPage })));
const ActivityPage = lazy(() => import("./pages/ActivityPage").then((m) => ({ default: m.ActivityPage })));
const StocktakePage = lazy(() => import("./pages/StocktakePage").then((m) => ({ default: m.StocktakePage })));
const SurfacesPage = lazy(() => import("./pages/SurfacesPage").then((m) => ({ default: m.SurfacesPage })));
const ProductionTestPage = lazy(() => import("./pages/ProductionTestPage").then(m => ({ default: m.ProductionTestPage })));
const ProductionStationPage = lazy(() => import("./pages/ProductionStationPage").then(m => ({ default: m.ProductionStationPage })));
const DigifabPage = lazy(() => import("./pages/DigifabPage").then((m) => ({ default: m.DigifabPage })));
const PrinterStationPage = lazy(() => import("./pages/PrinterStationPage").then((m) => ({ default: m.PrinterStationPage })));
const EmbroideryPage = lazy(() => import("./pages/EmbroideryPage").then(m => ({ default: m.EmbroideryPage })));
const FloorManagerPage = lazy(() => import("./pages/FloorManagerPage").then(m => ({ default: m.FloorManagerPage })));
const InspectionStationPage = lazy(() => import("./pages/InspectionStationPage").then(m => ({ default: m.InspectionStationPage })));
const BoardInspectionPage = lazy(() => import("./pages/BoardInspectionPage").then(m => ({ default: m.BoardInspectionPage })));
const ReflowStationPage = lazy(() => import("./pages/ReflowStationPage").then(m => ({ default: m.ReflowStationPage })));
const AssemblyStationPage = lazy(() => import("./pages/AssemblyStationPage").then(m => ({ default: m.AssemblyStationPage })));
const KilnStationPage = lazy(() => import("./pages/KilnStationPage").then(m => ({ default: m.KilnStationPage })));
const StockStationPage = lazy(() => import("./pages/StockStationPage").then((m) => ({ default: m.StockStationPage })));
const MachineStationPage = lazy(() => import("./pages/MachineStationPage").then((m) => ({ default: m.MachineStationPage })));
const MakesPage = lazy(() => import("./pages/MakesPage").then((m) => ({ default: m.MakesPage })));
const MakePage = lazy(() => import("./pages/MakesPage").then((m) => ({ default: m.MakePage })));
const MaintenancePage = lazy(() => import("./pages/MaintenancePage").then((m) => ({ default: m.MaintenancePage })));
const UnitsPage = lazy(() => import("./pages/UnitsPage").then((m) => ({ default: m.UnitsPage })));
const BackupPage = lazy(() => import("./pages/BackupPage").then((m) => ({ default: m.BackupPage })));
const OutboundEmailPage = lazy(() => import("./pages/OutboundEmailPage").then((m) => ({ default: m.OutboundEmailPage })));
const CalendarPage = lazy(() => import("./pages/CalendarPage").then((m) => ({ default: m.CalendarPage })));
const AllAppsPage = lazy(() => import("./pages/AllAppsPage").then((m) => ({ default: m.AllAppsPage })));
const QrPage = lazy(() => import("./pages/QrPage").then((m) => ({ default: m.QrPage })));
const HealthPage = lazy(() => import("./pages/HealthPage").then((m) => ({ default: m.HealthPage })));
const OpenApiPage = lazy(() => import("./pages/OpenApiPage").then((m) => ({ default: m.OpenApiPage })));
const ConnectAssistantPage = lazy(() => import("./pages/ConnectAssistantPage").then((m) => ({ default: m.ConnectAssistantPage })));
const OAuthConsentPage = lazy(() => import("./pages/OAuthConsentPage").then((m) => ({ default: m.OAuthConsentPage })));
const ApiRecipesPage = lazy(() => import("./pages/ApiRecipesPage").then((m) => ({ default: m.ApiRecipesPage })));
const QueuePage = lazy(() => import("./pages/QueuePage").then((m) => ({ default: m.QueuePage })));
const LinksPage = lazy(() => import("./pages/LinksPage").then((m) => ({ default: m.LinksPage })));
const SharingPage = lazy(() => import("./pages/SharingPage").then((m) => ({ default: m.SharingPage })));
const SuggestionsPage = lazy(() => import("./pages/SuggestionsPage").then((m) => ({ default: m.SuggestionsPage })));
const ViewAsPage = lazy(() => import("./pages/ViewAsPage").then((m) => ({ default: m.ViewAsPage })));
const ShareJoinPage = lazy(() => import("./pages/ShareJoinPage").then((m) => ({ default: m.ShareJoinPage })));
const LocationsPage = lazy(() => import("./pages/LocationsPage").then((m) => ({ default: m.LocationsPage })));
const PlaceItemsPage = lazy(() => import("./pages/PlaceItemsPage").then((m) => ({ default: m.PlaceItemsPage })));
const LocationDetailPage = lazy(() => import("./pages/LocationDetailPage").then((m) => ({ default: m.LocationDetailPage })));
const PlanLayoutPage = lazy(() => import("./pages/PlanLayoutPage").then((m) => ({ default: m.PlanLayoutPage })));
const LayoutPrintPage = lazy(() => import("./pages/LayoutPrintPage").then((m) => ({ default: m.LayoutPrintPage })));
const OpenRecordPage = lazy(() => import("./pages/OpenRecordPage").then((m) => ({ default: m.OpenRecordPage })));
const TemplatesPage = lazy(() => import("./pages/TemplatesPage").then((m) => ({ default: m.TemplatesPage })));
const AssistantSettingsPage = lazy(() => import("./pages/AssistantSettingsPage").then((m) => ({ default: m.AssistantSettingsPage })));
const ScanPage = lazy(() => import("./pages/ScanPage").then((m) => ({ default: m.ScanPage })));
const ScanStationsPage = lazy(() => import("./pages/ScanStationsPage").then((m) => ({ default: m.ScanStationsPage })));
const ScanCameraPage = lazy(() => import("./pages/ScanCameraPage").then((m) => ({ default: m.ScanCameraPage })));
const ShareReceivePage = lazy(() => import("./pages/ShareReceivePage").then((m) => ({ default: m.ShareReceivePage })));
const ScanLivePage = lazy(() => import("./pages/ScanLivePage").then((m) => ({ default: m.ScanLivePage })));
const BundleComposerPage = lazy(() => import("./pages/BundleComposerPage").then((m) => ({ default: m.BundleComposerPage })));
const CatalogsPage = lazy(() => import("./pages/CatalogsPage").then((m) => ({ default: m.CatalogsPage })));
const CatalogDetailPage = lazy(() => import("./pages/CatalogDetailPage").then((m) => ({ default: m.CatalogDetailPage })));
const CatalogMatchPage = lazy(() => import("./pages/CatalogMatchPage").then((m) => ({ default: m.CatalogMatchPage })));
const RecordActionsPage = lazy(() => import("./pages/RecordActionsPage").then((m) => ({ default: m.RecordActionsPage })));
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
const PlanPrintPage = lazy(() => import("./pages/PlanPrintPage").then((m) => ({ default: m.PlanPrintPage })));
const PortalPlanPage = lazy(() => import("./pages/PortalPlanPage").then((m) => ({ default: m.PortalPlanPage })));
const AppPlayerPage = lazy(() => import("./pages/AppPlayerPage").then((m) => ({ default: m.AppPlayerPage })));
const AppRecordPage = lazy(() => import("./pages/AppPlayerPage").then((m) => ({ default: m.AppRecordPage })));
const BrickLinkPage = lazy(() => import("./pages/BrickLinkPage").then((m) => ({ default: m.BrickLinkPage })));
import { ForcePasswordResetPage } from "./pages/ForcePasswordResetPage";
const AdminConsole = lazy(() => import("./pages/AdminConsole").then((m) => ({ default: m.AdminConsole })));
import { AppLayout } from "./components/AppLayout";
import { WorkspaceStateBar } from "./components/WorkspaceStateBar";
import { WorkspaceDeletionBar } from "./components/WorkspaceDeletionBar";
import { PersonalDocumentSheet } from "./components/PersonalDocumentSheet";
import { BlockedActionHost } from "./components/BlockedActionHost";
import { ImpersonationBanner } from "./components/ImpersonationBanner";
import { ShareViewBanner } from "./components/ShareViewBanner";
const AdminLayout = lazy(() => import("./components/AdminLayout").then((m) => ({ default: m.AdminLayout })));
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ConnectivityBanner } from "./components/ConnectivityBanner";
const PortalLayout = lazy(() => import("./components/PortalLayout").then((m) => ({ default: m.PortalLayout })));
import { ToastProvider, ConfirmProvider } from "@cobblr/platform-web";
import { BootScrim } from "./components/BootScrim";
import { api, getToken } from "./lib/api";
import { WorkspacePlatformWeb } from "./WorkspacePlatformWeb";
import { useNavMode, useNavTopBar } from "./lib/nav-mode";
import { isFullSidebar } from "./lib/nav-layout";
import { useIsDesktopWidth } from "./lib/useIsDesktopWidth";
import { useQuery } from "@tanstack/react-query";
const InstancePage = lazy(() => import("./pages/InstancePage").then((m) => ({ default: m.InstancePage })));
import { inManagedAppSurface } from "./lib/managed-apps";
import { WorkspaceShapeRefresh } from "./lib/useWorkspaceShapeRefresh";
import { hydrateNavPref } from "./lib/nav-mode";


function RouteFallback() {
  return (
    // aria-busy: a page whose code is still arriving is not settled
    // (scripts/lib/wait-settled.mjs), whatever the queries say.
    <div aria-busy="true" className="text-xs font-mono text-faint dark:text-slate-500 p-6">
      loading…
    </div>
  );
}

/** Applies the signed-in user's server-stored theme preference on login, so a
 *  fresh device follows the user's choice instead of the OS default. Renders
 *  nothing; lives inside AuthProvider (the ThemeProvider is an ancestor from
 *  main.tsx). Only syncs — the user's own toggle owns changes + persistence.
 *
 *  ABSENT IS NOT "NO PREFERENCE". This used to sync `user?.theme_pref ?? null`,
 *  which fires with null the moment nobody is signed in — and syncFromServer
 *  clears the cache, so simply landing on the LOGIN PAGE erased the very
 *  localStorage copy that exists to survive it. Sign in and your workspace came
 *  up light; a refresh, going through /me, put it back (reported 2026-09-08).
 *  So: nothing to say while signed out, and nothing to say about a response
 *  that did not carry the field. An explicit null still applies - that is the
 *  real "follow this device". */
function ThemeSync() {
  const { user } = useAuth();
  const { syncFromServer } = useTheme();
  const pref = themePrefToApply(user);
  useEffect(() => {
    if (pref === undefined) return;
    syncFromServer(pref);
  }, [pref, syncFromServer]);
  return null;
}

/** Same for the desktop nav layout: a fresh desktop adopts the sidebar you set
 *  on another one, instead of silently starting on the top bar. Desktop-only by
 *  construction — the sidebar is `hidden md:block`, so a phone ignores it. */
function NavPrefSync() {
  const { user } = useAuth();
  useEffect(() => {
    // Same rule as ThemeSync: only an account that has actually loaded gets to
    // say anything. (hydrateNavPref already ignores a falsy pref, so this has
    // never lost a layout — but the two must read the same way, or the next
    // person fixes one of them.)
    if (!user) return;
    hydrateNavPref(user.nav_pref ?? null);
  }, [user]);
  return null;
}

/** And where the person is: their browser's time zone, so a quote, an invoice
 *  or a due date made for them is dated on their day, not on a day that has
 *  arrived everywhere. Same rule: only an account that loaded, and only a
 *  response that carried the field, says anything. */
function TimeZoneSync() {
  const { user } = useAuth();
  const known = user && "time_zone" in user ? (user.time_zone ?? null) : undefined;
  useEffect(() => {
    if (known === undefined) return;
    api.syncTimeZone(known).catch(() => undefined);
  }, [known]);
  return null;
}

export function App() {
  return (
    <ErrorBoundary scope="app">
      <ConnectivityBanner />
      <WorkspaceShapeRefresh />
      <ScanFiledRefresh />
      <AuthProvider>
        <ThemeSync />
      <NavPrefSync />
      <TimeZoneSync />
        <ToastProvider>
          <ConfirmProvider>
            <DeletedRecordUndo />
            <Shell />
          </ConfirmProvider>
        </ToastProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}

function Shell() {
  const { loading, offline, user } = useAuth();
  if (loading) return <BootScrim />;
  if (offline && !user) return <OfflineScreen />;

  // The operator console is INSTANCE-wide, not workspace-scoped — it gets
  // its own top-level mount at /admin (no /w/:slug prefix, no tenant
  // context, reachable by a platform admin with ZERO workspaces). Console
  // audit 2026-06-11: the old workspace-nested mount made every console URL
  // contradict the cross-tenant story it tells.
  // /t/<token> — the no-account sandbox link. Handled BEFORE anything else
  // resolves: the visitor has no session yet, and the token is what mints one.
  // Deliberately not a /w/ route, because there is no workspace to name until
  // the token has been exchanged for one.
  if (window.location.pathname.startsWith("/t/")) {
    return <SandboxLanding />;
  }
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
        <ShareViewBanner />
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
      <Route path="/share/join" element={<ShareJoinPage />} />
      <Route path="/view-as" element={<ViewAsPage />} />
      {/* /oauth/authorize — an AI assistant's connector (claude.ai, the phone
          apps) sends a person here to approve it; signed out, it asks them to
          sign in and comes back. */}
      <Route path="/oauth/authorize" element={<OAuthRoute />} />
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
      <Route path="/email-change/revert/:token" element={<EmailChangePage mode="revert" />} />
      <Route path="/email-change/:token" element={<EmailChangePage mode="confirm" />} />
      {/* Emailed magic-link landing: consumes ?token= and signs in. Without it
          the link falls to the catch-all and nothing consumes the token. */}
      <Route path="/auth/magic" element={<MagicConsumePage />} />
      {/* Where account.cobblr.xyz returns a browser with its one-time code. */}
      <Route path="/auth/callback" element={<IdentityCallbackPage />} />
      <Route path="/sign-in/oidc" element={<OidcSignInPage />} />
      {/* /pair?code=… — phone-side QR pair-login landing. Claims the code the
          desktop minted and signs the phone in to that workspace. Reached
          unauthenticated (the code is the secret). */}
      <Route path="/pair" element={<PairPage />} />
      {/* /station/<workspace>/<address>: a Station tablet (#4640). Opening it
          is the setup: a new tablet shows a code to approve from a signed-in
          phone. /station alone goes back to the station this device opened. */}
      <Route path="/station" element={<Suspense fallback={<BootScrim />}><StationHome /></Suspense>} />
      <Route path="/station/:slug" element={<Suspense fallback={<BootScrim />}><StationPage /></Suspense>} />
      <Route path="/station/:slug/:address" element={<Suspense fallback={<BootScrim />}><StationPage /></Suspense>} />
      {/* The sandbox's ending, to look at: test-door boxes only. */}
      <Route path="/try/ended" element={<EndingPreview />} />
      {/* A kept trial's address saying yes to keeping another sandbox. */}
      <Route path="/try/join/:token" element={<TryJoinPage />} />
      {/* Where a trial's "bring what I built" lands, signed out or in. */}
      <Route path="/carry" element={<CarryRoute />} />
      {/* Where a sandbox's "Continue on Cobblr" lands, signed out or in. */}
      <Route path="/bring" element={<BringRoute />} />
      {/* /p/:token is the un-auth'd public surface render. Reachable
          signed-in or signed-out — the token is the secret. */}
      <Route path="/p/:token" element={<PublicSurfacePage />} />
      {/* The stop link at the foot of an automation's message to someone
          outside a workspace (#6070). Signed out; the token is the key. */}
      <Route path="/m/stop/:token" element={<StopMessagesPage />} />
      {/* The reply link an automation's message may carry (#6070). */}
      <Route path="/m/reply/:token" element={<ReplyToMessagePage />} />
      {/* A public page's memorable address, when its owner gave it one. */}
      <Route path="/p/:org/:address" element={<NamedPublicPage />} />
      {/* Public "What's new" feed — reachable signed-in or signed-out. */}
      <Route path="/changelog" element={<ChangelogPage />} />
      {/* /qr/:token — printed QR-label resolve (phone-camera scans land
          here bare, signed-in or signed-out). Navigate-mode forwards to
          /w/<org>/<detail>; the workspace shell handles login from there. */}
      <Route path="/qr/*" element={<QrResolvePage />} />
      {/* A printed action label (#3897): found by the same resolver. */}
      <Route path="/a/*" element={<QrResolvePage />} />
      {/* Streamlined consumer signup for a managed app ("Cobblr for Yarn"). */}
      <Route path="/start/:app" element={<StartAppPage />} />
      {/* Legacy un-prefixed member-portal links → workspace-scoped portal. */}
      <Route path="/portal/:slug/*" element={<PortalSlugRedirect />} />
      <Route path="/login" element={<LandingEntry />} />
      <Route path="/signup" element={<LandingEntry />} />
      <Route path="*" element={<LandingEntry />} />
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

// /carry: a trial's "bring what I built" lands here, usually signed out. The
// grant is held before the sign-up form, which opens on sign-up, because most
// people arrive without an account on this side.
function CarryRoute() {
  const { user } = useAuth();
  const [grant] = useState(() => takeCarryGrant(window.location.search));
  if (grant && !user) return <AuthPage initialMode="signup" carrying />;
  return <CarryPage grant={grant} />;
}

// /bring: a sandbox's file on its way in, usually signed out. Held before the
// sign-up form, like /carry's grant.
function BringRoute() {
  const { user } = useAuth();
  const [file] = useState(() => takeBringFile(window.location.search));
  if (file && !user) return <AuthPage initialMode="signup" carrying />;
  return <BringPage file={file} />;
}

// /oauth/authorize: an AI connector's consent screen, usually reached signed
// out. Sign-in happens right here, so the request the connector sent is still
// in the address bar afterwards; a trip through the account service comes
// back to "/", which takeOAuthReturn sends back here once.
function OAuthRoute() {
  const { user } = useAuth();
  if (!user) {
    try {
      sessionStorage.setItem("cobblr.oauthReturn", `/oauth/authorize${window.location.search}`);
    } catch {
      /* storage blocked: password sign-in still returns in place */
    }
    return <AuthPage />;
  }
  return <OAuthConsentPage />;
}

// A bare URL (no /w/:slug): once authed, redirect into the user's default
// workspace, preserving any deep path so old bookmarks keep working.
/** The consent screen a sign-in interrupted, once, and only that screen. */
function takeOAuthReturn(): string | null {
  try {
    const v = sessionStorage.getItem("cobblr.oauthReturn");
    if (!v) return null;
    sessionStorage.removeItem("cobblr.oauthReturn");
    return v.startsWith("/oauth/authorize?") ? v : null;
  } catch {
    return null;
  }
}

function LandingEntry() {
  const { user, orgs } = useAuth();
  if (!user) return <AuthPage />;
  if (user.must_reset_password) return <ForcePasswordResetPage />;
  // Signed in on the way to approving an AI connector: back to that screen.
  const oauthReturn = takeOAuthReturn();
  if (oauthReturn) {
    window.location.replace(oauthReturn);
    return <BootScrim />;
  }
  // A trial waiting to be brought in, from before a sign-up or a trip through
  // the account service: back to the page that brings it.
  if (pendingCarry()) {
    window.location.replace("/carry");
    return <BootScrim />;
  }
  // A sandbox's file waiting to come in, the same way.
  if (pendingBring()) {
    window.location.replace("/bring");
    return <BootScrim />;
  }
  // Signed in from a page that asked to come back ("/?next=/invite/…": an
  // invite's "Sign in to join", a machine share's "Log in"): back there,
  // not to the default workspace, or the invite is lost on the way.
  // A share invite opened signed out comes back too, though the sign-up's
  // email verification landed on "/" without its ?next= (#4737).
  const held = pendingShareInvite();
  const back = nextFromQuery(window.location.search) ?? (held ? `/share/join#${held}` : null);
  if (back) {
    window.location.replace(back);
    return <BootScrim />;
  }
  const org = pickDefaultOrg(orgs);
  if (!org) {
    // No workspace (an admin-minted account, or the only one was just
    // deleted). A page with doors, not a line: make one, sign out, delete the
    // account; a platform admin also gets the console, which is instance-wide.
    return (
      <Suspense fallback={<BootScrim />}>
        <NoWorkspacePage />
      </Suspense>
    );
  }
  const { pathname, search, hash } = window.location;
  window.location.replace(`/w/${urlHandleFor(org, orgs)}${deepPathAfterWorkspace(pathname)}${search}${hash}`);
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
  // A section's code is fetched on intent (a link pointed at, focused or
  // touched) and, on a desktop, once the page has settled (#4945).
  useEffect(() => installRoutePrefetch(`/w/${urlHandle}`), [urlHandle]);
  // A no-account sandbox past its hour is not a workspace with a notice on
  // it; it is gone. The whole shell goes with it: no cached dashboard, no
  // strip, no tour, no modal, nothing left to press but the doors out.
  const sandboxOver = useSandboxEnded();
  if (sandboxOver) return <SandboxEnded kind={sandboxOver} />;
  if (!user) return <AuthPage />;
  // Force-password-reset gate: if the admin minted this account with
  // a temp password, the user must pick a new one before anything
  // else. ForcePasswordResetPage is rendered standalone (no portal, no
  // admin shell, no nav) so the user can't navigate around it. NOT a
  // route, deliberately: a route would be a URL to escape to, and a URL
  // that shows the screen to someone who does not need it. The gate is
  // the whole mechanism.
  // See docs/operations/PRODUCTION_DEPLOY.md (no-email onboarding).
  if (user.must_reset_password) return <ForcePasswordResetPage />;
  return (
    <ActiveOrgProvider urlHandle={urlHandle}>
      <BrowserLaserProvider><ActiveOrgScopedRoutes /></BrowserLaserProvider>
    </ActiveOrgProvider>
  );
}

/** /configuration/locations[/:id] → /locations[/:id]. The place tree is a thing
 *  you browse, not a setting, so it owns the bare URL; it was reachable at both,
 *  which meant a click from the navbar entry landed you in the settings shell.
 *  Kept as a redirect for old bookmarks + any entity_kinds.detail_route row that
 *  still carries the pre-move value. */
function LocationsConfigRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={id ? `/locations/${id}` : "/locations"} replace />;
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
  // A workspace whose database was never made says so, with the button to
  // finish it, instead of drawing an empty dashboard (#5146).
  const unfinished = useWorkspaceUnfinished(activeSlug);

  // Shell routing: a guest lands in the portal (what the workspace shares);
  // everyone else gets the workspace, and the gates decide what they may do
  // in it. The rule is the contract's (shellForRole, beside the rank table),
  // because the shell used to send members to the portal too, contradicting
  // the role's own words (#3122). See docs/modules/member-portal-and-permissions.md.
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
  const shouldRedirectToPortal = activeSlug && role && shellForRole(role) === "portal" && !onPortal;

  // Managed-app lock-down: when the active workspace is a managed vertical app
  // ("Cobblr for Yarn"), the user only ever sees the app — its instance tables,
  // the scanner, and their own account. Every other route (the dashboard,
  // marketplace, bundles, configuration, wires, fields, other modules) bounces
  // to the app home, so a non-technical user never reaches the platform. A
  // WHITELIST (not blacklist) so new platform pages are blocked by default.
  // See business-models/docs/18-managed-vertical-apps.md.
  const appMode = activeOrg?.app_mode ?? null;
  // Full-sidebar mode hosts Feedback as a row in the sidebar foot (AppLayout),
  // so the floating pill would double up — suppress it there. The one rule
  // AppLayout uses, width included: below md there is no foot to host it.
  const navMode = useNavMode();
  const navTopBar = useNavTopBar();
  const desktopWidth = useIsDesktopWidth();
  const fullSide = isFullSidebar({ navMode, navTopBar, appMode: !!appMode, desktopWidth });
  // The label queue's count rides on the sidebar's Labels row (nav.count), so
  // the floating pill is for the top bar, where the row can fold into "more".
  const labelsRowInSidebar = useNavHasRow(activeSlug, "labels") && navMode === "side" && desktopWidth && !appMode;
  const shouldRedirectToAppHome = !!appMode && !inManagedAppSurface(location.pathname);

  if (unfinished) return <WorkspaceUnfinished slug={activeSlug} name={activeOrg?.name} />;
  return (
    <WorkspacePlatformWeb orgSlug={activeSlug} role={role ?? null} appMode={!!appMode}>
      <Suspense fallback={<RouteFallback />}>
      {/* Host gate: turns the fabrication file renderers on/off with the
          active workspace's machine domains. core-file-preview stays
          domain-agnostic; this is the integrator wiring (see the file). */}
      <FilePreviewGate />
      <InstalledRenderers />
      {/* Always-on feedback button for every signed-in user — except the
          operator console, where the operator IS the recipient. */}
      {!onAdmin && !fullSide && <FeedbackWidget />}
      {/* The strip that says what kind of workspace this is: a sandbox's
          countdown and Keep button, a trial's "yours until", nothing at all
          for a kept or self-hosted one.
          It lived in the sidebar foot, which only renders in full-sidebar mode -
          so in the default top-nav layout a visitor saw no clock and had no way
          to keep the workspace, and it simply vanished when the hour was up. It
          portals to <body> anyway, so the only thing its position in the tree
          decides is WHETHER it mounts. Here it always does; the server says
          whether there is anything to draw. */}
      <WorkspaceStateBar slug={activeSlug} />
      {/* The day a workspace set to be deleted goes, for everyone in it. */}
      <WorkspaceDeletionBar slug={activeSlug} />
      {/* The one sheet a refusal opens, from whichever surface made the call,
          and the one that finishes an approved ask (?resume=<id>). */}
      <BlockedActionHost />
      <PersonalDocumentSheet />
      {shouldRedirectToPortal && <Navigate to={`/portal/${activeSlug}`} replace />}
      {shouldRedirectToAppHome && <Navigate to={appMode!.home_path} replace />}
      <Routes>
        <Route path="/station/stock/:station" element={<StockStationPage />} />
        <Route element={<ModuleOffGate><Outlet /></ModuleOffGate>}>
          <Route path="/station/assembly/:machineId/:orderId" element={<AssemblyStationPage />} />
          <Route path="/station/reflow/:machineId/:orderId" element={<ReflowStationPage />} />
          <Route path="/station/inspection/:machineId/:orderId" element={<InspectionStationPage />} />
          <Route path="/station/floor" element={<FloorManagerPage screen />} />
          <Route path="/station/kiln/:machineId" element={<KilnStationPage />} />
          <Route path="/station/printer/:machineId" element={<PrinterStationPage />} />
          <Route path="/station/production/:connectionId" element={<ProductionStationPage />} />
          <Route path="/station/machine/:connectionId/:deviceId" element={<MachineStationPage />} />
        </Route>

        <Route element={<AppLayout activeSlug={activeSlug} />}>
          <Route path="/builds/inspections/:id" element={<BoardInspectionPage />} />
          <Route path="/" element={<Dashboard />} />
          <Route
            path="/inventory/*"
            element={
              <InstanceHubGate module="inventory" basePath="/inventory" icon={Boxes} noun="part">
                <InventoryUI orgSlug={activeSlug} getToken={getToken} />
              </InstanceHubGate>
            }
          />
          <Route
            path="/labels/*"
            element={<LabelsUI orgSlug={activeSlug} getToken={getToken} />}
          />
          <Route
            path="/projects/*"
            element={
              <InstanceHubGate module="projects" basePath="/projects" icon={FolderKanban} noun="project">
                <ProjectsUI orgSlug={activeSlug} getToken={getToken} />
              </InstanceHubGate>
            }
          />
          <Route
            path="/lists/*"
            element={
              <>
                <ListsUI orgSlug={activeSlug} getToken={getToken} />
                <div className="max-w-4xl"><WorksWith module="lists" orgSlug={activeSlug} /></div>
              </>
            }
          />
          <Route
            path="/knowledge/*"
            element={
              <>
                <KnowledgeUI orgSlug={activeSlug} getToken={getToken} />
                <div className="max-w-4xl"><WorksWith module="knowledge" orgSlug={activeSlug} /></div>
              </>
            }
          />
          <Route
            path="/builds/*"
            element={
              <>
                <BuildsUI orgSlug={activeSlug} getToken={getToken} />
                <div className="max-w-4xl"><WorksWith module="builds" orgSlug={activeSlug} /></div>
              </>
            }
          />
          <Route
            path="/sales/*"
            element={
              <>
                <SalesUI orgSlug={activeSlug} getToken={getToken} />
                <div className="max-w-4xl"><WorksWith module="sales" orgSlug={activeSlug} /></div>
              </>
            }
          />
          <Route
            path="/tracking/*"
            element={
              <>
                <TrackingUI orgSlug={activeSlug} getToken={getToken} />
                <div className="max-w-4xl"><WorksWith module="tracking" orgSlug={activeSlug} /></div>
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
          <Route path="/records" element={<RecordsPage />} />
          <Route path="/records/:id" element={<RecordsPage />} />
          <Route path="/purchases" element={<PurchasesPage />} />
          <Route path="/purchases/vendors/:vendorId" element={<PurchasesPage />} />
          <Route path="/purchases/:id" element={<PurchasesPage />} />
          {/* Every /configuration/* page renders inside ConfigurationLayout.
              2026-07 revamp: /configuration is five section CARDS and
              /configuration/s/:section lists that section's settings, so the
              hub is a short menu instead of a 34-tile wall. Leaf URLs did NOT
              move — sections are a navigation layer, not a URL segment — so
              only the pages that MERGED carry redirects.
              See docs/design-decisions/configuration-revamp.md. */}
          <Route element={<ConfigurationLayout />}>
            <Route path="/configuration" element={<ConfigurationPage />} />
            <Route path="/configuration/s/:section" element={<ConfigSectionPage />} />
            <Route path="/configuration/recently-deleted" element={<RecentlyDeletedPage />} />
            <Route path="/configuration/tidy" element={<TidySuggestionsPage />} />
            <Route path="/configuration/general" element={<GeneralSettingsPage />} />
            <Route path="/configuration/notification-audiences" element={<NotificationAudiencesPage />} />
            {/* Launcher PAGES (settings-cohesion): the dialogs, in-flow. */}
            <Route path="/configuration/modules" element={<ConfigModulesPage />} />
            <Route path="/configuration/members" element={<ConfigMembersPage />} />
            <Route path="/configuration/people" element={<PeoplePage />} />
            <Route path="/configuration/members/invite" element={<ConfigInvitePage />} />
            <Route path="/configuration/new-thing" element={<ConfigNewThingPage />} />
            {/* Merged into Fields & forms — same act, one page, two tabs. */}
            <Route
              path="/configuration/form-builder"
              element={<Navigate to="/fields?tab=layout" replace />}
            />
            <Route path="/configuration/tokens" element={<ApiTokensPage />} />
            <Route path="/configuration/surfaces" element={<SurfacesPage />} />
            {/* Bridges + machine managers + printers were three entries in a
                group with no primary tile, so all three were invisible on
                arrival. One Devices page, three tabs; the old URLs redirect. */}
            <Route path="/configuration/devices" element={<DevicesPage />} />
            <Route
              path="/configuration/digifab"
              element={<Navigate to="/configuration/devices?tab=machines" replace />}
            />
            {/* Notifications already sent carry this older link; it lands on
                the same page. */}
            <Route
              path="/configuration/farm"
              element={<Navigate to="/configuration/devices?tab=machines" replace />}
            />
            <Route
              path="/configuration/edge"
              element={<Navigate to="/configuration/devices" replace />}
            />
            <Route
              path="/configuration/print"
              element={<Navigate to="/configuration/devices?tab=printers" replace />}
            />
            {/* Maintenance moved to the nav — "what's overdue" is a work list
                you visit, not a setting you change. */}
            <Route
              path="/configuration/maintenance"
              element={<Navigate to="/maintenance" replace />}
            />
            <Route path="/configuration/units" element={<UnitsPage />} />
            <Route path="/configuration/backup" element={<BackupPage />} />
            <Route path="/configuration/email" element={<OutboundEmailPage />} />
            <Route path="/configuration/qr-tokens" element={<QrPage />} />
            {/* Scan rules is its own destination again: it is owned by
                core-scan (interop with ANOTHER app's labels), not by labels,
                so burying it in the QR page hid it from workspaces that print
                no labels of their own. */}
            <Route path="/configuration/scan-rules" element={<ScanRulesPage />} />
            <Route path="/configuration/health" element={<HealthPage />} />
            {/* Locations moved OUT of the settings namespace to the bare
                /locations it already had a nav entry for (see
                LocationsPage.tsx). Redirects, not pages, so old bookmarks and
                any entity_kinds.detail_route row synced before this shipped
                keep resolving. */}
            <Route path="/configuration/locations" element={<LocationsConfigRedirect />} />
            <Route path="/configuration/locations/:id" element={<LocationsConfigRedirect />} />
            <Route path="/configuration/templates" element={<TemplatesPage />} />
            <Route path="/configuration/record-actions" element={<RecordActionsPage />} />
            <Route path="/configuration/presentation" element={<PresentationPage />} />
            <Route path="/configuration/integrations" element={<IntegrationsPage />} />
            <Route path="/configuration/ai" element={<AiPage />} />
            <Route path="/configuration/connect-assistant" element={<ConnectAssistantPage />} />
            <Route path="/configuration/assistant" element={<AssistantSettingsPage />} />
            <Route path="/configuration/x/:panelId" element={<HostedPanelPage />} />
            <Route path="/configuration/catalogs" element={<CatalogsPage />} />
            <Route path="/configuration/catalogs/match" element={<CatalogMatchPage />} />
            <Route path="/configuration/catalogs/:id" element={<CatalogDetailPage />} />
            <Route path="/configuration/portal" element={<PortalConfigPage />} />
            <Route path="/configuration/apps" element={<AppsConfigPage />} />
            {/* Permissions absorbs the two routes that were reachable ONLY
                through a tab strip and appeared in no sidebar, so standing on
                either highlighted nothing. */}
            <Route path="/configuration/permissions" element={<PermissionsPage />} />
            <Route
              path="/configuration/users"
              element={<Navigate to="/configuration/permissions?tab=accounts" replace />}
            />
            <Route
              path="/configuration/roles"
              element={<Navigate to="/configuration/permissions?tab=roles" replace />}
            />
            <Route path="/configuration/openapi" element={<OpenApiPage />} />
            <Route path="/configuration/api-recipes" element={<ApiRecipesPage />} />
            <Route path="/configuration/queue" element={<QueuePage />} />
            <Route path="/configuration/links" element={<LinksPage />} />
            <Route path="/configuration/sharing" element={<SharingPage />} />
            <Route path="/suggestions" element={<SuggestionsPage />} />
            {/* Settings FAMILY pages that live outside /configuration/* render
                inside the same sidebar — a sidebar link must never drop the
                sidebar. Files / Tags / Views used to be here too; they are
                BROWSE surfaces, so they moved to the nav (below). */}
            {/* The page is called Wires everywhere a user can read it; the route
                said /bindings because it was named after the API's noun (and
                the DB table) before the product settled on "wire". The URL
                matches the word now. The API path stays /orgs/:slug/bindings —
                that is a server contract, and renaming it is a separate,
                breaking change. */}
            <Route path="/wires" element={<BindingsPage />} />
            <Route path="/bindings" element={<Navigate to="/wires" replace />} />
            <Route path="/actions" element={<ActionsPage />} />
            <Route path="/bundles" element={<BundlesPage />} />
            <Route path="/bundles/compose" element={<BundleComposerPage />} />
            <Route path="/fields" element={<FieldsAndFormsPage />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/stocktakes/:id" element={<StocktakePage />} />
          </Route>
          {/* Browse surfaces — data you look at, so they wear normal workspace
              chrome and own one canonical URL each. They reach the nav through
              their module manifest's `nav` block rather than a hardcoded entry.
              See docs/design-decisions/configuration-revamp.md. */}
          <Route path="/files" element={<FilesPage />} />
          <Route path="/files/:id" element={<FileDetailPage />} />
          <Route path="/views" element={<ViewsPage />} />
          <Route path="/tags" element={<TagsPage />} />
          <Route path="/tags/:id" element={<TagDetailPage />} />
          <Route path="/discussion" element={<DiscussionInboxPage />} />
          <Route path="/maintenance" element={<MaintenancePage />} />
          {/* A saved view as a full PAGE — outside the configuration shell.
              The dashboard's pinned-view cards land here so a view opens
              with the whole screen, not as a modal floating over the
              /views config list. */}
          <Route path="/views/:viewId" element={<SavedViewPage />} />
          <Route path="/build" element={<BuildPage />} />
          {/* digifab is a domain (bare module name) → the navbar links to its
              top path `/digifab`. Route it there as well as the Configuration
              deep-link, or the nav entry falls through to the home redirect. */}
          <Route path="/digifab/production" element={<ProductionTestPage />} />
          <Route path="/digifab/embroidery" element={<EmbroideryPage />} />
          <Route path="/digifab/manager" element={<FloorManagerPage />} />
          <Route path="/digifab" element={<DigifabPage />} />
          <Route path="/makes" element={<MakesPage />} />
          <Route path="/makes/:id" element={<MakePage />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/apps" element={<AllAppsPage />} />
          <Route path="/people/:who" element={<PersonThingsPage />} />
          <Route path="/vault" element={<VaultPage />} />
          <Route path="/vault/:folderId" element={<VaultPage />} />
          {/* Nav alias — the synthetic "Locations" top routes here (useNavModules). */}
          <Route path="/locations" element={<LocationsPage />} />
          <Route path="/locations/place" element={<PlaceItemsPage />} />
          <Route path="/locations/:id" element={<LocationDetailPage />} />
          <Route path="/locations/:id/plan" element={<PlanLayoutPage />} />
          <Route path={OPEN_RECORD_ROUTE} element={<OpenRecordPage />} />
          <Route path="/scan" element={<ScanPage />} />
          <Route path="/scan/stations" element={<ScanStationsPage />} />
          <Route path="/scan/stations/:id" element={<ScanStationsPage />} />
          <Route path="/scan/stations/:id/sessions/:sessionId" element={<ScanStationsPage />} />
          <Route path="/scan/camera" element={<ScanCameraPage />} />
          {/* Where another app's share lands (the manifests' share_target). */}
          <Route path="/scan/share" element={<ShareReceivePage />} />
          {/* The bench display: the last few scans, big, no controls. */}
          <Route path="/scan/live" element={<ScanLivePage />} />
          {/* QR-label resolve inside the workspace: the in-app scanner
              navigates here on a label hit, and LandingEntry rewrites
              bare /qr/<token> URLs into /w/<default>/qr/<token>. */}
          <Route path="/qr/*" element={<QrResolvePage />} />
          <Route path="/a/*" element={<ActionLabelPage />} />
          <Route path="/bricklink-connector" element={<BrickLinkPage />} />
          {/* Legacy alias — pre-rename. A redirect, not a second URL for one page, so bookmarks keep working. */}
          <Route path="/bricklink" element={<Navigate to="/bricklink-connector" replace />} />
          {/* "What's new" from the account menu. The authed app mounts under the
              /w/:slug BASENAME, so the menu's <Link to="/changelog"> resolves to
              /w/<slug>/changelog — which fell through to the workspace catch-all
              (the link "did nothing"). The un-auth'd top-level /changelog route
              (public feed) only serves signed-out visitors. Same page, workspace
              chrome kept. */}
          <Route path="/changelog" element={<ChangelogPage />} />
          <Route path="/search" element={<SearchPage />} />
          {/* Every /me page renders inside AccountLayout, which owns the
              reading column. Pages used to set their own and drifted to five
              widths and three alignments. See lib/account-nav.ts. */}
          <Route element={<AccountLayout />}>
            <Route path="/me/activity" element={<MeActivityPage />} />
            <Route path="/me/notifications" element={<MeNotificationsPage />} />
            <Route path="/services/runs" element={<ServiceRunsPage />} />
            <Route path="/services/runs/:id" element={<ServiceRunPage />} />
            <Route path="/me/notification-channels" element={<MeNotificationChannelsPage />} />
            <Route path="/me/communication" element={<CommunicationPreferencesPage />} />
            <Route path="/me/photos" element={<PhotoConsentPage />} />
            <Route path="/me/feedback" element={<MyFeedbackPage />} />
            <Route path="/me/app-settings" element={<AppSettingsPage />} />
            <Route path="/me/drive" element={<DriveSettingsPage />} />
            <Route path="/me" element={<MeProfilePage />} />
            <Route path="/me/s/:section" element={<AccountSectionPage />} />
            <Route path="/me/identity" element={<MeIdentityPage />} />
            <Route path="/me/appearance" element={<MeAppearancePage />} />
            <Route path="/me/connections" element={<ConnectionsPage />} />
            <Route path="/me/connections/new" element={<ConnectionsPage startAdding />} />
            <Route path="/me/connections/mailbox-check/:id" element={<MailboxCheckPage />} />
            {/* Inside the managed-app surface on purpose: a locked app prints labels
                from the camera, and this is the only door where a Bluetooth printer
                can be paired (Configuration → Devices is outside it). */}
            <Route path="/me/printer" element={<PrintPageLazy embedded />} />
          </Route>
          {/* /me is canonical; /me/profile redirects so old bookmarks keep
              working. Outside the layout: a redirect renders no content. */}
          <Route path="/me/profile" element={<Navigate to="/me" replace />} />
          {/* Module-name aliases, now REDIRECTS not second mounts. Two live
              URLs for one page is the defect that made Locations bounce users
              into the settings shell; these were the same shape. The nav reads
              each module's manifest `nav.route`, so nothing needs the alias to
              resolve any more. */}
          <Route path="/core-files" element={<Navigate to="/files" replace />} />
          <Route path="/core-views" element={<Navigate to="/views" replace />} />
          <Route path="/core-tags" element={<Navigate to="/tags" replace />} />
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
          {/* Read-only floor plan for members — link it from the portal
              welcome markdown. */}
          <Route path="locations/:id/plan" element={<PortalPlanPage />} />
        </Route>
        {/* Print-friendly floor plan — chrome-less like the portal; the page
            is deliberately paper-white regardless of theme. */}
        <Route path="/print/:slug/locations/:id" element={<PlanPrintPage />} />
        <Route path="/print/:slug/locations/:id/layout/:draftId" element={<LayoutPrintPage />} />
        {/* The operator console now lives at TOP-LEVEL /admin (instance-wide,
            no workspace prefix — see Shell). Old workspace-nested URLs
            (/w/:slug/admin/…, /w/:slug/super-admin) escape with a full
            navigation so bookmarks keep working. */}
        <Route path="/admin/*" element={<ConsoleEscape />} />
        <Route path="/super-admin" element={<ConsoleEscape />} />
      </Routes>
      </Suspense>
      {/* Floating queue pill — top-nav mode only. In full-sidebar mode the
          basket lives as a foot row (AppLayout), same as the feedback pill;
          floating it in the empty bottom-right corner there reads as orphaned
          chrome. When it does float, it sits ABOVE the feedback pill (see
          BasketWidget) — the two used to overlap in that corner. */}
      {!onAdmin && labelsEnabled && !fullSide && !labelsRowInSidebar && <LabelsBasket orgSlug={activeSlug} getToken={getToken} />}
    </WorkspacePlatformWeb>
  );
}
