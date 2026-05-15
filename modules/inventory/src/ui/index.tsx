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
import { PartDetailPage } from "./PartDetailPage";
import { SettingsPage } from "./SettingsPage";

export const navItems = [
  { label: "Inventory", path: "/inventory", icon: Boxes },
];

interface InventoryUIProps {
  orgSlug: string;
  getToken: () => string | null;
}

export function InventoryUI({ orgSlug, getToken }: InventoryUIProps) {
  return (
    <InventoryProvider orgSlug={orgSlug} getToken={getToken}>
      <div className="space-y-4">
        <Header />
        <Routes>
          <Route index element={<PartsListPage />} />
          <Route path="parts/:id" element={<PartDetailPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Routes>
      </div>
    </InventoryProvider>
  );
}

function Header() {
  const cls = ({ isActive }: { isActive: boolean }) =>
    isActive ? "text-cobble-600 font-semibold" : "text-slate-400 dark:text-slate-500 hover:text-cobble-500";
  return (
    <div className="flex items-baseline gap-4 border-b border-slate-200 dark:border-slate-700 pb-3">
      <h1 className="font-display text-2xl font-extrabold text-slate-700 dark:text-mortar-100 lowercase">
        inventory
      </h1>
      <nav className="flex gap-3 text-xs font-mono">
        <NavLink to="." end className={cls}>// parts</NavLink>
        <NavLink to="settings" className={cls}>// settings</NavLink>
      </nav>
    </div>
  );
}

export default InventoryUI;
