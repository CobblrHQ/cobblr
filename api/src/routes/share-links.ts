// Sharing part of a workspace (docs/design-decisions/share-spaces.md).
//
// Two kinds of door. A workspace's owners and admins manage its shares under
// /orgs/:slug/share-links (Settings → Sharing). Another Cobblr reaches this one
// under /share-links: an invite is read and claimed with its code, and once
// paired every change arrives signed with the link's key.

import { cloudUrl, inviteLinks, inviteDestinations } from "../platform/cloud.js";
import { hasAuthEmailSender } from "../platform/hosted-seams.js";
import { inviteToShare } from "../platform/share-invite.js";
import { inviteSaid } from "../platform/share-invite-email.js";
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { readScope, readVisibility } from "@cobblr/platform-contract/share-scope";
import { listKindsForOrg } from "../platform/entities.js";
import { gatedFields, previewScope } from "../platform/scope-eval.js";
import { mirrorAndDeliverNow } from "../platform/share-mirror.js";
import { sharePerson } from "../platform/share-person.js";
import { shareTargets, sharesOfRecord, sharesOfCollection } from "../platform/share-picks.js";
import { listAdditions } from "../platform/share-additions.js";
import { publicPageFieldChoices, recordPublicPages } from "../platform/public-page.js";
import { copyNotes } from "../platform/share-edits.js";
import { endShareView, mintShareView, renewShareView, requestShareView } from "../platform/share-view.js";
import { decideShareEdit, describeShareEdits, listShareEdits, readEditMode } from "../platform/share-edits.js";
import { requireRole } from "../auth/capability.js";
import { withTenant } from "../middleware/tenant.js";
import { makeIpLimiter, overLimit, rateLimited } from "../platform/ip-limiter.js";
import { publicOrigin } from "./edge.js";
import {
  ShareInviteError,
  acceptShareInvite,
  createShareInvite,
  claimShareInvite,
  decodeInvite,
  hereUrl,
  listShareLinks,
  previewInvite,
  readInvite,
  revokeShareLink,
} from "../platform/share-links.js";
import { ShareApplyError, isOwnLink, applyShareOps, flushShareLinkNow, getShareLink, verifyShareRequest } from "../platform/share-sync.js";
import { listOffers, offerTargets, receivedOffer, sendBack, withdrawOffer } from "../platform/share-offers.js";

import { ownConnections, receiveConnectedSend } from "../platform/record-send-connected.js";
import { SendError, requireSendToken } from "../platform/record-send.js";
import { kindHoldable, shareRefusal } from "../platform/kind-writer.js";

export const shareLinksOrgRouter = Router();
export const shareLinksRouter = Router();

const bad = (res: Response, status: number, code: string, message: string) => void res.status(status).json({ error: { code, message } });

// UI-REACH: Settings → Sharing
// AI-REACH: exempt — managing who a workspace is shared with is a person's decision in settings, never an assistant's.
shareLinksOrgRouter.get("/:slug/share-links", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin")) return;
    const org = await meta.selectFrom("orgs").select("kind").where("id", "=", req.tenant!.org.id).executeTakeFirst();
    res.json({ items: await listShareLinks(req.tenant!.org.id), kind: org?.kind ?? "workspace" });
  } catch (err) {
    next(err);
  }
});

// UI-REACH: Send to another workspace and Settings → Sharing
// AI-REACH: exempt — personal pairing approval; send_targets exposes approved destinations to the assistant.
shareLinksOrgRouter.get("/:slug/own-connections", requireAuth, withTenant, async (req, res, next) => {
  try {
    const here = hereUrl(publicOrigin(req));
    const destinations = inviteDestinations(here).map((d, index) => ({index, label: d.label, note: d.note, cloud: d.origin === cloudUrl()}));
    res.json({items: await ownConnections(req.tenant!.org.id, req.session!.id), destinations: destinations.sort((a,b) => Number(b.cloud) - Number(a.cloud))});
  } catch (err) {if (err instanceof SendError) return bad(res, 409, "connection_refused", err.message); next(err);}
});

