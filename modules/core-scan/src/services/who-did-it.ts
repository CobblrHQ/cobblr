// Who did what to a scan row, for the person who arrives second (#8848).
//
// Two people unpack one delivery on two phones. When both act on one row at
// once, one of them wins; the other is told who did it and when, never a
// bare "already done", and never a success for what they did not do.

import type { Request } from "express";
import { EDITED_FROM_HEADER, agoWords, decodeEditedFrom, staleFields } from "@cobblr/platform-contract/edited-from";
import { sessionUser } from "../db.js";

/** A person's act on a row, as it is kept in the row's metadata. */
export interface ActOnRow {
  by: string | null;
  by_name: string;
  at: string;
}

/** The row is being sent back by this person right now. */
export const SENDING_BACK_KEY = "sending_back";
/** The row was sent back by this person. */
export const SENT_BACK_KEY = "sent_back";

/** A claim this old is a request that died mid-way, never one still running. */
export const SENDING_BACK_EXPIRES_MS = 2 * 60_000;

/** How long "X sent this back" stays the answer to a late press. */
const SENT_BACK_REMEMBERED_MS = 30 * 60_000;

export function actOf(req: Request, now = new Date()): ActOnRow {
  const s = sessionUser(req);
  return { by: s.id ?? null, by_name: s.display_name?.trim() || "Someone", at: now.toISOString() };
}

function actIn(meta: Record<string, unknown> | null | undefined, key: string): ActOnRow | null {
  const v = meta?.[key] as Partial<ActOnRow> | undefined;
  if (!v || typeof v !== "object" || typeof v.at !== "string" || Number.isNaN(Date.parse(v.at))) return null;
  return { by: typeof v.by === "string" ? v.by : null, by_name: typeof v.by_name === "string" && v.by_name ? v.by_name : "Someone", at: v.at };
}

/** Why a press of Undo arriving now takes nothing back, or null when it may
 *  go ahead: someone is sending the row back this moment, or just did. */
export function sentBackRefusal(row: { status: string; suggested_metadata?: unknown }, now = Date.now()): string | null {
  const meta = (row.suggested_metadata ?? {}) as Record<string, unknown>;
  const sending = actIn(meta, SENDING_BACK_KEY);
  if (row.status === "resolved" && sending && now - Date.parse(sending.at) < SENDING_BACK_EXPIRES_MS) {
    return `${sending.by_name} is sending this back now, so nothing more was taken off.`;
  }
  const sent = actIn(meta, SENT_BACK_KEY);
  if (row.status !== "resolved" && sent && now - Date.parse(sent.at) < SENT_BACK_REMEMBERED_MS) {
    return `${sent.by_name} sent this back ${agoWords(new Date(sent.at), now)}, so nothing more was taken off.`;
  }
  return null;
}

/** The row's fields a filing may write, by the names the filing sends. */
const FILED_FIELDS = { name: "name", quantity: "count" } as const;

interface EditEntry { action?: unknown; at?: unknown; by?: unknown; by_name?: unknown; changed?: unknown }

/** The last person other than `me` whose edit of the row changed one of
 *  these parts ("name", "count"), from its History (#8557). */
function lastEditBy(meta: Record<string, unknown>, parts: readonly string[], me: string | null): { name: string; at: Date } | null {
  const history = Array.isArray(meta.history) ? (meta.history as EditEntry[]) : [];
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i];
    if (!e || e.action !== "edit" || typeof e.at !== "string") continue;
    if (me && e.by === me) continue;
    if (!Array.isArray(e.changed) || !e.changed.some((c) => parts.includes(String(c)))) continue;
    return { name: typeof e.by_name === "string" && e.by_name ? e.by_name : "Someone", at: new Date(e.at) };
  }
  return null;
}

/** Why a filing made from what a card showed would write over a change made
 *  since, or null (#8849). A filing that says nothing of what it showed is
 *  judged as before. */
export function staleFiling(
  req: Request,
  row: { suggested_name: string | null; quantity: unknown; suggested_metadata?: unknown },
  body: { name?: string; quantity?: number },
  now = Date.now(),
): { message: string; fields: string[] } | null {
  const opened = decodeEditedFrom(req.get(EDITED_FROM_HEADER));
  if (!opened) return null;
  const next: Record<string, unknown> = {};
  if (body.name !== undefined) next.name = body.name;
  if (body.quantity !== undefined) next.quantity = body.quantity;
  const fields = staleFields({ name: row.suggested_name, quantity: row.quantity }, opened, next);
  if (!fields.length) return null;
  const parts = fields.map((f) => FILED_FIELDS[f as keyof typeof FILED_FIELDS] ?? f);
  const what = parts.length === 1 ? `the ${parts[0]}` : `the ${parts.join(" and the ")}`;
  const by = lastEditBy((row.suggested_metadata ?? {}) as Record<string, unknown>, parts, sessionUser(req).id ?? null);
  const lead = by ? `${by.name} changed ${what} ${agoWords(by.at, now)}` : `${what[0]!.toUpperCase()}${what.slice(1)} changed`;
  return { message: `${lead}, after you opened this, so nothing was filed. Look at it again, then add it.`, fields };
}
