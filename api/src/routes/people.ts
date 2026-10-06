// /orgs/:slug/people — the workspace's People list (#3787).
//
// Who a record can belong to: every member, plus anyone added by name. Any
// member may add someone or fix a name they typed (a guest may only look);
// inviting someone on the list to become a member is the admin's, as every
// invite is. A member's own name is their account's, so it is not edited here.
import { Router } from "express";
import { z } from "zod";
import { meta } from "../db/meta.js";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import * as activity from "../platform/activity.js";
import { hasAuthEmailSender } from "../platform/hosted-seams.js";
import { addPerson, clearPeopleCache, listPeople, personForUser } from "../platform/people.js";
import { handOffThings, thingsOfPerson } from "../platform/person-things.js";
import { deliverInvite, newInviteToken } from "./members.js";

export const peopleRouter = Router({ mergeParams: true });

const canWrite = (role: string | undefined) => !!role && role !== "guest";
// role-gate: exact — inviting someone and handing on their things is
// governance, the members page's bar (assertAdmin), not an action an editor's
// rank reaches.
const isAdmin = (role: string | undefined) => role === "owner" || role === "admin";

peopleRouter.get("/", requireAuth, withTenant, async (req, res, next) => {
  try {
    res.json({ items: await listPeople(req.tenant!.org.id) });
  } catch (err) {
    next(err);
  }
});

// GET /people/things?person=<id | name | me> — everything that belongs to one
// person, across every collection. By name so the assistant can answer "what
// does Alex own" from what was said; "me" is the viewer's own entry (My things).
peopleRouter.get("/things", requireAuth, withTenant, async (req, res, next) => {
  try {
    const orgId = req.tenant!.org.id;
    const asked = String(req.query.person ?? "").trim();
    if (!asked) {
      res.status(400).json({ error: { code: "missing_person", message: "Say whose things: a name, or me." } });
      return;
    }
    const all = await listPeople(orgId, { includeArchived: true });
    let person = all.find((p) => p.id === asked);
    if (!person && asked.toLowerCase() === "me") {
      const mine = await personForUser(orgId, req.session!.id);
      person = (await listPeople(orgId, { includeArchived: true })).find((p) => p.id === mine);
    }
    if (!person) {
      const want = asked.toLowerCase();
      const exact = all.filter((p) => p.name.toLowerCase() === want);
      const partial = exact.length > 0 ? exact : all.filter((p) => p.name.toLowerCase().includes(want));
      if (partial.length > 1) {
        res.status(409).json({
          error: { code: "ambiguous_person", message: `More than one person matches "${asked}": ${partial.map((p) => p.name).join(", ")}.` },
          matches: partial.map((p) => ({ id: p.id, name: p.name })),
        });
        return;
      }
      person = partial[0];
    }
    if (!person) {
      res.status(404).json({ error: { code: "no_such_person", message: `Nobody called "${asked}" is on this workspace's People list.` } });
      return;
    }
    const groups = await thingsOfPerson(orgId, person.id, { userId: req.session!.id, role: req.tenant!.role });
    res.json({ person, groups, count: groups.reduce((n, g) => n + g.items.length, 0) });
  } catch (err) {
    next(err);
  }
});

const PersonBody = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(255).optional().or(z.literal("")),
});

peopleRouter.post("/", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!canWrite(req.tenant!.role)) {
      res.status(403).json({ error: { code: "forbidden", message: "A guest can see the people here but not add anyone." } });
      return;
    }
    const parsed = PersonBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "A person needs a name.", details: parsed.error.issues } });
      return;
    }
    const orgId = req.tenant!.org.id;
    const same = (await listPeople(orgId)).find((p) => p.name.toLowerCase() === parsed.data.name.toLowerCase());
    if (same) {
      res.status(409).json({ error: { code: "already_listed", message: `${same.name} is already on the list.` }, person: same });
      return;
    }
    const person = await addPerson(orgId, { name: parsed.data.name, email: parsed.data.email || null });
    await activity.log({
      orgId,
      userId: req.session!.id,
      action: "person_added",
      ref: { module: null, entityType: "person", entityId: person.id },
      diff: { name: person.name },
    });
    res.status(201).json(person);
  } catch (err) {
    next(err);
  }
});