const CreateBody = z.object({
  purpose: z.literal("own").optional(),
  label: z.string().max(120).default(""),
  /** Their email: the invite is bound to it and, with outgoing mail, sent there. */
  email: z.union([z.string().trim().toLowerCase().email().max(254), z.literal("")]).optional(),
  /** Which of the places an invite can open the owner chose (destinations). */
  where: z.number().int().min(0).max(50).optional(),
  collection: z.object({ kind: z.string().min(1), ids: z.array(z.string().uuid()).max(5000).optional() }).optional(),
});

// UI-REACH: the share page (a list's, a selection's or a record's Share) and Settings → Sharing
// AI-REACH: platform:share-with — Cobb invites by email through the share action
shareLinksOrgRouter.post("/:slug/share-links", requireAuth, withTenant, async (req, res, next) => {
  try {
    const body = CreateBody.safeParse(req.body ?? {});
    if (!body.success) return bad(res, 400, "bad_body", body.error.issues[0]?.message ?? "bad body");
    if (!requireRole(req, res, ...(body.data.purpose === "own" ? ["guest"] as const : ["owner", "admin"] as const))) return;
    if (body.data.purpose === "own") {
      await requireSendToken();
      const made = await createShareInvite({orgId: req.tenant!.org.id, userId: req.session!.id, here: hereUrl(publicOrigin(req)), label: "", purpose: "own"});
      const links = inviteLinks(hereUrl(publicOrigin(req)), made.token);
      const link = body.data.where === undefined ? [...links].sort((a,b) => Number(b.origin === cloudUrl()) - Number(a.origin === cloudUrl()))[0] : links[body.data.where];
      if (!link) throw new ShareInviteError(400, "Choose one of this Cobblr's configured destinations.");
      res.status(201).json({id: made.linkId, invite_url: link.url, expires_at: made.expiresAt, links});
      return;
    }
    if (body.data.collection && !(await listKindsForOrg(req.tenant!.org.id)).some((k) => k.id === body.data.collection!.kind)) return bad(res, 400, "bad_collection", "That collection is not in this workspace.");
    const made = await inviteToShare({ orgId: req.tenant!.org.id, userId: req.session!.id, here: hereUrl(publicOrigin(req)), email: body.data.email || null, label: body.data.label, where: body.data.where, collection: body.data.collection });
    res.status(201).json({ id: made.linkId, invite_url: made.url, expires_at: made.expiresAt, links: made.links, email: made.email, mail: made.mail, said: inviteSaid(made) });
  } catch (err) {
    if (err instanceof Error && /cannot be shared|does not know its own address/.test(err.message)) return bad(res, 409, "cannot_share", err.message);
    next(err);
  }
});

// Where an invite can open ("Where is their Cobblr?") and whether this Cobblr
// can email one, so the share page shows both before anything is made.
// UI-REACH: the share page and Settings → Sharing
// AI-REACH: exempt — a form's choices; the share action reads the same places itself.
shareLinksOrgRouter.get("/:slug/share-links/destinations", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin")) return;
    const here = hereUrl(publicOrigin(req));
    res.json({ destinations: here ? inviteDestinations(here).map((d) => ({ label: d.label, note: d.note })) : [], can_email: hasAuthEmailSender() });
  } catch (err) {
    next(err);
  }
});

// UI-REACH: Settings → Sharing ("Sync now")
// AI-REACH: exempt — a retry button for a person watching a share's sync.
shareLinksOrgRouter.post("/:slug/share-links/:id/sync", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin")) return;
    const link = await getShareLink(String(req.params.id));
    if (!link || link.org_id !== req.tenant!.org.id) return bad(res, 404, "not_found", "No such share.");
    // Sync now sends what the owner has now: a mirror pass first (waiting
    // out one already running), then the outbox, rather than only what an
    // earlier pass already queued.
    const r = link.side === "owner" && !isOwnLink(link) ? await mirrorAndDeliverNow(link.id) : await flushShareLinkNow(link.id);
    const left = await meta.selectFrom("share_outbox").select((eb) => eb.fn.countAll<string>().as("n")).where("link_id", "=", link.id).where("sent_at", "is", null).executeTakeFirst();
    res.json({ sent: r.sent, error: r.error, waiting: Number(left?.n ?? 0) });
  } catch (err) {
    next(err);
  }
});

