// core-mobility action handlers.
//
//  - recompute-away: wired to inventory.part.updated. Reads the before/after
//    delta from the event payload (Phase A), runs the drift rule, and stamps /
//    keeps / clears `away_since`.
//  - return-home: user-invoked on a part. Sets current location = home and
//    clears the stamp.
//
// GENERIC over entity kinds: the handlers key on ctx.entity.kind — any kind
// whose module (a) emits `<module>.<noun>.updated` with flat before/after bags
// and (b) registers a SILENT EntityWriter works, with zero mobility-side code.
// inventory:part and assets:asset qualify today; adding a kind = a manifest
// contributes block, not a handler change.
//
// Cross-module access is via the PLATFORM, never another module's table
// (module isolation): read with platform().entities.lookup, write with the
// registered EntityWriter (silent — no re-emit — so the write-back doesn't
// re-fire this wire). Values live in the entity's `metadata` jsonb, written
// wholesale → read-modify-write.

import { platform } from "@cobblr/platform-contract";
import { computeAwaySince } from "../compute-away.js";

function coerce(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return { ...(raw as Record<string, unknown>) };
  if (typeof raw === "string" && raw.trim()) {
    try {
      const p = JSON.parse(raw);
      if (p && typeof p === "object") return p as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
  }
  return {};
}

/** Current entity metadata via the platform (metadata is an exposable field on
 *  every mobility-capable kind). Null if the entity is gone. */
async function entityMeta(
  orgId: string,
  kind: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  const ent = await platform().entities.lookup(orgId, kind, id);
  if (!ent) return null;
  return coerce((ent.fields as { metadata?: unknown }).metadata);
}

let registered = false;

export function registerActionHandlers(): void {
  if (registered) return;
  registered = true;

  // Wire target = the updated entity (kind + id from ctx.entity). We recompute
  // from the event delta, not a re-read, so an unrelated edit that didn't move
  // the item is a cheap no-op.
  platform().actions.registerHandler("core-mobility.recompute-away", async (ctx) => {
    const payload = (ctx.event?.payload ?? {}) as {
      before?: Record<string, unknown>;
      after?: Record<string, unknown>;
    };
    const after = payload.after ?? {};
    const before = payload.before ?? {};
    const kind = ctx.entity?.kind;
    const id = ctx.entity?.id;
    if (!kind || !id) return { ok: false, reason: "no_entity" };

    const priorAway = before.away_since != null ? new Date(String(before.away_since)) : null;
    const next = computeAwaySince(
      { awaySince: priorAway },
      {
        mobility: (after.mobility ?? null) as string | null,
        location: (after.location_id ?? null) as string | null,
        home: (after.home_location ?? null) as string | null,
      },
      new Date(),
    );
    if (next === "keep") return { ok: true, changed: false };

    const meta = await entityMeta(ctx.orgId, kind, id);
    if (!meta) return { ok: false, reason: "not_found" };
    const nextVal = next === null ? null : next.toISOString();
    if ((meta.away_since ?? null) === nextVal) return { ok: true, changed: false };

    meta.away_since = nextVal;
    const writer = platform().entities.getWriter(kind);
    if (!writer) return { ok: false, reason: "no_writer" };
    await writer.update(ctx.orgId, id, { metadata: meta });
    return { ok: true, changed: true, away_since: nextVal };
  });

  // Return an item home: current location := home, stamp cleared.
  platform().actions.registerHandler("core-mobility.return-home", async (ctx) => {
    const kind = ctx.entity?.kind;
    const id = ctx.entity?.id;
    if (!kind || !id) return { ok: false, reason: "no_entity" };
    const meta = await entityMeta(ctx.orgId, kind, id);
    if (!meta) return { ok: false, reason: "not_found" };

    const home = meta.home_location as string | undefined;
    if (meta.mobility !== "mobile") return { ok: false, reason: "not_mobile" };
    if (!home) return { ok: false, reason: "no_home" };

    meta.away_since = null;
    const writer = platform().entities.getWriter(kind);
    if (!writer) return { ok: false, reason: "no_writer" };
    await writer.update(ctx.orgId, id, { metadata: meta });
    // The move itself goes through the placement seam (placement-cutover-plan
    // step 1); place() keeps the legacy location_id column mirrored. Fall back
    // to the direct column write if placement refuses (unknown custom kind).
    try {
      await platform().placement.place({
        orgId: ctx.orgId,
        containee: { kind, id },
        container: { kind: "core-locations:location", id: home },
      });
    } catch {
      await writer.update(ctx.orgId, id, { location_id: home });
    }
    return { ok: true, location_id: home };
  });
}