peopleRouter.patch("/:id", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!canWrite(req.tenant!.role)) {
      res.status(403).json({ error: { code: "forbidden", message: "A guest can see the people here but not change them." } });
      return;
    }
    const parsed = PersonBody.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad request body", details: parsed.error.issues } });
      return;
    }
    const orgId = req.tenant!.org.id;
    const row = await meta
      .selectFrom("workspace_people")
      .select(["id", "user_id"])
      .where("id", "=", req.params.id!)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "No such person here." } });
      return;
    }
    if (row.user_id && parsed.data.name !== undefined) {
      res.status(409).json({ error: { code: "member_name", message: "A member's name is their account's; they change it in their own settings." } });
      return;
    }
    await meta
      .updateTable("workspace_people")
      .set({
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.email !== undefined ? { email: parsed.data.email ? parsed.data.email.toLowerCase() : null } : {}),
      })
      .where("id", "=", row.id)
      .execute();
    clearPeopleCache(orgId);
    res.json((await listPeople(orgId)).find((p) => p.id === row.id));
  } catch (err) {
    next(err);
  }
});

// Invite someone on the list to become a member. Accepting ties their entry to
// the account they make, so the things already theirs stay theirs.
const InviteBody = z.object({ email: z.string().trim().email().max(255).optional() });
peopleRouter.post("/:id/invite", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!isAdmin(req.tenant!.role)) {
      res.status(403).json({ error: { code: "forbidden", message: "Workspace owners/admins only." } });
      return;
    }
    const parsed = InviteBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "That email does not look right.", details: parsed.error.issues } });
      return;
    }
    const orgId = req.tenant!.org.id;
    const person = (await listPeople(orgId)).find((p) => p.id === req.params.id);
    if (!person) {
      res.status(404).json({ error: { code: "not_found", message: "No such person here." } });
      return;
    }
    if (person.member) {
      res.status(409).json({ error: { code: "already_member", message: `${person.name} is already a member.` } });
      return;
    }
    const email = parsed.data.email?.toLowerCase() || person.email || null;
    if (email && email !== person.email) {
      await meta.updateTable("workspace_people").set({ email }).where("id", "=", person.id).execute();
      clearPeopleCache(orgId);
    }
    const token = newInviteToken();
    const expiresAt = new Date(Date.now() + 14 * 24 * 3600_000);
    const invite = await meta
      .insertInto("workspace_invites")
      .values({
        org_id: orgId,
        invited_by_user: req.session!.id,
        token,
        invited_email: email,
        role: "member",
        expires_at: expiresAt,
        person_id: person.id,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await activity.log({
      orgId,
      userId: req.session!.id,
      action: "invite_created",
      ref: { module: null, entityType: "invite", entityId: invite.id },
      diff: { role: "member", email, person: person.id },
    });
    if (email) {
      // DETACHED: the invite email; the invite exists and its link is shown to whoever made it
      void deliverInvite({
        req,
        email,
        token,
        role: "member",
        orgName: req.tenant!.org.name,
        inviterId: req.session!.id,
        inviteId: invite.id,
        expiresAt,
      }).catch((e) => console.error("[people] invite deliver failed:", (e as Error).message));
    }
    res.status(201).json({ ...invite, emailed: Boolean(email) && hasAuthEmailSender() });
  } catch (err) {
    next(err);
  }
});

// Hand everything one person owns to someone else on the list: what a member
// who left kept, passed on now. The same hand-off removing a member offers.
const HandOffBody = z.object({ to: z.string().uuid() });
peopleRouter.post("/:id/hand-off", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!isAdmin(req.tenant!.role)) {
      res.status(403).json({ error: { code: "forbidden", message: "Workspace owners/admins only." } });
      return;
    }
    const parsed = HandOffBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Say who to hand them to.", details: parsed.error.issues } });
      return;
    }
    const orgId = req.tenant!.org.id;
    const all = await listPeople(orgId, { includeArchived: true });
    const from = all.find((p) => p.id === req.params.id);
    const to = all.find((p) => p.id === parsed.data.to);
    if (!from || !to) {
      res.status(404).json({ error: { code: "not_found", message: "No such person here." } });
      return;
    }
    if (from.id === to.id) {
      res.status(400).json({ error: { code: "same_person", message: "They already own them." } });
      return;
    }
    const result = await handOffThings(orgId, from.id, to.id);
    await activity.log({
      orgId,
      userId: req.session!.id,
      action: "things_handed_off",
      ref: { module: null, entityType: "person", entityId: from.id },
      diff: { to: to.id, moved: result.moved, kept: result.kept.length },
    });
    res.json({ from, to, ...result });
  } catch (err) {
    next(err);
  }
});
