// Approval requests: a blocked action explained, asked for, decided and
// finished — once, by the person who asked, with their draft intact.
//
// THE BUG THIS EXISTS FOR. A person filing an item from their phone was told
// "This action requires the inventory:create-part capability. Ask a workspace
// admin to grant it." and had nowhere to go: no way to ask, no idea what was
// actually missing, and the item still sitting in the inbox with the toast
// gone (#3073). The owner asked for the CLASS to be resolved, not the case:
// every refusal that a decision could remedy should explain the prerequisite,
// offer the ask, route it to the people who can decide, return their answer,
// and let the person finish what they started.
//
// The seam is deliberately small and sits on things that already existed:
//   • a refusal carries `error.blocked` (contract: blocked-action.ts), the
//     prerequisite in words plus whether asking is even a remedy;
//   • a request is a row in cobblr_meta with the REMEDIES it asks for
//     (`capability`: grant this person one capability; `install`: install this
//     bundle for the workspace), the refused request itself (`resume`), and a
//     status that moves one way;
//   • the approvers are told through the ordinary notification dispatcher,
//     with ACTIONS on the card — the bell and the Discord DM both render those
//     and both press them through platform().actions.invoke, so Approve/Deny is
//     one click wherever the card lands (notification-press.ts);
//   • approving APPLIES the remedies through the same functions the settings
//     screens use (grantCapability, validateBundle/applyValidatedBundle), as
//     the approver, so an approval can do exactly what an admin could have done
//     by hand and nothing else;
//   • the yes reaches the requester as a notification whose link reopens the
//     page they were on with `?resume=<id>`, where the sheet shows what will be
//     done and replays the ORIGINAL request under the requester's own session,
//     once (a compare-and-set on the row).
//
// What an approval can never do: grant a role, grant the power to approve
// (the approve/deny actions are wire-only and not grantable, and a request
// naming them is refused), or act with anyone's powers but the approver's at
// decision time and the requester's at resume time.
//
// Time passes between the ask and the answer, so a yes is re-checked before
// anything replays (`prepareResume`): the requester must still be a member
// able to hold what was granted, every remedy must actually hold now, and the
// request must not have expired. If any of that is false the sheet says so and
// nothing runs — a blind replay of a stale draft would do something nobody
// agreed to, which is worse than the refusal it replaces.

import {
  approvalDedupeKey,
  blockedSentence,
  type ApprovalRemedy,
  type BlockedAction,
} from "@cobblr/platform-contract/blocked-action";
import { meta } from "../db/meta.js";
import type { ApprovalResume, ApprovalStatus } from "../db/schema.js";
import { effectiveCapabilities } from "../auth/effective-capabilities.js";
import { grantCapability, grantableActions } from "./capability-grants.js";
import { capabilityModule } from "./grantable-scope.js";
import { getEntry } from "../modules/registry.js";
import { getFlagshipManifest } from "../lib/flagship-bundles.js";
import { dispatch } from "./notifications.js";
import * as activity from "./activity.js";

/** A request lives this long unanswered. A card nobody pressed for a week is
 *  not going to be pressed; the person asks again and a fresh card goes out. */
export const APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const APPROVE_ACTION = "platform:approve-request";
export const DENY_ACTION = "platform:deny-request";

/** The event types on the cards. Workspace-scoped (dispatch), so a member's
 *  own subscriptions govern them; `high` so the fallback DM fires for anyone
 *  who wants Discord at all. */
export const REQUESTED_EVENT = "platform.approval.requested";
export const DECIDED_EVENT = "platform.approval.decided";

