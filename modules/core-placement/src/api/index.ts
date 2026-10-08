import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { insuranceCsv, insurancePdf, readInsuranceList } from "./insurance-list.js";
import { csvDownloadHeaders } from "@cobblr/platform-contract/csv";
// Default-exported Router, mounted at
//   /api/v1/orgs/:slug/modules/core-placement/
// (requireAuth + withTenant pre-applied by the platform).
//
// Thin HTTP surface over platform().placement — "what is this thing inside of?"
// and "what's inside this container?". Reads resolve refs to display entities
// (title + detailUrl) via platform().entities.lookupMany so callers render
// names, never uuids. A Location is just one KIND of container here.

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { placeLine, platform } from "@cobblr/platform-contract";
import { tenantContext, sessionUser } from "../db.js";
import { requireRole } from "./util.js";
import { registerPlacementActionHandlers } from "./action-handlers.js";

// Side effect on import: the place/remove action handlers.
registerPlacementActionHandlers();

const router = Router({ mergeParams: true });

const Ref = z.object({ kind: z.string().min(1).max(120), id: z.string().min(1).max(200) });

function orgId(req: Request): string {
  return tenantContext(req).org.id;
}
const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response) => {
    fn(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      // place() throws a plain Error on an illegal placement (self, cycle,
      // ineligible kind) — surface those as 422, everything else 500.
      const bad = /placement:/.test(message);
      res.status(bad ? 422 : 500).json({ error: { code: bad ? "invalid_placement" : "internal", message } });
    });
  };

// GET /contents?container_kind=&container_id= — what's directly inside a container.
router.get(
  "/contents",
  wrap(async (req, res) => {
    const parsed = Ref.safeParse({ kind: req.query.container_kind, id: req.query.container_id });
    if (!parsed.success) {
      res.status(400).json({ error: { code: "bad_query", message: "container_kind + container_id required" } });
      return;
    }
    const refs = await platform().placement.contents({ orgId: orgId(req), container: parsed.data });
    const found = refs.length ? await platform().entities.lookupMany(orgId(req), refs.map(({ kind, id }) => ({ kind, id }))) : [];
    // Each thing with where it sits: the slot, and the pin a floor plan drew.
    const at = new Map(refs.map((r) => [r.id, r]));
    const items = found.map((e) => ({ ...e, slot: at.get(e.id)?.slot ?? null, position: at.get(e.id)?.position ?? null }));
    res.json({ items });
  }),
);

// GET /of?containee_kind=&containee_id= — the container a thing lives in (or null).
router.get(
  "/of",
  wrap(async (req, res) => {
    const parsed = Ref.safeParse({ kind: req.query.containee_kind, id: req.query.containee_id });
    if (!parsed.success) {
      res.status(400).json({ error: { code: "bad_query", message: "containee_kind + containee_id required" } });
      return;
    }
    const ref = await platform().placement.containerOf({ orgId: orgId(req), containee: parsed.data });
    const container = ref ? (await platform().entities.lookupMany(orgId(req), [ref]))[0] ?? null : null;
    res.json({ container });
  }),
);

// GET /path?containee_kind=&containee_id= — where a thing is, every step up:
// { path: [{kind, id, name}, ...], line: "Backpack, in Desk drawer", inside }.
router.get(
  "/path",
  wrap(async (req, res) => {
    const parsed = Ref.safeParse({ kind: req.query.containee_kind, id: req.query.containee_id });
    if (!parsed.success) {
      res.status(400).json({ error: { code: "bad_query", message: "containee_kind + containee_id required" } });
      return;
    }
    const path = (await platform().placement.pathsOf({ orgId: orgId(req), containees: [parsed.data] })).get(`${parsed.data.kind}:${parsed.data.id}`) ?? [];
    // What it sits inside when that is a thing rather than a place (a
    // Backpack), so a picker can show it chosen without knowing place kinds.
    const first = path[0];
    const rec = first ? await Promise.resolve(platform().entities.getKind(first.kind)).catch(() => null) : null;
    const inside = first && (rec?.traits as { containment?: unknown } | undefined)?.containment !== "container" ? first : null;
    res.json({ path, line: placeLine(path), inside });
  }),
);

