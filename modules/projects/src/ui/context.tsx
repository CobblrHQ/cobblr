import { createContext, useContext, useMemo, type ReactNode } from "react";
import { ProjectsApi } from "./api";

interface Ctx {
  orgSlug: string;
  getToken: () => string | null;
  api: ProjectsApi;
  instance?: string;
  /** The instance's display label ("Outfits") + singular noun ("outfit") so the
   *  list reads as the user's thing, not "Projects" / "New project". Unset on
   *  the default /projects page. */
  displayName?: string;
  itemNoun?: string;
}

const Ctx = createContext<Ctx | null>(null);

export function ProjectsProvider({
  orgSlug,
  getToken,
  instance,
  displayName,
  itemNoun,
  children,
}: {
  orgSlug: string;
  getToken: () => string | null;
  instance?: string;
  displayName?: string;
  itemNoun?: string;
  children: ReactNode;
}) {
  const api = useMemo(
    () => new ProjectsApi(orgSlug, { getToken, instance }),
    [orgSlug, getToken, instance],
  );
  return (
    <Ctx.Provider value={{ orgSlug, getToken, api, instance, displayName, itemNoun }}>
      {children}
    </Ctx.Provider>
  );
}

export function useProjects(): Ctx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useProjects called outside ProjectsProvider");
  return v;
}
