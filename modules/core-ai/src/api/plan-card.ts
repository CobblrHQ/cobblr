// The code plan IS the card.
//
// When the no-AI path has worked a sentence out ("move things into another
// list": these records, that destination, a note naming what it left), the
// plan is the answer to that part of the message. The model was told so, in
// its prompt, and asked to run it. Asked. The free-tier model, given the
// grocery move with the plan in front of it, went looking at the teas
// instead, called the action with no destination, and ended on a question
// with no card (2026-09-12). A prompt is a request; this is the mechanism:
// the plan rides in the reply as the same Do-it card the offer strip shows,
// whatever the model did, and the model's own copy of the same move is
// dropped so one thing is not offered twice. What the model adds beyond the
// plan (the records it judged covered) stays, as its own card.

import type { Operation } from "../learned-commands.js";

export interface CodePlan {
  id: string;
  template: string;
  operations: Operation[];
  summary?: string;
  lines?: string[];
  note?: string;
  /** What the plan saw and left, by id, and where it puts things. */
  also?: Array<{ id: string; title: string }>;
  to?: { name: string; label: string };
}

type Item = { summary: string; proposal: Record<string, unknown> };

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The left-behind records the model NAMED in its reply. "I've found the
 *  remaining grocery item: Cheese Pizza (16in). Want me to move that?" made
 *  the judgement and then asked; the names are the judgement, and a card can
 *  be built from them without the model calling anything. A title is matched
 *  whole, and a title with a trailing "(16in)" also by the part before it. */
export function namedByModel(text: string, also: ReadonlyArray<{ id: string; title: string }>): Array<{ id: string; title: string }> {
  const hay = text.toLowerCase();
  return also.filter((r) => {
    const full = r.title.trim().toLowerCase();
    const bare = full.replace(/\s*\([^)]*\)\s*$/, "");
    for (const t of new Set([full, bare])) {
      if (t.length < 3) continue;
      if (new RegExp(`(^|[^a-z0-9])${escapeRe(t)}([^a-z0-9]|$)`).test(hay)) return true;
    }
    return false;
  });
}

/** The card for those: the same move, into the plan's destination, to confirm. */
function alsoCard(named: ReadonlyArray<{ id: string; title: string }>, to: { name: string; label: string }): Item {
  const title = named.length === 1 ? `Also move ${named[0]!.title} into ${to.label}` : `Also move ${named.length} into ${to.label}`;
  return {
    summary: title,
    proposal: {
      kind: "action",
      action_id: "platform:move-records",
      args: { ids: named.map((r) => r.id), to: to.name },
      plan: { title, lines: named.map((r) => r.title) },
    },
  };
}

/** Every record id the model's own cards already move. */
function idsProposed(out: Record<string, unknown>): Set<string> {
  const items: Item[] = out.type === "proposal" && out.proposal ? [{ summary: "", proposal: out.proposal as Record<string, unknown> }] : Array.isArray(out.items) ? (out.items as Item[]) : [];
  const ids = new Set<string>();
  for (const it of items) {
    const args = (it.proposal.args ?? {}) as { ids?: unknown };
    if (Array.isArray(args.ids)) for (const id of args.ids) if (typeof id === "string") ids.add(id);
  }
  return ids;
}

/** Add one card to a result, whatever shape it has. */
function withCard(out: Record<string, unknown>, card: Item): void {
  if (out.type === "proposals" && Array.isArray(out.items)) {
    out.items = [...(out.items as Item[]), card];
  } else if (out.type === "proposal" && out.proposal) {
    out.items = [{ summary: String(out.summary ?? ""), proposal: out.proposal as Record<string, unknown> }, card];
    delete out.proposal;
    delete out.summary;
    out.type = "proposals";
  } else {
    out.type = "proposal";
    out.summary = card.summary;
    out.proposal = card.proposal;
  }
}

/** The card the widget already knows how to run (runCommand): the plan, with
 *  the sentence it answers so the run can be bound to it. */
export function planCard(hit: CodePlan, message: string) {
  return {
    id: hit.id,
    template: hit.template,
    operations: hit.operations.length,
    summary: hit.summary ?? `${hit.operations.length} changes`,
    message,
    ...(hit.lines ? { lines: hit.lines } : {}),
    ...(hit.note ? { note: spent(hit.note) } : {}),
  };
}

/** The offer strip's hint to send the message is spent once it was sent. */
function spent(note: string): string {
  return note.replace(/\s*Send the message and Cobb will look through them\.?$/, "").trim();
}

/** A model proposal that is the plan again: the same action, on records the
 *  plan already moves. It is dropped; the plan's card is the one offered. */
function repeatsPlan(item: Item, hit: CodePlan): boolean {
  const p = item.proposal;
  if (p.kind !== "action" || typeof p.action_id !== "string") return false;
  const args = (p.args ?? {}) as { ids?: unknown };
  const ids = Array.isArray(args.ids) ? args.ids.filter((x): x is string => typeof x === "string") : [];
  return hit.operations.some((op) => {
    if (op.tool !== "action" || op.action_id !== p.action_id) return false;
    const planned = (op.payload as { ids?: unknown }).ids;
    const plannedIds = Array.isArray(planned) ? (planned as unknown[]) : [];
    // No ids on either side (create-instance): the same action IS the repeat.
    if (!ids.length && !plannedIds.length) return true;
    return ids.length > 0 && ids.every((id) => plannedIds.includes(id));
  });
}

export function withPlanCard(result: Record<string, unknown>, hit: CodePlan | null | undefined, message: string): Record<string, unknown> {
  if (!hit) return result;
  const out: Record<string, unknown> = { ...result, command: planCard(hit, message) };
  if (out.type === "proposal" && out.proposal && repeatsPlan({ summary: String(out.summary ?? ""), proposal: out.proposal as Record<string, unknown> }, hit)) {
    delete out.proposal;
    delete out.summary;
    out.type = "reply";
  } else if (out.type === "proposals" && Array.isArray(out.items)) {
    const kept = (out.items as Item[]).filter((it) => !repeatsPlan(it, hit));
    if (kept.length === 0) {
      delete out.items;
      out.type = "reply";
    } else if (kept.length === 1) {
      delete out.items;
      out.type = "proposal";
      out.summary = kept[0]!.summary;
      out.proposal = kept[0]!.proposal;
    } else {
      out.items = kept;
    }
  }
  // The judgement the model wrote down, made into the card it did not make.
  if (hit.also?.length && hit.to && typeof out.text === "string") {
    const already = idsProposed(out);
    const named = namedByModel(out.text, hit.also).filter((r) => !already.has(r.id));
    if (named.length) withCard(out, alsoCard(named, hit.to));
  }
  return out;
}
