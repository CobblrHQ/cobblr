// Who may run an action without a grant, and which grant also covers it: the
// one declaration every door reads (#5170).
//
// A member could add a line to a purchase order on the Purchases page and was
// refused the same thing through the API and through Cobb, because the page's
// route said "member or better" in its own words and the action door knew only
// its two default capabilities. Now an action says it once (`runBy`,
// `grantedAs` on a module action, `run_by` on a kernel one),
// platform().auth.userHasCapability reads it here, and a route that does the
// same thing gates with requireCapability on the action's own id, so the page,
// the API and Cobb give one answer (lint:route-and-action-gate-agree).

import { roleSatisfies, type OrgRoleName } from "@cobblr/platform-contract/org-roles";
import { list, listEntries } from "../modules/registry.js";
import { PLATFORM_ACTIONS, platformActionChangesWorkspace } from "./platform-actions.js";

export interface ActionGate {
  /** The lowest role that runs it without a grant, or "requester": the
   *  person who started its target, which the action door asks per run. */
  runBy?: Exclude<OrgRoleName, "guest"> | "requester";
  /** A capability whose grant also covers it. */
  grantedAs?: string;
}

let gates: Map<string, ActionGate> | null = null;

function build(): Map<string, ActionGate> {
  const out = new Map<string, ActionGate>();
  // A kernel action's min_role is a floor (refuse anyone below it), never a
  // pass; its run_by is the pass, said only where a route does the same thing.
  for (const a of PLATFORM_ACTIONS) if (a.run_by) out.set(a.id, { runBy: a.run_by });
  for (const m of list()) {
    for (const a of m.exposes?.actions ?? []) {
      const decl = a as { id: string; runBy?: ActionGate["runBy"]; grantedAs?: string };
      if (decl.runBy || decl.grantedAs) out.set(decl.id, { ...(decl.runBy ? { runBy: decl.runBy } : {}), ...(decl.grantedAs ? { grantedAs: decl.grantedAs } : {}) });
    }
  }
  return out;
}

/** The action's declaration; empty for one that declares neither. Modules
 *  register at boot and never change after, so it is read once. */
export function actionGateOf(actionId: string): ActionGate {
  if (!gates || gates.size === 0) gates = build();
  return gates.get(actionId) ?? {};
}

/** Does `role`, holding `held`, run `actionId`? The declaration's half of
 *  userHasCapability: its role floor, or a grant of the capability it shares.
 *  A guest never runs by role. */
export function gatePasses(actionId: string, role: string, held: (capability: string) => boolean): boolean {
  const g = actionGateOf(actionId);
  if (g.runBy && g.runBy !== "requester" && role !== "guest" && roleSatisfies(role, [g.runBy])) return true;
  return !!g.grantedAs && held(g.grantedAs);
}

/** Every declared action `role` runs given what it holds, for the UI's
 *  projection of a person's capabilities (/me/capabilities). */
export function actionsRunBy(role: string, held: ReadonlySet<string>): string[] {
  if (!gates || gates.size === 0) gates = build();
  return [...gates.keys()].filter((id) => gatePasses(id, role, (c) => held.has(c)));
}

/** Whether running `actionId` changes the workspace rather than its
 *  records: a platform action's `changes: "setup"`, a module action's
 *  `changes: "workspace"` (#7356). A token that may change only records is
 *  refused one at the invoke route. */
export function actionChangesWorkspace(actionId: string): boolean {
  if (platformActionChangesWorkspace(actionId)) return true;
  for (const e of listEntries()) {
    const a = (e.manifest.exposes?.actions ?? []).find((x) => x.id === actionId);
    if (a) return a.changes === "workspace";
  }
  return false;
}

let heldByRole: Map<string, Set<string>> | null = null;

/** What a stock role holds without a grant, from the modules' own
 *  declarations (`capabilities[].heldBy`): an operator holds what a module
 *  says an operator does (#6672). Read once, like the action gates. */
export function capabilitiesHeldBy(role: string): ReadonlySet<string> {
  if (!heldByRole || heldByRole.size === 0) {
    heldByRole = new Map();
    for (const e of listEntries()) {
      for (const c of e.manifest.capabilities ?? []) {
        for (const r of c.heldBy ?? []) {
          if (!heldByRole.has(r)) heldByRole.set(r, new Set());
          heldByRole.get(r)!.add(c.id);
        }
      }
    }
  }
  return heldByRole.get(role) ?? new Set();
}
