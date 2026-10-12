// Default-exported Router, mounted at
//   /api/v1/orgs/:slug/modules/core-documents/
// with requireAuth + withTenant already applied by the platform.
//
// The record's library panel reads one route, and it makes no outside call: what is
// linked and what was matched are in this workspace's own tables, put there
// in the background (../matching.ts). Find, Link and the thumbnail are the
// only routes that reach a library, each when a person asks.

import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { publicBaseUrl } from "@cobblr/platform-contract/public-url";
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { LIBRARY_ITEM_KIND, LIBRARY_LINK_REL, libraryTargetId } from "@cobblr/platform-contract/library";
import { roleSatisfies, type OrgRoleName } from "@cobblr/platform-contract/org-roles";
import type { CoreDocumentsDB } from "../db.js";
import { getOn, holdersOf, noteFacts, nudge, pushSetupOf, readFacts } from "../matching.js";
import { abilitiesOf, copyItem, LibraryRefusal, findFresh, healLinks, linkItem, systemsFor, unlinkItem } from "../service.js";
import { registerLibraryActions } from "./actions.js";

registerLibraryActions();

interface Tenant {
  org: { id: string; slug: string };
  role: OrgRoleName;
  db: unknown;
}
const tenantOf = (req: Request) => (req as unknown as { tenant: Tenant }).tenant;
const userOf = (req: Request) => (req as unknown as { session?: { id: string } }).session?.id ?? null;
const dbOf = (req: Request) => tenantOf(req).db as Kysely<CoreDocumentsDB>;

function handler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void fn(req, res).catch((err) => {
      if (err instanceof LibraryRefusal) {
        res.status(err.status).json({ error: { code: err.status === 403 ? "forbidden" : "library", message: err.message } });
        return;
      }
      next(err);
    });
  };
}

/** A read-only guest sees a record's library items and changes none of them. */
function requireRole(req: Request, res: Response, ...allowed: OrgRoleName[]): boolean {
  if (roleSatisfies(tenantOf(req).role, allowed)) return true;
  res.status(403).json({ error: { code: "forbidden", message: "Linking items from a library needs a member of this workspace." } });
  return false;
}

const record = (req: Request) => ({ kind: String(req.params.kind ?? ""), id: String(req.params.id ?? "") });
// The link written back into the outside document points at this instance,
// so it uses the instance's own public address when it has one.
const originOf = (req: Request) => {
  if (publicBaseUrl()) return publicBaseUrl();
  // HOST-OK: only when no public address is configured (a laptop, a rig).
  const host = req.get("x-forwarded-host") || req.get("host");
  return host ? `${req.get("x-forwarded-proto") || req.protocol}://${host}` : null;
};

const router = Router({ mergeParams: true });

/** The panel: what is linked, what was matched, and whether anything here can
 *  find documents at all. No outside call. */