// UI-REACH: Settings → Sharing ("End this share" / "Leave")
// AI-REACH: exempt — ending a share removes the other person's copy; a person's decision.
shareLinksOrgRouter.post("/:slug/share-links/:id/revoke", requireAuth, withTenant, async (req, res, next) => {
  try {
    const link = await getShareLink(String(req.params.id));
    if (link && isOwnLink(link)) {
      if (link.org_id !== req.tenant!.org.id || link.created_by !== req.session!.id) return bad(res, 403, "not_yours", "Only the account that approved this connection can revoke it.");
    } else if (!requireRole(req, res, "owner", "admin")) return;
    const ok = await revokeShareLink(req.tenant!.org.id, String(req.params.id));
    if (!ok) return bad(res, 404, "not_found", "No such share, or it has already ended.");
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const AcceptBody = z.object({ invite: z.string().min(8).max(4000), target_org: z.string().uuid().optional() });

// UI-REACH: /share/join (the invite page, before Accept)
// AI-REACH: exempt — the invite page reads who is sharing before its person decides.
shareLinksRouter.post("/share-links/preview", requireAuth, async (req, res, next) => {
  try {
    const body = AcceptBody.safeParse(req.body ?? {});
    if (!body.success) return bad(res, 400, "bad_body", "invite is required");
    const token = decodeInvite(body.data.invite);
    if (!token) return bad(res, 400, "bad_invite", "That invite link is damaged. Ask for a new one.");
    const r = await readInvite(token, hereUrl(publicOrigin(req) || undefined));
    res.json({ owner_name: r.preview.owner_name, workspace_name: r.preview.workspace_name, for_email: r.preview.for_email ?? null, purpose: r.preview.purpose ?? null, from_host: r.local ? null : new URL(r.ownerUrl).host });
  } catch (err) {
    if (err instanceof ShareInviteError) return bad(res, err.status, "invite_refused", err.message);
    next(err);
  }
});

// UI-REACH: /share/join (the invite page)
// AI-REACH: exempt — accepting an invite is the person's own act on their own Cobblr.
shareLinksRouter.post("/share-links/accept", requireAuth, async (req, res, next) => {
  try {
    const body = AcceptBody.safeParse(req.body ?? {});
    if (!body.success) return bad(res, 400, "bad_body", "invite is required");
    const token = decodeInvite(body.data.invite);
    if (!token) return bad(res, 400, "bad_invite", "That invite link is damaged. Ask for a new one.");
    if (token.p === "own") await requireSendToken();
    const made = await acceptShareInvite({ userId: req.session!.id, token, here: hereUrl(publicOrigin(req)), targetOrg: body.data.target_org });
    res.status(201).json({ org_id: made.orgId, slug: made.slug });
  } catch (err) {
    if (err instanceof ShareInviteError) return bad(res, err.status, "invite_refused", err.message);
    next(err);
  }
});

// Another Cobblr asks what an invite is, before its person accepts. Public: it
// answers only who shares and from which workspace, and only to the code.
const inviteLimiter = makeIpLimiter(60_000, 30);
// AI-REACH: exempt — spoken by another Cobblr, never by a person or the assistant.
// UI-REACH: spoken by another Cobblr
shareLinksRouter.get("/share-links/invite/:code", async (req, res, next) => {
  if (overLimit(inviteLimiter, req)) return void rateLimited(res);
  try {
    const p = await previewInvite(String(req.params.code));
    if (!p) return bad(res, 404, "invite_unusable", "That invite is used, expired or was withdrawn.");
    res.json(p);
  } catch (err) {
    next(err);
  }
});

const ClaimBody = z.object({
  purpose: z.literal("own").optional(),
  share_org_id: z.string().uuid().optional(),
  code: z.string().min(8).max(200),
  share_url: z.string().max(500),
  share_link_id: z.string().uuid(),
  person_name: z.string().max(200),
  share_workspace_name: z.string().max(300),
  key_to_share: z.string().min(20).max(300),
  key_to_owner: z.string().min(20).max(300),
  person_email: z.string().max(320).nullish(),
  v: z.number().int().min(1),
});

// AI-REACH: exempt — spoken by another Cobblr, never by a person or the assistant.
// UI-REACH: spoken by another Cobblr
shareLinksRouter.post("/share-links/claim", async (req, res, next) => {
  if (overLimit(inviteLimiter, req)) return void rateLimited(res);
  try {
    const body = ClaimBody.safeParse(req.body ?? {});
    if (!body.success) return bad(res, 400, "bad_body", body.error.issues[0]?.message ?? "bad body");
    if (body.data.share_url && !/^https?:\/\/[^/]+$/.test(body.data.share_url.replace(/\/+$/, ""))) return bad(res, 400, "bad_body", "share_url must be an address");
    const got = await claimShareInvite({ ...body.data, share_url: body.data.share_url.replace(/\/+$/, "") });
    if (!got) return bad(res, 404, "invite_unusable", "That invite is used, expired or was withdrawn.");
    res.json(got);
  } catch (err) {
    if (err instanceof ShareInviteError) return bad(res, err.status, "invite_refused", err.message);
    next(err);
  }
});

// AI-REACH: exempt — spoken by another Cobblr, signed with the share's key.
// UI-REACH: spoken by another Cobblr
shareLinksRouter.post("/share-links/:id/ops", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const raw = (req as unknown as { rawBody?: string }).rawBody;
    const link = await verifyShareRequest({
      linkId: String(req.params.id),
      headers: req.headers as Record<string, string | undefined>,
      pathAndQuery: req.originalUrl,
      rawBody: raw,
    });
    res.json(await applyShareOps(link, JSON.parse((raw ?? "") || "{}")));
  } catch (err) {
    if (err instanceof ShareApplyError) return bad(res, err.status, err.code, err.message);
    next(err);
  }
});

// AI-REACH: exempt — signed transport between the workspaces a person approved.
// UI-REACH: spoken by another Cobblr
shareLinksRouter.post("/share-links/:id/own-send", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const raw = (req as unknown as {rawBody?: string}).rawBody;
    const link = await verifyShareRequest({linkId: String(req.params.id), headers: req.headers as Record<string, string | undefined>, pathAndQuery: req.originalUrl, rawBody: raw});
    res.json(await receiveConnectedSend(link, JSON.parse((raw ?? "") || "{}"), publicOrigin(req) || undefined));
  } catch (err) {
    if (err instanceof ShareApplyError) return bad(res, err.status, err.code, err.message);
    if (err instanceof SendError) return bad(res, 409, "send_refused", err.message);
    if (err instanceof z.ZodError) return bad(res, 409, "needs_update", "The Cobblrs cannot read this connected send. Update them, or use a send file.");
    next(err);
  }
});

