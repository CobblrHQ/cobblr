// Action handlers — registered with the platform at module load.
// The platform calls these in-process when another module / the UI
// / a wire triggers a labels action.

import type { Kysely } from "kysely";
import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { LabelsDB } from "../db.js";
import { evaluateAutoflush } from "./autoflush.js";
import { renameCodeGroup, setGroupOverlay } from "../services/codes.js";
import { getQrLabelBaseUrl, getQrTokenStyle, qrScanUrl } from "./qr-db.js";
import { ensureNavToken } from "../services/entity-qr.js";

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
    const entity = requireActionEntity(ctx);
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<LabelsDB>;
    const ent = await platform().entities.lookup(
      ctx.orgId,
      entity.kind,
      entity.id,
    );
    if (!ent) {
      throw new Error(
        `labels:print: could not resolve ${entity.kind}:${entity.id}`,
      );
    }
    // Description: prefer the rendered template if the binding had
    // one; fall back to the entity's title.
    const description = ctx.rendered && ctx.rendered.trim() !== ""
      ? ctx.rendered
      : ent.title;
    // QR payload: the SAME token URL layer every manual print uses. A label
    // is a physical artifact — a QR encoding a bare path reads as text on any
    // phone and can never be fixed after printing, so this path REFUSES to
    // queue without a workspace label base URL rather than print a dud. The
    // error surfaces in the wire run log with the fix spelled out.
    const qrDb = db as unknown as Parameters<typeof getQrLabelBaseUrl>[0];
    // Base resolution mirrors the manual print path: the workspace's custom
    // label base wins; else the instance's configured public origin (manual
    // prints use the request origin — a wire has no request, and this env is
    // the same origin the instance hands out in emails/DMs). Only when BOTH
    // are absent do we refuse: that instance genuinely has no address a
    // phone could open, and a printed dud can't be recalled.
    const base =
      (await getQrLabelBaseUrl(qrDb)) ||
      (process.env.PUBLIC_BASE_URL || process.env.COBBLR_PUBLIC_URL || "").replace(/\/+$/, "") ||
      // Dev/test instances have a truthful origin even with nothing
      // configured: the box itself. Production does not get this crutch —
      // a printed localhost QR would be a permanent dud.
      (process.env.NODE_ENV !== "production"
        ? `http://localhost:${process.env.API_PORT || 4000}`
        : null);
    if (!base) {
      throw new Error(
        "labels:print: no label base URL is set and this instance has no public URL configured, so an automation-printed QR would not scan. Set one under Configuration → Labels → QR codes (or set PUBLIC_BASE_URL), then re-run.",
      );
    }
    const style = await getQrTokenStyle(qrDb);
    const token = await ensureNavToken(
      ctx.orgId,
      ent.kind,
      ent.id,
      style === "descriptive" ? "descriptive" : "opaque",
    );
    const qr_payload = qrScanUrl(base, token);

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

    // Server-side auto-flush: if this workspace has an auto-print policy on a
    // network printer, a label reaching the buffer may fire a print now — the same
    // as the /queue route. Best-effort; never fail the queue. base=null: the row's
    // stored qr_payload is used as-is (no request to resolve a custom QR base from).
    // A userless invoke (a wire/system trigger) has no personal buffer to flush.
    if (ctx.userId) {
      try {
        await evaluateAutoflush(db, ctx.orgId, ctx.userId, null);
      } catch (e) {
        console.error("[labels] auto-flush (from action) error:", (e as Error).message);
      }
    }

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

  // labels:set-code — a WORKSPACE-scoped action (no entity): configure the
  // workspace's label codes. This is the AI-reachable form of the /codes
  // routes, so Cobb / the MCP can "give the 3D printers a 'p' prefix" through
  // the generic invoke_action rail rather than a bespoke per-op tool. Shares
  // the exact rename/config services the HTTP routes use, so the freeze /
  // keep-existing / seed-default rules can't drift between the two surfaces.
  platform().actions.registerHandler("labels.set-code", async (ctx) => {
    const args = (ctx.args ?? {}) as {
      group_key?: unknown;
      prefix?: unknown;
      code_in_qr?: unknown;
      remove_code?: unknown;
    };
    const groupKey = typeof args.group_key === "string" ? args.group_key.trim() : "";
    if (!groupKey) {
      return { ok: false, error: "group_key is required (see the label-codes list)" };
    }
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<LabelsDB>;
    const changed: string[] = [];

    // 1. Change the prefix. remove_code opts the list OUT of a code (frees the
    // letter, unbinds its items); otherwise a non-blank prefix renames. On a
    // printed (frozen) group a rename retries as going-forward (keeps the printed
    // codes valid); a removal is refused (the sticker still carries the code).
    // remove_code and prefix are mutually exclusive — remove_code wins.
    if (args.remove_code === true) {
      const r = await renameCodeGroup(db, groupKey, "", false);
      if (!r.ok) return { ok: false, error: r.message };
      changed.push(
        `code removed — list opted out${r.codes_rewritten ? ` (${r.codes_rewritten} cleared)` : ""}`,
      );
    } else if (typeof args.prefix === "string" && args.prefix.trim()) {
      const wanted = args.prefix.trim();
      let r = await renameCodeGroup(db, groupKey, wanted, false);
      if (!r.ok && r.code === "frozen") r = await renameCodeGroup(db, groupKey, wanted, true);
      if (!r.ok) return { ok: false, error: r.message };
      changed.push(
        r.kept_existing ? `prefix → ${r.prefix} (already-printed codes kept)` : `prefix → ${r.prefix}`,
      );
    }

    // 2. QR-center is PER GROUP (per instance): one instance can drop its code
    // from the QR while another keeps it. Sets the group's own override.
    const wantCodeInQr = typeof args.code_in_qr === "boolean" ? args.code_in_qr : undefined;
    if (wantCodeInQr !== undefined) {
      const ok = await setGroupOverlay(db, groupKey, wantCodeInQr);
      if (!ok) return { ok: false, error: "couldn't find that code group" };
      changed.push(`code in QR → ${wantCodeInQr ? "on" : "off"}`);
    }

    if (changed.length === 0) {
      return { ok: false, error: "nothing to change, pass prefix or code_in_qr" };
    }
    return { ok: true, group_key: groupKey, changed };
  });
}
