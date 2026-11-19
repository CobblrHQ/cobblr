// Every field a person saves on a page can be put back (#4115).
//
// A page's save sends only the fields it changed, and in EDITED_FROM_HEADER
// what those fields were when its form opened (changed-from.ts, #7925). So a
// save that landed already holds its own way back: the same write with the
// two swapped. The values from before go back, judged against the values just
// saved, so a field someone changed since is refused with who and when,
// never reversed in silence (an-undo-is-exact-or-it-says-no.md).
//
// Both doors a page's writes leave by (the app's api client and
// workspaceFetch, which every module's client sends through) tell
// noteSavedEdit once a save lands, and the app draws one Undo for it
// (SavedEditUndo). A field cleared by mistake and blurred out of was saved
// with no way back but retyping it.
import { EDITED_FROM_HEADER, decodeEditedFrom, encodeEditedFrom, type EditedFrom } from "@cobblr/platform-contract/edited-from";

/** Marks the write an Undo sends, so putting a field back offers no Undo of its own. */
export const UNDO_OF_AN_EDIT_HEADER = "x-cobblr-undo-of-an-edit";
/** A surface that draws its own Undo beside the field says so, and no second Undo is offered. */
export const UNDO_SHOWN_HERE_HEADER = "x-cobblr-undo-shown-here";
/** A write an earlier page left waiting, sent now: not a save this page made. */
const SENT_FOR_AN_EARLIER_PAGE = "x-cobblr-waited";

/** A save that landed, and the write that puts it back. */
export interface SavedEdit {
  /** The workspace the record is in. */
  slug: string;
  /** `/orgs/<slug>/…`, as the web client's request takes it. */
  path: string;
  method: "PATCH" | "PUT";
  /** What to send to put it back: the fields as they were. */
  back: EditedFrom;
  /** Sent with it, as what the fields are now: a field changed since refuses. */
  headers: Record<string, string>;
}

const listeners = new Set<(edit: SavedEdit) => void>();

export function subscribeSavedEdit(listener: (edit: SavedEdit) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const header = (headers: HeadersInit | Record<string, string> | undefined, name: string): string | null => new Headers(headers as HeadersInit | undefined).get(name);

/** The way back from a save that landed, or null when it is not a page's save
 *  of a record's fields (a create, a delete, an action, a save that changed
 *  nothing, an Undo itself, or one whose surface draws its own Undo). */
export function savedEditOf(method: string, url: string, headers: HeadersInit | Record<string, string> | undefined, body: unknown, status: number): SavedEdit | null {
  const m = method.toUpperCase();
  if ((m !== "PATCH" && m !== "PUT") || status < 200 || status >= 300) return null;
  if (header(headers, UNDO_OF_AN_EDIT_HEADER) || header(headers, UNDO_SHOWN_HERE_HEADER) || header(headers, SENT_FOR_AN_EARLIER_PAGE)) return null;
  const was = decodeEditedFrom(header(headers, EDITED_FROM_HEADER));
  if (!was || !Object.keys(was).length) return null;
  let sent: unknown = body;
  if (typeof body === "string") {
    try {
      sent = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (!sent || typeof sent !== "object" || Array.isArray(sent)) return null;
  let path = url;
  try {
    if (/^https?:\/\//.test(path)) path = new URL(path).pathname + new URL(path).search;
  } catch {
    return null;
  }
  path = path.replace(/^\/api\/v1(?=\/)/, "");
  const slug = /^\/orgs\/([^/?#]+)\//.exec(path)?.[1];
  if (!slug) return null;
  const now: Record<string, unknown> = {};
  for (const k of Object.keys(was)) if (k in (sent as Record<string, unknown>)) now[k] = (sent as Record<string, unknown>)[k];
  const back = Object.fromEntries(Object.keys(now).map((k) => [k, was[k]]));
  if (!Object.keys(back).length) return null;
  return { slug: decodeURIComponent(slug), path, method: m, back, headers: { [EDITED_FROM_HEADER]: encodeEditedFrom(now), [UNDO_OF_AN_EDIT_HEADER]: "1" } };
}

/** Told by a door once a write has landed: a page's save of a record's fields
 *  is offered back. */
export function noteSavedEdit(method: string, url: string, headers: HeadersInit | Record<string, string> | undefined, body: unknown, status: number): void {
  const edit = savedEditOf(method, url, headers, body, status);
  if (edit) listeners.forEach((l) => l(edit));
}
