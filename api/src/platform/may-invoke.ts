// Would this action run for this person? The one answer every door gives
// (#7922): the invoke route asks it before it runs anything, and the actions
// list (a record's bar, Cobb, MCP's list_actions) offers only what it allows.
//
// The gates lived inline in the invoke route, so the list offered whatever a
// kind's modules registered and the door refused it after the tap: a member
// offered Lend on an asset was refused "needs permission to lend it out"
// though they may lend it through assets' own Lend (#7897), and an assistant
// listed actions its connection could never run. Asked here, once, the offer
// and the door cannot disagree. The guard drives both for every role
// (api/tests/an-action-offered-is-an-action-allowed.test.ts).

import { humanOnlyRefusal } from "@cobblr/platform-contract/human-only";
import { platform } from "@cobblr/platform-contract";
import { roleRefusal, roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { appTokenInvokeRefusal } from "../auth/middleware.js";
import { accessMessage } from "../auth/token-access.js";
import { actionRefusal, actionSafety } from "./ai-action-door.js";
import { actionChangesWorkspace, actionGateOf, kindActionsOfFace } from "./action-gates.js";
import { isRequester } from "./actions.js";
import { platformActionMinRole, platformActionStandsFor } from "./platform-actions.js";

/** Who is asking, and through what. */
export interface InvokeAsker {
  orgId: string;
  userId: string;
  role: string;
  /** The assistant door this session is (an MCP token, a connector). */
  aiDoor?: string | null;
  /** A managed app's token: what it may edit. */
  appScope?: string | null;
  appEditKinds?: readonly string[];
  /** A personal token that may change only records. */
  tokenAccess?: string | null;
  /** The door this request arrived through (assistant, mcp, ...). */
  via?: string | null;
  /** This request's answers, asked once: a list asks of every action, and
   *  each asked the same capabilities and kinds again until a member's list
   *  took a minute (main red 2026-10-24, set 14). */
  memo?: Map<string, Promise<unknown>>;
}

/** One answer per request for one question. */
function once<T>(asker: InvokeAsker, key: string, ask: () => Promise<T>): Promise<T> {
  asker.memo ??= new Map();
  let p = asker.memo.get(key) as Promise<T> | undefined;
  if (!p) {
    p = ask();
    asker.memo.set(key, p);
  }
  return p;
}

/** What the action would run on. */
export interface InvokeTarget {
  entityKind?: string | null;
  entityId?: string | null;
  args?: Record<string, unknown> | null;
}

/** A refusal, as the door answers it. */
export interface InvokeRefusal {
  status: number;
  body: { error: Record<string, unknown> };
}

const refuse = (status: number, error: Record<string, unknown>): InvokeRefusal => ({ status, body: { error } });

/** The door's half: what this connection may never run, whoever is on it. */
export async function doorRefusal(asker: InvokeAsker, actionId: string, target: InvokeTarget): Promise<InvokeRefusal | null> {
  const args = (target.args ?? null) as Record<string, unknown> | null;
  // A Tier-B app-scoped token may fire capability-gated MODULE actions but
  // never a kernel workspace-config one, and a kernel record verb only on a
  // kind its app declares it edits (#7408).
  if (asker.appScope) {
    const refusal = appTokenInvokeRefusal(actionId, args, [...(asker.appEditKinds ?? [])]);
    if (refusal) return refuse(403, { code: "app_token_out_of_scope", message: refusal });
  }
  // A personal token that may change only records never changes the workspace (#7138, #7343, #7356).
  if (asker.tokenAccess === "change" && actionChangesWorkspace(actionId)) return refuse(403, { code: "token_access", message: accessMessage("change") });
  // What only a person does is refused to every assistant door, confirmed or not.
  if (asker.aiDoor || asker.via === "assistant" || asker.via === "mcp") {
    const human = humanOnlyRefusal(actionId, args);
    if (human) return refuse(403, { code: "human_only", message: human });
  }
  // An assistant with no way to show a person a confirmation never runs an action that needs one.
  if (asker.aiDoor) {
    const refused = actionRefusal(await once(asker, `safety:${actionId}`, () => actionSafety(actionId)));
    if (refused) return refuse(403, { code: "needs_a_person", message: refused });
  }
  return null;
}

/** May this person run it, by role, grant, or the record's own module? A
 *  generic action that stands for a kind's own (the record's Lend for
 *  assets' Lend it out) runs for whoever may run that kind's own: the same
 *  act on the same record never needs two permissions (#7897). */
async function holdsIt(asker: InvokeAsker, actionId: string, target: InvokeTarget, listing = false): Promise<boolean> {
  const has = (id: string) => once(asker, `cap:${id}`, () => platform().auth.userHasCapability({ orgId: asker.orgId, userId: asker.userId, role: asker.role, actionId: id }));
  if (await has(actionId)) return true;
  const face = platformActionStandsFor(actionId);
  const kind = target.entityKind ?? (typeof target.args?.entity_kind === "string" ? target.args.entity_kind : null);
  if (!face) return false;
  // A list of every action names no record: offered where any kind's own runs.
  if (!kind) {
    if (!listing) return false;
    for (const id of kindActionsOfFace(face, null)) if (await has(id)) return true;
    return false;
  }
  const base = await once(asker, `kind:${kind}`, () => platform().entities.resolveKind(asker.orgId, kind).then((r) => r?.base ?? null).catch(() => null));
  for (const id of kindActionsOfFace(face, base ? [kind, base] : [kind])) if (await has(id)) return true;
  return false;
}

/** The person's half: requester, capability, the action's role floor. */
export async function permissionRefusal(
  asker: InvokeAsker,
  actionId: string,
  target: InvokeTarget,
  opts: { ownUndo?: boolean; listing?: boolean } = {},
): Promise<InvokeRefusal | null> {
  const gate = actionGateOf(actionId);
  // An undo the platform handed this person is theirs to run (#5193); what a
  // person started is theirs to answer (#5192). A list cannot tell who started
  // a record it has not opened, so it offers a requester's action.
  const asRequester =
    !!opts.ownUndo ||
    (gate.runBy === "requester" &&
      (opts.listing ||
        (await isRequester(actionId, asker.userId, {
          orgId: asker.orgId,
          args: target.args ?? {},
          ...(target.entityKind && target.entityId ? { entity: { kind: target.entityKind, id: target.entityId } } : {}),
        }))));
  if (!asRequester && !(await holdsIt(asker, actionId, target, opts.listing))) {
    // A list only leaves it out: what to ask for, and of whom, is said at the
    // door when someone presses it, not worked out for every action listed.
    if (opts.listing) return refuse(403, { code: "missing_capability", details: { action_id: actionId, your_role: asker.role } });
    const blocked = await platform().auth.describeBlockedCapability({ orgId: asker.orgId, userId: asker.userId, role: asker.role, actionId });
    return refuse(403, { code: "missing_capability", message: blocked.sentence, details: { action_id: actionId, your_role: asker.role }, blocked });
  }
  // A kernel action's role floor, parity with its REST twin (M-ACTION-PARITY).
  const minRole = platformActionMinRole(actionId);
  if (minRole && !roleSatisfies(asker.role, [minRole])) {
    return refuse(403, {
      code: "forbidden",
      message: roleRefusal([minRole]),
      details: { action_id: actionId, required_role: minRole, your_role: asker.role },
    });
  }
  return null;
}

/** Would it run for them, as far as who may run it goes? */
export async function mayInvoke(asker: InvokeAsker, actionId: string, target: InvokeTarget, opts: { listing?: boolean } = {}): Promise<InvokeRefusal | null> {
  return (await doorRefusal(asker, actionId, target)) ?? (await permissionRefusal(asker, actionId, target, opts));
}
