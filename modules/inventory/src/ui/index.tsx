// Inventory module's UI export. The web host imports this from
// "@cobblr/inventory/ui" and mounts <InventoryUI /> inside its
// React Router tree, wrapping it with InventoryProvider so the
// pages can pull api + orgSlug from context.
//
// The host also reads `navItems` to render the module's nav entries
// in the platform shell.

import { Routes, Route, NavLink, useLocation } from "react-router-dom";
import { Boxes } from "lucide-react";
// Side-effect: registers the inventory "at a glance" dashboard tile through
// platform-web's registerDashboardWidget seam when this UI bundle loads.
import "./DashboardWidget";
import { InventoryProvider, useInventory, type ParentConfig } from "./context";
import { PartsListPage } from "./PartsListPage";
import { SettingsPage } from "./SettingsPage";

// Re-export the NewPartDialog + Provider so the portal shell can
// mount a per-view create button when the user has the
// inventory:create-part capability. Wraps the dialog with the same
// InventoryProvider the admin shell uses.
export { NewPartDialog } from "./NewPartDialog";
export { InventoryProvider } from "./context";

export const navItems = [
  { label: "Inventory", path: "/inventory", icon: Boxes },
];

interface InventoryUIProps {
  orgSlug: string;
  getToken: () => string | null;
  /** When set, scopes every parts query to this module instance — the
   *  page renders that instance's items, isolated from the others. */
  instance?: string;
  /** Heading to show (the instance's display label). Default
   *  "inventory" = the default instance. */
  displayName?: string;
  /** Singular noun for the add button + create modal ("yarn" → "New yarn"). */
  itemNoun?: string;
  /** Plural noun for lists / search / counts ("Film" → "films"). */
  itemNounPlural?: string;
  /** Default unit for new items (e.g. "skein"). */
  qtyUnit?: string;
  /** When items belong to a parent "type" in another instance (Spool → Filament
   *  type), the forms show a parent picker + write an `instance-of` pairing. */
  parent?: ParentConfig;
}

export function InventoryUI({ orgSlug, getToken, instance, displayName, itemNoun, itemNounPlural, qtyUnit, parent }: InventoryUIProps) {
  return (
    <InventoryProvider orgSlug={orgSlug} getToken={getToken} instance={instance} itemNoun={itemNoun} itemNounPlural={itemNounPlural} qtyUnit={qtyUnit} parent={parent}>
      <div className="space-y-4">
        <Header title={displayName ?? "inventory"} />
        <Routes>
          {/* Both render the list; parts/:id additionally opens the
              detail MODAL (D4) — the list stays mounted underneath,
              mirroring machines. */}
          <Route index element={<PartsListPage />} />
          <Route path="parts/:id" element={<PartsListPage />} />
          <Route path="settings" element={<SettingsPage />} />
          {/* Bundle setup-cards / next-steps deep-link to
              /instances/<name>/items (mirroring the API path
              /orgs/:slug/instances/:name/items). That UI path had no
              matching route, so it rendered the Header + a blank below.
              Map it — and any other stray instance sub-path — to the
              list so a deep-link never dead-ends on a blank page. */}
          <Route path="items" element={<PartsListPage />} />
          <Route path="items/:id" element={<PartsListPage />} />
          <Route path="*" element={<PartsListPage />} />
        </Routes>
      </div>
    </InventoryProvider>
  );
}

function Header({ title }: { title: string }) {
  // The list tab is named after WHAT IT HOLDS. The noun is already in context
  // (every instance declares it) and the tabs used to throw it away: a base
  // inventory hardcoded "Parts" and a skinned instance fell back to the generic
  // "List", so Yarn's tab read "List" instead of "Skeins" (reported 2026-08-01).
  const { itemNounPlural } = useInventory();
  const listLabel = itemNounPlural
    ? itemNounPlural.charAt(0).toUpperCase() + itemNounPlural.slice(1)
    : "Items";
  // Underline TABS, not "// path" links. Prefixing each with "//" made a pair of
  // peers read as a breadcrumb - as though Settings lived under Parts.
  const cls = ({ isActive }: { isActive: boolean }) =>
    "pb-3 -mb-3 border-b-2 transition " +
    (isActive
      ? "border-accent text-content dark:text-mortar-100 font-semibold"
      : "border-transparent text-faint dark:text-slate-500 hover:text-content dark:hover:text-mortar-200");
  // Link the tabs ABSOLUTELY off the instance/module base — everything up
  // through ".../instances/<name>" (or ".../inventory"). InventoryUI's inner
  // <Routes> mounts under a splat, so a RELATIVE `to="settings"` resolves
  // against the *current* path and re-clicking appended forever
  // (/settings/settings/settings…); `to="."` self-referenced so "list" did
  // nothing from the settings page. An absolute base fixes both and also
  // recovers from an already-broken URL.
  const { pathname } = useLocation();
  const base =
    pathname.match(/^.*\/instances\/[^/]+/)?.[0] ??
    pathname.match(/^.*\/inventory/)?.[0] ??
    pathname.replace(/\/(settings|items|parts)(\/.*)?$/, "");
  return (
    <div className="flex items-baseline gap-4 border-b border-line dark:border-slate-700 pb-3">
      <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">
        {title}
      </h1>
      {/* The default inventory page reads "// parts // settings". On a skinned
          instance (Yarn) "parts" is the wrong noun, but settings still has to be
          reachable — it's where you edit a list's dropdown options (otherwise
          there's no findable "config area"). So keep a settings link either way. */}
      <nav className="flex items-baseline gap-5 text-sm">
        <NavLink to={base} end className={cls}>{listLabel}</NavLink>
        <NavLink to={`${base}/settings`} className={cls}>Settings</NavLink>
      </nav>
    </div>
  );
}

export default InventoryUI;
