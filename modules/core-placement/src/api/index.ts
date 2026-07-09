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
import { platform } from "@cobblr/platform-contract";
import { tenantContext, sessionUser } from "../db.js";
import { requireRole } from "./util.js";

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
    const items = refs.length ? await platform().entities.lookupMany(orgId(req), refs) : [];
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

const PlaceBody = z.object({ containee: Ref, container: Ref, slot: z.string().max(120).nullish() });

// POST /place { containee, container, slot? } — put a thing inside a container.
router.post(
  "/place",
  wrap(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = PlaceBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "bad_body", message: "containee + container required" } });
      return;
    }
    await platform().placement.place({
      orgId: orgId(req),
      containee: parsed.data.containee,
      container: parsed.data.container,
      slot: parsed.data.slot ?? null,
      placedBy: sessionUser(req)?.id ?? null,
    });
    res.status(204).end();
  }),
);

const RemoveBody = z.object({ containee: Ref });

// POST /remove { containee } — take a thing out of its container.
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
