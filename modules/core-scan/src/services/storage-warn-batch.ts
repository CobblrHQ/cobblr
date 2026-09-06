// One message for one shopping trip.
//
// The storage-fit check fires per PLACEMENT, and groceries arrive in bulk. So
// filing a shop produced one Discord DM per item:
//
//   Baby Carrots needs kept refrigerated - it just went into Kitchen
//   Cucumbers Long needs kept refrigerated - it just went into Kitchen
//   Tomatoes Roma needs kept refrigerated - it just went into Kitchen
//
// The `priority: "high"` that produced that was reasoned about ONE item ("your
// ice cream is in a cupboard, read tomorrow, is a message about a puddle") and
// never about the way food actually enters a workspace. Per-item urgency is
// true; per-item DELIVERY is spam, and the standing rule is that a DM is one
// combined message, never a stream through the day.
//
// So warnings are collected per workspace for a beat, then sent as one. The
// window is short (seconds, not the morning digest) because the case that earns
// an interruption at all is food spoiling NOW - but one message about six items
// is not six messages.

import { NotificationBatcher, type ComposedBurst } from "@cobblr/platform-contract";

/** One thing found in the wrong place. */
export interface StorageWarning {
  name: string;
  requirement: "refrigerated" | "frozen";
  location: string;
  /** Where the misplaced thing lives, resolved when the warning was raised —
   *  moving it is the whole point, and the message named it and then left you
   *  to find it. Resolved at the call site because that is where the entity
   *  ref is; composing stays pure and synchronous. */
  link?: string;
}

/** What to say about a burst of them. */
export interface BatchedWarning {
  message: string;
  /** `frozen` anywhere in the batch earns an interruption; a fridge item can
   *  wait for the person's own digest window. The distinction is real: a
   *  freezer item in a cupboard is a puddle within the hour. */
  priority: "normal" | "high";
  count: number;
}

const phraseFor = (r: StorageWarning["requirement"]): string =>
  r === "frozen" ? "kept frozen" : "kept refrigerated";

/**
 * Turn a burst into a single sentence.
 *
 * Groups by (requirement, location) because that is how they cluster in real
 * life - a whole shop into one Kitchen - and naming the group once is what
 * makes the message short enough to read on a phone.
 */
export function describeBatch(warnings: readonly StorageWarning[]): BatchedWarning | null {
  if (warnings.length === 0) return null;
  const priority: BatchedWarning["priority"] = warnings.some((w) => w.requirement === "frozen")
    ? "high"
    : "normal";

  if (warnings.length === 1) {
    const w = warnings[0]!;
    return {
      ...(w.link ? { link_url: w.link } : {}),
      // "needs to be kept", not "needs kept" - the original read like a telegram.
      message: `${w.name} needs to be ${phraseFor(w.requirement)} - it just went into ${w.location}`,
      priority,
      count: 1,
    };
  }

  const groups = new Map<string, { requirement: StorageWarning["requirement"]; location: string; names: string[] }>();
  for (const w of warnings) {
    const key = `${w.requirement}|${w.location}`;
    const g = groups.get(key) ?? { requirement: w.requirement, location: w.location, names: [] };
    g.names.push(w.name);
    groups.set(key, g);
  }

  // At most three names per group: the message is a nudge to go move something,
  // not an inventory listing, and a phone notification truncates anyway.
  const parts = [...groups.values()].map((g) => {
    const shown = g.names.slice(0, 3).join(", ");
    const rest = g.names.length > 3 ? ` and ${g.names.length - 3} more` : "";
    return `${shown}${rest} ${g.names.length === 1 ? "needs" : "need"} to be ${phraseFor(g.requirement)} - ${g.names.length === 1 ? "it is" : "they are"} in ${g.location}`;
  });
  // Several: nowhere honest to point. They are different things in different
  // places, and the message names them.
  return { message: parts.join("; "), priority, count: warnings.length };
}

/**
 * Collect warnings per workspace and send one message per shop.
 *
 * The beat, the per-workspace grouping and the cap are the platform's
 * `NotificationBatcher`, because the same shape bit projects (one task
 * finished unblocks eight) and would have been copied. What stays here is the
 * only part that is genuinely about storage: how several warnings become one
 * good sentence.
 */
export class StorageWarnBatcher extends NotificationBatcher<StorageWarning> {
  constructor(
    flush: (orgId: string, batch: ComposedBurst) => void | Promise<void>,
    windowMs = 20_000,
    maxPerBatch = 50,
  ) {
    super(describeBatch, flush, windowMs, maxPerBatch);
  }
}
