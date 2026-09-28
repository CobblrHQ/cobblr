// The app catalogue for this workspace and this device, and what a person can
// do with an app that is not in their sidebar: open it, turn it on, ask an
// admin to, or put it back in the sidebar. One door for the search palette and
// the All apps page (#3883), over the contract's one rule (app-catalog.ts).
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { changeWorkspaceShape, useToast } from "@cobblr/platform-web";
import { appCatalog, type AppEntry } from "@cobblr/platform-contract/app-catalog";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { api, ApiError } from "./api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { readNavHidden, writeNavHidden } from "./nav-order";
import { raiseBlockedAction } from "./blocked-action";

/** The sidebar's per-device hide list, live: the nav writes it and announces
 *  the change, so a "Show in sidebar" here and a hide there stay in step. */
function useNavHidden(slug: string): ReadonlySet<string> {
  const [hidden, setHidden] = useState<string[]>(() => readNavHidden(slug));
  useEffect(() => {
    setHidden(readNavHidden(slug));
    const reload = () => setHidden(readNavHidden(slug));
    window.addEventListener("cobblr:nav-order-changed", reload);
    window.addEventListener("storage", reload);
    return () => {
      window.removeEventListener("cobblr:nav-order-changed", reload);
      window.removeEventListener("storage", reload);
    };
  }, [slug]);
  return useMemo(() => new Set(hidden), [hidden]);
}

export function useAppCatalog(enabled = true): { apps: AppEntry[]; loading: boolean } {
  const { activeSlug } = useActiveOrg();
  const modules = useQuery({
    queryKey: ["org-modules", activeSlug],
    queryFn: () => api.orgModules(activeSlug),
    enabled: enabled && !!activeSlug,
    staleTime: 30_000,
  });
  const hidden = useNavHidden(activeSlug);
  const apps = useMemo(() => appCatalog(modules.data?.items ?? [], hidden), [modules.data, hidden]);
  return { apps, loading: modules.isLoading };
}

/** What a person can do with an app from anywhere: open it; turn it on when
 *  they may (an owner or admin), else ask an admin through the one
 *  blocked-action sheet; put it back in the sidebar they hid it from. */
export function useModuleDoor() {
  const { activeSlug, activeOrg } = useActiveOrg();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const canTurnOn = roleSatisfies(activeOrg?.role, ["owner", "admin"]);
  const turnOn = useMutation({
    // Through the workspace-shape door, which refreshes everything a newly
    // enabled module changes (the nav, the kinds, the actions) at once.
    mutationFn: (app: AppEntry) => changeWorkspaceShape(qc, activeSlug, () => api.enableModule(activeSlug, app.name), { settled: true }),
    onSuccess: (_r, app) => {
      toast.success(`${app.label} is on`);
      navigate(app.route);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const ask = useMutation({
    mutationFn: async (app: AppEntry) => {
      const { blocked } = await api.describeBlockedAction(activeSlug, [{ kind: "module", key: app.name }], `Using ${app.label}`);
      raiseBlockedAction({ blocked, refused: null, subject: `Turn on ${app.label}` });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const showInSidebar = (app: AppEntry) => {
    writeNavHidden(activeSlug, readNavHidden(activeSlug).filter((k) => k !== app.key));
    toast.success(`${app.label} is back in your sidebar`);
  };
  return {
    canTurnOn,
    open: (app: AppEntry) => navigate(app.route),
    turnOn: (app: AppEntry) => turnOn.mutate(app),
    ask: (app: AppEntry) => ask.mutate(app),
    showInSidebar,
    busy: turnOn.isPending || ask.isPending,
  };
}
