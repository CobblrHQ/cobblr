// BrickLink wanted-list XML parser.
//
// Wanted-list XML is the canonical "things I want to buy" format. A
// minimal sample looks like:
//
//   <INVENTORY>
//     <ITEM>
//       <ITEMTYPE>P</ITEMTYPE>           <!-- P=Part, S=Set, M=Minifig -->
//       <ITEMID>3001</ITEMID>            <!-- BL design number = Rebrickable part_num -->
//       <COLOR>5</COLOR>                 <!-- BL color id -->
//       <MAXPRICE>0.10</MAXPRICE>        <!-- per-unit cap, optional -->
//       <MINQTY>4</MINQTY>               <!-- count needed -->
//       <CONDITION>U</CONDITION>         <!-- N=new, U=used -->
//       <NOTIFY>N</NOTIFY>
//     </ITEM>
//     …
//   </INVENTORY>
//
// We use a regex-driven parser rather than a full XML library — the
// schema is fixed, the data is small (typical wanted list = 10s to
// 100s of items), and every Lego user's file has been through the
// same BL tool so it's structurally consistent. If we ever hit
// pathological inputs we'll switch to fast-xml-parser; the parser
// signature stays the same.

export interface ParsedWantedItem {
  /** Item type. P=part, S=set, M=minifig, B=book, etc. */
  item_type: "P" | "S" | "M" | "B" | "G" | "C" | "I" | "O";
  /** BL design / set / fig number. For parts this is the same as the
   *  Rebrickable part_num — match through that catalog. */
  item_id: string;
  /** BL color id (numeric). Maps to Rebrickable's colors.id. Items
   *  without a color (sets, minifigs) get -1. */
  color_id: number;
  /** Quantity wanted. */
  min_qty: number;
  /** Per-unit price cap, or null if not set. */
  max_price: number | null;
  /** N=new, U=used, A=any. */
  condition: "N" | "U" | "A";
  /** Free-form notes the user put on the item. */
  remarks: string | null;
}

export interface WantedListParseResult {
  items: ParsedWantedItem[];
  warnings: string[];
}

export function parseWantedList(xml: string): WantedListParseResult {
  const warnings: string[] = [];
  const items: ParsedWantedItem[] = [];
  // ITEM blocks are line-anchored in well-formed BL output but we
  // handle arbitrary whitespace so a one-line minified file works.
  const itemRe = /<ITEM\b[^>]*>([\s\S]*?)<\/ITEM>/g;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(xml)) !== null) {
    const body = match[1] ?? "";
    const itemType = readTag(body, "ITEMTYPE") || "P";
    const itemId = readTag(body, "ITEMID");
    if (!itemId) {
      warnings.push("Skipped ITEM with no ITEMID");
      continue;
    }
    const colorRaw = readTag(body, "COLOR");
    const colorId = colorRaw === "" ? -1 : Number(colorRaw);
    const minQty = Number(readTag(body, "MINQTY") || "1");
    const maxPriceRaw = readTag(body, "MAXPRICE");
    const maxPrice = maxPriceRaw === "" ? null : Number(maxPriceRaw);
    const condition = (readTag(body, "CONDITION") || "A").toUpperCase();
    const remarks = readTag(body, "REMARKS") || null;

    if (!isValidItemType(itemType)) {
      warnings.push(`Skipped item ${itemId}: unknown ITEMTYPE ${itemType}`);
      continue;
    }
    if (!Number.isFinite(minQty) || minQty < 0) {
      warnings.push(`Item ${itemId}: invalid MINQTY ${minQty}, defaulting to 1`);
    }
    items.push({
      item_type: itemType as ParsedWantedItem["item_type"],
      item_id: itemId,
      color_id: Number.isFinite(colorId) ? colorId : -1,
      min_qty: Number.isFinite(minQty) && minQty > 0 ? minQty : 1,
      max_price: maxPrice !== null && Number.isFinite(maxPrice) ? maxPrice : null,
      condition: condition === "N" || condition === "U" ? condition : "A",
      remarks,
    });
  }
  return { items, warnings };
}

function readTag(body: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "i");
  const m = body.match(re);
  return (m?.[1] ?? "").trim();
}

function isValidItemType(t: string): boolean {
  return ["P", "S", "M", "B", "G", "C", "I", "O"].includes(t);
}
