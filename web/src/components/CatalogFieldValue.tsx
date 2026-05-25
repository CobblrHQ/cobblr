// Thin re-export — the implementation moved to platform-web so
// module UIs (inventory, etc.) can share one library. Existing
// imports (CatalogDetailPage) keep working unchanged via this
// alias.

import { FieldRenderer, NoImage } from "@cobblr/platform-web";

/** Back-compat alias for the catalog page. */
export const CatalogFieldValue = FieldRenderer;
export { NoImage };
