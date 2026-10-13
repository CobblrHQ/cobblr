import { displayName, personNameOf } from "@cobblr/platform-contract/display-identity";
import { sameProduct } from "@cobblr/platform-contract/same-product";
import { nameOverlap, tokens } from "./entity-match.js";
import { statedColoursOf } from "./picture-agrees.js";

export interface OrderLineProduct {
  suggested_name: string | null;
  suggested_metadata?: unknown;
  source_kind?: string | null;
}

function namesOf(row: OrderLineProduct): string[] {
  const name = displayName(row) ?? "";
  if (personNameOf(row.suggested_metadata)) return [name];
  const meta = (row.suggested_metadata ?? {}) as { description?: unknown; intake_shape?: unknown };
  const captured = row.source_kind === "receipt" || (row.source_kind === "note" && meta.intake_shape === "phrase");
  return captured && typeof meta.description === "string" && meta.description.trim()
    ? [name, meta.description]
    : [name];
}

/** A suggested name can lose a variant. Check captured evidence separately,
 * so adding an agreeing colour cannot hide a captured contradiction. */
export function orderLineOverlap(scan: OrderLineProduct, line: OrderLineProduct): { pass: boolean; shared: number } {
  const scanNames = namesOf(scan);
  const lineNames = namesOf(line);
  const overlap = nameOverlap(tokens(scanNames[0]), lineNames[0] ?? "");
  if (!overlap.pass) return overlap;
  for (const name of scanNames) {
    for (const lineName of lineNames) {
      if (sameProduct({ name }, { name: lineName }).verdict === "different") return { ...overlap, pass: false };
      const mine = statedColoursOf({ name });
      const theirs = statedColoursOf({ name: lineName });
      if (mine.size > 0 && theirs.size > 0 && ![...mine].some((c) => theirs.has(c))) return { ...overlap, pass: false };
    }
  }
  return overlap;
}