// GET /holders — every record that holds things now and is not a place by
// nature (a Backpack, a toolbox, a van): what a "where is it kept" picker
// offers beside the places themselves. Each with its own place, so two
// toolboxes can be told apart, and how many things are in it (a floor plan
// says so on its pin): { items: [{kind, id, title, line, holds}] }.
router.get(
  "/holders",
  wrap(async (req, res) => {
    const held = await platform().placement.holders({ orgId: orgId(req) });
    if (!held.length) {
      res.json({ items: [] });
      return;
    }
    const refs = held.map(({ kind, id }) => ({ kind, id }));
    const holds = new Map(held.map((h) => [`${h.kind}:${h.id}`, h.holds]));
    const [found, paths] = await Promise.all([
      platform().entities.lookupMany(orgId(req), refs),
      platform().placement.pathsOf({ orgId: orgId(req), containees: refs }),
    ]);
    const items = found
      .map((e) => ({
        kind: e.kind,
        id: e.id,
        title: e.title,
        detailUrl: e.detailUrl ?? null,
        line: placeLine(paths.get(`${e.kind}:${e.id}`) ?? []),
        holds: holds.get(`${e.kind}:${e.id}`) ?? 0,
      }))
      .sort((a, b) => a.title.localeCompare(b.title));
    res.json({ items });
  }),
);

/** Who is asking, for values a kind keeps behind a capability (a part's cost). */
function viewerOf(req: Request): { userId: string; role: string } | undefined {
  const user = sessionUser(req);
  return user ? { userId: user.id, role: tenantContext(req).role } : undefined;
}

// GET /built?container_kind=&container_id= — a thing built from parts: its
// own value ("other value, not itemized"), each part with its count and value
// (and what is installed in that, all the way down), and the total. Each
// part counted once. Values a viewer may not see are withheld, and said so.
router.get(
  "/built",
  wrap(async (req, res) => {
    const parsed = Ref.safeParse({ kind: req.query.container_kind, id: req.query.container_id });
    if (!parsed.success) {
      res.status(400).json({ error: { code: "bad_query", message: "container_kind + container_id required" } });
      return;
    }
    const viewer = viewerOf(req);
    res.json(await platform().placement.builtValue({ orgId: orgId(req), container: parsed.data, ...(viewer ? { viewer } : {}) }));
  }),
);

async function mayReadCosts(req: Request, res: Response): Promise<boolean> {
  const viewer = viewerOf(req);
  if (!viewer) { res.status(401).json({ error: { code: "unauthorized", message: "Sign in to view costs." } }); return false; }
  const who = { orgId: orgId(req), ...viewer, actionId: "inventory:view-costs" };
  if (await platform().auth.userHasCapability(who)) return true;
  const blocked = await platform().auth.describeBlockedCapability(who);
  res.status(403).json({ error: { code: "missing_capability", message: blocked.sentence, blocked } });
  return false;
}

router.get("/insurance-list.:format", wrap(async (req, res) => {
  if (!await mayReadCosts(req, res)) return;
  const within = Ref.safeParse({ kind: req.query.within_kind, id: req.query.within_id });
  const format = z.enum(["csv", "pdf"]).safeParse(req.params.format);
  if (!within.success || !format.success) {
    res.status(400).json({ error: { code: "bad_query", message: "Choose a place and CSV or PDF." } });
    return;
  }
  const got = await readInsuranceList(orgId(req), within.data, viewerOf(req)!);
  const filename = `insurance-list.${format.data}`;
  res.set(csvDownloadHeaders(filename));
  if (format.data === "csv") res.send(insuranceCsv(got.rows));
  else res.type("application/pdf").send(Buffer.from(await insurancePdf(orgId(req), got.title, got.worth, got.rows)));
}));

// GET /worth?within_kind=&within_id= — what everything is worth, each record
// once: the workspace, or what is inside one place at any depth.
router.get(
  "/worth",
  wrap(async (req, res) => {
    const within = req.query.within_kind || req.query.within_id ? Ref.safeParse({ kind: req.query.within_kind, id: req.query.within_id }) : null;
    if (within && !within.success) {
      res.status(400).json({ error: { code: "bad_query", message: "within_kind + within_id go together" } });
      return;
    }
    const viewer = viewerOf(req);
    if (within && !await mayReadCosts(req, res)) return;
    res.json(await platform().placement.worth({ orgId: orgId(req), within: within?.data ?? null, ...(viewer ? { viewer } : {}) }));
  }),
);

// GET /word?kind= — what this kind calls the things inside one of its records
// ("Parts", "In the bag"): { word, custom, default_word }, word null = "Contents".
router.get(
  "/word",
  wrap(async (req, res) => {
    const kind = typeof req.query.kind === "string" ? req.query.kind.trim() : "";
    if (!kind || kind.length > 120) {
      res.status(400).json({ error: { code: "bad_query", message: "kind required" } });
      return;
    }
    res.json(await platform().placement.contentsWord({ orgId: orgId(req), kind }));
  }),
);

const WordBody = z.object({ kind: z.string().min(1).max(120), word: z.string().max(40).nullable() });

