// What a scan already knows about a record's fields, by what each field
// MEANS rather than what it is called (#3990 item 8).
//
// - A field whose role is `identifier` (a filament type's UPC, a set's
//   number) gets the product barcode that was scanned, when it is empty. A
//   field that names a decoder (`decode_role: identifier:isbn`) gets only a
//   code of that kind; one that names none gets a retail product code
//   (UPC/EAN), never a URL, a store's own label or an Amazon FNSKU.
// - A field with declared choices gets the one choice the item's name plainly
//   says ("1.75mm" is the "1.75 mm" choice, "1kg" the "1 kg" one), when it is
//   empty and exactly one choice matches. Two matches say nothing.
// Neither ever overwrites a value, and neither writes a colour: a colour
// field is the colour rule's (@cobblr/platform-contract/colour).
import { classifyScanCode } from "./scan-router.js";

export interface FactFieldDef {
  name: string;
  type?: string | null;
  choices?: readonly string[] | null;
  field_role?: string | null;
  decode_role?: string | null;
  renderer?: string | null;
}

const isEmpty = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/** The identifier fields a scanned code fills. */
export function identifierFromScan(
  code: string | null | undefined,
  defs: readonly FactFieldDef[],
  meta: Readonly<Record<string, unknown>>,
): Record<string, string> {
  if (!code) return {};
  const c = classifyScanCode(code);
  const out: Record<string, string> = {};
  for (const d of defs) {
    if (d.field_role !== "identifier" || !isEmpty(meta[d.name])) continue;
    const wants = d.decode_role?.startsWith("identifier:") ? d.decode_role.slice("identifier:".length) : null;
    const fits = wants ? wants === c.type : c.type === "upc";
    if (fits) out[d.name] = c.code;
  }
  return out;
}

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, "");

/** The choice fields an item's name plainly fills. */
export function choicesNamedIn(
  name: string | null | undefined,
  defs: readonly FactFieldDef[],
  meta: Readonly<Record<string, unknown>>,
): Record<string, string> {
  if (!name) return {};
  // The name's words, each also with its neighbour joined ("1.75" + "mm").
  const words = name.toLowerCase().split(/[\s,;/()]+/).filter(Boolean);
  const tokens = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    tokens.add(words[i]!);
    if (i + 1 < words.length) tokens.add(words[i]! + words[i + 1]!);
  }
  const out: Record<string, string> = {};
  for (const d of defs) {
    if (!d.choices?.length || d.renderer === "color-hex" || !isEmpty(meta[d.name])) continue;
    const hits = d.choices.filter((ch) => ch.toLowerCase() !== "other" && tokens.has(squash(ch)));
    if (hits.length === 1) out[d.name] = hits[0]!;
  }
  return out;
}