router.get(
  "/records/:kind/:id",
  handler(async (req, res) => {
    const orgId = tenantOf(req).org.id;
    const userId = userOf(req);
    const r = record(req);
    const db = dbOf(req);
    const systems = await systemsFor(orgId, userId);
    const can = await abilitiesOf(orgId);
    // The pairing is the link; this table is its picture. A link taken away
    // anywhere else (the API, the assistant) is gone from the panel too.
    let rows = await db.selectFrom("core_documents_linked").selectAll().where("record_id", "=", r.id).orderBy("linked_at", "desc").execute();
    // Reconnecting a library makes a new connection: the links made through
    // the old one move to it here, so they read connected at once (#5876).
    if (rows.some((l) => !systems.some((s) => s.credentialId === l.connection_id)) && (await healLinks(orgId, db, userId, r, rows, systems)) > 0) {
      rows = await db.selectFrom("core_documents_linked").selectAll().where("record_id", "=", r.id).orderBy("linked_at", "desc").execute();
    }
    const live = rows.length
      ? new Set(
          (
            await platform().pairings.findByTargets({
              orgId,
              sourceKind: r.kind,
              targetKind: LIBRARY_ITEM_KIND,
              targetIds: rows.map((l) => libraryTargetId(l.connection_id, l.ref)),
              relationshipKind: LIBRARY_LINK_REL,
            })
          )
            .filter((p) => p.sourceId === r.id)
            .map((p) => p.targetId),
        )
      : new Set<string>();
    const linked = rows.filter((l) => live.has(libraryTargetId(l.connection_id, l.ref)));
    // What is true for THIS person (#5936): a library another member keeps to
    // themselves still works, it is only not theirs to ask; a copy kept in a
    // Vault is in the Vault of whoever asked for it.
    const holders = new Map((await holdersOf(orgId)).map((h) => [h.credentialId, h]));
    const othersLibrary = (id: string) => {
      const h = holders.get(id);
      return h && !h.shared && h.ownerUserId !== userId ? h.ownerUserId : null;
    };
    const names = await platform().accounts.displayNames(orgId, [
      ...new Set(linked.flatMap((l) => [othersLibrary(l.connection_id), l.copied_vault_file_id && l.copy_requested_by !== userId ? l.copy_requested_by : null].filter((x): x is string => !!x))),
    ]);
    const someone = (id: string | null) => (id ? (names[id] ?? "another member") : null);
    let suggestions = await db
      .selectFrom("core_documents_suggestions")
      .selectAll()
      .where("record_id", "=", r.id)
      .where("dismissed_at", "is", null)
      .where((eb) => eb.or([eb("for_user_id", "is", null), ...(userId ? [eb("for_user_id", "=", userId)] : [])]))
      .orderBy("score", "desc")
      .execute();
    // Only what this person's systems can still show them.
    const usable = new Set(systems.map((s) => s.credentialId));
    suggestions = suggestions.filter((s) => usable.has(s.connection_id));
    let known: { status: string; matched_at: Date | null; last_error: string | null } | undefined = await db
      .selectFrom("core_documents_records")
      .select(["status", "matched_at", "last_error"])
      .where("record_id", "=", r.id)
      .executeTakeFirst();
    // A record the background has not reached yet goes to the front of the
    // queue now: still no outside call on this page.
    if (!known && systems.length) {
      const facts = await readFacts(orgId, r.kind, r.id);
      if (facts && (await noteFacts(db, r.kind, r.id, facts))) {
        nudge(orgId);
        known = { status: "queued", matched_at: null, last_error: null };
      }
    }
    res.json({
      available: systems.length > 0,
      // What each library can do beyond find and get: a button for an
      // ability a library lacks is never drawn.
      systems: systems.map((s) => ({
        connection_id: s.credentialId,
        label: s.label,
        can_link_back: can.get(s.credentialId)?.link === true,
        can_copy: can.get(s.credentialId)?.copy === true,
        // How this library pushes a new item, when it can: the panel's setup.
        push_setup: pushSetupOf(s.provider),
      })),
      linked: linked.map((l) => ({
        connection_id: l.connection_id,
        connected: usable.has(l.connection_id),
        ref: l.ref,
        type: l.item_type,
        type_label: l.item_type_label,
        title: l.title,
        subtitle: l.subtitle,
        created: l.created,
        tags: l.tags,
        open_url: l.open_url,
        open_label: l.open_label,
        has_thumb: l.has_thumb,
        system: l.system_label,
        written_back: l.written_back,
        copied_at: l.copied_at?.toISOString() ?? null,
        copied_filename: l.copied_filename,
        // The local copy, so the record opens it without the library (#5873).
        copied_file_id: l.copied_file_id,
        // Only the person whose Vault it is gets the file; anyone else is told
        // whose it is.
        copied_vault_file_id: l.copy_requested_by === userId ? l.copied_vault_file_id : null,
        vault_of: l.copied_vault_file_id && l.copy_requested_by !== userId ? someone(l.copy_requested_by) : null,
        // Connected, and another member's own: not this person's to reconnect.
        library_of: usable.has(l.connection_id) ? null : someone(othersLibrary(l.connection_id)),
        // What Reconnect opens on: the same program at the same address.
        ...(usable.has(l.connection_id) || othersLibrary(l.connection_id) ? {} : { reconnect: { provider: l.library_provider, address: l.library_address } }),
      })),
      suggestions: suggestions.map((s) => ({ connection_id: s.connection_id, ref: s.ref, type: s.item_type, type_label: s.item_type_label, title: s.title, subtitle: s.subtitle, created: s.created, tags: s.tags, open_url: s.open_url, open_label: s.open_label, has_thumb: s.has_thumb, because: s.because, conflict: s.conflict, warning: s.warning, score: s.score })),
      matching: known?.status === "queued",
      matched_at: known?.matched_at ?? null,
      // The background asked and got no answer: the panel says so with a
      // Retry; the record itself shows nothing extra.
      unanswered: known?.last_error ?? null,
    });
  }),
);

const FindBody = z.object({ query: z.string().max(300).optional() });

// AI-REACH: exempt: the same search is library.find, which the assistant reaches through invoke_service; this is the panel's Find button over it
// UI-REACH: the library panel's Find on every record
router.post(
  "/records/:kind/:id/find",
  handler(async (req, res) => {
    const b = FindBody.safeParse(req.body ?? {});
    if (!b.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "query must be text" } });
      return;
    }
    res.json({ systems: await findFresh(tenantOf(req).org.id, userOf(req), record(req), b.data.query) });
  }),
);

const DocBody = z.object({ connection_id: z.string().min(1).max(200), ref: z.string().min(1).max(200), write_back: z.boolean().optional() });
/** `to: "vault"` keeps a personal document in the requester's Vault, the
 *  supported place for what shared Files refuse (#5871). */
const CopyBody = DocBody.extend({ to: z.enum(["files", "vault"]).optional() });