// PUT /word { kind, word } — rename it for every record of the kind; null or
// blank puts the default back. Owners and admins, as any rename of a kind.
// AI-REACH: action platform:rename-contents
router.put(
  "/word",
  wrap(async (req, res) => {
    if (!(await requireCapability(req, res, "platform:rename-contents"))) return;
    const parsed = WordBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "bad_body", message: "kind and word (up to 40 characters, or null) required" } });
      return;
    }
    res.json(await platform().placement.setContentsWord({ orgId: orgId(req), kind: parsed.data.kind, word: parsed.data.word }));
  }),
);

const Position = z.object({ x_mm: z.number().finite().min(-1_000_000).max(1_000_000), y_mm: z.number().finite().min(-1_000_000).max(1_000_000) });
const PlaceBody = z.object({
  containee: Ref,
  container: Ref,
  slot: z.string().max(120).nullish(),
  // A pin inside the container, millimetres from its top-left; null clears it.
  position: Position.nullish(),
  // What made the move ("floor plan"): the activity row says so.
  via: z.string().trim().min(1).max(80).optional(),
  // The slot holds one thing: what is in it now goes back where it came from.
  one_to_a_slot: z.boolean().optional(),
  // Only this many of a counted thing (2 of 4 sticks): the rest stays put.
  qty: z.number().finite().positive().max(1_000_000).optional(),
});

// POST /place { containee, container, slot?, position?, via? } — put a thing inside a container.
// AI-REACH: covered by core-placement:place and :remove actions on the placed record
router.post(
  "/place",
  wrap(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = PlaceBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "bad_body", message: "containee + container required" } });
      return;
    }
    if (parsed.data.one_to_a_slot && !parsed.data.slot) {
      res.status(400).json({ error: { code: "bad_body", message: "one_to_a_slot needs a slot" } });
      return;
    }
    const was = await platform().placement.containerOf({ orgId: orgId(req), containee: parsed.data.containee }).catch(() => null);
    const done = await platform().placement.place({
      orgId: orgId(req),
      containee: parsed.data.containee,
      container: parsed.data.container,
      slot: parsed.data.slot ?? null,
      placedBy: sessionUser(req)?.id ?? null,
      ...(parsed.data.position !== undefined ? { position: parsed.data.position } : {}),
      ...(parsed.data.via ? { via: parsed.data.via } : {}),
      ...(parsed.data.one_to_a_slot ? { oneToASlot: true } : {}),
      ...(parsed.data.qty !== undefined ? { qty: parsed.data.qty } : {}),
    });
    // When what went in is another record than the one asked (a split-off
    // part of it, or the record it joined there), say which: putting that one
    // back where it was is the undo. Otherwise nothing to say, as before.
    const placed = done?.placed ?? parsed.data.containee;
    const another = placed.id !== parsed.data.containee.id;
    if (!another && !(done && done.displaced.length)) {
      res.status(204).end();
      return;
    }
    res.json({ placed, was, ...(done && done.displaced.length ? { displaced: done.displaced } : {}) });
  }),
);

const HomeBody = z.object({ containee: Ref, via: z.string().trim().min(1).max(80).optional() });

// POST /return-home { containee, via? } — back to where it was before its
// current container (a spool off a printer, onto its shelf).
// AI-REACH: action core-placement:return-home
// UI-REACH: a printer's "Take off" sends a spool home through digifab POST /loaded/:machineId/unload
router.post(
  "/return-home",
  wrap(async (req, res) => {
    if (!(await requireCapability(req, res, "core-placement:return-home"))) return;
    const parsed = HomeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "bad_body", message: "containee required" } });
      return;
    }
    const to = await platform().placement.returnHome({
      orgId: orgId(req),
      containee: parsed.data.containee,
      placedBy: sessionUser(req)?.id ?? null,
      ...(parsed.data.via ? { via: parsed.data.via } : {}),
    });
    const container = to ? (await platform().entities.lookupMany(orgId(req), [{ kind: to.kind, id: to.id }]))[0] ?? null : null;
    // The record it is now: a part taken back to its spares joined them.
    res.json({ to: container, placed: to?.placed ?? parsed.data.containee });
  }),
);

const RemoveBody = z.object({ containee: Ref });

// POST /remove { containee } — take a thing out of its container.
// AI-REACH: covered by core-placement:place and :remove actions on the placed record
router.post(
  "/remove",
  wrap(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = RemoveBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "bad_body", message: "containee required" } });
      return;
    }
    await platform().placement.remove({ orgId: orgId(req), containee: parsed.data.containee });
    res.status(204).end();
  }),
);

export default router;