// The share space's side of View as: the other side asks, signed with the
// link's key, and gets a read-only grant to look through it.
// AI-REACH: exempt — spoken by another Cobblr, signed with the share's key.
// UI-REACH: spoken by another Cobblr
shareLinksRouter.post("/share-links/:id/view", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const raw = (req as unknown as { rawBody?: string }).rawBody;
    const link = await verifyShareRequest({ linkId: String(req.params.id), headers: req.headers as Record<string, string | undefined>, pathAndQuery: req.originalUrl, rawBody: raw });
    const body = JSON.parse((raw ?? "") || "{}") as { viewer?: unknown };
    res.json(await mintShareView(link.id, typeof body.viewer === "string" ? body.viewer : link.peer_name));
  } catch (err) {
    if (err instanceof ShareApplyError) return bad(res, err.status, err.code, err.message);
    if (err instanceof Error && /ended|nobody/.test(err.message)) return bad(res, 409, "cannot_view", err.message);
    next(err);
  }
});

// UI-REACH: the View as banner's Exit
// AI-REACH: exempt — ends the read-only view a person opened; nothing for an assistant.
shareLinksRouter.post("/share-view/end", requireAuth, async (req, res, next) => {
  try {
    const view = req.session!.share_view;
    if (!view) return bad(res, 400, "not_viewing", "This is not a view.");
    await endShareView(view.session_id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// UI-REACH: the View as banner (renews quietly while the view is open)
// AI-REACH: exempt — keeps a person's read-only view of their own share open; nothing for an assistant.
shareLinksRouter.post("/share-view/renew", requireAuth, async (req, res, next) => {
  try {
    const view = req.session!.share_view;
    if (!view) return bad(res, 400, "not_viewing", "This is not a view.");
    res.json(await renewShareView(view.session_id));
  } catch (err) {
    if (err instanceof Error && /ended/.test(err.message)) return bad(res, 401, "share_view_ended", err.message);
    next(err);
  }
});

// UI-REACH: Settings → Sharing ("View as <them>")
// AI-REACH: exempt — a person opens a read-only view in a new tab; an assistant has nothing to look through.
shareLinksOrgRouter.post("/:slug/share-links/:id/view-as", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin")) return;
    const l = await ownerLink(req.tenant!.org.id, String(req.params.id));
    if (!l) return bad(res, 404, "not_found", "No such share.");
    res.json(await requestShareView(l.id, req.session!.display_name || null));
  } catch (err) {
    if (err instanceof Error && !(err as { status?: number }).status) return bad(res, 409, "cannot_view", err.message);
    next(err);
  }
});

// UI-REACH: Settings → Sharing (Handed over), and every record's "Give to…"
// AI-REACH: exempt — a read for the hand-over list and the Give-to picker; the hand-over itself is platform:offer-to.
shareLinksOrgRouter.get("/:slug/share-offers", requireAuth, withTenant, async (req, res, next) => {
  try {
    const orgId = req.tenant!.org.id;
    res.json({ items: await listOffers(orgId, req.session!.id), targets: await offerTargets(orgId, req.session!.id) });
  } catch (err) {
    next(err);
  }
});

// UI-REACH: Settings → Sharing (Withdraw), and a record that is offered
// AI-REACH: exempt — taking back an offer made to a person is the giver's own act in the hand-over list.
shareLinksOrgRouter.post("/:slug/share-offers/:id/withdraw", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin", "editor", "member")) return;
    const r = await withdrawOffer(req.tenant!.org.id, String(req.params.id), req.session!.id);
    if (!r.ok) return bad(res, 409, "cannot_withdraw", r.error);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// UI-REACH: Settings → Sharing (Send back)
// AI-REACH: exempt — giving a thing back to the person it came from is a person's decision in the hand-over list.
shareLinksOrgRouter.post("/:slug/share-offers/:id/send-back", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin", "editor", "member")) return;
    const r = await sendBack(req.tenant!.org.id, String(req.params.id), req.session!.id);
    if (!r.ok) return bad(res, 409, "cannot_send_back", r.error);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// UI-REACH: a record taken from someone's share ("Send back to <them>", beside Shared with)
// AI-REACH: exempt — a read the record page makes to offer Send back; the send itself is the route above.
shareLinksOrgRouter.get("/:slug/received-from", requireAuth, withTenant, async (req, res, next) => {
  try {
    // By id alone: a record's page may name it by its collection or its module.
    const id = String(req.query.id ?? "");
    if (!id) return bad(res, 400, "bad_query", "id is required");
    res.json({ received: await receivedOffer(req.tenant!.org.id, id) });
  } catch (err) {
    next(err);
  }
});

const ScopeBody = z.object({ scope: z.unknown(), link_id: z.string().uuid().optional() });

// UI-REACH: Settings → Sharing ("What's shared": the live count while a scope is built)
// AI-REACH: exempt — a read the scope editor makes while a person picks what to share.
shareLinksOrgRouter.post("/:slug/scope-preview", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin")) return;
    const body = ScopeBody.safeParse(req.body ?? {});
    if (!body.success) return bad(res, 400, "bad_body", "scope is required");
    // A share's preview counts what is lent to its person too.
    const link = body.data.link_id ? await ownerLink(req.tenant!.org.id, body.data.link_id) : null;
    const person = link ? await sharePerson(link.id) : null;
    res.json(await previewScope(req.tenant!.org.id, readScope(body.data.scope), person?.id ?? null));
  } catch (err) {
    next(err);
  }
});

// UI-REACH: every record page ("Share with…", "Shared with <them>")
// AI-REACH: platform:share-with / platform:stop-sharing (the same change, as actions)
shareLinksOrgRouter.get("/:slug/record-shares", requireAuth, withTenant, async (req, res, next) => {
  try {
    // Without a record: only who this workspace shares with (a list's
    // selection bar asks that).
    const kind = String(req.query.kind ?? "");
    const id = String(req.query.id ?? "");
    // A kind no share space can hold is not offered at all: no Share on its
    // records, rather than a share accepted and never delivered (#5911).
    if (kind && !(await kindHoldable(req.tenant!.org.id, kind))) {
      res.json({ targets: [], can_share: false, shared_with: [] });
      return;
    }
    const targets = await shareTargets(req.tenant!.org.id);
    const org = await meta.selectFrom("orgs").select("kind").where("id", "=", req.tenant!.org.id).executeTakeFirst();
    const can_share = !!org && org.kind !== "share" && roleSatisfies(req.tenant!.role, ["owner", "admin"]);
    res.json({ targets, can_share, shared_with: targets.length && kind ? (id ? await sharesOfRecord(req.tenant!.org.id, kind, id) : await sharesOfCollection(req.tenant!.org.id, kind)) : [] });
  } catch (err) {
    next(err);
  }
});

// UI-REACH: /suggestions, and every record page ("2 suggested edits by Vince")
// AI-REACH: exempt — a read; the assistant reaches it as list_suggestions, and decides with platform:accept-suggestions / reject-suggestions / take-additions / leave-additions
shareLinksOrgRouter.get("/:slug/suggestions", requireAuth, withTenant, async (req, res, next) => {
  try {
    const kind = String(req.query.kind ?? "");
    const id = String(req.query.id ?? "");
    const rows = await listShareEdits(req.tenant!.org.id, { ...(kind && id ? { kind, id } : {}), open: req.query.all !== "1" }, 500);
    res.json({ items: await describeShareEdits(req.tenant!.org.id, rows), additions: kind && id ? [] : await listAdditions(req.tenant!.org.id, req.query.all !== "1") });
  } catch (err) {
    next(err);
  }
});

// UI-REACH: every record page in a share space ("changed by <owner> since you edited")
// AI-REACH: exempt — a note on the friend's own copy, read by the page that shows it
shareLinksOrgRouter.get("/:slug/copy-notes", requireAuth, withTenant, async (req, res, next) => {
  try {
    const kind = String(req.query.kind ?? "");
    const id = String(req.query.id ?? "");
    if (!kind || !id) return bad(res, 400, "bad_query", "kind and id are required");
    res.json(await copyNotes(req.tenant!.org.id, kind, id));
  } catch (err) {
    next(err);
  }
});

// UI-REACH: Settings → Sharing → Public pages (a page's "What it shows": the restricted fields)
// AI-REACH: exempt — a read for the scope editor's field list
shareLinksOrgRouter.get("/:slug/scope-fields", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin")) return;
    res.json({ gated_fields: await gatedFields(req.tenant!.org.id) });
  } catch (err) {
    next(err);
  }
});

