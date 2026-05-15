import { createContext, useContext, useMemo, type ReactNode } from "react";
import { ProjectsApi } from "./api";

interface Ctx {
  orgSlug: string;
  getToken: () => string | null;
  api: ProjectsApi;
}

const Ctx = createContext<Ctx | null>(null);

export function ProjectsProvider({
  orgSlug,
  getToken,
  children,
}: {
  orgSlug: string;
  getToken: () => string | null;
  children: ReactNode;
}) {
  const api = useMemo(() => new ProjectsApi(orgSlug, { getToken }), [orgSlug, getToken]);
  return <Ctx.Provider value={{ orgSlug, getToken, api }}>{children}</Ctx.Provider>;
}

export function useProjects(): Ctx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useProjects called outside ProjectsProvider");
  return v;
}
