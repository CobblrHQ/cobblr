import type { DecodeResult, IdentifierDecoder } from "./identifier-registry.js";

const GS = "\u001d";
const RS = "\u001e";
const EOT = "\u0004";

function eciaFields(code: string): Map<string, string> | null {
  const normalized = code.replace(/^\]d[12]/, "");
  const header = normalized.startsWith(`[)>${RS}06${GS}`) ? `[)>${RS}06${GS}` : normalized.startsWith(`>[)>06${GS}`) ? `>[)>06${GS}` : null;
  if (!header) return null;
  const content = normalized.slice(header.length).replace(new RegExp(`${RS}${EOT}?$`), "");
  const fields = new Map<string, string>();
  for (const segment of content.split(GS)) {
    if (!segment) continue;
    const match = /^(\d*[A-Z])([^\u0000-\u001f]*)$/.exec(segment);
    if (!match || fields.has(match[1]!)) return null;
    fields.set(match[1]!, match[2]!);
  }
  return fields;
}

function lcscFields(code: string): Map<string, string> | null {
  if (!code.startsWith("{pbn:") || !code.endsWith("}")) return null;
  const fields = new Map<string, string>();
  for (const segment of code.slice(1, -1).split(",")) {
    const separator = segment.indexOf(":");
    if (separator <= 0) return null;
    const key = segment.slice(0, separator).trim();
    if (fields.has(key)) return null;
    fields.set(key, segment.slice(separator + 1).trim());
  }
  return fields;
}

export const packageLabelDecoder: IdentifierDecoder = {
  id: "package-label",
  preserveCase: true,
  entityType: "part",
  matches(code) {
    return /^(?:\]d[12])?\[\)>\u001e06\u001d/.test(code) || code.startsWith(`>[)>06${GS}`) || code.startsWith("{pbn:");
  },
  async decode(code): Promise<DecodeResult> {
    const lcsc = code.startsWith("{pbn:");
    const encoded = lcsc ? lcscFields(code) : eciaFields(code);
    if (!encoded) return { outcome: "miss", fields: {}, provenance: "Package label", note: "This label is incomplete or has repeated fields. Scan it again.", raw: code };
    const digikey = !lcsc && (encoded.has("30P") || encoded.get("11Z") === "PICK");
    const mouser = !lcsc && encoded.has("14K");
    const supplier = lcsc ? "LCSC" : digikey ? "Digi-Key" : mouser ? "Mouser" : "ECIA";
    const fields: Record<string, string | number> = { distributor: supplier };
    const part = encoded.get(lcsc ? "pm" : "1P");
    if (part) fields.supplier_part_number = part;
    if (part && (lcsc || digikey || mouser)) fields.mpn = part;
    const sku = lcsc ? encoded.get("pc") : encoded.get("30P");
    if (sku) fields.distributor_part_number = sku;
    const identifiers = lcsc
      ? { manufacturer: "mc", purchase_order: "on", package_id: "pbn" }
      : { manufacturer: "1V", purchase_order: "K", lot_code: "1T", date_code: encoded.has("10D") ? "10D" : "9D", package_id: "3S" };
    for (const [field, identifier] of Object.entries(identifiers)) {
      const value = encoded.get(identifier);
      if (value) fields[field] = value;
    }
    const rawQuantity = encoded.get(lcsc ? "qty" : "Q");
    const quantity = rawQuantity && /^\d+$/.test(rawQuantity) ? Number(rawQuantity) : NaN;
    if (Number.isSafeInteger(quantity) && quantity > 0) fields.quantity = quantity;
    const complete = typeof fields.mpn === "string" && typeof fields.quantity === "number";
    return {
      outcome: complete ? "hit" : "partial", fields, provenance: `${supplier} package label`, title: typeof fields.mpn === "string" ? fields.mpn : part,
      ...(!complete ? { note: "Confirm the manufacturer part number and package quantity before receiving." } : {}), raw: code,
    };
  },
};