export interface ApprovalRequestRow {
  id: string;
  org_id: string;
  requester_id: string;
  subject: string;
  remedies: ApprovalRemedy[];
  dedupe_key: string;
  resume: ApprovalResume | null;
  route: string | null;
  note: string | null;
  status: ApprovalStatus;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  outcome: Record<string, unknown> | null;
  approver_notification_ids: string[] | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

// ── Who decides ──────────────────────────────────────────────────────────

/** The people who may answer a request in this workspace: its owners and
 *  admins, exactly. Governance by construction — an editor outranks a member
 *  for actions and still does not decide what other people may do, and a
 *  boundary the constrained party could edit is not a boundary. */
// role-gate: exact — deciding what another person may do is governance.
export function mayDecide(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

async function approversOf(orgId: string, exceptUserId?: string): Promise<{ id: string; name: string }[]> {
  const rows = await meta
    .selectFrom("org_memberships as m")
    .innerJoin("users as u", "u.id", "m.user_id")
    .select(["u.id as id", "u.display_name as name", "m.role as role"])
    .where("m.org_id", "=", orgId)
    .execute();
  return rows
    .filter((r) => mayDecide(r.role) && r.id !== exceptUserId)
    .map((r) => ({ id: r.id, name: r.name }));
}

async function memberRole(orgId: string, userId: string): Promise<string | null> {
  const m = await meta
    .selectFrom("org_memberships")
    .select("role")
    .where("org_id", "=", orgId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return m?.role ?? null;
}

async function displayName(userId: string): Promise<string> {
  const u = await meta.selectFrom("users").select("display_name").where("id", "=", userId).executeTakeFirst();
  return u?.display_name ?? "Someone";
}

// ── Remedies: what can be asked for, and how a yes is applied ────────────

/** A remedy kind: how to name it, whether it already holds, and how a yes
 *  applies it. Two today; the registry shape is what lets the next approval
 *  class (an AI-sharing offer, a join request) be one entry instead of a
 *  fourth bespoke flow. */
interface RemedyKind {
  /** Words for the card and the sentence, or null when the key names nothing
   *  askable (then the request is refused, not created). */
  label(orgId: string, key: string): Promise<string | null>;
  /** Does the requester already have this? A yes then applies nothing. */
  holds(orgId: string, requesterId: string, requesterRole: string, key: string): Promise<boolean>;
  /** Apply the yes, as the approver. Throws with a person-readable message. */
  apply(args: { orgId: string; requesterId: string; key: string; approver: Approver }): Promise<string>;
}

interface Approver {
  id: string;
  display_name: string | null;
}

const KINDS: Record<ApprovalRemedy["kind"], RemedyKind> = {
  capability: {
    async label(orgId, key) {
      // The approve/deny actions are wire-only and so never grantable; the
      // guard is explicit anyway, because "an approval can grant the power to
      // approve" is the one hole this whole seam must not have.
      if (key === APPROVE_ACTION || key === DENY_ACTION) return null;
      const found = (await grantableActions(orgId)).find((a) => a.action_id === key);
      if (!found) return null;
      const moduleName = capabilityModule(key);
      const shown = getEntry(moduleName)?.manifest.displayName ?? null;
      const verb = found.label.charAt(0).toLowerCase() + found.label.slice(1);
      return shown ? `permission to ${verb} in ${shown}` : `permission to ${verb}`;
    },
    async holds(orgId, requesterId, requesterRole, key) {
      const ec = await effectiveCapabilities(orgId, requesterId, requesterRole);
      return ec.all || ec.caps.has(key);
    },
    async apply({ orgId, requesterId, key, approver }) {
      const r = await grantCapability({ orgId, userId: requesterId, actionId: key, grantedBy: approver.id });
      if (!r.ok) throw new Error(r.message);
      return r.already ? "already granted" : "granted";
    },
  },
  install: {
    async label(_orgId, key) {
      const m = (await getFlagshipManifest(key)) as { name?: string } | null;
      return m?.name ? `the ${m.name} bundle installed` : null;
    },
    async holds(orgId, _requesterId, _role, key) {
      const row = await meta
        .selectFrom("bundles")
        .select("id")
        .where("org_id", "=", orgId)
        .where("external_id", "=", key)
        .executeTakeFirst();
      return !!row;
    },
    async apply({ orgId, key, approver }) {
      if (await KINDS.install.holds(orgId, "", "", key)) return "already installed";
      const manifest = await getFlagshipManifest(key);
      if (!manifest) throw new Error(`The bundle "${key}" is not in this deployment's catalog any more.`);
      // Dynamic, like bundle-updates.ts: the route module pulls the whole app
      // graph, and a static import from here would be a cycle.
      const { validateBundle, applyValidatedBundle } = await import("../routes/bundles.js");
      const v = await validateBundle(orgId, manifest, { autoEnable: true });
      if (!v.valid) throw new Error(v.errors.map((e) => e.message).join(" ") || "The bundle no longer validates here.");
      await applyValidatedBundle(orgId, { id: approver.id, display_name: approver.display_name ?? null, auth_method: "session" }, v);
      return "installed";
    },
  },
};

/** Name every remedy, or say which one cannot be asked for. */
async function describeRemedies(
  orgId: string,
  remedies: readonly { kind: ApprovalRemedy["kind"]; key: string }[],
): Promise<{ ok: true; remedies: ApprovalRemedy[] } | { ok: false; reason: string }> {
  const out: ApprovalRemedy[] = [];
  for (const r of remedies) {
    const kind = KINDS[r.kind];
    if (!kind) return { ok: false, reason: `"${r.kind}" is not something that can be asked for.` };
    const label = await kind.label(orgId, r.key);
    // No identifier in the sentence: the person cannot act on one, and the
    // matrix is where an admin would look for what can be given.
    if (!label) return { ok: false, reason: r.kind === "install" ? "That bundle is not in this deployment's catalog." : "This needs a permission no admin can grant here." };
    out.push({ kind: r.kind, key: r.key, label });
  }
  return { ok: true, remedies: out };
}

// ── The refusal, explained ───────────────────────────────────────────────

/** The `blocked` object a capability gate puts on its 403. The real
 *  prerequisite in words, whether asking is a remedy for THIS person, who
 *  would decide, and a request already waiting if there is one. */
export async function describeCapabilityBlock(args: {
  orgId: string;
  userId: string;
  role: string;
  actionId: string;
}): Promise<BlockedAction> {
  return describeBlock({
    orgId: args.orgId,
    userId: args.userId,
    role: args.role,
    remedies: [{ kind: "capability", key: args.actionId }],
  });
}

export async function describeBlock(args: {
  orgId: string;
  userId: string;
  role: string;
  remedies: readonly { kind: ApprovalRemedy["kind"]; key: string }[];
  doing?: string;
}): Promise<BlockedAction> {
  const approvers = await approversOf(args.orgId, args.userId);
  const named = await describeRemedies(args.orgId, args.remedies);
  if (!named.ok) {
    return {
      sentence: "You cannot do this here.",
      remedies: [],
      requestable: false,
      reason: named.reason,
      approvers: { count: approvers.length, names: approvers.map((a) => a.name) },
      pending: null,
    };
  }
  const sentence = blockedSentence(named.remedies, args.doing);
  if (named.remedies.length === 0) {
    return {
      sentence,
      remedies: [],
      requestable: false,
      reason: "There is nothing an admin could give you for this.",
      approvers: { count: approvers.length, names: approvers.map((a) => a.name) },
      pending: null,
    };
  }
  // A guest is read-only by invariant, and a grant cannot change that
  // (grantCapability refuses it). The honest remedy is a role change, which is
  // a person's decision about a person and never a button here.
  if (args.role === "guest") {
    return {
      sentence,
      remedies: named.remedies,
      requestable: false,
      reason: "Your role here is read-only. An owner or admin can change it under Members.",
      approvers: { count: approvers.length, names: approvers.map((a) => a.name) },
      pending: null,
    };
  }
  if (approvers.length === 0) {
    return {
      sentence,
      remedies: named.remedies,
      requestable: false,
      reason: "Nobody else in this workspace can decide this.",
      approvers: { count: 0, names: [] },
      pending: null,
    };
  }
  const pending = await meta
    .selectFrom("approval_requests")
    .select(["id", "created_at", "expires_at"])
    .where("org_id", "=", args.orgId)
    .where("requester_id", "=", args.userId)
    .where("dedupe_key", "=", approvalDedupeKey(named.remedies))
    .where("status", "=", "pending")
    .executeTakeFirst();
  return {
    sentence,
    remedies: named.remedies,
    requestable: true,
    reason: null,
    approvers: { count: approvers.length, names: approvers.map((a) => a.name) },
    pending: pending && pending.expires_at.getTime() > Date.now() ? { id: pending.id, created_at: pending.created_at.toISOString() } : null,
  };
}

// ── Lifecycle ────────────────────────────────────────────────────────────

export type CreateOutcome =
  | { ok: true; request: ApprovalRequestRow; existing: boolean }
  | { ok: false; status: 400 | 403; code: "not_requestable" | "invalid"; message: string };

/** Ask. One pending request per requester and remedy set: pressing Ask again
 *  returns the one already waiting rather than sending a second card. */
export async function createApprovalRequest(args: {
  orgId: string;
  requesterId: string;
  requesterRole: string;
  remedies: readonly { kind: ApprovalRemedy["kind"]; key: string }[];
  subject: string;
  resume: ApprovalResume | null;
  route?: string | null;
  note?: string | null;
}): Promise<CreateOutcome> {
  if (args.remedies.length === 0) return { ok: false, status: 400, code: "invalid", message: "Nothing to ask for." };
  const blocked = await describeBlock({
    orgId: args.orgId,
    userId: args.requesterId,
    role: args.requesterRole,
    remedies: args.remedies,
  });
  if (!blocked.requestable) {
    return { ok: false, status: 403, code: "not_requestable", message: blocked.reason ?? "This cannot be asked for." };
  }
  if (blocked.pending) {
    const existing = await getRequest(blocked.pending.id);
    if (existing) return { ok: true, request: existing, existing: true };
  }
  const dedupe = approvalDedupeKey(blocked.remedies);
  let row: ApprovalRequestRow;
  try {
    row = (await meta
      .insertInto("approval_requests")
      .values({
        org_id: args.orgId,
        requester_id: args.requesterId,
        subject: args.subject.slice(0, 200),
        // jsonb-array-ok: written once, read back whole.
        remedies: JSON.stringify(blocked.remedies) as never,
        dedupe_key: dedupe,
        resume: args.resume ? (JSON.stringify(args.resume) as never) : null,
        route: args.route?.slice(0, 600) ?? null,
        note: args.note?.slice(0, 500) ?? null,
        expires_at: new Date(Date.now() + APPROVAL_TTL_MS),
      })
      .returningAll()
      .executeTakeFirstOrThrow()) as unknown as ApprovalRequestRow;
  } catch (err) {
    // Two asks in the same instant: the partial unique index makes the
    // second one lose, and the first is the answer.
    if ((err as { code?: string }).code === "23505") {
      const again = await findPending(args.orgId, args.requesterId, dedupe);
      if (again) return { ok: true, request: again, existing: true };
    }
    throw err;
  }
  await notifyApprovers(row);
  await activity.log({
    orgId: args.orgId,
    userId: args.requesterId,
    action: "approval_requested",
    ref: { module: null, entityType: "approval_request", entityId: row.id },
    diff: { remedies: blocked.remedies.map((r) => `${r.kind}:${r.key}`), subject: row.subject },
  });
  return { ok: true, request: (await getRequest(row.id)) ?? row, existing: false };
}

async function notifyApprovers(row: ApprovalRequestRow): Promise<void> {
  const approvers = await approversOf(row.org_id, row.requester_id);
  const who = await displayName(row.requester_id);
  const asks = row.remedies.map((r) => r.label).join(" and ");
  const message = `${who} asked for ${asks}, to ${lowerFirst(row.subject)}.`;
  const ids: string[] = [];
  for (const a of approvers) {
    try {
      const r = await dispatch({
        orgId: row.org_id,
        userId: a.id,
        eventType: REQUESTED_EVENT,
        message,
        priority: "high",
        link_url: `/configuration/permissions#request-${row.id}`,
        entityType: "approval_request",
        entityId: row.id,
        card: {
          heading: `${who} is asking for ${asks}`,
          body: `So they can ${lowerFirst(row.subject)}.${row.note ? `\n\n"${row.note}"` : ""}`,
          context: "Approving gives exactly this, to this person, and nothing else.",
        },
        actions: [
          { id: "approve", label: "Approve", action: APPROVE_ACTION, args: { request_id: row.id }, style: "primary" },
          { id: "deny", label: "Deny", action: DENY_ACTION, args: { request_id: row.id }, style: "secondary" },
        ],
      });
      if (r.notificationId) ids.push(r.notificationId);
    } catch (err) {
      console.error("[approvals] could not notify an approver:", (err as Error).message);
    }
  }
  await meta
    .updateTable("approval_requests")
    // jsonb-array-ok: the ids of the cards this row sent.
    .set({ approver_notification_ids: JSON.stringify(ids) as never, updated_at: new Date() })
    .where("id", "=", row.id)
    .execute();
}

/** The cards the other approvers hold stop asking once one has answered:
 *  marked read, so the bell does not keep an answered question as a to-do.
 *  (The Discord card is replaced at press time by its own door.) */
async function settleApproverCards(row: ApprovalRequestRow): Promise<void> {
  const ids = row.approver_notification_ids ?? [];
  if (ids.length === 0) return;
  await meta
    .updateTable("notifications")
    .set({ read_at: new Date() })
    .where("id", "in", ids)
    .where("read_at", "is", null)
    .execute()
    .catch(() => {});
}

export type DecideOutcome =
  | { ok: true; request: ApprovalRequestRow; applied: Record<string, string> }
  | { ok: false; status: 403 | 404 | 409; code: "not_found" | "not_approver" | "not_pending" | "apply_failed"; message: string };

/**
 * Answer. One door for the notification press and the settings page, so the
 * two cannot disagree about who may answer or what a yes does.
 *
 * A yes applies every remedy as the decider, then records the outcome per
 * remedy. A remedy that already holds (someone else installed the bundle in
 * the meantime) is recorded as such and nothing is done twice. A remedy that
 * FAILS to apply leaves the request pending with the failure on the row —
 * the approver sees why, and can try again or deny — rather than telling the
 * requester yes for something that did not happen.
 */
export async function decideApprovalRequest(args: {
  requestId: string;
  deciderId: string;
  decision: "approve" | "deny";
  note?: string | null;
}): Promise<DecideOutcome> {
  const row = await getRequest(args.requestId);
  if (!row) return { ok: false, status: 404, code: "not_found", message: "No such request." };
  const role = await memberRole(row.org_id, args.deciderId);
  if (!mayDecide(role)) {
    return { ok: false, status: 403, code: "not_approver", message: "Only a workspace owner or admin can answer this." };
  }
  if (row.status !== "pending" || row.expires_at.getTime() <= Date.now()) {
    if (row.status === "pending") await markExpired(row.id);
    return { ok: false, status: 409, code: "not_pending", message: describeSettled(row) };
  }
  const decider = await meta.selectFrom("users").select(["id", "display_name"]).where("id", "=", args.deciderId).executeTakeFirst();
  const approver: Approver = { id: args.deciderId, display_name: decider?.display_name ?? null };
  const requesterRole = await memberRole(row.org_id, row.requester_id);

  if (args.decision === "deny") {
    const updated = await transition(row.id, "pending", {
      status: "denied",
      decided_by: args.deciderId,
      decided_at: new Date(),
      decision_note: args.note?.slice(0, 500) ?? null,
    });
    if (!updated) return { ok: false, status: 409, code: "not_pending", message: "Somebody answered this first." };
    await settleApproverCards(updated);
    await notifyRequester(updated, approver, "denied");
    await activity.log({
      orgId: row.org_id,
      userId: args.deciderId,
      action: "approval_denied",
      ref: { module: null, entityType: "approval_request", entityId: row.id },
      diff: { requester_id: row.requester_id, note: args.note ?? null },
    });
    return { ok: true, request: updated, applied: {} };
  }

  // The requester left the workspace while the card was waiting: there is
  // nobody to grant to, and a grant to a non-member is refused anyway.
  if (!requesterRole) {
    const updated = await transition(row.id, "pending", {
      status: "denied",
      decided_by: args.deciderId,
      decided_at: new Date(),
      decision_note: "The person who asked is no longer a member of this workspace.",
    });
    if (updated) await settleApproverCards(updated);
    return { ok: false, status: 409, code: "not_pending", message: "The person who asked is no longer a member of this workspace." };
  }

  // Claim the decision before applying anything, so two approvers pressing
  // in the same second apply it once. `resuming` is not used here; the row
  // moves to `approved` only after every remedy holds.
  const applied: Record<string, string> = {};
  for (const remedy of row.remedies) {
    const kind = KINDS[remedy.kind];
    try {
      if (await kind.holds(row.org_id, row.requester_id, requesterRole, remedy.key)) {
        applied[`${remedy.kind}:${remedy.key}`] = "already held";
        continue;
      }
      applied[`${remedy.kind}:${remedy.key}`] = await kind.apply({
        orgId: row.org_id,
        requesterId: row.requester_id,
        key: remedy.key,
        approver,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      applied[`${remedy.kind}:${remedy.key}`] = `failed: ${message}`;
      await meta
        .updateTable("approval_requests")
        .set({ outcome: JSON.stringify({ applied }) as never, updated_at: new Date() })
        .where("id", "=", row.id)
        .execute();
      return { ok: false, status: 409, code: "apply_failed", message: `Could not give ${remedy.label}: ${message}` };
    }
  }
  // An ask that was not tied to something to finish is done the moment it
  // is granted: there is no draft to hand out, so nothing stays open.
  const updated = await transition(row.id, "pending", {
    status: row.resume ? "approved" : "completed",
    decided_by: args.deciderId,
    decided_at: new Date(),
    decision_note: args.note?.slice(0, 500) ?? null,
    // jsonb-replace-ok: the outcome is this decision's own record, written by
    // the one pass that decided; the replay result is merged onto it later.
    outcome: JSON.stringify({ applied }) as never,
  });
  if (!updated) return { ok: false, status: 409, code: "not_pending", message: "Somebody answered this first." };
  await settleApproverCards(updated);
  await notifyRequester(updated, approver, "approved");
  await activity.log({
    orgId: row.org_id,
    userId: args.deciderId,
    action: "approval_approved",
    ref: { module: null, entityType: "approval_request", entityId: row.id },
    diff: { requester_id: row.requester_id, applied },
  });
  return { ok: true, request: updated, applied };
}

async function notifyRequester(row: ApprovalRequestRow, approver: Approver, decision: "approved" | "denied"): Promise<void> {
  const who = approver.display_name ?? "An admin";
  const asks = row.remedies.map((r) => r.label).join(" and ");
  const route = row.route ?? "/";
  const link = `${route}${route.includes("?") ? "&" : "?"}resume=${row.id}`;
  const message =
    decision === "approved"
      ? `${who} approved your request for ${asks}. Open this to ${lowerFirst(row.subject)}.`
      : `${who} declined your request for ${asks}.${row.decision_note ? ` "${row.decision_note}"` : ""}`;
  try {
    await dispatch({
      orgId: row.org_id,
      userId: row.requester_id,
      eventType: DECIDED_EVENT,
      message,
      priority: "high",
      link_url: decision === "approved" ? link : route,
      entityType: "approval_request",
      entityId: row.id,
      card: {
        heading: decision === "approved" ? `Approved: ${asks}` : `Declined: ${asks}`,
        body:
          decision === "approved"
            ? `You can now ${lowerFirst(row.subject)}. Open the notification to finish it; nothing has been filed for you.`
            : row.decision_note ?? "No reason was given.",
        context: `Decided by ${who}`,
      },
    });
  } catch (err) {
    console.error("[approvals] could not notify the requester:", (err as Error).message);
  }
}

/** Take back an ask. Only the requester, only while it is pending. */
export async function withdrawApprovalRequest(requestId: string, requesterId: string): Promise<ApprovalRequestRow | null> {
  const row = await getRequest(requestId);
  if (!row || row.requester_id !== requesterId || row.status !== "pending") return null;
  const updated = await transition(row.id, "pending", { status: "withdrawn" });
  if (updated) await settleApproverCards(updated);
  return updated;
}

export type ResumeOutcome =
  | { ok: true; request: ApprovalRequestRow; resume: ApprovalResume }
  | { ok: false; status: 403 | 404 | 409; code: "not_found" | "not_yours" | "not_approved" | "stale" | "no_resume"; message: string };

/**
 * Take the yes and get ready to finish. Compare-and-set `approved` →
 * `resuming`, so the platform hands the draft out exactly once; the client
 * replays it under the requester's own session and reports back through
 * completeApprovalRequest. Before handing anything out, re-check that the
 * world still agrees with the decision (see the header).
 */
export async function prepareResume(requestId: string, requesterId: string): Promise<ResumeOutcome> {
  const row = await getRequest(requestId);
  if (!row) return { ok: false, status: 404, code: "not_found", message: "No such request." };
  if (row.requester_id !== requesterId) return { ok: false, status: 403, code: "not_yours", message: "This is somebody else's request." };
  if (row.status === "resuming" || row.status === "completed") {
    return { ok: false, status: 409, code: "not_approved", message: row.status === "completed" ? "This was already finished." : "You already started finishing this. If it did not go through, do it again by hand; the permission stays." };
  }
  if (row.status !== "approved") return { ok: false, status: 409, code: "not_approved", message: describeSettled(row) };
  if (!row.resume) return { ok: false, status: 409, code: "no_resume", message: "This request was not tied to something to finish; the permission is in place, so just do it again." };

  const role = await memberRole(row.org_id, requesterId);
  if (!role) return { ok: false, status: 403, code: "stale", message: "You are no longer a member of this workspace." };
  for (const remedy of row.remedies) {
    const holds = await KINDS[remedy.kind].holds(row.org_id, requesterId, role, remedy.key);
    if (!holds) {
      return {
        ok: false,
        status: 409,
        code: "stale",
        message: `This was approved, but ${remedy.label} no longer holds (it was taken back or undone since). Ask again.`,
      };
    }
  }
  const updated = await transition(row.id, "approved", { status: "resuming" });
  if (!updated) return { ok: false, status: 409, code: "not_approved", message: "Somebody else took this up first." };
  return { ok: true, request: updated, resume: updated.resume! };
}

/** The replay happened; record how it went. Either way the request is done —
 *  the draft was handed out once and the person saw the answer. */
export async function completeApprovalRequest(
  requestId: string,
  requesterId: string,
  result: { ok: boolean; status?: number; message?: string | null },
): Promise<ApprovalRequestRow | null> {
  const row = await getRequest(requestId);
  if (!row || row.requester_id !== requesterId || row.status !== "resuming") return null;
  return transition(row.id, "resuming", {
    status: "completed",
    outcome: JSON.stringify({ ...(row.outcome ?? {}), replay: result }) as never,
  });
}

// ── Reads ────────────────────────────────────────────────────────────────

export async function getRequest(id: string): Promise<ApprovalRequestRow | null> {
  const row = (await meta.selectFrom("approval_requests").selectAll().where("id", "=", id).executeTakeFirst()) as
    | ApprovalRequestRow
    | undefined;
  return row ?? null;
}

async function findPending(orgId: string, requesterId: string, dedupe: string): Promise<ApprovalRequestRow | null> {
  const row = (await meta
    .selectFrom("approval_requests")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("requester_id", "=", requesterId)
    .where("dedupe_key", "=", dedupe)
    .where("status", "=", "pending")
    .executeTakeFirst()) as ApprovalRequestRow | undefined;
  return row ?? null;
}

export interface ApprovalRequestView {
  id: string;
  subject: string;
  remedies: ApprovalRemedy[];
  status: ApprovalStatus;
  note: string | null;
  decision_note: string | null;
  requester: { id: string; name: string };
  decided_by: { id: string; name: string } | null;
  created_at: string;
  decided_at: string | null;
  expires_at: string;
  has_resume: boolean;
  route: string | null;
}

/** The workspace's requests: an approver sees everyone's, anyone sees their
 *  own. Pending rows past their time are expired on the way out, so the list
 *  never shows a card nobody can press. */
export async function listApprovalRequests(args: {
  orgId: string;
  viewerId: string;
  viewerRole: string;
  status?: ApprovalStatus | "open";
}): Promise<ApprovalRequestView[]> {
  await expireDue(args.orgId);
  let q = meta
    .selectFrom("approval_requests as r")
    .innerJoin("users as u", "u.id", "r.requester_id")
    .leftJoin("users as d", "d.id", "r.decided_by")
    .select([
      "r.id",
      "r.subject",
      "r.remedies",
      "r.status",
      "r.note",
      "r.decision_note",
      "r.requester_id",
      "u.display_name as requester_name",
      "r.decided_by",
      "d.display_name as decider_name",
      "r.created_at",
      "r.decided_at",
      "r.expires_at",
      "r.resume",
      "r.route",
    ])
    .where("r.org_id", "=", args.orgId)
    .orderBy("r.created_at", "desc")
    .limit(200);
  if (!mayDecide(args.viewerRole)) q = q.where("r.requester_id", "=", args.viewerId);
  if (args.status === "open") q = q.where("r.status", "in", ["pending", "approved", "resuming"]);
  else if (args.status) q = q.where("r.status", "=", args.status);
  const rows = await q.execute();
  return rows.map((r) => ({
    id: r.id,
    subject: r.subject,
    remedies: r.remedies as ApprovalRemedy[],
    status: r.status as ApprovalStatus,
    note: r.note,
    decision_note: r.decision_note,
    requester: { id: r.requester_id, name: r.requester_name },
    decided_by: r.decided_by ? { id: r.decided_by, name: r.decider_name ?? "Someone" } : null,
    created_at: r.created_at.toISOString(),
    decided_at: r.decided_at ? r.decided_at.toISOString() : null,
    expires_at: r.expires_at.toISOString(),
    has_resume: !!r.resume,
    route: r.route,
  }));
}

/** Requests the viewer may see, as a view. */
export async function viewRequest(id: string, viewerId: string, viewerRole: string, orgId: string): Promise<ApprovalRequestView | null> {
  const all = await listApprovalRequests({ orgId, viewerId, viewerRole });
  return all.find((r) => r.id === id) ?? null;
}

// ── Plumbing ─────────────────────────────────────────────────────────────

async function transition(
  id: string,
  from: ApprovalStatus,
  set: Partial<{
    status: ApprovalStatus;
    decided_by: string;
    decided_at: Date;
    decision_note: string | null;
    outcome: never;
  }>,
): Promise<ApprovalRequestRow | null> {
  const row = (await meta
    .updateTable("approval_requests")
    .set({ ...set, updated_at: new Date() })
    .where("id", "=", id)
    .where("status", "=", from)
    .returningAll()
    .executeTakeFirst()) as ApprovalRequestRow | undefined;
  return row ?? null;
}

async function markExpired(id: string): Promise<void> {
  const row = await transition(id, "pending", { status: "expired" });
  if (row) await settleApproverCards(row);
}

async function expireDue(orgId: string): Promise<void> {
  const due = await meta
    .selectFrom("approval_requests")
    .select("id")
    .where("org_id", "=", orgId)
    .where("status", "=", "pending")
    .where("expires_at", "<=", new Date())
    .execute();
  for (const d of due) await markExpired(d.id);
}

function describeSettled(row: ApprovalRequestRow): string {
  switch (row.status) {
    case "approved":
    case "resuming":
    case "completed":
      return "This was already approved.";
    case "denied":
      return "This was already declined.";
    case "withdrawn":
      return "This request was withdrawn.";
    case "expired":
      return "This request expired unanswered. Ask again.";
    default:
      return row.expires_at.getTime() <= Date.now() ? "This request expired unanswered. Ask again." : "This request is still open.";
  }
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
