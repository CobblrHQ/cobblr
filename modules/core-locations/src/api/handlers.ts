// core-locations:reorder — the AI-reachable form of POST /locations/reorder.
//
// `position` on a location is maintained by the module: the update route
// refuses it, because a caller setting it there was silently discarded while
// the call returned 200. Refusing is honest, but it left the capability with no
// door at all — asked to order twelve racks, the assistant could only report
// that it could not. A workspace-scoped ACTION is the repo's answer for
// something that acts on a set rather than one record (core-units:add-unit and
// labels:set-code are the precedents): it rides the generic invoke_action rail,
// so it inherits the confirm gate, the permission check and the change ledger
// without a bespoke tool.
//
// It shares ReorderIds + applyOrder with the HTTP route, so dragging in the
// tree and asking for an order cannot come to mean different things.

import { platform, readListArg } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import { ReorderIds, applyOrder } from "./locations.js";
import type { CoreLocationsDB } from "../db.js";

export function registerLocationsHandlers(): void {
  platform().actions.registerHandler("core-locations.reorder", async (ctx) => {
    // `ids` is a list arg: a real array from invoke_action, a delimited string
    // from a wire's text field. readListArg makes those the same thing — an
    // Array.isArray check here silently ignored the second form.
    const ids = readListArg(ctx.args, "ids");
    const parsed = ReorderIds.safeParse(ids);
    if (!parsed.success) {
      return {
        ok: false,
        error:
          "Pass `ids`: the location ids of ONE parent's children, in the order you want them, as a list, e.g. [\"<id-a>\", \"<id-b>\"]. Use list_records on core-locations:location to read them, keeping only the children of the parent being ordered.",
      };
    }

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreLocationsDB>;

    // Every id must exist, and they must be siblings. Ordering a set that spans
    // two parents silently renumbers both groups against each other, which
    // looks like the wrong thing moved.
    const rows = await db
      .selectFrom("core_locations_locations")
      .select(["id", "name", "parent_id"])
      .where("id", "in", parsed.data)
      .execute();
    if (rows.length !== parsed.data.length) {
      const found = new Set(rows.map((r) => r.id));
      const missing = parsed.data.filter((id) => !found.has(id));
      return { ok: false, error: `no location with id ${missing.join(", ")}` };
    }
    const parents = new Set(rows.map((r) => r.parent_id ?? "«root»"));
    if (parents.size > 1) {
      return {
        ok: false,
        error:
          "Those locations do not share a parent. Order one parent's children at a time: position is a sibling order, not a global one.",
      };
    }

    await applyOrder(db as never, parsed.data);
    const byId = new Map(rows.map((r) => [r.id, r.name]));
    return {
      ok: true,
      result: {
        ordered: parsed.data.map((id, i) => ({ position: i, id, name: byId.get(id) })),
        note: "Sibling order updated. The tree lists shallowest first, then this order, then alphabetically.",
      },
    };
  });
}
