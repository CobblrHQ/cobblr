// /orgs/:slug/people — the workspace's People list (#3787).
//
// Who a record can belong to: every member, plus anyone added by name. Any
// member may add someone or fix a name they typed (a guest may only look);
// inviting someone on the list to become a member is the admin's, as every
// invite is. A member's own name is their account's, so it is not edited here.
import { handOffPersonThings, invitePerson } from "../platform/people-ops.js";
import { linkOrigin } from "../platform/link-origin.js";
import { Router } from "express";
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { createPerson, listPeople, personForUser, updatePerson } from "../platform/people.js";
import { thingsOfPerson } from "../platform/person-things.js";
import { accountEmailFor } from "../platform/account-emails.js";
import { invalidBodyMessage } from "@cobblr/platform-contract/invalid-body";

export const peopleRouter = Router({ mergeParams: true });

// role-gate: exact — inviting someone and handing on their things is
// governance, the members page's bar (assertAdmin), not an action an editor's
// rank reaches.
const isAdmin = (role: string | undefined) => role === "owner" || role === "admin";

peopleRouter.get("/", requireAuth, withTenant, async (req, res, next) => {
  try {
    const viewer = { id: req.session!.id, role: req.tenant!.role };
    // `you` marks the asker's own entry, so "email me" names a person (#8331).
    res.json({ items: (await listPeople(req.tenant!.org.id)).map((p) => (p.user_id ? { ...p, email: accountEmailFor(viewer, p.user_id, p.email), ...(p.user_id === viewer.id ? { you: true } : {}) } : p)) });
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
    const shownPerson = person.user_id ? { ...person, email: accountEmailFor({ id: req.session!.id, role: req.tenant!.role }, person.user_id, person.email) } : person;
    res.json({ person: shownPerson, groups, count: groups.reduce((n, g) => n + g.items.length, 0) });
  } catch (err) {
    next(err);
  }
});

const PersonBody = z.object({
  name: z.string().max(120),
  email: z.string().max(255).nullish(),
  phone: z.string().max(40).nullish(),
});

// AI-ACTION: platform:add-person
peopleRouter.post("/", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!(await requireCapability(req, res, "platform:add-person"))) return;
    const parsed = PersonBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "A person needs a name.", details: parsed.error.issues } });
      return;
    }
    const r = await createPerson(req.tenant!.org.id, req.session!.id, parsed.data);
    if (!r.ok) {
      res.status(r.status).json({ error: { code: r.code, message: r.message }, ...(r.person ? { person: r.person } : {}) });
      return;
    }
    res.status(201).json(r.person);
  } catch (err) {
    next(err);
  }
});

// AI-ACTION: platform:edit-person
peopleRouter.patch("/:id", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!(await requireCapability(req, res, "platform:edit-person"))) return;
    const parsed = PersonBody.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: invalidBodyMessage(parsed.error.issues), details: parsed.error.issues } });
      return;
    }
    const r = await updatePerson(req.tenant!.org.id, req.params.id!, parsed.data);
    if (!r.ok) {
      res.status(r.status).json({ error: { code: r.code, message: r.message } });
      return;
    }
    res.json(r.person);
  } catch (err) {
    next(err);
  }
});

// Invite someone on the list to become a member. Accepting ties their entry to
// the account they make, so the things already theirs stay theirs.
const InviteBody = z.object({ email: z.string().trim().email().max(255).optional() });
// AI-REACH: human-only: grants workspace access. Cobb may explain it or open
// this screen filled in; the person presses Invite (human-only.ts).
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
    const r = await invitePerson({ orgId: req.tenant!.org.id, orgName: req.tenant!.org.name, inviterId: req.session!.id, personId: String(req.params.id), email: parsed.data.email ?? null, origin: linkOrigin(req) });
    if (!r.ok) {
      res.status(r.status).json({ error: { code: r.code, message: r.message } });
      return;
    }
    res.status(201).json({ ...r.invite, emailed: r.emailed });
  } catch (err) {
    next(err);
  }
});

// Hand everything one person owns to someone else on the list: what a member
// who left kept, passed on now. The same hand-off removing a member offers.
const HandOffBody = z.object({ to: z.string().uuid() });
// AI-REACH: human-only: hands everything one person owns to another. Cobb
// may explain it or open this screen; the person presses Hand off.
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
    const r = await handOffPersonThings({ orgId: req.tenant!.org.id, userId: req.session!.id, fromId: String(req.params.id), toId: parsed.data.to });
    if (!r.ok) {
      res.status(r.status).json({ error: { code: r.code, message: r.message } });
      return;
    }
    const { ok: _ok, ...body } = r;
    res.json(body);
  } catch (err) {
    next(err);
  }
});

