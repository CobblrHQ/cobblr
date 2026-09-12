import { normalizeSortSpec } from "@cobblr/platform-contract";

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
  // The grammar lives in the contract (normalizeSortSpec), so the view query
  // the pages build and the list() the kernel runs read a sort the same way.
  // This wrapper keeps the kernel's warnings about entries it dropped.
  for (const e of raw) {
    if (typeof e === "string" || (e && typeof e === "object" && typeof (e as { field?: unknown }).field === "string")) continue;
    console.warn("[entities] ignoring malformed sort entry:", e);
  }
  return normalizeSortSpec(raw);
}
