// Tracks which of the user's orgs is currently active. Persists the
// active slug to localStorage so reloads land on the same workspace.
// Switching invalidates every per-org query so we don't render
// stale data from the previous tenant.

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "./AuthContext";
import type { OrgMembership } from "../lib/api";

const STORAGE_KEY = "cobblr.activeOrgSlug";

interface ActiveOrgCtx {
  activeOrg: OrgMembership | null;
  activeSlug: string;
  setActiveSlug: (slug: string) => void;
}

const Ctx = createContext<ActiveOrgCtx | null>(null);

export function ActiveOrgProvider({ children }: { children: ReactNode }) {
  const { orgs } = useAuth();
  const qc = useQueryClient();
  const [slug, setSlugState] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) ?? "";
    } catch {
      return "";
    }
  });

  // Keep slug pointed at a real org. If the stored one isn't in the
  // user's membership list (revoked, signed-into-different-account,
  // etc.) fall back to the first org.
  useEffect(() => {
    if (orgs.length === 0) {
      if (slug) {
        setSlugState("");
        try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
      }
      return;
    }
    const valid = slug && orgs.some((o) => o.slug === slug);
    if (!valid) {
      const next = orgs[0]!.slug;
      setSlugState(next);
      try { localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
    }
  }, [orgs, slug]);

  const setActiveSlug = useCallback(
    (next: string) => {
      if (next === slug) return;
      setSlugState(next);
      try { localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
      // Drop every per-org query — they all key on slug, so the
      // wrong-org rows would otherwise flash before refetch.
      qc.removeQueries({ predicate: () => true });
    },
    [slug, qc],
  );

  const activeOrg = useMemo(
    () => orgs.find((o) => o.slug === slug) ?? null,
    [orgs, slug],
  );

  return (
    <Ctx.Provider value={{ activeOrg, activeSlug: slug, setActiveSlug }}>
      {children}
    </Ctx.Provider>
  );
}

export function useActiveOrg(): ActiveOrgCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useActiveOrg called outside ActiveOrgProvider");
  return v;
}
