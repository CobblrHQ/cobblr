// Theme — light / dark, persisted in localStorage, applied as a
// class on <html>. Same pattern companion app uses: the Tailwind
// config has darkMode: "class", and dark: variants on classnames
// flip in when this provider sets it.
//
// Mount picks the first defined source in order:
//   1. localStorage key 'cobblr.theme'
//   2. matchMedia '(prefers-color-scheme: dark)'
//   3. light

import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
  type ReactNode,
} from "react";
import { api } from "../lib/api";

export type Theme = "light" | "dark";

interface ThemeCtx {
  theme: Theme;
  toggle: () => void;
  set: (t: Theme) => void;
  /** Apply a server-provided preference WITHOUT re-persisting it (the login
   *  sync uses this). Distinct from set(), which the user's own toggle uses
   *  and which DOES persist to the server. */
  syncFromServer: (t: Theme | null | undefined) => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

const KEY = "cobblr.theme";

function detectInitial(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = localStorage.getItem(KEY) as Theme | null;
  if (stored === "light" || stored === "dark") return stored;
  if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) return "dark";
  return "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(detectInitial);
  // localStorage is the instant/offline cache (no FOUC); the server pref is
  // the cross-device source of truth, synced in on login. A change the user
  // makes here persists to the server so every device follows it.
  const persistRef = useRef(false);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // ignore (private mode, etc.)
    }
    if (persistRef.current) {
      persistRef.current = false;
      // Fire-and-forget: the local + <html> change already happened; a failed
      // persist just means this device won't sync to others (non-fatal).
      void api.setThemePref(theme).catch(() => {});
    }
  }, [theme]);

  const applyPersisting = useCallback((t: Theme) => {
    persistRef.current = true;
    setThemeState(t);
  }, []);
  const toggle = useCallback(() => {
    applyPersisting(theme === "dark" ? "light" : "dark");
  }, [theme, applyPersisting]);
  const set = useCallback((t: Theme) => applyPersisting(t), [applyPersisting]);

  // Server sync: apply the stored pref if it differs, WITHOUT persisting back.
  const syncFromServer = useCallback((t: Theme | null | undefined) => {
    if ((t === "light" || t === "dark")) {
      setThemeState((cur) => (cur === t ? cur : t)); // no persist (persistRef stays false)
    }
  }, []);

  return <Ctx.Provider value={{ theme, toggle, set, syncFromServer }}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTheme called outside ThemeProvider");
  return v;
}
