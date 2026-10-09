// The doors into a stocktake (stocktake.ts): the action a person's confirm,
// the assistant and the API all run, its card, its one Undo, and the two reads
// the "What's still here?" sheet and the stocktake's own page need.
import { Router } from "express";
import { ActionRefusal, platform } from "@cobblr/platform-contract";
import { countOf, quantityWithUnit } from "@cobblr/platform-contract/plural";
import { sessionUser, tenantContext } from "../db.js";
import { asyncHandler, requireCapability } from "./util.js";
import { matchSeen, seenInPhoto } from "../stocktake-photo.js";
import { planStocktake, readStocktake, runStocktake, scopeOf, undoStocktake } from "../stocktake.js";

const args = (v: unknown) => ((v && typeof v === "object" ? v : {}) as Record<string, unknown>);

export function registerStocktakeActions(): void {
  platform().actions.registerHandler("inventory.stocktake", async (ctx) => {
    const a = args(ctx.args);
    const done = await runStocktake(ctx.orgId, ctx.userId ?? null, { scope: a.scope, keep: a.keep, counted: a.counted, confirm_count: a.confirm_count });
    return {
      ok: true,
      summary: `Took stock of ${done.label}: ${done.kept} kept, ${done.gone} marked gone.`,
      data: { stocktake_id: done.id, kept: done.kept, gone: done.gone, counted: done.counted },
    };
  });
  platform().actions.registerPlanner("inventory.stocktake", async (ctx) => {
    const a = args(ctx.args);
    try {
      const plan = await planStocktake(ctx.orgId, { scope: a.scope, keep: a.keep, counted: a.counted });
      const lines = [
        ...plan.kept.map((i) => `Keep ${i.title}`),
        ...plan.counted.map((i) => `Keep ${i.title}, ${quantityWithUnit(i.after, i.unit)} left (was ${i.before})`),
        ...plan.gone.map((i) => `Gone: ${i.title}`),
      ];
      const title = `${plan.label}: keep ${plan.kept.length + plan.counted.length}, mark ${countOf(plan.gone.length, "thing")} gone`;
      return { title: plan.confirm ? `${title}. ${plan.confirm.sentence}` : title, lines };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
  platform().actions.registerUndo("inventory.stocktake", (result) => {
    const id = (result as { data?: { stocktake_id?: unknown } } | null)?.data?.stocktake_id;
    return typeof id === "string" ? { action_id: "inventory:undo-stocktake", args: { stocktake_id: id } } : null;
  });

  platform().actions.registerHandler("inventory.undo-stocktake", async (ctx) => {
    const id = args(ctx.args).stocktake_id;
    if (typeof id !== "string" || !id) throw new ActionRefusal("Choose the stocktake to undo.");
    const r = await undoStocktake(ctx.orgId, ctx.userId ?? null, id);
    return { ok: true, summary: `Undid the stocktake of ${r.label}: ${countOf(r.back, "thing")} back as ${r.back === 1 ? "it was" : "they were"}.`, data: { stocktake_id: id, back: r.back } };
  });
  platform().actions.registerPlanner("inventory.undo-stocktake", async (ctx) => {
    const id = args(ctx.args).stocktake_id;
    const row = typeof id === "string" ? await readStocktake(ctx.orgId, id) : null;
    if (!row) return { error: "That stocktake no longer exists." };
    if (row.undone_at) return { error: `The stocktake of ${row.label} is already undone.` };
    return {
      title: `Undo the stocktake of ${row.label}`,
      lines: [...row.gone.map((g) => `Back: ${g.title}`), ...row.counted.map((c) => `${c.title}: ${c.before} again`)],
    };
  });
}

export const stocktakeRouter = Router({ mergeParams: true });

/** Everything still listed in a place (or the picked records, or a
 *  collection's things with no place), newest first: the sheet's list. */
stocktakeRouter.get("/stocktake", asyncHandler(async (req, res) => {
  const q = req.query as Record<string, unknown>;
  const ids = typeof q.ids === "string" && q.ids ? q.ids.split(",") : null;
  const instance = typeof q.instance === "string" && q.instance ? q.instance : null;
  const scope = ids ? { ids } : q.unplaced === "true" ? { unplaced: true, instance } : { place_id: q.place_id, instance };
  try {
    const { label, items } = await scopeOf(tenantContext(req).org.id, scope);
    res.json({ label, items });
  } catch (err) {
    if (err instanceof ActionRefusal) return void res.status(400).json({ error: { code: "bad_scope", message: err.message } });
    throw err;
  }
}));

/** One stocktake: what it kept, marked gone and counted, and whether it was undone. */
stocktakeRouter.get("/stocktakes/:id", asyncHandler(async (req, res) => {
  const row = await readStocktake(tenantContext(req).org.id, String(req.params.id));
  if (!row) return void res.status(404).json({ error: { code: "not_found", message: "That stocktake no longer exists." } });
  res.json(row);
}));

/** A starting list from one photo of a shelf or door: which listed records it
 *  saw (to tick in the sheet) and what it saw that is not listed (to offer as
 *  new). Writes nothing; the person still checks every tick and presses the
 *  button. */
// UI-SCREEN: /locations/:id through the Stock here panel's What's still here? sheet, Start from a photo
// AI-REACH: exempt writes nothing; the assistant sees a photo itself and passes the ids it read to inventory:stocktake
stocktakeRouter.post("/stocktake/photo", asyncHandler(async (req, res) => {
  if (!(await requireCapability(req, res, "inventory:stocktake"))) return;
  const body = (req.body ?? {}) as { place_id?: unknown; file_id?: unknown };
  if (typeof body.place_id !== "string" || typeof body.file_id !== "string") {
    return void res.status(400).json({ error: { code: "bad_body", message: "Choose the place and the photo." } });
  }
  const orgId = tenantContext(req).org.id;
  try {
    const { items } = await scopeOf(orgId, { place_id: body.place_id });
    const seen = await seenInPhoto(orgId, sessionUser(req).id, body.file_id);
    const { matched, unmatched } = matchSeen(seen, items);
    res.json({ seen: seen.length, matched, unmatched });
  } catch (err) {
    if (err instanceof ActionRefusal) return void res.status(409).json({ error: { code: "not_read", message: err.message } });
    throw err;
  }
}));
