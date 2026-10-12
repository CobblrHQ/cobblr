// The invokable side of outside libraries, so Cobb, MCP and wires link the
// same way the panel does ("link the warranty PDF to the dishwasher", "link
// the Zelda ROM to this cartridge"). Each handler
// reads ctx.entity: it acts on the record it was invoked on.

import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { Db } from "../matching.js";
import { copyItem, LibraryRefusal, linkItem, pickItem, unlinkItem } from "../service.js";

let registered = false;

const dbOf = async (orgId: string) => (await platform().tenants.getDb(orgId)) as Db;
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function refusal(err: unknown): { ok: false; error: string } {
  if (err instanceof LibraryRefusal) return { ok: false, error: err.message };
  throw err;
}

export function registerLibraryActions(): void {
  if (registered) return;
  registered = true;

  platform().actions.registerHandler("core-documents.link-item", async (ctx) => {
    const entity = requireActionEntity(ctx);
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const record = { kind: entity.kind, id: entity.id };
    try {
      let connectionId = text(args.connection_id);
      let ref = text(args.ref);
      if (!connectionId || !ref) {
        const words = text(args.item);
        if (!words) return { ok: false, error: "Say which item: its ref, or words from its title." };
        const picked = await pickItem(ctx.orgId, ctx.userId, record, words);
        if (!picked) return { ok: false, error: `Nothing answering "${words}" was found in the libraries you can use here.` };
        connectionId = picked.connectionId;
        ref = picked.doc.ref;
      }
      // Never written back from here: this action is undoable and may run
      // without a confirm, so it changes nothing outside the workspace.
      // Writing the address onto the item is the person's own tick in
      // the panel.
      const out = await linkItem(ctx.orgId, await dbOf(ctx.orgId), ctx.userId, record, connectionId, ref);
      return { ok: true, summary: `Linked "${out.linked.title}" from ${out.linked.system}${out.already ? " (it was linked already)" : ""}.`, connection_id: connectionId, ref, title: out.linked.title };
    } catch (err) {
      return refusal(err);
    }
  });

  platform().actions.registerHandler("core-documents.unlink-item", async (ctx) => {
    const entity = requireActionEntity(ctx);
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const connectionId = text(args.connection_id);
    const ref = text(args.ref);
    if (!connectionId || !ref) return { ok: false, error: "Say which linked item: its connection_id and ref (list_related shows them)." };
    const out = await unlinkItem(ctx.orgId, await dbOf(ctx.orgId), ctx.userId, { kind: entity.kind, id: entity.id }, connectionId, ref);
    return { ok: true, summary: out.removed ? `Unlinked "${out.title}".` : "That item was not linked.", removed: out.removed, connection_id: connectionId, ref };
  });

  platform().actions.registerHandler("core-documents.copy-item", async (ctx) => {
    const entity = requireActionEntity(ctx);
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const connectionId = text(args.connection_id);
    const ref = text(args.ref);
    if (!connectionId || !ref) return { ok: false, error: "Say which item: its connection_id and ref." };
    try {
      const vault = args.to === "vault";
      const job = await copyItem(ctx.orgId, ctx.userId, { kind: entity.kind, id: entity.id }, connectionId, ref, { to: vault ? "vault" : "files" });
      return { ok: true, summary: vault ? "Keeping a copy in your Vault, in Personal documents; this record will list it." : "Bringing a copy into Cobblr; it will be attached to this record.", job_id: job.id };
    } catch (err) {
      return refusal(err);
    }
  });

  // Undo a link the assistant made: take it away again.
  platform().actions.registerUndo("core-documents.link-item", (result, ctx) => {
    const r = result as { ok?: unknown; connection_id?: unknown; ref?: unknown } | null;
    if (!ctx.entity || r?.ok !== true || typeof r.connection_id !== "string" || typeof r.ref !== "string") return null;
    return { action_id: "core-documents:unlink-item", args: { connection_id: r.connection_id, ref: r.ref }, entity_kind: ctx.entity.kind, entity_id: ctx.entity.id };
  });
  // Undo an unlink: put the link back.
  platform().actions.registerUndo("core-documents.unlink-item", (result, ctx) => {
    const r = result as { ok?: unknown; removed?: unknown; connection_id?: unknown; ref?: unknown } | null;
    if (!ctx.entity || r?.ok !== true || r.removed !== true || typeof r.connection_id !== "string" || typeof r.ref !== "string") return null;
    return { action_id: "core-documents:link-item", args: { connection_id: r.connection_id, ref: r.ref }, entity_kind: ctx.entity.kind, entity_id: ctx.entity.id };
  });
}
