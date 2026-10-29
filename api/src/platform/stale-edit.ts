// A save never silently reverses another (#7925): the server half.
//
// A save that says what its fields were when its form opened
// (EDITED_FROM_HEADER) is compared with the record as it is now. A field
// someone changed since, to something other than this save writes, refuses
// the whole save, nothing written, with who changed it and when; the person
// looks again and saves what they still want. A save that says nothing (an
// assistant's write, a script) is judged as before.
//
// Every update route of a kind passes here through observeModuleHistory, with
// the record as it was read for its history. A route the kind registry does
// not map (a line inside an order) calls refuseStaleEdit with its own read.
import type { Request, Response } from "express";
import { EDITED_FROM_HEADER, agoWords, decodeEditedFrom, staleFields } from "@cobblr/platform-contract/edited-from";
import { changesIn } from "@cobblr/platform-contract/activity-changes";

/** How a field reads in a sentence: its own words, not its column. */
function said(field: string): string {
  const name = field.replace(/^metadata\./, "").replace(/_id$/, "").replace(/_/g, " ");
  return name === "parent" ? "where it is" : name;
}

/** Who last changed one of these fields of this record, and when. */
async function lastChangeOf(orgId: string, id: string, fields: readonly string[]): Promise<{ who: string; at: Date } | null> {
  const { meta } = await import("../db/meta.js");
  const rows = await meta
    .selectFrom("activity_log as a")
    .leftJoin("users as u", "u.id", "a.user_id")
    .select(["a.diff", "a.occurred_at", "u.display_name"])
    .where("a.org_id", "=", orgId)
    .where("a.entity_id", "=", id)
    .orderBy("a.id", "desc")
    .limit(50)
    .execute();
  const wanted = new Set(fields.map((f) => f.replace(/^metadata\./, "")));
  for (const r of rows) {
    if ((changesIn(r.diff) ?? []).some((c) => wanted.has(c.field))) return { who: r.display_name ?? "Someone", at: new Date(r.occurred_at as unknown as string) };
  }
  return null;
}

/** The sentence a refused save shows. */
export function staleEditMessage(fields: readonly string[], last: { who: string; at: Date } | null, now = Date.now()): string {
  const what = fields.map(said);
  const list = what.length === 1 ? what[0]! : `${what.slice(0, -1).join(", ")} and ${what.at(-1)}`;
  const by = last ? `${last.who} changed ${list} ${agoWords(last.at, now)}` : `${list[0]!.toUpperCase()}${list.slice(1)} changed`;
  return `${by}, after you opened this, so nothing was saved. Look at it again and save what you still want.`;
}

/** When this save would overwrite a field changed since its form opened,
 *  answer 409 and say so; true when it did. `current` is the record now, by
 *  the same field names the save sends. */
export async function refuseStaleEdit(req: Request, res: Response, orgId: string, id: string, current: Record<string, unknown>): Promise<boolean> {
  const opened = decodeEditedFrom(req.get(EDITED_FROM_HEADER));
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : null;
  if (!opened || !body) return false;
  const stale = staleFields(current, opened, body);
  if (!stale.length) return false;
  const last = await lastChangeOf(orgId, id, stale);
  res.status(409).json({ error: { code: "changed_since", message: staleEditMessage(stale, last), fields: stale } });
  return true;
}

/** The platform seam (platform().http.refuseStaleEdit), for a module's own
 *  route: the workspace is the request's. */
export function refuseStaleEditOf(req: unknown, res: unknown, recordId: string, current: Record<string, unknown>): Promise<boolean> {
  const r = req as Request;
  return refuseStaleEdit(r, res as Response, r.tenant!.org.id, recordId, current);
}
