// Sort-grammar normalization for platform.entities.list (D16).
//
// `sort` reaches list() in two grammars. Resolvers only understand the REST
// string form (`["name"]`, `["-name"]` — `-` = descending), but view configs
// and bundles widely use the object form (`[{ field, dir }]`). The object form
// used to pass through untouched and make resolvers return ZERO rows. We
// normalize both into the string grammar; anything unparseable degrades to
// `undefined` (unsorted) — never an empty array, so a bad sort can never
// produce an empty result instead of unsorted rows.
export function normalizeEntitySort(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) {
    if (raw != null) console.warn("[entities] ignoring non-array sort:", raw);
    return undefined;
  }
  const out: string[] = [];
  for (const e of raw) {
    if (typeof e === "string") {
      if (e) out.push(e);
    } else if (e && typeof e === "object") {
      const field = (e as { field?: unknown }).field;
      const dir = (e as { dir?: unknown }).dir;
      if (typeof field === "string" && field) {
        out.push(dir === "desc" || dir === "-" ? `-${field}` : field);
      } else {
        console.warn("[entities] ignoring malformed sort entry:", e);
      }
    }
  }
  return out.length > 0 ? out : undefined;
}
