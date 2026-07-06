// Read side of the stock-vs-catalog disclosure. An inventory instance shows its
// full STOCK face or a LEAN catalog face, derived server-side from the data
// (see api/disclosure.ts + docs/design-decisions/one-record-substrate.md). This
// hook fetches that verdict and exposes a `hides(field)` helper the parts UI
// composes with the workspace's native-field presentation overrides
// (useFieldPresentation): a field is hidden if the workspace explicitly hid it
// OR it belongs to the stock set and this instance is lean.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useInventory } from "./context";

/** The native fields + panels that make up inventory's STOCK face. When an
 *  instance is lean (a catalog: films, books, ...) these are hidden, leaving
 *  title + photo + notes + location + the user's own fields. Non-stock native
 *  fields (location, tags, notes, archive) are never in here. */
export const STOCK_NATIVE_FIELDS: ReadonlySet<string> = new Set([
  "qty",
  "unit",
  "min_qty",
  "cost",
  "category",
  "supplier_url",
  "manufacturer",
  "serial_number",
  "model_number",
  "warranty",
  "maintenance",
  "allocations",
  "consumable",
  "insured",
]);

export interface DisclosurePolicy {
  /** True once the instance is known to be a stock instance. */
  stock: boolean;
  /** True while the verdict is still loading. */
  isLoading: boolean;
  /** Whether the derived policy hides this native field for this instance.
   *  (Only stock fields, and only when the instance is lean.) Compose with the
   *  workspace override: `fp.hidden(name) || disclosure.hides(name)`. */
  hides: (field: string) => boolean;
}

export function useDisclosure(): DisclosurePolicy {
  const { api, orgSlug, instance } = useInventory();
  const q = useQuery({
    queryKey: ["inv-disclosure", orgSlug, instance ?? "inventory"],
    queryFn: () => api.getDisclosure(),
    staleTime: 30_000,
  });
  // Bias: assume stock until we know otherwise, so a real inventory instance
  // never flashes lean and nothing is hidden on a slow/failed fetch.
  const stock = q.data?.stock ?? true;
  return useMemo(
    () => ({
      stock,
      isLoading: q.isLoading,
      hides: (field: string) => !stock && STOCK_NATIVE_FIELDS.has(field),
    }),
    [stock, q.isLoading],
  );
}
