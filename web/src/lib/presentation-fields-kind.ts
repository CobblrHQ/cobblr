// Which entity kind the Fields button on a Presentation row edits (#7878).
//
// A row is a kind, or a collection (an instance of a module). A collection's
// records are of its own kind (`test-swatches:item`), which carries its own
// field overrides; the module's default kind (`inventory:part`) is a different
// kind with its own. The dialog took the first kind of the module, so hiding a
// field on one collection wrote the override onto Inventory instead.

import type { PlatformEntityKind } from "./api";

export interface PresentationRowTarget {
  target_kind: string;
  /** A kind's id, or `<module>:<instance>` for a collection. */
  target_id: string;
  moduleName?: string;
}

export function kindForFieldsEditor(
  kinds: ReadonlyArray<Pick<PlatformEntityKind, "id" | "module_name" | "instance_name">>,
  row: PresentationRowTarget,
): string | null {
  if (row.target_kind === "entity_kind") return row.target_id;
  const instanceName = row.target_id.slice(row.target_id.indexOf(":") + 1);
  const own = kinds.find((k) => k.module_name === row.moduleName && k.instance_name === instanceName);
  if (own) return own.id;
  // The module's own kind: what a collection with no kind of its own (the base one) shows.
  return kinds.find((k) => k.module_name === row.moduleName && !k.instance_name)?.id ?? null;
}