// AI-ACTION: core-documents:link-item
// UI-REACH: the library panel's Link beside a suggestion or a Find result
router.post(
  "/records/:kind/:id/links",
  handler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-documents:link-item"))) return;
    const b = DocBody.safeParse(req.body ?? {});
    if (!b.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "connection_id and ref are required" } });
      return;
    }
    const out = await linkItem(tenantOf(req).org.id, dbOf(req), userOf(req), record(req), b.data.connection_id, b.data.ref, { writeBack: b.data.write_back === true, origin: originOf(req) });
    res.status(out.already ? 200 : 201).json(out);
  }),
);

// AI-ACTION: core-documents:unlink-item
// UI-REACH: the library panel's Unlink on a linked item
router.delete(
  "/records/:kind/:id/links",
  handler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-documents:unlink-item"))) return;
    const b = DocBody.safeParse({ ...(req.body ?? {}), ...req.query });
    if (!b.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "connection_id and ref are required" } });
      return;
    }
    res.json(await unlinkItem(tenantOf(req).org.id, dbOf(req), userOf(req), record(req), b.data.connection_id, b.data.ref));
  }),
);

// AI-REACH: exempt: a person's own "not this one" on a suggestion they are looking at; the assistant links or leaves a suggestion, it does not hide one for someone
// UI-REACH: the library panel's Not this one on a suggestion
router.post(
  "/records/:kind/:id/dismiss",
  handler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const b = DocBody.safeParse(req.body ?? {});
    if (!b.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "connection_id and ref are required" } });
      return;
    }
    const r = record(req);
    await dbOf(req)
      .updateTable("core_documents_suggestions")
      .set({ dismissed_at: new Date() })
      .where("record_id", "=", r.id)
      .where("connection_id", "=", b.data.connection_id)
      .where("ref", "=", b.data.ref)
      .execute();
    res.json({ ok: true });
  }),
);

// AI-REACH: exempt: Retry when a library did not answer; the background asks again on its own, and the assistant reaches the system directly through invoke_service
// UI-REACH: the library panel's Retry when the library did not answer
router.post(
  "/records/:kind/:id/rematch",
  handler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const orgId = tenantOf(req).org.id;
    const r = record(req);
    const db = dbOf(req);
    const facts = await readFacts(orgId, r.kind, r.id);
    if (!facts) {
      res.status(404).json({ error: { code: "not_found", message: "That record is not here." } });
      return;
    }
    await noteFacts(db, r.kind, r.id, facts);
    await db.updateTable("core_documents_records").set({ status: "queued", attempts: 0, last_error: null, updated_at: new Date() }).where("record_id", "=", r.id).execute();
    nudge(orgId);
    res.status(202).json({ ok: true });
  }),
);

// AI-ACTION: core-documents:copy-item
// UI-REACH: the library panel's Bring a copy into Cobblr on a linked item
router.post(
  "/records/:kind/:id/copies",
  handler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-documents:copy-item"))) return;
    const b = CopyBody.safeParse(req.body ?? {});
    if (!b.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "connection_id and ref are required; to is \"files\" or \"vault\"" } });
      return;
    }
    res.status(202).json({ job: await copyItem(tenantOf(req).org.id, userOf(req), record(req), b.data.connection_id, b.data.ref, { to: b.data.to }) });
  }),
);

/** An item's picture (a document's thumbnail, a game's cover), through
 *  Cobblr: the browser never holds the library's token or address. Cached a while per workspace. */
const THUMBS = new Map<string, { at: number; type: string; bytes: Buffer }>();
const THUMB_KEEP_MS = 3600_000;
router.get(
  "/thumb",
  handler(async (req, res) => {
    const orgId = tenantOf(req).org.id;
    const connectionId = String(req.query.connection_id ?? "");
    const ref = String(req.query.ref ?? "");
    if (!connectionId || !ref) {
      res.status(400).json({ error: { code: "invalid_query", message: "connection_id and ref are required" } });
      return;
    }
    if (!(await systemsFor(orgId, userOf(req))).some((s) => s.credentialId === connectionId)) {
      res.status(404).end();
      return;
    }
    const key = `${orgId}|${connectionId}|${ref}`;
    let hit = THUMBS.get(key);
    if (!hit || Date.now() - hit.at > THUMB_KEEP_MS) {
      const got = await getOn(orgId, connectionId, ref, "thumb").catch(() => null);
      if (!got?.thumb) {
        res.status(404).end();
        return;
      }
      hit = { at: Date.now(), type: got.thumb.type, bytes: Buffer.from(got.thumb.base64, "base64") };
      THUMBS.set(key, hit);
      if (THUMBS.size > 500) THUMBS.delete(THUMBS.keys().next().value!);
    }
    res.setHeader("content-type", hit.type);
    res.setHeader("cache-control", "private, max-age=3600");
    res.end(hit.bytes);
  }),
);

export default router;
