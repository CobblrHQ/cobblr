// Making what an order needs: a line's "Make this" plans a work order in
// builds (the module that knows which build makes a part), and the order reads
// back how many each has made. Both through builds' actions, never its tables;
// in a workspace without builds, nothing here appears (the action is unknown).

import { platform } from "@cobblr/platform-contract";

export interface WorkOrderView {
  id: string;
  build_id: string;
  build_name: string;
  output_part_id: string | null;
  qty: number;
  made: number;
  status: string;
}

function ctxFor(orgId: string, userId: string | null) {
  return {
    orgId,
    userId,
    scope: "workspace" as const,
    event: {
      name: null,
      payload: {},
      actor: { user_id: userId, display_name: null, auth_method: "session" as const },
      timestamp: new Date().toISOString(),
      trigger_type: "user-invoked" as const,
    },
  };
}

/** The work orders made for an order; empty when builds is not here. */
export async function workOrdersFor(orgId: string, orderId: string): Promise<WorkOrderView[]> {
  const r = (await platform()
    .actions.invoke("builds:work-orders-for", { ...ctxFor(orgId, null), args: { source_kind: "sales:order", source_id: orderId } })
    .catch(() => null)) as { ok?: boolean; items?: WorkOrderView[] } | null;
  return r?.ok && Array.isArray(r.items) ? r.items : [];
}

export type MakeResult =
  | { ok: true; plannedId: string; buildName: string; reused: boolean }
  | { ok: false; code: "no_build" | "unavailable" | "refused"; message: string }
  /** Builds is here and this workspace has it off: the platform hands the
   *  person the switch, or the ask, from `module` (#5865). */
  | { ok: false; code: "module_not_enabled"; module: string; message: string };

/** Plan a work order for `qty` of a part, made for this order. */
export async function makeForOrder(orgId: string, userId: string | null, orderId: string, partId: string, qty: number): Promise<MakeResult> {
  let r: { ok?: boolean; code?: string; module?: string; error?: string; plannedId?: string; buildName?: string; reused?: boolean } | null;
  try {
    r = (await platform().actions.invoke("builds:plan-for", {
      ...ctxFor(orgId, userId),
      args: { part_id: partId, qty, source_kind: "sales:order", source_id: orderId },
    })) as typeof r;
  } catch {
    // Only an action this server does not have throws here; the door answers
    // a Builds that is merely off (below), so there is no switch to point at.
    return { ok: false, code: "unavailable", message: "Making things needs Builds, which this server does not have." };
  }
  if (r?.ok && r.plannedId) return { ok: true, plannedId: r.plannedId, buildName: r.buildName ?? "", reused: !!r.reused };
  if (r?.code === "module_not_enabled" && typeof r.module === "string") return { ok: false, code: "module_not_enabled", module: r.module, message: r.error ?? "Builds is not turned on in this workspace." };
  return { ok: false, code: r?.code === "no_build" ? "no_build" : "refused", message: r?.error ?? "That could not be put in to be made." };
}

/**
 * Start a Make in digifab for a work order just planned for this order, so the
 * print has one record from request to outcome and says which order it is
 * for. Traceability only: what counts the order's parts is the good count on
 * the print, never this. Null in a workspace without digifab.
 */
export async function startMakeFor(orgId: string, userId: string | null, orderId: string, name: string): Promise<string | null> {
  const r = (await platform()
    .actions.invoke("digifab:start-make", {
      ...ctxFor(orgId, userId),
      args: { name, source_kind: "sales:order", source_id: orderId },
    })
    .catch(() => null)) as { ok?: boolean; makeId?: string } | null;
  return r?.ok && r.makeId ? r.makeId : null;
}
