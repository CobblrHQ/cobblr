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
  createContext, useCallback, useContext, useEffect, useState,
  type ReactNode,
} from "react";

export type Theme = "light" | "dark";

interface ThemeCtx {
  theme: Theme;
  toggle: () => void;
  set: (t: Theme) => void;
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

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // ignore (private mode, etc.)
    }
  }, [theme]);

  const toggle = useCallback(() => {
    setThemeState((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  const set = useCallback((t: Theme) => setThemeState(t), []);

  return <Ctx.Provider value={{ theme, toggle, set }}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTheme called outside ThemeProvider");
  return v;
}
