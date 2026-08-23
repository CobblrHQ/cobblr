// Does where it IS contradict how it must be KEPT?
//
// The whole reason those are two separate facts. Neither answers the question
// alone, and the answer is the only thing in this area worth interrupting
// somebody for: it is a fact about food going off, not a prediction about
// shopping.
//
// WHY THIS LIVES IN core-scan. The first attempt put it in inventory, and the
// isolation lint refused it - inventory would have had to import
// storageMismatch from here. That refusal was pointing at a design error, not
// an import error: the module that DEFINES what a storage requirement means is
// the one that should decide what contradicts it. core-scan owns the vocabulary
// and derives the value, so it owns the check.
//
// Nothing here knows about inventory. The record and the location are both read
// through platform.entities.lookup, so this works for ANY kind that carries a
// storage_requirement - a scanned asset, a future perishables module - without
// naming one.
//
// It rides core-placement.placed rather than sweeping: the check costs nothing
// at rest and fires at the moment the mistake is made, which is when it is
// cheapest to fix. A sweep would re-ask the same question about the same
// unmoved jar every hour.

import { platform } from "@cobblr/platform-contract";
import { storageMismatch, type StorageRequirement } from "./storage-requirement.js";

let registered = false;

/** Kinds whose containment says nothing about temperature. A part moved inside
 *  another part (a spare into a toolbox) is not a storage decision. */
const LOCATION_KIND = "core-locations:location";

/** Names of the container and everything it is inside, innermost first.
 *  Capped: a malformed chain must not spin, and nothing real is nested deeply. */
async function ancestorNames(orgId: string, containerId: string): Promise<string[]> {
  const names: string[] = [];
  let ref: { kind: string; id: string } | null = { kind: LOCATION_KIND, id: containerId };
  for (let hop = 0; hop < 8 && ref; hop++) {
    const resolved = await platform().entities.lookup(orgId, ref.kind, ref.id);
    if (resolved?.title) names.push(resolved.title);
    const up = await platform().placement.containerOf({ orgId, containee: ref });
    // Only keep walking through LOCATIONS. A location inside a machine is not a
    // temperature statement about the machine.
    ref = up && up.kind === LOCATION_KIND ? { kind: up.kind, id: up.id } : null;
  }
  return names;
}

export function registerStorageFitCheck(): void {
  if (registered) return;
  registered = true;

  platform().events.on("core-placement.placed", "core-scan", async (payload: unknown) => {
    const p = (payload ?? {}) as {
      orgId?: string;
      containeeKind?: string;
      containeeId?: string;
      containerKind?: string;
      containerId?: string;
    };
    if (!p.orgId || !p.containeeKind || !p.containeeId) return;
    if (p.containerKind !== LOCATION_KIND || !p.containerId) return;

    try {
      const record = await platform().entities.lookup(p.orgId, p.containeeKind, p.containeeId);
      if (!record) return;

      // Custom field values live in metadata on a resolved entity.
      const md = (record.fields?.metadata as Record<string, unknown> | undefined) ?? {};
      const requirement = md.storage_requirement as StorageRequirement | undefined;
      // No requirement means we genuinely do not know how this must be kept.
      // Saying nothing is the honest answer; guessing would put a false warning
      // on exactly the items this exists to protect.
      if (!requirement) return;

      // Walk the whole containment chain, not just the immediate container.
      // "Shelf 2" inside the Fridge is refrigerated; reading only the container
      // it was dropped into would call that a mismatch and ping every member at
      // `high`, which is the priority that bypasses digests. A false alarm on
      // that channel is how the whole check gets muted.
      const chain = await ancestorNames(p.orgId, p.containerId);
      if (chain.length === 0) return;
      // Satisfied if ANY ancestor satisfies it: the fridge does not stop being a
      // fridge because there is a shelf in the way.
      const satisfied = chain.some((name) => storageMismatch(requirement, name) === null);
      if (satisfied) return;
      const mismatch = storageMismatch(requirement, chain[0]!);
      if (!mismatch) return;

      // Warn once per place. Re-organising a cupboard should not re-ping for
      // every item every time it is picked up and put back. Stored on the
      // record rather than in a new table: one key, no migration, and it clears
      // itself the moment the thing is put somewhere sensible.
      const warnedFor = md.storage_warned_for;
      if (typeof warnedFor === "string" && warnedFor === p.containerId) return;
      try {
        await platform().entities.getWriter(p.containeeKind)?.update(p.orgId, p.containeeId, {
          metadata: { ...md, storage_warned_for: p.containerId },
        });
      } catch {
        // Not being able to remember must not stop the warning; a repeat is
        // better than a silence.
      }

      platform().events.emit("core-scan.storage.mismatch", {
        orgId: p.orgId,
        entityKind: p.containeeKind,
        entityId: p.containeeId,
        name: record.title,
        requirement: mismatch.requirement,
        location: mismatch.location,
      });

      // And tell somebody. Priority `high` on purpose: the delivery-window work
      // batches anything at or below `normal` into a digest, and "your ice cream
      // is in a cupboard" read tomorrow morning is a message about a puddle.
      // This is the rare case in this area that has earned an interruption -
      // a fact about food spoiling now, not a prediction about shopping later.
      const phrase =
        mismatch.requirement === "frozen" ? "kept frozen" : "kept refrigerated";
      const members = await platform().notifications.orgMemberIds(p.orgId);
      for (const userId of members) {
        try {
          await platform().notifications.dispatch({
            orgId: p.orgId,
            userId,
            eventType: "core-scan.storage.mismatch",
            message: `${record.title} needs ${phrase} - it just went into ${mismatch.location}`,
            module: "core-scan",
            entityType: p.containeeKind,
            entityId: p.containeeId,
            priority: "high",
            payload: { requirement: mismatch.requirement, location: mismatch.location },
          });
        } catch (err) {
          console.warn("[core-scan] storage-fit notify failed:", (err as Error).message);
        }
      }
    } catch (err) {
      // A check that cannot run must never break the move that triggered it.
      console.warn("[core-scan] storage-fit check skipped:", (err as Error).message);
    }
  });
}
