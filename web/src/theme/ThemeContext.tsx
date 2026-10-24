// Theme — light / dark, applied as a class on <html> (Tailwind darkMode:
// "class"). THREE inputs, resolved in strict precedence:
//
//   deviceOverride  — THIS browser only. localStorage, never synced. "Lock this
//                     screen to dark" without touching your account default
//                     (e.g. a shared wall display, or one machine you want dark
//                     even though your default is light). null = no override.
//   accountPref     — your account-wide default: "light" / "dark" / null (=
//                     match device). Persisted server-side (users.theme_pref)
//                     and synced to every device on login.
//   os              — the device's own OS setting (prefers-color-scheme).
//
//   resolved theme = deviceOverride ?? accountPref ?? os
//
// Two genuinely separate things (the author): a per-device lock and a global default.
// The always-visible quick toggle (sidebar icon / account menu / ⌘K) sets the
// DEVICE override — a fast "flip this screen"; the account default is a
// deliberate choice under Profile → Appearance. Toggling toward what your
// account would show anyway RELEASES the device lock (stays in sync); toggling
// away LOCKS this device.
//
// FOUC: both prefs are cached in localStorage, and web/public/prepaint.js reads
// them (with resolveTheme's rule) to set the class BEFORE the first paint, so a
// dark-mode user never sees a light page while the app loads. The effect below
// only takes over from there. The legacy single "cobblr.theme" key (the old
// combined value) is migrated to the account slot on first load.

import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
  type ReactNode,
} from "react";
import { api } from "../lib/api";
import { resolveTheme, type DeviceOverride, type Theme, type ThemePref } from "./resolve-theme";

export type { DeviceOverride, Theme, ThemePref };

interface ThemeCtx {
  /** The resolved theme actually applied. */
  theme: Theme;
  /** Account-wide default, synced across devices. null = match device. */
  accountPref: ThemePref;
  /** This-device override. null = follow the account default here. */
  deviceOverride: DeviceOverride;
  /** Set the synced account default (Profile). Persists to the server. */
  setAccountPref: (p: ThemePref) => Promise<void>;
  /** Set the local device override (Profile / used by the quick toggle). Never synced. */
  setDeviceOverride: (p: DeviceOverride) => void;
  /** Quick flip of THIS device (icon buttons). Returns what it did: `locked`
   *  true when it pinned this device to `value` (diverging from the account
   *  default), false when it released the lock so this device follows the
   *  default again. Lets the caller offer to promote a lock to the account. */
  toggle: () => { locked: boolean; value: Theme };
  /** Apply the server account pref on login WITHOUT re-persisting it. */
  syncFromServer: (p: ThemePref) => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

const K_ACCOUNT = "cobblr.theme.account";
const K_DEVICE = "cobblr.theme.device";
const K_LEGACY = "cobblr.theme"; // pre-two-tier combined value

function readPref(key: string): ThemePref {
  if (typeof window === "undefined") return null;
  const s = localStorage.getItem(key);
  return s === "light" || s === "dark" ? s : null;
}
function readDeviceOverride(): DeviceOverride {
  if (typeof window === "undefined") return null;
  const s = localStorage.getItem(K_DEVICE);
  return s === "light" || s === "dark" || s === "os" ? s : null;
}
function detectOS(): Theme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function readInitialAccount(): ThemePref {
  const acct = readPref(K_ACCOUNT);
  if (acct) return acct;
  // one-time migration: the old combined key held the account choice
  const legacy = readPref(K_LEGACY);
  if (legacy && typeof window !== "undefined") {
    try {
      localStorage.setItem(K_ACCOUNT, legacy);
      localStorage.removeItem(K_LEGACY);
    } catch {
      /* ignore */
    }
  }
  return legacy;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [accountPref, setAccountPrefState] = useState<ThemePref>(readInitialAccount);
  const [deviceOverride, setDeviceOverrideState] = useState<DeviceOverride>(readDeviceOverride);
  const [os, setOS] = useState<Theme>(detectOS);
  const accountWrites = useRef(Promise.resolve());

  const theme: Theme = resolveTheme(deviceOverride, accountPref, os);

  // Follow the OS live when nothing overrides it (account = match device, no
  // device lock). Harmless otherwise — `theme` ignores os when a pref is set.
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const onChange = () => setOS(mq.matches ? "dark" : "light");
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  // Paint the resolved theme.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    // prepaint.js's stand-in for the stylesheet; from here index.css says it.
    document.documentElement.style.removeProperty("color-scheme");
  }, [theme]);

  const writeCache = (key: string, p: string | null) => {
    try {
      if (p) localStorage.setItem(key, p);
      else localStorage.removeItem(key);
    } catch {
      /* ignore (private mode) */
    }
  };

  const setAccountPref = useCallback((p: ThemePref) => {
    const saved = accountWrites.current.catch(() => {}).then(async () => {
      await api.setThemePref(p);
      setAccountPrefState(p);
      writeCache(K_ACCOUNT, p);
    });
    accountWrites.current = saved;
    return saved;
  }, []);

  const setDeviceOverride = useCallback((p: DeviceOverride) => {
    setDeviceOverrideState(p);
    writeCache(K_DEVICE, p); // local only — never hits the server
  }, []);

  const toggle = useCallback((): { locked: boolean; value: Theme } => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    // If the flip matches what the account default would show here anyway,
    // clear the override so this device stays in sync; otherwise lock it.
    const accountResolved: Theme = accountPref ?? os;
    const locked = next !== accountResolved;
    setDeviceOverride(locked ? next : null);
    return { locked, value: next };
  }, [theme, accountPref, os, setDeviceOverride]);

  const syncFromServer = useCallback((p: ThemePref) => {
    const next: ThemePref = p === "light" || p === "dark" ? p : null;
    setAccountPrefState(next);
    writeCache(K_ACCOUNT, next); // keep the FOUC cache honest; no server write
  }, []);

  return (
    <Ctx.Provider value={{ theme, accountPref, deviceOverride, setAccountPref, setDeviceOverride, toggle, syncFromServer }}>
      {children}
    </Ctx.Provider>
  );
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTheme called outside ThemeProvider");
  return v;
}
