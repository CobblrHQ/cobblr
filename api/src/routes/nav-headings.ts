// /orgs/:slug/nav-headings — user-defined navbar headings (org-wide).
// Read by any member (the nav renders them); mutated by owner/admin.
// See docs/architecture/nav-builder.md.

import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { requireRole } from "../auth/capability.js";
import {
  addNavMember,
  createNavHeading,
  deleteNavHeading,
  listNavHeadings,
  removeNavMember,
  updateNavHeading,
} from "../platform/nav-headings.js";
import { invalidBodyMessage } from "@cobblr/platform-contract/invalid-body";

export const navHeadingsRouter = Router({ mergeParams: true });

type Req = import("express").Request;
type Res = import("express").Response;

/** Shaping the navbar is builder work: the admin tier, by rank. */
function requireOwnerOrAdmin(req: Req, res: Res): boolean {
  return requireRole(req, res, "owner", "admin");
}

const CreateBody = z.object({
  name: z.string().min(1).max(80),
  icon: z.string().max(80).nullable().optional(),
});
const UpdateBody = z.object({
  name: z.string().min(1).max(80).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  icon: z.string().max(80).nullable().optional(),
  position: z.number().int().optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
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

// AI-ACTION: core-presentation:group-nav
navHeadingsRouter.post("/", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!(await requireCapability(req, res, "core-presentation:group-nav"))) return;
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: invalidBodyMessage(parsed.error.issues), details: parsed.error.issues } });
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

// AI-REACH: renaming or re-icon-ing a heading is a presentation detail with no
// sentence behind it yet. group-nav creates one with the name it was given.
navHeadingsRouter.patch("/:id", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireOwnerOrAdmin(req, res)) return;
    const parsed = UpdateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: invalidBodyMessage(parsed.error.issues), details: parsed.error.issues } });
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

// AI-REACH: ungroup-nav empties a heading, which is the ask ("take them back
// out"). Removing the empty label itself has never been asked for in words.
navHeadingsRouter.delete("/:id", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireOwnerOrAdmin(req, res)) return;
    await deleteNavHeading(req.tenant!.org.id, req.params.id!);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// AI-ACTION: core-presentation:group-nav
navHeadingsRouter.post("/:id/members", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!(await requireCapability(req, res, "core-presentation:group-nav"))) return;
    const parsed = MemberBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: invalidBodyMessage(parsed.error.issues), details: parsed.error.issues } });
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
// AI-ACTION: core-presentation:ungroup-nav
navHeadingsRouter.delete(
  "/members/:targetKind/:targetId",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      if (!(await requireCapability(req, res, "core-presentation:ungroup-nav"))) return;
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
