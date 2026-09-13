// Nav-placement preference (top bar ⇄ left sidebar) + the sidebar's
// pinned ⇄ auto-hide option — shared between AppLayout (which renders the
// chrome), SidebarNav, and ConfigurationLayout (which suppresses its own
// sidebar when the main one folds the config nav in). A custom event keeps
// every consumer in sync within the tab.
//
// FOLLOWS THE ACCOUNT, same as theme_pref. It was localStorage-only, which meant
// setting the sidebar and then signing in on another desktop put you back on the
// top bar, with nothing to indicate the preference still existed. localStorage
// is now a CACHE, not the record: it is read synchronously so the first paint is
// right (useSyncExternalStore cannot await), and users.nav_pref is what actually
// persists.
//
// The three values travel together because they are one decision — `autohide`
// and `topbar` only mean anything in side mode, and arriving on a synced sidebar
// in an unsynced sub-configuration is the same complaint one level down.
//
// Desktop only, structurally: the sidebar renders `hidden md:block`, so a phone
// ignores all of this and keeps its own menu. Syncing cannot reach mobile.

import { useSyncExternalStore } from "react";
import { api } from "./api";

const MODE_KEY = "cobblr.nav.mode";
const HIDE_KEY = "cobblr.nav.autohide";
const TOPBAR_KEY = "cobblr.nav.topbar";
const EVT = "cobblr:nav-pref";

export type NavMode = "top" | "side";

export function getNavMode(): NavMode {
  return localStorage.getItem(MODE_KEY) === "side" ? "side" : "top";
}
export function getNavAutoHide(): boolean {
  return localStorage.getItem(HIDE_KEY) === "1";
}
/** Has this device recorded a layout at all? A device that has never chosen
 *  reads as "top" too, and the graduation rules (nav-graduation.ts) need to
 *  tell the two apart: the default is offered a sidebar once, a choice never. */
export function hasLocalNavChoice(): boolean {
  return localStorage.getItem(MODE_KEY) !== null;
}
export function setNavMode(mode: NavMode): void {
  localStorage.setItem(MODE_KEY, mode);
  changed();
}
export function setNavAutoHide(on: boolean): void {
  localStorage.setItem(HIDE_KEY, on ? "1" : "0");
  changed();
}
/** "Completely sidebar": hide the top bar while nav is in the sidebar — the
 *  brand/workspace move to the sidebar head, the Scan/search/bell/AI/account
 *  cluster to its foot (the Notion/Linear/Slack shape). Default ON the bar. */
export function getNavTopBar(): boolean {
  return localStorage.getItem(TOPBAR_KEY) !== "0";
}
export function setNavTopBar(on: boolean): void {
  localStorage.setItem(TOPBAR_KEY, on ? "1" : "0");
  changed();
}

export interface NavPref {
  mode: NavMode;
  autohide: boolean;
  topbar: boolean;
}

/** What this device currently shows. */
export function getNavPref(): NavPref {
  return { mode: getNavMode(), autohide: getNavAutoHide(), topbar: getNavTopBar() };
}

/** The three layouts a person can name. `mode` and `topbar` are one decision
 *  seen from Appearance: "Sidebar" keeps the top bar, "Sidebar only" hides it.
 *  Autohide is not part of a layout (it is spatial, and lives on the pin in
 *  the sidebar itself). */
export type NavLayout = "top" | "side" | "side-only";

export const NAV_LAYOUTS: ReadonlyArray<{
  value: NavLayout;
  label: string;
  desc: string;
  pref: Pick<NavPref, "mode" | "topbar">;
}> = [
  {
    value: "top",
    label: "Top bar",
    desc: "Your modules run across the top. Roomy with a handful of them; folds into more as they grow.",
    pref: { mode: "top", topbar: true },
  },
  {
    value: "side",
    label: "Sidebar",
    desc: "Everything down the left, always visible, with the top bar kept for the workspace and tools.",
    pref: { mode: "side", topbar: true },
  },
  {
    value: "side-only",
    label: "Sidebar only",
    desc: "The sidebar is the whole frame: brand and workspace at its head, the tools at its foot, no top bar.",
    pref: { mode: "side", topbar: false },
  },
];

/** Which of the three a pref is. `topbar` only means anything in side mode, so
 *  a top-bar layout with the bar flag off is still "top". */
export function layoutOf(pref: Pick<NavPref, "mode" | "topbar">): NavLayout {
  if (pref.mode !== "side") return "top";
  return pref.topbar ? "side" : "side-only";
}

export function getNavLayout(): NavLayout {
  return layoutOf(getNavPref());
}

/** Pick a layout as ONE change: both keys land, then one event and one push.
 *  Setting mode and topbar through their own setters pushed twice, and the
 *  second write could lose to the first on a slow link, leaving the account
 *  on a layout nobody chose. Autohide is kept as it was. */
export function setNavLayout(layout: NavLayout): void {
  const target = NAV_LAYOUTS.find((l) => l.value === layout);
  if (!target) return;
  localStorage.setItem(MODE_KEY, target.pref.mode);
  localStorage.setItem(TOPBAR_KEY, target.pref.topbar ? "1" : "0");
  changed();
}

/** Tell this tab, then the account. The push is fire-and-forget: a failed sync
 *  must not undo a toggle the user can see has already happened, and the next
 *  toggle retries it anyway. */
function changed(): void {
  window.dispatchEvent(new Event(EVT));
  void api.setNavPref(getNavPref()).catch(() => {});
}

/** Apply the account's stored layout to this device. Called once after the
 *  session loads. A device that has never chosen simply adopts it; a device that
 *  HAS chosen also adopts it, because the account is the record and the local
 *  copy is a cache of it — otherwise the first machine you ever set would be the
 *  only one that could change the preference. */
export function hydrateNavPref(pref: NavPref | null | undefined): void {
  if (!pref) return;
  if (
    pref.mode === getNavMode() &&
    pref.autohide === getNavAutoHide() &&
    pref.topbar === getNavTopBar()
  ) {
    return; // already in sync — don't wake every consumer for nothing
  }
  localStorage.setItem(MODE_KEY, pref.mode);
  localStorage.setItem(HIDE_KEY, pref.autohide ? "1" : "0");
  localStorage.setItem(TOPBAR_KEY, pref.topbar ? "1" : "0");
  window.dispatchEvent(new Event(EVT));
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(EVT, cb);
  window.addEventListener("storage", cb); // cross-tab
  return () => {
    window.removeEventListener(EVT, cb);
    window.removeEventListener("storage", cb);
  };
}

export function useNavMode(): NavMode {
  return useSyncExternalStore(subscribe, getNavMode, () => "top" as const);
}
export function useNavAutoHide(): boolean {
  return useSyncExternalStore(subscribe, getNavAutoHide, () => false);
}
export function useNavTopBar(): boolean {
  return useSyncExternalStore(subscribe, getNavTopBar, () => true);
}
export function useNavLayout(): NavLayout {
  return useSyncExternalStore(subscribe, getNavLayout, () => "top" as const);
}
export function useNavChoiceMade(): boolean {
  return useSyncExternalStore(subscribe, hasLocalNavChoice, () => false);
}
