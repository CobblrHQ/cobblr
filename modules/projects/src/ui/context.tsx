import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { FileIntakeDecl } from "@cobblr/platform-contract";
import { ProjectsApi } from "./api";

interface Ctx {
  orgSlug: string;
  getToken: () => string | null;
  api: ProjectsApi;
  instance?: string;
  /** Presentation entity kind: `<instance>:item` when scoped (e.g. a Designs
   *  instance stores its custom fields under `designs:item`), else the base
   *  `projects:project`. Field defs / overrides / custom fields key off this —
   *  using the base kind for an instance silently shows none of its fields. */
  entityKind: string;
  /** The instance's display label ("Outfits") + singular noun ("outfit") so the
   *  list reads as the user's thing, not "Projects" / "New project". Unset on
   *  the default /projects page. */
  displayName?: string;
  itemNoun?: string;
  fileIntake?: FileIntakeDecl;
}

const Ctx = createContext<Ctx | null>(null);

export function ProjectsProvider({
  orgSlug,
  getToken,
  instance,
  displayName,
  itemNoun,
  fileIntake,
  children,
}: {
  orgSlug: string;
  getToken: () => string | null;
  instance?: string;
  displayName?: string;
  itemNoun?: string;
  fileIntake?: FileIntakeDecl;
  children: ReactNode;
}) {
  const api = useMemo(
    () => new ProjectsApi(orgSlug, { getToken, instance }),
    [orgSlug, getToken, instance],
  );
  const entityKind = instance ? `${instance}:item` : "projects:project";
  return (
    <Ctx.Provider value={{ orgSlug, getToken, api, instance, entityKind, displayName, itemNoun, fileIntake }}>
      {children}
    </Ctx.Provider>
  );
}

export function useProjects(): Ctx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useProjects called outside ProjectsProvider");
  return v;
}
