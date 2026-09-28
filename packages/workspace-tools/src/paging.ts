// How a tool that returns rows hands over ALL of them.
//
// list_records capped a page at 50 and took no offset, so on a kind with 54
// records the last four could only be reached by guessing their names (#3806).
// Every read tool now declares how a caller gets everything it can return:
// by following a cursor, or because one call already returns it all, and why.
// The declaration is required by the type, so a new list tool cannot forget.
//
// The cursor is opaque to the caller: base64url of a small JSON state stamped
// with the tool's name, so a cursor from one tool is refused by another rather
// than read as the wrong position.
import { z } from "zod";

export type Paging =
  /** Takes `cursor`, returns `next_cursor` (null on the last page) and `has_more`. */
  | { by: "cursor" }
  /** One call returns what this tool offers (everything, or a summary that
   *  says what it leaves out). `why` says which, for the next reader. */
  | { by: "one-call"; why: string };

/** How to page, said once on the parameter every cursor tool takes (the tool
 *  schemas are sent on every turn, so it is said in as few words as work). */
export const PAGING_SENTENCE = "Pass next_cursor here while has_more is true.";

export const CURSOR_PARAM = z.string().optional().describe(PAGING_SENTENCE);

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodeCursor(tool: string, state: Record<string, unknown>): string {
  return toBase64Url(JSON.stringify({ t: tool, ...state }));
}

export type DecodedCursor<T> = { ok: true; state: T | null } | { ok: false; error: string };

/** `state: null` = no cursor, the first page. A cursor from another tool, or
 *  one that does not decode, is refused with a sentence the model can act on. */
export function decodeCursor<T extends Record<string, unknown>>(tool: string, raw: unknown): DecodedCursor<T> {
  if (raw === undefined || raw === null || raw === "") return { ok: true, state: null };
  if (typeof raw !== "string") return { ok: false, error: "cursor must be the next_cursor string from the previous page" };
  try {
    const parsed = JSON.parse(fromBase64Url(raw)) as { t?: unknown } & Record<string, unknown>;
    if (parsed.t !== tool) {
      return { ok: false, error: `that cursor came from ${String(parsed.t ?? "another call")}, not ${tool}. Pass the next_cursor ${tool} returned, or leave cursor out to start again.` };
    }
    const { t: _t, ...state } = parsed;
    return { ok: true, state: state as T };
  } catch {
    return { ok: false, error: "cursor was not recognised. Pass the next_cursor from the previous page exactly, or leave it out to start again." };
  }
}

/** The two fields every cursor tool's result carries, together. */
export function pageEnd(tool: string, next: Record<string, unknown> | null): { has_more: boolean; next_cursor: string | null } {
  return next ? { has_more: true, next_cursor: encodeCursor(tool, next) } : { has_more: false, next_cursor: null };
}
