// A page for a module that is off says so, and offers the one thing that
// works: turning it on (an owner or admin) or asking someone who can.
//
// Without this, /inventory on a workspace that never turned Inventory on drew
// the whole working page (filters, "New part", "Import CSV") over calls that
// all answered 409, and Lists and Purchases showed "New list" and "Log the
// first order" the same way. A first-time user pressed them and nothing
// worked. The gate stands at the one outlet every page renders through, and
// knows a page's module from the app catalogue (the registry the All apps
// page reads), so no page has to remember to wrap itself.

import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { Power } from "lucide-react";
import type { AppEntry } from "@cobblr/platform-contract/app-catalog";
import { useAppCatalog, useModuleDoor } from "../lib/appCatalog";

/** The app whose page this is, when that app is off. A page belongs to the
 *  app whose route's first segment it starts with, the same key the nav and
 *  the All apps page use. */
export function moduleOffAt(pathname: string, apps: readonly AppEntry[]): AppEntry | null {
  const seg = pathname.split("/").filter(Boolean)[0];
  if (!seg) return null;
  const app = apps.find((a) => a.key === seg);
  return app && app.state === "off" ? app : null;
}

export function ModuleOffGate({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const { apps, loading } = useAppCatalog();
  const off = loading ? null : moduleOffAt(pathname, apps);
  if (!off) return <>{children}</>;
  return <ModuleOff app={off} />;
}

function ModuleOff({ app }: { app: AppEntry }) {
  const door = useModuleDoor();
  return (
    <div className="max-w-xl mx-auto mt-10 rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-6 text-center">
      <Power className="w-8 h-8 mx-auto text-faint mb-3" aria-hidden />
      <h1 className="text-lg font-semibold text-content dark:text-mortar-100 mb-1">{app.label} is not on in this workspace</h1>
      {app.description && <p className="text-sm text-muted mb-4">{app.description}</p>}
      {door.canTurnOn ? (
        <button
          type="button"
          disabled={door.busy}
          onClick={() => door.turnOn(app)}
          className="px-4 py-2 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
        >
          Turn on {app.label}
        </button>
      ) : (
        <>
          <p className="text-sm text-muted mb-3">Only an owner or an admin can turn it on.</p>
          <button
            type="button"
            disabled={door.busy}
            onClick={() => door.ask(app)}
            className="px-4 py-2 text-sm rounded border border-line dark:border-slate-600 hover:border-accent disabled:opacity-50"
          >
            Ask an admin to turn it on
          </button>
        </>
      )}
    </div>
  );
}