// The fields a public page's records can show, by the words a person reads,
// for choosing which ones it shows (#4502, Tier A).
// UI-REACH: Settings → Sharing → Public pages (a page's Look)
// AI-REACH: exempt — a read for choosing what a public page shows
shareLinksOrgRouter.get("/:slug/public-page-fields/:id", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin")) return;
    res.json({ fields: await publicPageFieldChoices(req.tenant!.org.id, String(req.params.id)) });
  } catch (err) {
    next(err);
  }
});

// UI-REACH: a record's header (the "Public" chip)
// AI-REACH: exempt a header chip saying a record is on a public page; the pages themselves are read and changed in Settings, Sharing
shareLinksOrgRouter.get("/:slug/public-status/:id", requireAuth, withTenant, async (req, res, next) => {
  try {
    res.json({ pages: await recordPublicPages(req.tenant!.org.id, String(req.params.id)) });
  } catch (err) {
    next(err);
  }
});

async function ownerLink(orgId: string, id: string) {
  const l = await meta.selectFrom("share_links").select(["id", "org_id", "side", "status", "settings"]).where("id", "=", id).executeTakeFirst();
  return l && !isOwnLink(l) && l.org_id === orgId && l.side === "owner" && l.status !== "revoked" ? l : null;
}

// UI-REACH: Settings → Sharing (a share's "What's shared")
// AI-REACH: exempt — what is shared with a person is decided by a person in settings, never an assistant.
shareLinksOrgRouter.get("/:slug/share-links/:id/what", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin")) return;
    const l = await ownerLink(req.tenant!.org.id, String(req.params.id));
    if (!l) return bad(res, 404, "not_found", "No such share.");
    const s = (l.settings ?? {}) as Record<string, unknown>;
    res.json({ scope: readScope(s.scope), visibility: readVisibility(s.visibility), edit_mode: readEditMode(s), person: await sharePerson(l.id), gated_fields: await gatedFields(req.tenant!.org.id) });
  } catch (err) {
    next(err);
  }
});

