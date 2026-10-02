// Who a thing came from, kept apart from where (#4593).
//
// An assistant adding a printer sent Acquired from "3DPrintopia 2026" and the
// note "acquired at 3DPrintopia 2026 from Jai"; the card showed the event and
// Jai was gone. The values an agent sends are split here before they are kept:
// the event stays the value (it groups, and it becomes a choice), and the
// person goes beside it, in the table's own seller field when it has an empty
// one, else the field's note ("3DPrintopia 2026 · Jai"). Pure.

import { fieldNoteKey } from "@cobblr/platform-contract";
import { isAcquiredFromField, isSellerField, sellerSaidWith } from "@cobblr/platform-contract/acquisition-source";

export type SentFields = Record<string, string | number | boolean>;

/** The fields with each acquired-from value's seller split out. `roles` are
 *  the roles the destination table declares by field name, so a field named
 *  anything that plays the part is read the same. */
export function withSellersApart(fields: SentFields, name: string | null, roles: ReadonlyMap<string, string> = new Map()): SentFields {
  const out: SentFields = { ...fields };
  const texts = [name, ...Object.values(fields).filter((v): v is string => typeof v === "string")];
  const sellerKey = Object.keys(out).find((k) => isSellerField({ name: k, field_role: roles.get(k) ?? null })) ?? [...roles].find(([, r]) => r === "seller")?.[0] ?? null;
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v !== "string" || !isAcquiredFromField({ name: k, field_role: roles.get(k) ?? null })) continue;
    const split = sellerSaidWith(v, texts.filter((t) => t !== v));
    if (!split) continue;
    out[k] = split.value;
    const blank = (x: unknown) => x == null || (typeof x === "string" && !x.trim());
    if (sellerKey && blank(out[sellerKey])) out[sellerKey] = split.seller;
    else if (!sellerKey && blank(out[fieldNoteKey(k)])) out[fieldNoteKey(k)] = split.seller;
  }
  return out;
}
