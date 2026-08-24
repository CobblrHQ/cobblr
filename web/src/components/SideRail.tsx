// The one right-hand rail, and the tabs that share it.
//
// There is exactly ONE right-side panel and there always will be: it is 440px
// of a laptop screen, and AppLayout shifts the whole page left to make room
// (xl:pr-[456px]). A second rail would leave the record narrower than the two
// panels discussing it, so anything that wants to live beside a record becomes
// a TAB here rather than a new panel.
// Spec: docs/design-decisions/discussion-and-the-side-rail.md
//
// WHY TABS PORTAL IN, instead of the rail rendering them:
//
// The rail's chrome only exists while it is open, but a tab's STATE has to
// outlive that. Cobb's conversation survives close/reopen precisely because
// ChatPanel stays mounted in AppLayout the whole time and renders null when
// hidden. If the rail owned its tabs, closing it would unmount them and throw
// that away — the exact regression ChatWidget.test.ts was written to prevent.
//
// So ownership is inverted: AppLayout mounts each tab component once and
// forever, the rail publishes three slots (title, actions, content), and the
// ACTIVE tab portals itself into them. A hidden tab renders nothing and keeps
// everything.
//
// With one tab the bar hides itself and the header shows that tab's own title,
// which is why introducing this shell changed nothing on screen.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { SidePanel } from "./SidePanel";

/** What a tab tells the bar about itself. Registered on mount so the bar can
 *  draw it without the rail importing every tab. */
export interface RailTabInfo {
  id: string;
  /** The word on the tab. */
  label: string;
  /** Shown instead of the label when the bar is too narrow for words. */
  icon: ReactNode;
  /** Unread/pending count. 0 or undefined draws nothing. */
  badge?: number;
  /** Lower sorts first; keeps bar order independent of mount order. */
  order: number;
}

interface RailContext {
  open: boolean;
  setOpen: (v: boolean) => void;
  activeId: string | null;
  setActiveId: (id: string) => void;
  register: (tab: RailTabInfo) => () => void;
  titleEl: HTMLElement | null;
  actionsEl: HTMLElement | null;
  contentEl: HTMLElement | null;
  /** True when the bar is drawn, i.e. more than one tab exists. A tab uses this
   *  to drop its own title, which the bar has replaced. */
  barVisible: boolean;
}

const Ctx = createContext<RailContext | null>(null);

/** Open the rail on a given tab from anywhere. The chat's existing
 *  `cobblr:open-chat` event still works and is handled by the Cobb tab; this is
 *  the generic form. */
export function openRail(tabId: string): void {
  window.dispatchEvent(new CustomEvent("cobblr:open-rail", { detail: { tab: tabId } }));
}

// WHICH TAB IS SHOWING, readable from outside the rail.
//
// The launchers live in the app chrome, not under this provider, so they cannot
// use the context. Without knowing the active tab a launcher can only "open" or
// "toggle", and both are wrong once there is more than one room: pressing Cobb
// while Discussion was showing CLOSED the panel instead of switching to Cobb,
// and pressing Discussion while Discussion was showing did nothing at all.
//
// A tiny store rather than a context, for the same reason openRail is an event:
// the two sides of this are in different subtrees and always will be.
let activeTab: string | null = null;
const tabListeners = new Set<() => void>();

function setActiveTabStore(id: string | null): void {
  if (activeTab === id) return;
  activeTab = id;
  for (const l of tabListeners) l();
}

/** The tab the rail is showing, or null. Re-renders on change. */
export function useRailActiveTab(): string | null {
  return useSyncExternalStore(
    (cb: () => void) => {
      tabListeners.add(cb);
      return () => tabListeners.delete(cb);
    },
    () => activeTab,
    () => activeTab,
  );
}

/** Mount a tab into the rail.
 *
 *  `active` is what a tab should gate its work on — not `open`. A tab that is
 *  mounted but not showing must not poll, subscribe, or capture selection. */
