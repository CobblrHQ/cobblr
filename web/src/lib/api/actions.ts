import { isBlockedAction } from "@cobblr/platform-contract/blocked-action";
import type { ApprovalRemedy, BlockedAction } from "@cobblr/platform-contract/blocked-action";
import { request, upload } from "./client";
import { raiseBlockedAction } from "../blocked-action";

export interface PlatformAction {
  user_invokable?: boolean;
  group?: string | null;
  primary?: boolean;
  id: string;
  module_name: string;
  label: string;
  description: string | null;
  icon: string | null;
  applies_to: unknown;
  invoke_route: string | null;
  invoke_handler: string | null;
  /** Per-arg shape for the wire composer's structured "With" form; null if none. */
  args_schema: Record<string, ActionArgSpec> | null;
  version: string;
}

/** One argument of an action, as the wire composer draws it. `picker` asks
 *  for a chooser instead of a text box; `schema_from` names the argument
 *  whose choice decides this one's fields (a service's input). */
export interface ActionArgSpec {
  label: string;
  type: "text" | "number" | "boolean" | "list" | "json";
  required?: boolean;
  picker?: "service-capability";
  schema_from?: string;
  /** What it picks from, filled by the server for a `choicesFrom` argument
   *  (the workspace's people for a "who"). */
  choices?: Array<{ value: string; label: string }>;
}

/** A workspace action a wire runs once per event on no record. */
export interface WireRecordlessAction {
  id: string;
  label: string;
  description: string;
  icon: string;
  args_schema: Record<string, ActionArgSpec>;
}

/** The kind a record-less wire is filed under: it acts on the workspace. */
export const WORKSPACE_SOURCE_KIND = "platform:workspace";

/** appliesTo predicate — mirrors the platform-contract shape. */
export type ActionAppliesTo =
  | { any: true }
  | { kinds?: string[]; traits?: string[]; hasFieldRole?: string; requires?: { traits: string[] } };

export interface RegisteredAction {
  id: string;
  module_name: string;
  label: string;
  description: string | null;
  icon: string | null;
  default_applies_to: ActionAppliesTo;
  effective_applies_to: ActionAppliesTo;
  overridden: boolean;
  overridden_at: string | null;
  /** Entity-kind IDs the action currently matches, given the
   *  effective predicate. */
  matched_kinds: string[];
}

export interface RegisteredActionDetail {
  id: string;
  default_applies_to: ActionAppliesTo;
  effective_applies_to: ActionAppliesTo;
  overridden: boolean;
}

/** An action a record would have if a module that is off were on (#3883). */
export interface PlatformDormantAction {
  group?: string | null;
  primary?: boolean;
  id: string;
  label: string;
  description: string | null;
  icon: string | null;
  module_name: string;
  module_label: string;
}

export interface PlatformActionBinding {
  description?: string | null;
  group?: string | null;
  primary?: boolean;
  binding_id: string;
  action_id: string;
  template: string | null;
  label: string;
  icon: string | null;
  invoke_route: string | null;
  invoke_handler: string | null;
}

export interface PlatformBinding {
  id: string;
  org_id: string;
  source_kind: string;
  action_id: string;
  trigger_type: "user-invoked" | "event" | "on-create" | "on-update" | "on-delete" | "schedule";
  /** Why this wire can never run (a record trigger on a kind that says
   *  nothing at that moment); null or absent when it can. */
  never_runs?: string | null;
  /** The wire in words (#6110): the one record it watches, the action's
   *  label, and its arguments in the action's words. */
  said?: { record: { id: string; title: string | null } | null; action: string | null; args: Array<{ label: string; value: string }> };
  trigger_event: string | null;
  /** The event it waits for is one nothing sends any more, so it never runs. */
  trigger_silent?: boolean;
  /** iCal RRULE for schedule-triggered wires; null otherwise. */
  trigger_schedule: string | null;
  template: string | null;
  filter: unknown | null;
  args: unknown | null;
  /** A button's own label and what it asks first (user-invoked only). */
  label?: string | null;
  ask?: Array<{ arg: string; label: string; kind?: "text" | "number"; placeholder?: string }> | null;
  /** "self" (run on the source) or { rel, dir?, kind? } (run on linked entities). */
  target: "self" | { rel: string; dir?: "out" | "in"; kind?: string } | null;
  enabled: boolean;
  bundle_id: string | null;
  created_at: string;
  updated_at: string;
}

export type ApprovalRequestStatus = "pending" | "approved" | "denied" | "expired" | "withdrawn" | "resuming" | "completed";

