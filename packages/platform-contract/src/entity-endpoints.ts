// Where one record of a kind is written: the kind's manifest-declared
// endpoint, under its module or, for a workspace's named instance, under
// /instances/<name>. One rule for every client that writes a record it did
// not define (the assistant's tools, a board's drag, the floor plan), so a
// second copy cannot drift from the first. A kind that declares no endpoint
// is honestly not writable: null, never a guessed route.

export interface EndpointKind {
  id: string;
  module_name?: string | null;
  instance_name?: string | null;
  endpoints?: { get?: string; list?: string; create?: string; update?: string; delete?: string } | null;
}

/** The org-relative root: "instances/<name>" or "modules/<module>". */
export function entityRoot(kind: EndpointKind): string | null {
  if (kind.instance_name) return `instances/${kind.instance_name}`;
  return kind.module_name ? `modules/${kind.module_name}` : null;
}

/** The org-relative path ("modules/…" | "instances/…") for `which` on one
 *  record (`{id}` substituted) or on the collection, or null. */
export function entityEndpointPath(kind: EndpointKind | undefined, which: "get" | "list" | "create" | "update" | "delete", id?: string): string | null {
  if (!kind) return null;
  const tmpl = kind.endpoints?.[which];
  const root = entityRoot(kind);
  if (!root || !tmpl) return null;
  const rel = tmpl.replace(/^\//, "");
  return `${root}/${id === undefined ? rel : rel.replace("{id}", encodeURIComponent(id))}`;
}