const WhatBody = z.object({ scope: z.unknown(), visibility: z.unknown(), edit_mode: z.enum(["suggest", "direct"]).optional() });

// UI-REACH: Settings → Sharing (a share's "What's shared", Save)
// AI-REACH: exempt — what is shared with a person is decided by a person in settings, never an assistant.
shareLinksOrgRouter.put("/:slug/share-links/:id/what", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin")) return;
    const l = await ownerLink(req.tenant!.org.id, String(req.params.id));
    if (!l) return bad(res, 404, "not_found", "No such share.");
    const body = WhatBody.safeParse(req.body ?? {});
    if (!body.success) return bad(res, 400, "bad_body", "scope and visibility are required");
    const scope = readScope(body.data.scope);
    const visibility = readVisibility(body.data.visibility);
    const edit_mode = body.data.edit_mode ?? readEditMode(l.settings);
    const refused = await shareRefusal(req.tenant!.org.id, [...scope.rules.flatMap((r) => (r.type === "collection" ? [r.entity_kind] : [])), ...scope.picks.map((p) => p.entity_kind)]);
    if (refused) return bad(res, 409, "not_holdable", refused);
    await meta
      .updateTable("share_links")
      .set({ settings: sql`coalesce(settings, '{}'::jsonb) || ${JSON.stringify({ scope, visibility, edit_mode })}::jsonb` as never })
      .where("id", "=", l.id)
      .execute();
    // What is shared changed: mirrored and delivered before the owner is
    // answered, so a price turned off or a record taken out is out of the
    // friend's copy when this says so (share-mirror.ts mirrorAndDeliverNow).
    await meta.updateTable("share_links").set({ mirror_due_at: new Date() }).where("id", "=", l.id).execute();
    const sync = await mirrorAndDeliverNow(l.id).catch((err) => {
      console.error(`[share] mirror of ${l.id} failed:`, err);
      return { delivered: false, error: err instanceof Error ? err.message : String(err) };
    });
    res.json({ scope, visibility, edit_mode, delivered: sync.delivered, preview: await previewScope(req.tenant!.org.id, scope, (await sharePerson(l.id))?.id ?? null) });
  } catch (err) {
    next(err);
  }
});