export function useRailTab(info: RailTabInfo | null): {
  open: boolean;
  active: boolean;
  setOpen: (v: boolean) => void;
} {
  const ctx = useContext(Ctx);
  // `null` means "not applicable here" — the tab is not registered, so the bar
  // does not draw it and the rail does not count it. Discussion uses this on
  // every page that is not a record: a visible dead tab reads as broken, an
  // absent one reads as "not here". Passing null must NOT be a conditional
  // hook, hence the fields are read defensively rather than early-returning.
  const id = info?.id ?? "";
  const label = info?.label ?? "";
  const badge = info?.badge;
  const order = info?.order ?? 0;
  const icon = info?.icon ?? null;
  const enabled = !!info;
  const register = ctx?.register;
  useEffect(() => {
    if (!register || !enabled) return;
    return register({ id, label, icon, badge, order });
    // `icon` is JSX and would be a new object every render; the id is what
    // identifies the tab, and label/badge are the only parts that change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [register, enabled, id, label, badge, order]);
  return {
    open: !!ctx?.open,
    active: !!ctx?.open && ctx?.activeId === id,
    setOpen: ctx?.setOpen ?? (() => {}),
  };
}

/** Render a tab's chrome + body into the rail. Renders nothing unless the tab
 *  is the active one, so an inactive tab costs a mounted component and no DOM. */
export function RailTabContent({
  id,
  title,
  actions,
  children,
}: {
  id: string;
  /** Shown in the header when this is the ONLY tab. Ignored once the bar draws,
   *  because then the bar IS the title. */
  title?: ReactNode;
  /** This tab's header buttons, to the left of the close control. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const ctx = useContext(Ctx);
  if (!ctx || !ctx.open || ctx.activeId !== id) return null;
  return (
    <>
      {title && !ctx.barVisible && ctx.titleEl ? createPortal(title, ctx.titleEl) : null}
      {actions && ctx.actionsEl ? createPortal(actions, ctx.actionsEl) : null}
      {ctx.contentEl ? createPortal(children, ctx.contentEl) : null}
    </>
  );
}

export function SideRail({
  open,
  setOpen,
  initialTab,
  children,
}: {
  open: boolean;
  setOpen: (v: boolean) => void;
  /** The tab that was showing before a refresh, if any. Honoured ONCE, when the
   *  tab that owns it registers - after that the person's clicks decide. */
  initialTab?: string | null;
  /** The tab components. Mounted here for the lifetime of the app so their
   *  state survives the rail closing. */
  children: ReactNode;
}) {
  const [tabs, setTabs] = useState<RailTabInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [titleEl, setTitleEl] = useState<HTMLElement | null>(null);
  const [actionsEl, setActionsEl] = useState<HTMLElement | null>(null);
  const [contentEl, setContentEl] = useState<HTMLElement | null>(null);

  const register = useMemo(
    () => (tab: RailTabInfo) => {
      setTabs((prev) => [...prev.filter((t) => t.id !== tab.id), tab].sort((a, b) => a.order - b.order));
      return () => setTabs((prev) => prev.filter((t) => t.id !== tab.id));
    },
    [],
  );

  // First tab to register becomes the default, so the rail is never open with
  // nothing showing - UNLESS a previous tab is remembered and still exists.
  //
  // Tabs register one by one as their components mount, so "restore" cannot be
  // a one-shot on first render: the remembered tab may not have registered yet,
  // and picking tabs[0] before it does is exactly how a refresh landed everyone
  // back on Cobb. The restore is therefore attempted on every registration
  // until it lands, and then never again, so it cannot fight a later click.
  const restored = useRef(false);
  useEffect(() => {
    if (!activeId && tabs[0]) {
      const wanted = !restored.current && initialTab ? tabs.find((t) => t.id === initialTab) : undefined;
      if (wanted) restored.current = true;
      setActiveId((wanted ?? tabs[0]).id);
    }
    if (!restored.current && initialTab && activeId && activeId !== initialTab) {
      const wanted = tabs.find((t) => t.id === initialTab);
      if (wanted) {
        restored.current = true;
        setActiveId(wanted.id);
      }
    }
    if (activeId && !tabs.some((t) => t.id === activeId)) setActiveId(tabs[0]?.id ?? null);
  }, [tabs, activeId, initialTab]);

  // Mirror it out for the launchers. `open` is theirs already; the tab is not.
  useEffect(() => {
    setActiveTabStore(open ? activeId : null);
  }, [open, activeId]);

  useEffect(() => {
    const onOpenRail = (e: Event) => {
      const tab = (e as CustomEvent<{ tab?: string }>).detail?.tab;
      if (tab) setActiveId(tab);
      setOpen(true);
    };
    window.addEventListener("cobblr:open-rail", onOpenRail);
    return () => window.removeEventListener("cobblr:open-rail", onOpenRail);
  }, [setOpen]);

  // The chat's own deep-link event predates the rail and is still the way every
  // surface opens Cobb. It must also SELECT his tab, or a click on "Ask Cobb"
  // would open the rail on whatever tab was last used.
  useEffect(() => {
    const onOpenChat = () => setActiveId("cobb");
    window.addEventListener("cobblr:open-chat", onOpenChat);
    return () => window.removeEventListener("cobblr:open-chat", onOpenChat);
  }, []);

  const barVisible = tabs.length > 1;
  const ctx = useMemo<RailContext>(
    () => ({ open, setOpen, activeId, setActiveId, register, titleEl, actionsEl, contentEl, barVisible }),
    [open, setOpen, activeId, register, titleEl, actionsEl, contentEl, barVisible],
  );

  return (
    <Ctx.Provider value={ctx}>
      {children}
      {open && (
        <SidePanel
          width="sm:w-[min(100vw,440px)]"
          escapeExempt
          // Only true while Cobb is showing: it tells a text selection made
          // inside the panel that it is Cobb's own words being read back, which
          // is not what a selection in the Discussion tab means.
          cobbPanel={activeId === "cobb"}
        >
          <header className="flex items-center justify-between px-4 py-3 border-b border-line dark:border-slate-700 shrink-0">
            {barVisible ? (
              <div role="tablist" className="flex items-center gap-1 min-w-0">
                {tabs.map((t) => {
                  const on = t.id === activeId;
                  return (
                    <button
                      key={t.id}
                      role="tab"
                      aria-selected={on}
                      onClick={() => setActiveId(t.id)}
                      title={t.label}
                      className={
                        "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm transition shrink-0 " +
                        (on
                          ? "bg-subtle dark:bg-slate-800 text-content dark:text-mortar-100 font-medium"
                          : "text-muted hover:text-content dark:hover:text-mortar-200")
                      }
                    >
                      <span className="shrink-0">{t.icon}</span>
                      {/* Words cost room the close control cannot give up. Below
                          `sm` only the ACTIVE tab keeps its label; the others are
                          their icon, so three tabs plus the X still fit 390px. */}
                      <span className={on ? "truncate" : "hidden sm:inline truncate"}>{t.label}</span>
                      {!!t.badge && t.badge > 0 && (
                        <span className="shrink-0 rounded-full bg-amber-400 text-cobble-900 text-[10px] leading-none px-1.5 py-0.5">
                          {t.badge > 99 ? "99+" : t.badge}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div
                ref={setTitleEl}
                className="flex items-center gap-2 text-sm font-semibold text-content dark:text-mortar-100 min-w-0"
              />
            )}
            <div className="flex items-center gap-1 shrink-0">
              <div ref={setActionsEl} className="flex items-center gap-1" />
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-faint hover:text-content dark:hover:text-mortar-200 transition"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
          </header>
          <div ref={setContentEl} className="flex-1 min-h-0 flex flex-col" />
        </SidePanel>
      )}
    </Ctx.Provider>
  );
}
