// Tracks which of the user's orgs is currently active. The active workspace
// lives in the URL (/w/:handle/… — set as the router basename), so it is
// PER-TAB: two tabs on different workspaces don't clobber each other.
//
// The URL carries a SHORT HANDLE — the org's name-slug without the random
// `-<4hex>` uniqueness suffix that signup appends (so `/w/empty-test-1/`, not
// `/w/empty-test-1-23c4/`). The API still keys on the full `org.slug`; we map
// handle → org → full slug here. Old `/w/<full-slug>/` URLs still resolve
// (exact match wins), so existing bookmarks keep working. A handle that's
// ambiguous among the user's own workspaces (two same-named ones) falls back to
// the full slug for that workspace so it stays distinguishable.
//
// localStorage keeps only the last-active full slug, to pick a default when the
// user lands on a bare URL. Switching is a full navigation to the new base.

import {
  createContext, useCallback, useContext, useEffect, useMemo,
  type ReactNode,
} from "react";
import { useAuth } from "./AuthContext";
import { deepPathAfterWorkspace } from "../lib/deep-path";
import { displaySlug } from "../lib/workspaceSlug";
import { useImpersonation } from "../lib/impersonation";
import type { OrgMembership } from "../lib/api";

const STORAGE_KEY = "cobblr.activeOrgSlug";

/** The pretty URL handle for an org: its slug without the random suffix, but
 *  only when that's unique among the user's orgs; otherwise the full slug. */
export function urlHandleFor(org: OrgMembership, orgs: OrgMembership[]): string {
  const short = displaySlug(org.slug);
  const collisions = orgs.filter((o) => displaySlug(o.slug) === short);
  return collisions.length === 1 ? short : org.slug;
}

/** Resolve a URL handle (short handle OR a full slug) back to the org. */
export function resolveHandle(handle: string, orgs: OrgMembership[]): OrgMembership | null {
  // Exact full-slug match wins — unambiguous + keeps old bookmarks working.
  const exact = orgs.find((o) => o.slug === handle);
  if (exact) return exact;
  const matches = orgs.filter((o) => displaySlug(o.slug) === handle);
  return matches.length === 1 ? matches[0]! : null;
}

/** Where a bare URL lands: the last-active org if still valid (resume on a
 *  device you've used), else a sensible fallback. The fallback prefers your
 *  first OWNED workspace — the top of the switcher's owned-first grouping —
 *  rather than the raw `orgs[0]`, which is your OLDEST membership by join date
 *  (`joined_at asc` from the API) and can be a shared workspace sitting low in
 *  the list. So a fresh device opens into the top of your switcher, not an
 *  arbitrary old/shared one. (A user-pinned default workspace is a deliberate
 *  follow-up; this just makes the no-preference fallback intuitive.) */
export function pickDefaultOrg(orgs: OrgMembership[]): OrgMembership | null {
  if (orgs.length === 0) return null;
  try {
    const last = localStorage.getItem(STORAGE_KEY);
    const m = last && orgs.find((o) => o.slug === last);
    if (m) return m;
  } catch {
    /* ignore */
  }
  // No last-active on this device → the user's explicit DEFAULT wins; else the
  // first owned workspace (top of the switcher's owned group); else anything.
  return orgs.find((o) => o.is_default) ?? orgs.find((o) => o.role === "owner") ?? orgs[0]!;
}

interface ActiveOrgCtx {
  activeOrg: OrgMembership | null;
  activeSlug: string; // FULL slug — what the API keys on
  setActiveSlug: (slug: string) => void;
}

const Ctx = createContext<ActiveOrgCtx | null>(null);

export function ActiveOrgProvider({
  urlHandle,
  children,
}: {
  urlHandle: string;
  children: ReactNode;
}) {
  const { orgs } = useAuth();
  const imp = useImpersonation();
  const org = useMemo(() => {
    // While impersonating, the impersonated workspace IS the active one — even
    // though the operator isn't a member, so resolveHandle would miss it. Build a
    // synthetic membership from the grant (the target's role is what they see).
    if (imp && (urlHandle === displaySlug(imp.workspace.slug) || urlHandle === imp.workspace.slug)) {
      return {
        id: imp.workspace.id,
        name: imp.workspace.name,
        slug: imp.workspace.slug,
        role: imp.target.role as OrgMembership["role"],
        owner_name: imp.target.name,
      } satisfies OrgMembership;
    }
    return resolveHandle(urlHandle, orgs);
  }, [urlHandle, orgs, imp]);

  // If the URL handle doesn't resolve to a membership (revoked, wrong account,
  // typo, or a shared/placeholder slug like a docs link), bounce to the user's
  // own workspace — PRESERVING the deep path so the link still lands on the right
  // page. Never while impersonating (the operator legitimately isn't a member of
  // the workspace they're viewing).
  useEffect(() => {
    if (orgs.length === 0 || org || imp) return;
    const fallback = pickDefaultOrg(orgs);
    if (fallback) {
      const { pathname, search, hash } = window.location;
      window.location.replace(`/w/${urlHandleFor(fallback, orgs)}${deepPathAfterWorkspace(pathname)}${search}${hash}`);
    }
  }, [orgs, org, imp]);

  // Remember the last-active workspace (by full slug) for bare-URL landings.
  useEffect(() => {
    try {
      if (org) localStorage.setItem(STORAGE_KEY, org.slug);
    } catch {
      /* ignore */
    }
  }, [org]);

  const setActiveSlug = useCallback(
    (nextSlug: string) => {
      const next = orgs.find((o) => o.slug === nextSlug);
      if (!next || next.slug === org?.slug) return;
      try {
        localStorage.setItem(STORAGE_KEY, next.slug);
      } catch {
        /* ignore */
      }
      // Full navigation to the new basename — per-tab + clean tenant state.
      window.location.assign(`/w/${urlHandleFor(next, orgs)}/dashboard`);
    },
    [org, orgs],
  );

  return (
    <Ctx.Provider value={{ activeOrg: org, activeSlug: org?.slug ?? "", setActiveSlug }}>
      {children}
    </Ctx.Provider>
  );
}

export function useActiveOrg(): ActiveOrgCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useActiveOrg called outside ActiveOrgProvider");
  return v;
}
