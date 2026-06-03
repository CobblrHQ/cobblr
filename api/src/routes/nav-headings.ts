// /orgs/:slug/nav-headings — user-defined navbar headings (org-wide).
// Read by any member (the nav renders them); mutated by owner/admin.
// See docs/architecture/nav-builder.md.

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import {
  addNavMember,
  createNavHeading,
  deleteNavHeading,
  listNavHeadings,
  removeNavMember,
  updateNavHeading,
} from "../platform/nav-headings.js";

export const navHeadingsRouter = Router({ mergeParams: true });

type Req = import("express").Request;
type Res = import("express").Response;

function requireOwnerOrAdmin(req: Req, res: Res): boolean {
  const role = (req as unknown as { tenant?: { role: string } }).tenant?.role;
  if (role === "owner" || role === "admin") return true;
  res.status(403).json({
    error: { code: "forbidden", message: "Requires owner or admin role." },
  });
  return false;
}

const CreateBody = z.object({
  name: z.string().min(1).max(80),
  icon: z.string().max(80).nullable().optional(),
});
const UpdateBody = z.object({
  name: z.string().min(1).max(80).optional(),
  icon: z.string().max(80).nullable().optional(),
  position: z.number().int().optional(),
});
const MemberBody = z.object({
  target_kind: z.enum(["module", "instance"]),
  target_id: z.string().min(1).max(160),
});

navHeadingsRouter.get("/", requireAuth, withTenant, async (req, res, next) => {
  try {
    res.json({ items: await listNavHeadings(req.tenant!.org.id) });
  } catch (err) {
    next(err);
  }
});

navHeadingsRouter.post("/", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireOwnerOrAdmin(req, res)) return;
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad body", details: parsed.error.issues } });
      return;
    }
    const created = await createNavHeading({
      orgId: req.tenant!.org.id,
      name: parsed.data.name,
      icon: parsed.data.icon,
    });
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

navHeadingsRouter.patch("/:id", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireOwnerOrAdmin(req, res)) return;
    const parsed = UpdateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad body", details: parsed.error.issues } });
      return;
    }
    const ok = await updateNavHeading(req.tenant!.org.id, req.params.id!, parsed.data);
    if (!ok) {
      res.status(404).json({ error: { code: "not_found", message: "heading not found" } });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

navHeadingsRouter.delete("/:id", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireOwnerOrAdmin(req, res)) return;
    await deleteNavHeading(req.tenant!.org.id, req.params.id!);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

navHeadingsRouter.post("/:id/members", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireOwnerOrAdmin(req, res)) return;
    const parsed = MemberBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad body", details: parsed.error.issues } });
      return;
    }
    await addNavMember({
      orgId: req.tenant!.org.id,
      headingId: req.params.id!,
      targetKind: parsed.data.target_kind,
      targetId: parsed.data.target_id,
    });
    res.status(201).end();
  } catch (err) {
    next(err);
  }
});

// Remove a member by its target — an entry is in at most one heading, so
// the heading id isn't needed.
navHeadingsRouter.delete(
  "/members/:targetKind/:targetId",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      if (!requireOwnerOrAdmin(req, res)) return;
      await removeNavMember(
        req.tenant!.org.id,
        req.params.targetKind!,
        req.params.targetId!,
      );
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);
