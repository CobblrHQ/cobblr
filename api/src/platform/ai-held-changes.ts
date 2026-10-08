// A delete an assistant asks for waits for its person.
//
// In the in-app chat a delete is always a card the person confirms, because a
// record's own words (a name, a scanned note) must never be able to steer an
// unconfirmed delete. An assistant connected over MCP reads the same words,
// and a connector allowed to "change" deleted whatever it was asked to. Now
// every AI door (req.session.ai_door: the MCP server's token, the hosted
// endpoint with any token, a connector signed in with OAuth) has its DELETE
// held here instead of run: a row says what was asked, the person gets a card
// with Delete it / Keep it, and Delete it replays the request under the
// person's own session, once. A card pressed a day later deletes nothing.
//
// The hold sits in withTenant, the one middleware every workspace route
// passes, so a route added tomorrow is held the day it lands.

import type { Request, Response } from "express";
import { platform } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import { signSession } from "../auth/jwt.js";
import { dispatch } from "./notifications.js";
import { apiFetch, selfOrigin } from "@cobblr/platform-contract/self-api";

export const CONFIRM_HELD_CHANGE_ACTION = "platform:confirm-held-change";
export const KEEP_HELD_CHANGE_ACTION = "platform:keep-held-change";
const EVENT = "platform.assistant.change_held";
/** A card answered after this deletes nothing: nobody remembers what it was. */
export const HELD_CHANGE_TTL_MS = 24 * 60 * 60 * 1000;

/** The path under /api/v1/orgs/<slug>, or null for anything else. */
function workspacePath(originalUrl: string, slug: string): string | null {
  const path = originalUrl.split("?")[0] ?? "";
  const prefix = `/api/v1/orgs/${slug}`;
  return path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : null;
}

/** "the part “M3 bolt”", from the kind whose delete endpoint the path is, or
 *  a plain description when no kind claims it. */
export async function describeDelete(orgId: string, rel: string): Promise<string> {
  try {
    const kinds = await platform().entities.listKindsForOrg(orgId);
    for (const k of kinds) {
      const del = k.endpoints?.delete;
      if (!del) continue;
      const base = k.instance_name ? `/instances/${k.instance_name}` : `/modules/${k.module_name}`;
      const template = `${base}/${del.replace(/^\//, "")}`;
      // RECORD-LINK-OK: matches a DELETE request's API path to recognise the record; it builds no address to show anyone.
      const pattern = new RegExp(`^${template.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace("{id}", "([^/]+)")}$`); // lint-allow-detail-substitution: an API delete endpoint turned into a matcher, not a detail route
      const m = rel.match(pattern);
      if (!m?.[1]) continue;
      const rec = await platform().entities.lookup(orgId, k.id, decodeURIComponent(m[1])).catch(() => null);
      const noun = (k.display_name ?? k.id).toLowerCase();
      return rec?.title ? `the ${noun} “${rec.title}”` : `a ${noun}`;
    }
  } catch {
    /* the plain description below still says what was asked */
  }
  return `something in this workspace (${rel})`;
}

/** Hold this request for its person instead of running it. Answers 202 with
 *  what the assistant should tell them. */
