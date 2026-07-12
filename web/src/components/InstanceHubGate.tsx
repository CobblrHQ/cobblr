// Base-module-page instance hub. Wrap an instanceable module's base route so
// that, when the base (default) collection is EMPTY but the workspace has named
// instances of it (e.g. Projects with only a "Designs" instance), the base page
// renders those instances as tiles — a way IN — instead of a dead empty page.
//
// This is the third surface of the same "empty default + named instances" idea
// that the nav (defaultModuleEntriesToHide) and the dashboard (expandInstance
// Widgets) already handle; the base PAGE was the one still wired per-module by
// hand (MachinesPage/AssetsPage, which are app pages and can use the chooser
// directly). Module-shipped UIs (Projects, Inventory) can't import the app-side
// chooser, so the gate lives here in the app and wraps their route.
//
// Only fires on the EXACT base path — /projects/:id (a detail) and nested routes
// fall straight through to the module's own UI.

import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import { api } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { ModuleInstanceChooser } from "./ModuleInstanceChooser";

export function InstanceHubGate({
  module,
  basePath,
  icon,
  noun,
  children,
}: {
  module: string;
  basePath: string;
  icon: LucideIcon;
  noun: string;
  children: ReactNode;
}) {
  const { activeSlug } = useActiveOrg();
  const location = useLocation();
  const atBase = location.pathname === basePath || location.pathname === `${basePath}/`;
  const q = useQuery({
    queryKey: ["instances", activeSlug, module],
    queryFn: () => api.listInstances(activeSlug ?? "", module),
    enabled: !!activeSlug && atBase,
    staleTime: 30_000,
  });

  // Anything below the base (details, nested routes) is the module's own UI.
  if (!atBase) return <>{children}</>;

  const items = q.data?.items ?? [];
  const named = items.filter((i) => !i.is_default);
  const def = items.find((i) => i.is_default);
  const showHub = named.length > 0 && (def?.item_count ?? 0) === 0;

  // Until we know, and whenever the default has its own items or there are no
  // named instances, show the module's normal base page.
  if (q.isLoading || !showHub) return <>{children}</>;
  return <ModuleInstanceChooser instances={named} icon={icon} noun={noun} />;
}
