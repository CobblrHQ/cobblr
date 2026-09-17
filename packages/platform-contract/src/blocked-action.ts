// A refused action, explained, and what asking for it looks like.
//
// THE BUG THIS EXISTS FOR. A person filing an item from their phone was told
// "This action requires the inventory:create-part capability. Ask a workspace
// admin to grant it." — an internal identifier, no way to ask, and nothing
// that said what was actually missing (a bundle to install, then a permission
// to file into it). Every gate in the product wrote its own refusal, so every
// refusal was a dead end of a slightly different shape (#3073).
//
// The rule now: a refusal that a request could remedy carries this object at
// `error.blocked`, in words a person can act on, and ONE surface in the app
// (the blocked-action sheet) reads it. A refusal that no request can remedy
// (a governance gate, an owner-only act) says so honestly with
// `requestable: false` and never grows an Ask button.

/** One thing a request asks for. `key` is the id the remedy is keyed on: an
 *  action id for a capability, a bundle's external id for an install. */
export type ApprovalRemedyKind = "capability" | "install";

export interface ApprovalRemedy {
  kind: ApprovalRemedyKind;
  key: string;
  /** In words, for the card and the sentence: "permission to create parts in
   *  Inventory", "the Spice Rack bundle installed". */
  label: string;
}

export interface BlockedAction {
  /** The real prerequisite, one sentence: "Filing this needs permission to
   *  create parts in Inventory." */
  sentence: string;
  /** What a request would ask for. Empty when nothing can be asked for. */
  remedies: ApprovalRemedy[];
  /** Whether asking is the remedy. False for a role change (governance is a
   *  person's decision about a person, never a button) and for owner-only
   *  acts. */
  requestable: boolean;
  /** Why asking is not offered, when it is not. */
  reason: string | null;
  /** Who decides: the workspace's owners and admins. Named when the caller
   *  may know them (a member of the workspace always may). */
  approvers: { count: number; names: string[] };
  /** A request already waiting on the same remedies, if one exists. */
  pending: { id: string; created_at: string } | null;
}

/** The dedupe handle: the sorted remedy keys, so the same ask from two
 *  surfaces is one request. */
export function approvalDedupeKey(remedies: readonly ApprovalRemedy[]): string {
  return remedies
    .map((r) => `${r.kind}:${r.key}`)
    .sort()
    .join("|");
}

/** The sentence the sheet leads with when the block is synthesised by a
 *  surface (a row the person cannot file yet) rather than answered by a 403. */
export function blockedSentence(remedies: readonly ApprovalRemedy[], doing = "This"): string {
  if (remedies.length === 0) return `${doing} is not something you can do here.`;
  const labels = remedies.map((r) => r.label);
  const list = labels.length === 1 ? labels[0]! : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]!}`;
  return `${doing} needs ${list}.`;
}
