// Shared platform-web context. The host (cobblr web app) wraps its
// authed surface in <PlatformWebProvider api={...} orgSlug={...} />
// so shared components like <EntityActionsBar> can resolve their
// dependencies.

import { createContext, useContext, type ReactNode } from "react";
import type { PlatformWebApi } from "./types";

interface PlatformWebCtx {
  api: PlatformWebApi;
  orgSlug: string;
  /** True when the active workspace is a LOCKED managed vertical app
   *  ("Cobblr for Yarn"). Lets shared/module UI trim platform-only chrome
   *  (e.g. the QR-label option) without importing the host's org context. */
  appMode: boolean;
}

const Ctx = createContext<PlatformWebCtx | null>(null);

export function PlatformWebProvider({
  api,
  orgSlug,
  appMode = false,
  children,
}: {
  api: PlatformWebApi;
  orgSlug: string;
  appMode?: boolean;
  children: ReactNode;
}) {
  return <Ctx.Provider value={{ api, orgSlug, appMode }}>{children}</Ctx.Provider>;
}

export function usePlatformWeb(): PlatformWebCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePlatformWeb called outside PlatformWebProvider");
  return v;
}
