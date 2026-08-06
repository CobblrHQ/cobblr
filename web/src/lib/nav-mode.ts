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
