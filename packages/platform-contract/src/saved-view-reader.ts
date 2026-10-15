// A saved view, read by something that is not the views module (#6070).
//
// A wire narrowed to "the records this saved view shows" needs the view's
// kind and its query at the moment the wire fires, so a change to the view
// changes what the wire is about. The views live in the core-views module's
// own table, which the kernel never reads; core-views registers this reader
// when it loads, and the wire engine asks through it. With core-views off
// there is no reader, and a wire on a view runs for no record (the view it
// names cannot be read, so nothing can be said to be in it).
//
// Only a view everyone in the workspace can see is answered: a wire belongs
// to the workspace, never to one member's private view.

export interface SavedViewForWire {
  /** The kind of record the view shows. */
  entityKind: string;
  /** The view's stored config (its filter, where and sort), read with
   *  `viewQuery` from @cobblr/platform-contract. */
  config: Record<string, unknown>;
  /** The view's name, as the person called it ("PETG in use"). */
  name?: string;
}

export type SavedViewReader = (orgId: string, viewId: string) => Promise<SavedViewForWire | null>;

// On globalThis so the api and a module that each load this file still share
// one reader.
const KEY = Symbol.for("cobblr.saved-view-reader");
type Holder = { [KEY]?: SavedViewReader };

/** Called once by core-views when it loads. */
export function registerSavedViewReader(reader: SavedViewReader): void {
  (globalThis as Holder)[KEY] = reader;
}

/** The view, or null when there is no such shared view or no reader. */
export async function readSavedView(orgId: string, viewId: string): Promise<SavedViewForWire | null> {
  const reader = (globalThis as Holder)[KEY];
  return reader ? reader(orgId, viewId) : null;
}