/** One request as the settings page and the sheet see it. */
export interface ApprovalRequestView {
  id: string;
  subject: string;
  remedies: ApprovalRemedy[];
  status: ApprovalRequestStatus;
  note: string | null;
  decision_note: string | null;
  requester: { id: string; name: string };
  decided_by: { id: string; name: string } | null;
  created_at: string;
  decided_at: string | null;
  expires_at: string;
  has_resume: boolean;
  route: string | null;
  /** Whether you may answer this one (an AI share is the owner's alone). */
  can_decide?: boolean;
  /** For a yes: whether it still holds for the requester as of this read, and
   *  what was taken back if not. Null for anything that was never a yes; the
   *  list omits it. Anything saying a permission is in place reads this, never
   *  `status` alone. */
  holds_now?: { holds: boolean; missing: string | null; message: string | null } | null;
}

export const actionsApi = {
  // Pillar B — actions + invocation
  listActions: (slug: string, kind: string) =>
    request<{ items: PlatformAction[]; bindings: PlatformActionBinding[]; dormant?: PlatformDormantAction[]; lifecycle?: boolean; lendable?: boolean; layout?: import("@cobblr/platform-contract/action-groups").RecordActionLayout; pins?: Record<string, boolean> }>(
      "GET",
      `/orgs/${slug}/actions?kind=${encodeURIComponent(kind)}`,
    ),
  invokeAction: (
    slug: string,
    { label, document, ...body }: {
      actionId: string;
      /** Left out for an action on the workspace (scope "workspace"). */
      entityKind?: string;
      entityId?: string;
      bindingId?: string;
      args?: Record<string, unknown>;
      document?: File;
      /** A scanned action label's code: the door checks it and the history
       *  says "via label" (#3897). */
      label?: string;
    },
  ) =>
    // The route's 200 means "the action was invoked"; whether the operation went
    // ahead is the handler's own `result.ok`. Callers reasonably treat a resolved
    // promise as success — the App Player toasted "ran." on a refusal — so a
    // refusal is raised HERE, once, with the handler's reason. Every existing
    // caller's catch then shows why instead of a false confirmation, and no
    // future caller has to remember to unwrap the envelope.
    (document ? (() => {
      const form = new FormData();
      form.set("payload", JSON.stringify(body));
      form.set("file", document);
      return upload<{ ok: boolean; result: unknown }>(`/api/v1/orgs/${slug}/actions/invoke`, form, document);
    })() : request<{ ok: boolean; result: unknown }>("POST", `/orgs/${slug}/actions/invoke`, body, label ? { "x-cobblr-label": label } : undefined)).then(
      (res) => {
        const inner = res.result as { ok?: unknown; error?: unknown; skipped?: unknown; blocked?: unknown } | null;
        if (inner && typeof inner === "object" && inner.ok === false) {
          // A refusal that says who and what would work opens the one
          // refusal sheet here, for every caller: a surface that only
          // toasted, or looked for it in the wrong place, left it unsaid
          // (#4736, Bring back from the record's Actions menu). `told` lets
          // a caller skip its own toast.
          const blocked = isBlockedAction(inner.blocked) ? inner.blocked : null;
          if (blocked) raiseBlockedAction({ blocked, refused: null, subject: null });
          // Declined (nothing applied: "already confirmed") is thrown too, so
          // no caller mistakes it for done, but marked, so a surface can say
          // it calmly rather than as a failure (action-result.ts, #3141).
          // The handler's answer rides along as `result`: some refusals are a
          // question back ("which list?", with the lists), and a surface that
          // asks it needs more than the sentence.
          throw Object.assign(
            new Error(typeof inner.error === "string" && inner.error.trim() ? inner.error : "That action couldn't run."),
            inner.skipped === true ? { declined: true as const } : {},
            blocked ? { blocked, told: true as const } : {},
            { result: inner },
          );
        }
        return res;
      },
    ),

  /** What an action WOULD do, written before anything runs ("Toilet paper:
   *  12 → 11"), or the reason it can't. Writes nothing. */
  planAction: (
    slug: string,
    body: { actionId: string; entityKind?: string; entityId?: string; bindingId?: string; args?: Record<string, unknown> },
  ) => request<{ plan: { title: string; lines: string[] } | null; error?: string }>("POST", `/orgs/${slug}/actions/plan`, body),

  // Pillar B — registered actions + per-org appliesTo overrides
  listRegisteredActions: (slug: string) =>
    request<{ items: RegisteredAction[] }>(
      "GET",
      `/orgs/${slug}/registered-actions`,
    ),
  setActionPredicate: (slug: string, actionId: string, override: ActionAppliesTo) =>
    request<RegisteredActionDetail>(
      "PUT",
      `/orgs/${slug}/registered-actions/${encodeURIComponent(actionId)}/predicate`,
      override,
    ),
  revertActionPredicate: (slug: string, actionId: string) =>
    request<RegisteredActionDetail>(
      "DELETE",
      `/orgs/${slug}/registered-actions/${encodeURIComponent(actionId)}/predicate`,
    ),

  // Pillar C — bindings (wires)
  listBindings: (slug: string) =>
    request<{ items: PlatformBinding[] }>("GET", `/orgs/${slug}/bindings`),
  // Available trigger events (enabled modules' manifest-declared events)
  // for the wire composer's typeahead.
  /** Workspace actions a wire can run on no record ("Run a service"). */
  listWireActions: (slug: string) => request<{ items: WireRecordlessAction[] }>("GET", `/orgs/${slug}/wire-actions`),
  /** Which record triggers ("a record is created / updated / deleted") this
   *  kind can carry, and why not. */
  getWireLifecycle: (slug: string, kind: string) =>
    request<{ kind: string; triggers: Record<string, { ok: boolean; why: string | null }> }>("GET", `/orgs/${slug}/wire-lifecycle?kind=${encodeURIComponent(kind)}`),
  listWireEvents: (slug: string) =>
    request<{ items: { event: string; module: string }[] }>(
      "GET",
      `/orgs/${slug}/wire-events`,
    ),
  /** How many existing records a wire with this trigger and filter would
   *  fire on, and what that number means for the trigger. */
  previewWire: (slug: string, body: { source_kind: string; trigger_type: string; filter: unknown }) =>
    request<{ count: number | null; of: number | null; complete: boolean; means: string; ignored: string[] }>(
      "GET",
      `/orgs/${slug}/bindings/preview?${new URLSearchParams({
        source_kind: body.source_kind,
        trigger_type: body.trigger_type,
        ...(body.filter ? { filter: JSON.stringify(body.filter) } : {}),
      })}`,
    ),
  createBinding: (slug: string, body: Partial<PlatformBinding>) =>
    request<PlatformBinding>("POST", `/orgs/${slug}/bindings`, body),
  updateBinding: (slug: string, id: string, body: Partial<PlatformBinding>) =>
    request<PlatformBinding>("PATCH", `/orgs/${slug}/bindings/${id}`, body),
  deleteBinding: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/bindings/${id}`),
  // Approval requests (api/src/routes/approval-requests.ts): asking for what
  // a gate refused, answering, finishing. The sheet and the permissions page.
  listApprovalRequests: (slug: string, status?: "open" | ApprovalRequestStatus) =>
    request<{ items: ApprovalRequestView[]; can_decide: boolean }>(
      "GET",
      `/orgs/${slug}/approval-requests${status ? `?status=${status}` : ""}`,
    ),
  describeBlockedAction: (slug: string, remedies: Array<{ kind: ApprovalRemedy["kind"]; key: string }>, doing?: string) =>
    request<{ blocked: BlockedAction }>("POST", `/orgs/${slug}/approval-requests/describe`, { remedies, doing }),
  createApprovalRequest: (
    slug: string,
    body: {
      remedies: Array<{ kind: ApprovalRemedy["kind"]; key: string }>;
      subject: string;
      note?: string | null;
      resume?: { method: "POST" | "PATCH" | "DELETE"; path: string; body?: unknown } | null;
      route?: string | null;
    },
  ) => request<{ request: ApprovalRequestView; existing: boolean }>("POST", `/orgs/${slug}/approval-requests`, body),
  getApprovalRequest: (slug: string, id: string) =>
    request<{ request: ApprovalRequestView }>("GET", `/orgs/${slug}/approval-requests/${id}`),
  decideApprovalRequest: (slug: string, id: string, decision: "approve" | "deny", note?: string | null) =>
    request<{ request: ApprovalRequestView; applied: Record<string, string> }>(
      "POST",
      `/orgs/${slug}/approval-requests/${id}/decide`,
      { decision, note: note ?? null },
    ),
  askApprovalAgain: (slug: string, id: string) =>
    request<{ request: ApprovalRequestView; existing: boolean }>("POST", `/orgs/${slug}/approval-requests/${id}/ask-again`),
  withdrawApprovalRequest: (slug: string, id: string) =>
    request<{ ok: true; status: ApprovalRequestStatus }>("POST", `/orgs/${slug}/approval-requests/${id}/withdraw`),
  resumeApprovalRequest: (slug: string, id: string) =>
    request<{ resume: { method: "POST" | "PATCH" | "DELETE"; path: string; body: unknown }; subject: string; remedies: ApprovalRemedy[] }>(
      "POST",
      `/orgs/${slug}/approval-requests/${id}/resume`,
    ),
  completeApprovalRequest: (slug: string, id: string, result: { ok: boolean; status?: number; message?: string | null }) =>
    request<{ ok: true; status: ApprovalRequestStatus }>("POST", `/orgs/${slug}/approval-requests/${id}/complete`, result),
};
