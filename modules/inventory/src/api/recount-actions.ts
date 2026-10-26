// The doors into a recount (recount.ts, #6302): starting or picking one up,
// scanning a thing into it, and taking a scan back out, which a person's
// press, the assistant and the API all run; and the two reads its page needs.
import { Router } from "express";
import { ActionRefusal, platform } from "@cobblr/platform-contract";
import { countOf } from "@cobblr/platform-contract/plural";
import { sessionUser, tenantContext } from "../db.js";
import { labelInPhoto } from "../recount-label.js";
import { openRecounts, progressLine, readRecount, removeRecountScan, scanIntoRecount, startRecount } from "../recount.js";
import { applyRecount, planLine, planReconcile, undoRecount, type ReconcileInput } from "../recount-reconcile.js";
import { asyncHandler, requireCapability } from "./util.js";

const args = (v: unknown) => ((v && typeof v === "object" ? v : {}) as Record<string, unknown>);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export function registerRecountActions(): void {
  platform().actions.registerHandler("inventory.start-recount", async (ctx) => {
    const r = await startRecount(ctx.orgId, ctx.userId ?? null, args(ctx.args).scope);
    return {
      ok: true,
      summary: r.resumed
        ? `Picked up the recount of ${r.label} where it was left.`
        : `Started a recount of ${r.label}: ${countOf(r.expected, "thing")} to find.`,
      data: { recount_id: r.id, expected: r.expected, resumed: r.resumed },
    };
  });

  platform().actions.registerHandler("inventory.recount-scan", async (ctx) => {
    const a = args(ctx.args);
    const id = str(a.recount_id);
    if (!id) throw new ActionRefusal("Choose the recount to scan into.");
    const amount = a.amount == null || a.amount === "" ? null : Number(a.amount);
    const r = await scanIntoRecount(ctx.orgId, ctx.userId ?? null, id, {
      record_id: str(a.record_id),
      barcode: str(a.barcode),
      text: str(a.text),
      attributes: a.attributes && typeof a.attributes === "object" ? (a.attributes as Record<string, unknown>) : null,
      new: a.new === true || a.new === "true",
      type_id: str(a.type_id),
      place_id: str(a.place_id),
      amount,
    });
    const m = r.match;
    if (m.kind === "refused") throw new ActionRefusal(m.reason);
    const progress = progressLine(r.progress);
    if (r.type_candidates) {
      return {
        ok: true,
        summary: `That is new here, and could be ${countOf(r.type_candidates.length, "kind")} you keep. Pick which, or say none of these.`,
        data: { result: "ask_type", candidates: r.type_candidates.map((c) => ({ id: c.id, title: c.title, place: c.place, image_path: c.image_path })), progress: r.progress },
      };
    }
    const summary =
      m.kind === "matched"
        ? `Counted ${r.title}. ${progress}.`
        : m.kind === "new"
          ? r.type
            ? `A new ${r.type.title}: noted to add under that kind. ${progress}.`
            : `${r.title} is not on record here: noted as new. ${progress}.`
          : `That could be ${countOf(m.candidates.length, "thing")} you have. Pick which.`;
    return {
      ok: true,
      summary,
      data: {
        result: m.kind,
        ...(m.kind === "matched" ? { record_id: m.id, by: m.by } : {}),
        ...(m.kind === "new" ? { like_id: m.like, type_id: r.type?.id ?? null } : {}),
        ...(m.kind === "ask" ? { candidates: m.candidates.map((c) => ({ id: c.id, title: c.title, place: c.place, image_path: c.image_path })) } : {}),
        scan_id: r.scan_id,
        progress: r.progress,
      },
    };
  });

  const reconcileInput = (a: Record<string, unknown>): ReconcileInput => ({ preview: a.preview, truth: a.truth, not_seen: a.not_seen, not_seen_all: a.not_seen_all, new: a.new });
  platform().actions.registerHandler("inventory.apply-recount", async (ctx) => {
    const a = args(ctx.args);
    const id = str(a.recount_id);
    if (!id) throw new ActionRefusal("Choose the recount to finish.");
    const r = await applyRecount(ctx, id, reconcileInput(a));
    return {
      ok: true,
      summary: `Finished the recount of ${r.label}: ${r.line}.`,
      data: { recount_id: id, moved: r.applied.moved.length, counted: r.applied.counted.length, added: r.applied.added.length, gone: r.applied.gone.length, later: r.applied.later.length },
    };
  });
  platform().actions.registerPlanner("inventory.apply-recount", async (ctx) => {
    const a = args(ctx.args);
    const id = str(a.recount_id);
    if (!id) return { error: "Choose the recount to finish." };
    try {
      const p = await planReconcile(ctx.orgId, id, reconcileInput(a));
      return {
        title: `Finish the recount of ${p.label}: ${planLine(p)}`,
        lines: [
          ...p.seen.flatMap((s) => [s.move ? `Move ${s.title} to ${s.move.to_name ?? "its new place"}` : null, s.amount ? `${s.title}: ${s.amount.after} left (was ${s.amount.before})` : null].filter((x): x is string => !!x)),
          ...p.new.filter((n) => n.choice === "add").map((n) => `Add ${n.title}`),
          ...p.not_seen.filter((n) => n.choice === "gone").map((n) => `Gone: ${n.title}`),
          ...p.not_seen.filter((n) => n.choice === "later").map((n) => `Check later: ${n.title}`),
        ],
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
  platform().actions.registerUndo("inventory.apply-recount", (result) => {
    const id = (result as { data?: { recount_id?: unknown } } | null)?.data?.recount_id;
    return typeof id === "string" ? { action_id: "inventory:undo-recount", args: { recount_id: id } } : null;
  });

  platform().actions.registerHandler("inventory.undo-recount", async (ctx) => {
    const id = str(args(ctx.args).recount_id);
    if (!id) throw new ActionRefusal("Choose the recount to undo.");
    const r = await undoRecount(ctx.orgId, ctx.userId ?? null, id);
    return { ok: true, summary: `Undid the recount of ${r.label}: ${countOf(r.back, "thing")} back as ${r.back === 1 ? "it was" : "they were"}.`, data: { recount_id: id, back: r.back } };
  });

  platform().actions.registerHandler("inventory.recount-remove-scan", async (ctx) => {
    const a = args(ctx.args);
    const id = str(a.recount_id);
    const scan = str(a.scan_id);
    if (!id || !scan) throw new ActionRefusal("Choose the recount and the scan to take out.");
    const r = await removeRecountScan(ctx.orgId, id, scan);
    return { ok: true, summary: `Took ${r.title} back out of the recount of ${r.label}.`, data: { recount_id: id, scan_id: scan } };
  });
}

export const recountRouter = Router({ mergeParams: true });

/** The recounts still open: where a paused one is picked up again. */
recountRouter.get("/recounts", asyncHandler(async (req, res) => {
  res.json({ items: await openRecounts(tenantContext(req).org.id) });
}));

/** What finishing the recount would do, with these choices, without doing
 *  it: the reconcile screen's preview, the same plan Apply writes. */
// UI-SCREEN: /instances/:name/recounts/:id through Finish…
// AI-REACH: exempt writes nothing; the assistant previews through inventory:apply-recount's planner card
recountRouter.post("/recounts/:id/plan", asyncHandler(async (req, res) => {
  if (!(await requireCapability(req, res, "inventory:apply-recount"))) return;
  try {
    res.json(await planReconcile(tenantContext(req).org.id, String(req.params.id), (req.body ?? {}) as ReconcileInput));
  } catch (err) {
    if (err instanceof ActionRefusal) return void res.status(409).json({ error: { code: "not_open", message: err.message } });
    throw err;
  }
}));

/** The words printed on a thing's label, read off one photo: what the
 *  recount page matches a thing with no barcode by. Writes nothing. */
// UI-SCREEN: /instances/:name/recounts/:id through Photo of the label
// AI-REACH: exempt writes nothing; the assistant reads a photo itself and passes the label's words to inventory:recount-scan as text
recountRouter.post("/recounts/:id/label", asyncHandler(async (req, res) => {
  if (!(await requireCapability(req, res, "inventory:recount-scan"))) return;
  const fileId = (req.body ?? {}).file_id;
  if (typeof fileId !== "string" || !fileId) return void res.status(400).json({ error: { code: "bad_body", message: "Choose the photo." } });
  try {
    res.json({ text: await labelInPhoto(tenantContext(req).org.id, sessionUser(req).id, fileId) });
  } catch (err) {
    if (err instanceof ActionRefusal) return void res.status(409).json({ error: { code: "not_read", message: err.message } });
    throw err;
  }
}));

/** One recount: what it expects, what has been seen, what is new, and how far along it is. */
recountRouter.get("/recounts/:id", asyncHandler(async (req, res) => {
  const row = await readRecount(tenantContext(req).org.id, String(req.params.id));
  if (!row) return void res.status(404).json({ error: { code: "not_found", message: "That recount no longer exists." } });
  res.json(row);
}));