// UI-REACH: Settings → Sharing (a share's "Their edits")
// AI-REACH: exempt — phase 4 of #4627 adds the review and accept/reject actions an assistant calls; this is the settings list.
shareLinksOrgRouter.get("/:slug/share-links/:id/edits", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin")) return;
    const l = await ownerLink(req.tenant!.org.id, String(req.params.id));
    if (!l) return bad(res, 404, "not_found", "No such share.");
    res.json({ items: await describeShareEdits(req.tenant!.org.id, await listShareEdits(req.tenant!.org.id, { linkId: l.id })) });
  } catch (err) {
    next(err);
  }
});

// UI-REACH: Settings → Sharing (a share's "Their edits": Accept, Reject, Undo)
// AI-REACH: exempt — phase 4 of #4627 adds the accept/reject actions an assistant calls; these are a person's buttons.
shareLinksOrgRouter.post("/:slug/share-links/:id/edits/:editId/:decision", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin")) return;
    const l = await ownerLink(req.tenant!.org.id, String(req.params.id));
    if (!l) return bad(res, 404, "not_found", "No such share.");
    const decision = String(req.params.decision);
    if (decision !== "accept" && decision !== "reject" && decision !== "undo") return bad(res, 400, "bad_decision", "accept, reject or undo");
    const r = await decideShareEdit(req.tenant!.org.id, req.session!.id, String(req.params.editId), decision);
    if (!r.ok) return bad(res, 409, "cannot", r.error);
    res.json({ status: r.status });
  } catch (err) {
    next(err);
  }
});
