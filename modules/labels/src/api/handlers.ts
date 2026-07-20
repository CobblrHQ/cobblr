// Action handlers — registered with the platform at module load.
// The platform calls these in-process when another module / the UI
// / a wire triggers a labels action.

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { LabelsDB } from "../db.js";

let registered = false;

export function registerLabelsHandlers(): void {
  if (registered) return;
  registered = true;

  // labels:print — queue a label for any entity. Generic — no
  // knowledge of what "inventory:part" or "projects:task" is.
  // The platform delivers a rendered description (from the binding's
  // template) + the entity ref; we encode a canonical URL for the
  // QR and stash everything in the labels_queue.
  platform().actions.registerHandler("labels.queue-from-entity", async (ctx) => {
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<LabelsDB>;
    const ent = await platform().entities.lookup(
      ctx.orgId,
      ctx.entityKind,
      ctx.entityId,
    );
    if (!ent) {
      throw new Error(
        `labels:print: could not resolve ${ctx.entityKind}:${ctx.entityId}`,
      );
    }
    // Description: prefer the rendered template if the binding had
    // one; fall back to the entity's title.
    const description = ctx.rendered && ctx.rendered.trim() !== ""
      ? ctx.rendered
      : ent.title;
    // QR payload: the entity's detail URL, joined to the host's
    // origin (where the QR is scanned from). For now we just put
    // the path; the printer-side renderer can add the origin if
    // needed. (Phase 1b used window.location.origin client-side;
    // server-side we'd need PUBLIC_BASE_URL from env.)
    const qr_payload = ent.detailUrl ?? `/entities/${ent.kind}/${ent.id}`;

    const inserted = await db
      .insertInto("labels_queue")
      .values({
        user_id: ctx.userId,
        module_name: ent.kind.split(":")[0] ?? "unknown",
        entity_type: ent.kind.split(":")[1] ?? "entity",
        entity_id: ent.id,
        qr_payload,
        description,
        qty: 1,
      })
      .returning(["id", "description"])
      .executeTakeFirstOrThrow();

    platform().events.emit("labels.print.queued", {
      orgId: ctx.orgId,
      queueId: inserted.id,
      entityKind: ent.kind,
      entityId: ent.id,
    });

    // The row is queued, which is the durable outcome and the fallback if
    // nothing below happens. The `ui.print` directive additionally offers it to
    // a browser-driven printer, which is the only kind the SERVER cannot reach:
    // that is walk-up printing (add a thing at the shelf, get the label in your
    // hand). The platform ignores this unless such a printer is the default, so
    // it is safe to return every time; labels does not know what hardware
    // exists, and does not need to.
    return {
      ok: true,
      queueId: inserted.id,
      description: inserted.description,
      ui: {
        print: {
          content: { qrPayload: qr_payload, caption: description },
          // Our own bookkeeping endpoint: clears the row, records history,
          // freezes the code. The platform just calls it back.
          record: { path: "/modules/labels/print/record", ids: [inserted.id] },
        },
      },
    };
  });
}
