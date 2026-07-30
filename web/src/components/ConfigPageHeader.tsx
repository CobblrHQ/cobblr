// The ONE header every settings page wears, rendered by the layout from the
// registry entry — icon, title, description, and a slot for the page's own
// actions.
//
// It is rendered by the LAYOUT and not by the page on purpose. When each page
// wrote its own <h1>, 24 settings pages grew TEN different headers: two font
// families, three weights, two sizes, some with the sentence-case lift and some
// without. Nobody chose that; each page copied whichever neighbour was open at
// the time. Reviewing a diff cannot catch it either, because every single one of
// those headers looks fine on its own page. Only seeing two in a row shows the
// problem, which is exactly what a user does and a reviewer does not.
//
// It also fixes duplication: the description already lives in the registry (the
// hub and the section pages render it), so a page repeating it meant the same
// sentence maintained in two places, and Permissions ended up printing its own
// title twice under the breadcrumb that had just said it.
//
// A page now renders its CONTENT. If it needs a button up top, it wraps it in
// <ConfigHeaderActions>.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";
import { CONFIG_DESTINATIONS } from "../lib/configuration-nav";

interface HeaderSlot {
  actions: ReactNode;
  setActions: (n: ReactNode) => void;
}

const Ctx = createContext<HeaderSlot | null>(null);

export function ConfigHeaderProvider({ children }: { children: ReactNode }) {
  const [actions, setActions] = useState<ReactNode>(null);
  const value = useMemo(() => ({ actions, setActions }), [actions]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Put a page's own buttons in the shared header. Renders nothing where you
 *  place it; the layout draws the children beside the title. */
export function ConfigHeaderActions({ children }: { children: ReactNode }) {
  const ctx = useContext(Ctx);
  useEffect(() => {
    ctx?.setActions(children);
    return () => ctx?.setActions(null);
  });
  return null;
}

/** The header itself. Reads the current route's registry entry; renders nothing
 *  for a route that is not a settings destination (the hub, a section page). */
export function ConfigPageHeader() {
  const { pathname } = useLocation();
  const ctx = useContext(Ctx);
  const here = CONFIG_DESTINATIONS.find(
    (d) => pathname === d.to || pathname.startsWith(`${d.to}/`),
  );
  if (!here) return null;
  const Icon = here.icon;
  return (
    <header className="mb-5">
      <div className="flex items-start gap-3">
        <Icon size={22} className="mt-0.5 shrink-0 text-accent dark:text-cobble-300" aria-hidden />
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">
            {here.label}
          </h1>
          <p className="page-subtitle mt-0.5">{here.description}</p>
        </div>
        {ctx?.actions ? (
          <div className="shrink-0 flex items-center gap-2">{ctx.actions}</div>
        ) : null}
      </div>
    </header>
  );
}
