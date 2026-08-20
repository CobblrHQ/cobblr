// Shared platform-web context. The host (cobblr web app) wraps its
// authed surface in <PlatformWebProvider api={...} orgSlug={...} />
// so shared components like <EntityActionsBar> can resolve their
// dependencies.

import { createContext, useCallback, useContext, useState, type ComponentType, type ReactNode } from "react";
import type { PlatformWebApi } from "./types";

interface PlatformWebCtx {
  api: PlatformWebApi;
  orgSlug: string;
  /** True when the active workspace is a LOCKED managed vertical app
   *  ("Cobblr for Yarn"). Lets shared/module UI trim platform-only chrome
   *  (e.g. the QR-label option) without importing the host's org context. */
  appMode: boolean;
  /** Cobb's head, drawn by the host. The package owns the button that puts a
   *  record in his context; the app owns what he looks like — the same split as
   *  `flows`, and the reason module UIs can show him without this package
   *  holding a copy of the artwork. */
  cobbIcon?: ComponentType<{ size?: number; title?: string }>;
}

const Ctx = createContext<PlatformWebCtx | null>(null);

// ─────────────────────────── Invokable flows ───────────────────────────
// A first-party "flow" is an interactive overlay (the organize planner, a
// future wizard) the shell can open FROM ANYWHERE by id — an action result's
// `ui` directive, a view bulk-action, a nav entry — without the caller knowing
// the component. The host app maps ids → components in a registry and passes it
// to PlatformWebProvider; shared components open one via useFlowHost().openFlow.
// See docs/architecture/invokable-flows-and-lego-redesign.md.

/** A flow component: rendered as a shell overlay, receives its opaque args and
 *  a close callback. Concrete flows live in the host app (web/src), never here
 *  — this package owns the MECHANISM, the app owns the components. */
export type FlowComponent = ComponentType<{ args: Record<string, unknown>; onClose: () => void }>;
export type FlowRegistry = Record<string, FlowComponent>;

interface FlowHostCtx {
  /** Open a registered flow. Unknown id (or no registry) → no-op, so returning
   *  a `ui` directive is always safe whether or not the shell honors it. */
  openFlow: (flowId: string, args?: Record<string, unknown>) => void;
}

const FlowCtx = createContext<FlowHostCtx>({ openFlow: () => {} });

export function useFlowHost(): FlowHostCtx {
  return useContext(FlowCtx);
}

export function PlatformWebProvider({
  api,
  orgSlug,
  appMode = false,
  flows,
  cobbIcon,
  children,
}: {
  api: PlatformWebApi;
  orgSlug: string;
  appMode?: boolean;
  cobbIcon?: ComponentType<{ size?: number; title?: string }>;
  /** id → flow component. Omit to disable flows (openFlow becomes a no-op). */
  flows?: FlowRegistry;
  children: ReactNode;
}) {
  const [active, setActive] = useState<{ flow: string; args: Record<string, unknown> } | null>(null);
  const openFlow = useCallback(
    (flowId: string, args: Record<string, unknown> = {}) => {
      if (flows && flows[flowId]) setActive({ flow: flowId, args });
      // Unknown flow / no registry: ignore. A caller returning a ui directive
      // for a flow this shell doesn't host must not crash.
    },
    [flows],
  );
  const Active = active && flows ? flows[active.flow] : null;
  return (
    <Ctx.Provider value={{ api, orgSlug, appMode, cobbIcon }}>
      <FlowCtx.Provider value={{ openFlow }}>
        {children}
        {active && Active && <Active args={active.args} onClose={() => setActive(null)} />}
      </FlowCtx.Provider>
    </Ctx.Provider>
  );
}

export function usePlatformWeb(): PlatformWebCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePlatformWeb called outside PlatformWebProvider");
  return v;
}
