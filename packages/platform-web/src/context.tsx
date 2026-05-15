// Shared platform-web context. The host (cobblr web app) wraps its
// authed surface in <PlatformWebProvider api={...} orgSlug={...} />
// so shared components like <EntityActionsBar> can resolve their
// dependencies.

import { createContext, useContext, type ReactNode } from "react";
import type { PlatformWebApi } from "./types";

interface PlatformWebCtx {
  api: PlatformWebApi;
  orgSlug: string;
}

const Ctx = createContext<PlatformWebCtx | null>(null);

export function PlatformWebProvider({
  api,
  orgSlug,
  children,
}: {
  api: PlatformWebApi;
  orgSlug: string;
  children: ReactNode;
}) {
  return <Ctx.Provider value={{ api, orgSlug }}>{children}</Ctx.Provider>;
}

export function usePlatformWeb(): PlatformWebCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePlatformWeb called outside PlatformWebProvider");
  return v;
}
