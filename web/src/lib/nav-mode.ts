// Nav-placement preference (top bar ⇄ left sidebar) + the sidebar's
// pinned ⇄ auto-hide option — shared between AppLayout (which renders the
// chrome), SidebarNav, and ConfigurationLayout (which suppresses its own
// sidebar when the main one folds the config nav in). localStorage-backed,
// per-device; a custom event keeps every consumer in sync within the tab.

import { useSyncExternalStore } from "react";

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
export function setNavMode(mode: NavMode): void {
  localStorage.setItem(MODE_KEY, mode);
  window.dispatchEvent(new Event(EVT));
}
export function setNavAutoHide(on: boolean): void {
  localStorage.setItem(HIDE_KEY, on ? "1" : "0");
  window.dispatchEvent(new Event(EVT));
}
/** "Completely sidebar": hide the top bar while nav is in the sidebar — the
 *  brand/workspace move to the sidebar head, the Scan/search/bell/AI/account
 *  cluster to its foot (the Notion/Linear/Slack shape). Default ON the bar. */
export function getNavTopBar(): boolean {
  return localStorage.getItem(TOPBAR_KEY) !== "0";
}
export function setNavTopBar(on: boolean): void {
  localStorage.setItem(TOPBAR_KEY, on ? "1" : "0");
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