export async function holdForAPerson(req: Request, res: Response): Promise<void> {
  const tenant = req.tenant!;
  const userId = req.session!.id;
  const rel = workspacePath(req.originalUrl, tenant.org.slug) ?? req.originalUrl;
  const summary = await describeDelete(tenant.org.id, rel);
  const row = await meta
    .insertInto("ai_held_changes")
    .values({
      org_id: tenant.org.id,
      user_id: userId,
      method: req.method,
      path: rel,
      summary,
      door: req.session!.ai_door ?? "mcp",
      outcome: null,
      notification_id: null,
      decided_at: null,
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
  try {
    const sent = await dispatch({
      orgId: tenant.org.id,
      userId,
      eventType: EVENT,
      message: `An assistant asked to delete ${summary}. Delete it?`,
      priority: "high",
      no_link_reason: "the question is answered on the card itself",
      card: {
        heading: "An assistant wants to delete something",
        body: `It asked to delete ${summary}. Nothing is deleted unless you say so here.`,
      },
      actions: [
        { id: "delete", label: "Delete it", action: CONFIRM_HELD_CHANGE_ACTION, args: { change_id: row.id }, style: "danger" },
        { id: "keep", label: "Keep it", action: KEEP_HELD_CHANGE_ACTION, args: { change_id: row.id }, style: "secondary" },
      ],
    });
    if (sent.notificationId) {
      await meta.updateTable("ai_held_changes").set({ notification_id: sent.notificationId }).where("id", "=", row.id).execute();
    }
  } catch (err) {
    console.warn(`[held-change] could not send the card for ${row.id}: ${(err as Error).message}`);
  }
  res.status(202).json({
    held: true,
    change_id: row.id,
    message: `Waiting for you: deleting ${summary} needs your yes in Cobblr. The card is in your notifications.`,
  });
}

export type HeldOutcome = { ok: true; message: string } | { ok: false; message: string };

async function settleCard(notificationId: string | null): Promise<void> {
  if (!notificationId) return;
  await meta.updateTable("notifications").set({ read_at: new Date() }).where("id", "=", notificationId).where("read_at", "is", null).execute().catch(() => {});
}

/** Claim a waiting change for its own person, once. Null when it is not
 *  theirs, not waiting, or too old (which it then records). */
/** The person the assistant was working for when it held this change. */
export async function heldChangeRequester(changeId: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(changeId)) return null;
  const row = await meta.selectFrom("ai_held_changes").select("user_id").where("id", "=", changeId).executeTakeFirst();
  return row?.user_id ?? null;
}

async function claim(changeId: string, userId: string, to: "done" | "kept") {
  const row = await meta.selectFrom("ai_held_changes").selectAll().where("id", "=", changeId).executeTakeFirst();
  if (!row) return { refusal: "That request is not here any more." } as const;
  if (row.user_id !== userId) return { refusal: "Only the person the assistant was working for can answer this." } as const;
  if (row.status !== "waiting") return { refusal: "That was already answered." } as const;
  if (Date.now() - new Date(row.created_at).getTime() > HELD_CHANGE_TTL_MS) {
    await meta.updateTable("ai_held_changes").set({ status: "expired", decided_at: new Date() }).where("id", "=", changeId).where("status", "=", "waiting").execute();
    await settleCard(row.notification_id);
    return { refusal: "That request is more than a day old, so nothing was deleted. Ask again if you still want it." } as const;
  }
  const won = await meta
    .updateTable("ai_held_changes")
    .set({ status: to, decided_at: new Date() })
    .where("id", "=", changeId)
    .where("status", "=", "waiting")
    .returningAll()
    .executeTakeFirst();
  if (!won) return { refusal: "That was already answered." } as const;
  return { row: won } as const;
}

/** Delete it: replay the request as the person, once. */
export async function confirmHeldChange(changeId: string, userId: string): Promise<HeldOutcome> {
  const c = await claim(changeId, userId, "done");
  if ("refusal" in c) return { ok: false, message: c.refusal! };
  const row = c.row;
  const org = await meta.selectFrom("orgs").select(["slug"]).where("id", "=", row.org_id).executeTakeFirst();
  let outcome: string;
  let ok = false;
  try {
    // The person's own session: no AI door, so it runs as if they had pressed
    // delete themselves, under their own role and capability checks.
    const token = await signSession(userId);
    const r = await apiFetch(`${selfOrigin()}/api/v1/orgs/${org?.slug ?? ""}${row.path}`, {
      method: row.method,
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
    ok = r.ok;
    outcome = ok ? `Deleted ${row.summary}.` : body.error?.message ?? `The delete did not go through (${r.status}).`;
  } catch (err) {
    outcome = `The delete did not go through: ${(err as Error).message}`;
  }
  await meta.updateTable("ai_held_changes").set({ status: ok ? "done" : "failed", outcome }).where("id", "=", changeId).execute();
  await settleCard(row.notification_id);
  return ok ? { ok: true, message: outcome } : { ok: false, message: outcome };
}

/** Keep it: nothing happens, and the card stops asking. */
export async function keepHeldChange(changeId: string, userId: string): Promise<HeldOutcome> {
  const c = await claim(changeId, userId, "kept");
  if ("refusal" in c) return { ok: false, message: c.refusal! };
  await meta.updateTable("ai_held_changes").set({ outcome: "kept" }).where("id", "=", changeId).execute();
  await settleCard(c.row.notification_id);
  return { ok: true, message: `Kept ${c.row.summary}. Nothing was deleted.` };
}
