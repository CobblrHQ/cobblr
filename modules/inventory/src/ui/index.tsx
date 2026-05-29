// Inventory module's UI export. The web host imports this from
// "@cobblr/inventory/ui" and mounts <InventoryUI /> inside its
// React Router tree, wrapping it with InventoryProvider so the
// pages can pull api + orgSlug from context.
//
// The host also reads `navItems` to render the module's nav entries
// in the platform shell.

import { Routes, Route, NavLink } from "react-router-dom";
import { Boxes } from "lucide-react";
import { InventoryProvider } from "./context";
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
}

export function InventoryUI({ orgSlug, getToken, instance, displayName }: InventoryUIProps) {
  return (
    <InventoryProvider orgSlug={orgSlug} getToken={getToken} instance={instance}>
      <div className="space-y-4">
        <Header title={displayName ?? "inventory"} scoped={!!instance} />
        <Routes>
          {/* Both render the list; parts/:id additionally opens the
              detail MODAL (D4) — the list stays mounted underneath,
              mirroring machines. */}
          <Route index element={<PartsListPage />} />
          <Route path="parts/:id" element={<PartsListPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Routes>
      </div>
    </InventoryProvider>
  );
}

function Header({ title, scoped }: { title: string; scoped: boolean }) {
  const cls = ({ isActive }: { isActive: boolean }) =>
    isActive ? "text-cobble-600 font-semibold" : "text-slate-400 dark:text-slate-500 hover:text-cobble-500";
  return (
    <div className="flex items-baseline gap-4 border-b border-slate-200 dark:border-slate-700 pb-3">
      <h1 className="font-display text-2xl font-extrabold text-slate-700 dark:text-mortar-100 lowercase">
        {title}
      </h1>
      <nav className="flex gap-3 text-xs font-mono">
        <NavLink to="." end className={cls}>// parts</NavLink>
        {/* Settings (categories) live in the default instance — only
            expose them on the default inventory page. */}
        {!scoped && (
          <NavLink to="settings" className={cls}>// settings</NavLink>
        )}
      </nav>
    </div>
  );
}

export default InventoryUI;
