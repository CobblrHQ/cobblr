// What a pattern says it needs: its yarns and its hooks or needles, read from
// the pattern's own text before any AI is asked.
//
// Published patterns state their materials in a handful of shapes, and a
// pattern that names "2 skeins 316 Soft White A" does not need a language
// model to be understood. The shapes this reads, each from a real free
// pattern PDF (the corpus in e2e/fixtures/pattern-photo-corpus/manifest.json):
//
//   Red Heart / Yarnspirations    RED HEART Super Saver:
//                                 2 skeins 316 Soft White A, 3 skeins 885 Delft Blue B
//   Yarnspirations (newer)        Main Color (MC) Christmas (7196)   10 O'Gos
//                                 Contrast A Cherry (7190)           3 O'Gos
//   Berroco                       2 Hanks BERROCO MOJO (100 grs), #8008 Enchantment
//                                 1 Hank each VINTAGE DK (100 grs), #2106 Smoke (MC), #2175 Fennel (A)
//                                 BERROCO STRATTO (50 g): 2 balls #12708 Heather
//   Free prose                    worsted weight 100% acrylic yarn … 3.50 mm crochet hook
//
// Lengths: a pattern states the length of ONE ball, sometimes per kind of
// colour ("Solids: 364 yds/333 m; Prints: 236 yds/215 m"). The need is then
// balls × length. When a pattern gives more than one per-ball length and the
// text does not say which kind a colour is, the length is left open and the
// choices are returned, never guessed: a solid read as a print is a third of
// the yarn short.
//
// Pure: text in, requirements out. The AI fallback and the storage live in
// pattern-needs.ts.

export type ToolKind = "hook" | "needle";

export interface YarnNeed {
  /** The pattern's own name for this yarn: "Main Color (MC)", "A", "Contrast A". */
  label: string | null;
  brand: string | null;
  /** The yarn line: "Super Saver O'Go", "Mojo", "Vintage DK". */
  product: string | null;
  color: string | null;
  color_code: string | null;
  /** A Craft Yarn Council weight in the Yarn table's own words ("4 – Worsted"). */
  weight: string | null;
  fiber: string | null;
  /** How many the pattern says to buy, in its own unit (first size when it lists sizes). */
  quantity: number | null;
  quantity_unit: string | null;
  /** Metres in one of those units, when the pattern says. */
  unit_length_m: number | null;
  /** Metres the pattern needs of this yarn, when it can be known. */
  length_m: number | null;
  /** When the pattern gives more than one per-unit length and does not say
   *  which applies to this colour ("solid" 333 m, "print" 215 m). */
  length_choices: { label: string; unit_length_m: number }[] | null;
}

export interface ToolNeed {
  kind: ToolKind;
  size_mm: number;
  /** The pattern's other name for the size ("US I/9", "M-13"), when given. */
  size_label: string | null;
}

export interface PatternMaterials {
  yarns: YarnNeed[];
  tools: ToolNeed[];
}

const M_PER_YD = 0.9144;

/** The Yarn table's weight choices, keyed by the words patterns use. */
const WEIGHT_WORDS: [RegExp, string][] = [
  [/\bsuper\s*bulky\b|\bjumbo\b|\(6\)|\b6\s*[-–]?\s*super bulky/i, "6 – Super Bulky"],
  [/\bbulky\b|\bchunky\b/i, "5 – Bulky"],
  [/\baran\b/i, "4 – Aran"],
  [/\bworsted\b|\bmedium\b|\bafghan\b/i, "4 – Worsted"],
  [/\bdk\b|\blight\s+worsted\b|\blight\b(?=\s*(?:weight|\d|\n|$))/i, "3 – DK"],
  [/\bsport\b/i, "2 – Sport"],
  [/\bfingering\b|\bsock\b|\bsuper\s*fine\b/i, "1 – Fingering"],
  [/\blace\b(?=\s*(?:weight|yarn|\d))/i, "0 – Lace"],
];

const FIBERS = ["Merino", "Wool", "Cotton", "Acrylic", "Nylon", "Chenille", "Alpaca", "Silk", "Linen", "Bamboo", "Cashmere", "Polyester", "Mohair"];

/** Straight quotes, no trademark marks, one space: what the regexes below read. */
export function normaliseText(text: string): string {
  return text
    .replace(/[®™©]/g, "")
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”˝″]/g, '"')
    .replace(/\t/g, " ")
    .replace(/ {2,}/g, " ")
    .replace(/\r/g, "");
}

const HEADING = /^\s*(materials|yarns?|ya\s?rn|hooks?|ho\s?o\s?k|needles?|notions|supplies|what you (?:will )?need|you will need)\s*:?\s*$/i;
// A heading that ends the materials: alone on its line (a "size 7 (4.50 mm)"
// needle line must not end the block), or "GAUGE:" opening a line.
const STOP = /^\s*(?:(gauges?|g\s?aug\s?e|abbreviations|instructions|notes?|finished (?:size|measurements)|f\s?in\s?is\s?he\s?d(?:\s+m\s?e\s?a\s?s\s?u\s?r\s?e\s?m\s?e\s?n\s?t\s?s)?|measurements?|sizes?|special stitches|construction notes|stitch guide|pattern notes|skill level)\s*:?\s*$|gauges?\s*:)/i;

/** The lines a pattern lists its materials in: each heading's block, and each
 *  line that opens with a yarn brand line ("RED HEART Super Saver:"). */
export function materialsBlocks(text: string): string[] {
  const lines = normaliseText(text).split("\n");
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const brandHeader = /^[A-Z][A-Z' ]{2,}[A-Za-z' ]*:\s*$/.test(line.trim()) && /\b(red heart|caron|bernat|lion brand|patons|berroco|lily|sugar'?n cream|premier|loops|hobbii|drops|cascade|malabrigo)\b/i.test(line);
    if (!HEADING.test(line) && !brandHeader) continue;
    const out: string[] = brandHeader ? [line] : [];
    for (let j = i + 1; j < lines.length && j <= i + 24; j++) {
      const l = lines[j]!;
      if (STOP.test(l) || /^--\s*\d+\s+of\s+\d+/.test(l)) break;
      if (HEADING.test(l) && j > i + 1 && !/^\s*(hooks?|ho\s?o\s?k|needles?)/i.test(l)) break;
      out.push(l);
    }
    blocks.push(out.join("\n"));
  }
  return blocks;
}

/** A pattern-wide weight: the Craft Yarn Council symbol ("MEDIUM" over "4"),
 *  or the one weight word the pattern's prose uses for its yarn. */
function patternWeight(text: string): string | null {
  const t = normaliseText(text);
  const sym = t.match(/\b(LACE|SUPER FINE|FINE|LIGHT|MEDIUM|BULKY|SUPER BULKY|JUMBO)\s*\n\s*([0-7])\s*\n/);
  if (sym) return weightFromWords(`${sym[1]} ${sym[2]}`);
  const prose = t.match(/\b(super bulky|bulky|chunky|aran|worsted|dk|sport|fingering)[- ]weight\b/i);
  return prose ? weightFromWords(prose[1]!) : null;
}

export function weightFromWords(s: string): string | null {
  // The Craft Yarn Council number, only beside its own word ("MEDIUM 4",
  // "(4) medium", "#4 worsted"): a stray "3.50 mm" is not a weight.
  const byNumber =
    s.match(/\b(?:lace|super fine|fine|light|medium|bulky|super bulky|jumbo)\s*[#(]?\s*([0-7])\b(?!\.\d)/i) ??
    s.match(/(?:^|[\s(#])\(?([0-7])\)?\s*[-–]?\s*(?:lace|super fine|fine|light|medium|bulky|super bulky|jumbo)\b/i);
  if (byNumber) {
    return ["0 – Lace", "1 – Fingering", "2 – Sport", "3 – DK", "4 – Worsted", "5 – Bulky", "6 – Super Bulky", "6 – Super Bulky"][Number(byNumber[1])] ?? null;
  }
  for (const [re, w] of WEIGHT_WORDS) if (re.test(s)) return w;
  return null;
}

function fiberIn(s: string): string | null {
  for (const f of FIBERS) if (new RegExp(`\\b${f}\\b`, "i").test(s)) return f;
  return null;
}

/** "364 yds/333 m", "236 yds (215 m)", "182 m", "200 yds": metres, preferring
 *  the pattern's own metric figure over a conversion. */
function lengthOf(s: string): number | null {
  const m = s.match(/(\d[\d,.]*)\s*m(?:eters?|etres?)?\b(?!m)/i);
  if (m) return Number(m[1]!.replace(/,/g, ""));
  const y = s.match(/(\d[\d,.]*)\s*(?:yds?|yards?)\b/i);
  return y ? Math.round(Number(y[1]!.replace(/,/g, "")) * M_PER_YD) : null;
}

/** Per-unit lengths a brand line states, by kind of colour when it splits them:
 *  "(Solids: 7 oz/198 g; 364 yds/333 m; Prints: 5 oz/141 g; 236 yds/215 m)". */
function unitLengths(block: string): { label: string; unit_length_m: number }[] {
  const flat = block.replace(/\n/g, " ");
  const out: { label: string; unit_length_m: number }[] = [];
  const kinds = /(solids?|solid colou?rs?|prints?(?:,? multis?)?(?:,? and heathers)?|multis?|heathers?|flecks?|ombres?|stripes?)\s*:?\s*(?:\d[\d.]*\s*oz\s*[\/(]\s*\d+\s*g\)?[,;]?\s*)?(\d[\d,.]*\s*yds?\s*[\/(]\s*\d[\d,.]*\s*m\)?|\d[\d,.]*\s*m\b)/gi;
  for (const k of flat.matchAll(kinds)) {
    const len = lengthOf(k[2]!);
    if (len) out.push({ label: normKind(k[1]!), unit_length_m: len });
  }
  if (out.length) return dedupeKinds(out);
  const one = flat.match(/(\d[\d,.]*\s*(?:yds?|yards?)\s*[\/(]\s*\d[\d,.]*\s*m(?:eters|etres)?\)?|\d[\d,.]*\s*m(?:eters|etres)?\s*[\/(]\s*\d[\d,.]*\s*yds?\)?)/i);
  const len = one ? lengthOf(one[1]!) : null;
  return len ? [{ label: "", unit_length_m: len }] : [];
}

function normKind(k: string): string {
  const s = k.toLowerCase();
  if (s.startsWith("solid")) return "solid";
  if (s.startsWith("print") || s.startsWith("multi") || s.startsWith("heather")) return "print";
  if (s.startsWith("fleck")) return "fleck";
  return s;
}

function dedupeKinds(xs: { label: string; unit_length_m: number }[]) {
  const seen = new Map<string, { label: string; unit_length_m: number }>();
  for (const x of xs) if (!seen.has(x.label)) seen.set(x.label, x);
  return [...seen.values()];
}

/** Which kind of colour a name says it is, when it says ("Monet Print"). */
function kindOfColour(name: string): string | null {
  if (/\b(print|multi|variegated|ombre|heather|stripes?)\b/i.test(name)) return /heather/i.test(name) ? "print" : "print";
  if (/\bfleck/i.test(name)) return "fleck";
  return null;
}

function applyLength(y: YarnNeed, units: { label: string; unit_length_m: number }[]): YarnNeed {
  if (units.length === 0) return y;
  let unit: number | null = null;
  if (units.length === 1) unit = units[0]!.unit_length_m;
  else {
    const kind = y.color ? kindOfColour(y.color) : null;
    const hit = kind ? units.find((u) => u.label === kind) : undefined;
    if (hit) unit = hit.unit_length_m;
  }
  if (unit == null) return { ...y, length_choices: units };
  return {
    ...y,
    unit_length_m: unit,
    length_m: y.quantity != null ? Math.round(y.quantity * unit) : null,
  };
}

// Capitalised or not ("2 Hanks BERROCO …"), without making the colour-name
// classes around it case-blind.
const UNIT = "([Ss]keins?|SKEINS?|[Bb]alls?|BALLS?|[Hh]anks?|HANKS?|[Cc]akes?|[Oo]'?[Gg]os?|[Cc]ones?|[Ss]pools?)";
/** Words that open the next item after a colour name: a colour is a name, not
 *  "Skimmer Straight knitting needles". */
const NEXT_ITEM = "(?:Straight|Circular|Double|Knitting|Crochet|Susan|Boye|Clover|Size|Sizes|Yarn|Tapestry|Stitch|St|Cable|Polyester|Safety|Scissors|OR|Note)\\b";

function unitWord(u: string): string {
  const s = u.toLowerCase().replace(/'/g, "");
  if (s.startsWith("skein")) return "skein";
  if (s.startsWith("hank")) return "hank";
  if (s.startsWith("cake")) return "cake";
  if (s.startsWith("cone")) return "cone";
  if (s.startsWith("spool")) return "spool";
  return "ball";
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/\bDk\b/g, "DK")
    .replace(/'S\b/g, "'s");
}

const BRANDS = ["Red Heart", "Caron", "Bernat", "Lion Brand", "Patons", "Berroco", "Lily Sugar'n Cream", "Premier", "Loops & Threads", "Hobbii", "Drops", "Cascade", "Malabrigo", "Paintbox", "Scheepjes", "Stylecraft", "King Cole", "Sirdar", "Knit Picks", "WeCrochet"];

function splitBrand(s: string): { brand: string | null; product: string | null } {
  const clean = s.replace(/[:,]\s*$/, "").replace(/\s+/g, " ").trim();
  for (const b of BRANDS) {
    const re = new RegExp(`^${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s*")}\\b\\s*(.*)$`, "i");
    const m = clean.match(re);
    if (m) return { brand: b, product: m[1] ? titleCase(m[1].replace(/,?\s*art\.?\s*\w+$/i, "").trim()) || null : null };
  }
  return { brand: null, product: clean ? titleCase(clean) : null };
}

function need(p: Partial<YarnNeed>): YarnNeed {
  return {
    label: null,
    brand: null,
    product: null,
    color: null,
    color_code: null,
    weight: null,
    fiber: null,
    quantity: null,
    quantity_unit: null,
    unit_length_m: null,
    length_m: null,
    length_choices: null,
    ...p,
  };
}

function firstNumber(q: string): number {
  return Number(q.match(/\d+(?:\.\d+)?/)![0]);
}

/** Yarns in one materials block. */
function yarnsIn(block: string, whole: string): YarnNeed[] {
  const flat = block.replace(/\s*\n\s*/g, " ");
  const out: YarnNeed[] = [];

  // A brand line the lines below belong to ("RED HEART Super Saver O'Go (Solids: …)").
  const brandLine = flat.match(/^\s*([A-Z][A-Za-z' ]*(?:red heart|caron|bernat|lion brand|patons|premier)[A-Za-z' ]*?)(?:\s*\(|:)/i)
    ?? flat.match(/((?:red heart|caron|bernat|lion brand|patons|premier)\b[A-Za-z' ]*?)(?:\s*\(|:)/i);
  const brandFromLine = brandLine ? splitBrand(brandLine[1]!) : { brand: null, product: null };
  const units = unitLengths(block + "\n" + whole.slice(0, 4000));

  // 1. "Main Color (MC) Christmas (7196) 10 O'Gos", "Contrast A Cherry (7190) 3 O'Gos"
  const labelled = /(Main Colou?r\s*\(MC\)|Contrast(?:\s+Colou?r)?\s+[A-Z]\b(?:\s*\(CC\d?\))?|Colou?r\s+[A-Z]\b|\bMC\b|\bCC\d?\b)\s+([A-Z][A-Za-z' ]*?)\s*\((\d{3,6})\)\s+(\d+(?:\.\d+)?)\s*(?:x\s*)?([A-Za-z']+)/g;
  for (const m of flat.matchAll(labelled)) {
    out.push(
      applyLength(
        need({
          label: m[1]!.replace(/\s+/g, " "),
          ...brandFromLine,
          color: m[2]!.trim(),
          color_code: m[3]!,
          quantity: Number(m[4]),
          quantity_unit: unitWord(m[5]!),
        }),
        units,
      ),
    );
  }
  if (out.length) return out;

  // 2. "2 skeins 316 Soft White A, 3 skeins 885 Delft Blue B"
  const listed = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${UNIT}\\s+(?:#?(\\d{3,6})\\s+)?([A-Z][A-Za-z' ]*?)\\s+(MC|CC\\d?|[A-Z])(?=\\s*[,.;]|\\s*$|\\s+(?:and\\s+)?\\d|\\s+${NEXT_ITEM}|\\s+[A-Z][a-z]+\\s+[A-Z][a-z]+:)`, "g");
  for (const m of flat.matchAll(listed)) {
    out.push(
      applyLength(
        need({
          label: m[5]!,
          ...brandFromLine,
          color: m[4]!.trim(),
          color_code: m[3] ?? null,
          quantity: Number(m[1]),
          quantity_unit: unitWord(m[2]!),
        }),
        units,
      ),
    );
  }
  if (out.length) return out;

  // 3. Berroco: "2 Hanks BERROCO MOJO (100 grs), #8008 Enchantment",
  //    "5(6-6-7) Balls BERROCO FOLIO (50 grs), #4534 Mount Desert",
  //    "1 Hank each VINTAGE DK (100 grs), #2106 Smoke (MC), #2175 Fennel (A) and #2194 Breezeway (B)"
  const berroco = new RegExp(`(\\d+(?:\\.\\d+)?(?:\\s*\\([\\d\\s\\-–,]+\\))?)\\s*${UNIT}\\s+(each\\s+)?(?:of\\s+)?([A-Z][A-Z'&\\s]+?)\\s*\\(\\s*(\\d+)\\s*(?:g|grs?|grams)\\s*\\)\\s*[,:]?\\s*((?:#\\d+[^#]*)+)`, "g");
  for (const m of flat.matchAll(berroco)) {
    const qty = firstNumber(m[1]!);
    const { brand, product } = splitBrand(m[4]!);
    const colours = [...m[6]!.matchAll(new RegExp(`#(\\d+)\\s+([A-Z][A-Za-z']*(?:\\s+(?!${NEXT_ITEM})[A-Z][A-Za-z']*){0,2})(?:\\s*\\((MC|CC\\d?|[A-Z])\\))?`, "g"))];
    const each = !!m[3] || colours.length === 1;
    for (const c of colours) {
      out.push(
        applyLength(
          need({
            label: c[3] ?? null,
            brand: brand ?? brandNamedIn(whole),
            product,
            color: c[2]!.trim(),
            color_code: c[1]!,
            quantity: each ? qty : null,
            quantity_unit: unitWord(m[2]!),
          }),
          units,
        ),
      );
    }
  }
  if (out.length) return out;

  // 4. "BERROCO STRATTO (50 g): 2 balls #12708 Heather"
  const brandFirst = new RegExp(`([A-Z][A-Z'&\\s]{2,}?)\\s*\\(\\s*\\d+\\s*(?:g|grs?)\\s*\\)\\s*:?\\s*(\\d+(?:\\.\\d+)?)\\s*${UNIT}\\s+#?(\\d{3,6})\\s+([A-Z][A-Za-z' ]*?[a-z])(?=\\s*[,.;]|\\s*$|\\s+[A-Z][a-z]+:|\\s+Note\\b)`, "g");
  for (const m of flat.matchAll(brandFirst)) {
    const { brand, product } = splitBrand(m[1]!);
    out.push(applyLength(need({ brand, product, quantity: Number(m[2]), quantity_unit: unitWord(m[3]!), color_code: m[4]!, color: m[5]!.trim() }), units));
  }
  if (out.length) return out;

  // 5. Prose: "worsted weight … yarn", with a fibre and a brand when it names them.
  if (/\byarn\b/i.test(flat)) {
    const weight = weightFromWords(flat);
    if (weight) {
      // "You can use the brand of worsted weight yarn of your choice. I
      // personally used Loops & Threads Impeccable": the brand is what the
      // designer happened to use, not what the pattern needs, so it rides as
      // the label and any yarn of the weight is the yarn.
      const used = flat.match(/\bused (?:the brand )?([A-Z][A-Za-z&' ]+?)(?:\s*[–-]\s*([A-Z][A-Za-z' ]+))?\s*\./);
      const anyBrand = /\b(of your choice|any (?:brand|yarn))\b/i.test(flat);
      const brandSplit = used ? splitBrand(used[1]!) : { brand: null, product: null };
      const named = [brandSplit.brand ?? brandSplit.product, used?.[2]?.trim()].filter(Boolean).join(" ");
      out.push(
        need({
          weight,
          fiber: fiberNearYarn(flat) ?? fiberNearYarn(whole),
          ...(anyBrand
            ? { label: named ? `Designer used ${named}` : null }
            : { brand: brandSplit.brand ?? brandSplit.product, product: used?.[2]?.trim() ?? null }),
        }),
      );
    }
  }
  return out;
}

/** The one yarn brand a pattern names, when it names exactly one: a publisher's
 *  own pattern lists "VINTAGE DK" under a page that says Berroco throughout. */
function brandNamedIn(text: string): string | null {
  const t = normaliseText(text);
  const hits = BRANDS.filter((b) => new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t));
  return hits.length === 1 ? hits[0]! : null;
}

/** "100% acrylic yarn" anywhere in the pattern. */
function fiberNearYarn(text: string): string | null {
  const m = normaliseText(text).match(/(\d+%\s*)?([A-Za-z]+)\s+yarn\b/gi);
  for (const hit of m ?? []) {
    const f = fiberIn(hit);
    if (f) return f;
  }
  return null;
}

/** Hooks and needles in one block: every "N mm" with the nearest tool word. */
function toolsIn(block: string): ToolNeed[] {
  const flat = block.replace(/\s*\n\s*/g, " ");
  const out: ToolNeed[] = [];
  for (const m of flat.matchAll(/(\d+(?:\.\d+)?)\s*mm\b/gi)) {
    const at = m.index ?? 0;
    const before = flat.slice(Math.max(0, at - 70), at);
    const after = flat.slice(at, at + 70);
    const hookBefore = before.search(/hook[^.]*$/i) >= 0 ? before.length - before.search(/hook[^.]*$/i) : Infinity;
    const hookAfter = after.search(/\bhook/i) >= 0 ? after.search(/\bhook/i) : Infinity;
    const needleRe = /(?<!yarn |tapestry |darning |sewing |cable )\b(?:knitting )?needles?\b|\bdpns?\b/i;
    const nb = [...before.matchAll(new RegExp(needleRe.source, "gi"))].pop();
    const needleBefore = nb ? before.length - (nb.index ?? 0) : Infinity;
    const na = after.match(needleRe);
    const needleAfter = na ? (na.index ?? Infinity) : Infinity;
    if (/\b(safety eyes?|eyes|buttons?|beads?|stitch markers?)\b/i.test(after.slice(0, 25))) continue;
    const hookD = Math.min(hookBefore, hookAfter);
    const needleD = Math.min(needleBefore, needleAfter);
    if (hookD === Infinity && needleD === Infinity) continue;
    const kind: ToolKind = hookD <= needleD ? "hook" : "needle";
    const size = Number(m[1]);
    if (!(size > 0 && size < 30)) continue;
    const label =
      (before.match(/(?:U\.?S\.?\s*(?:size\s*)?|sizes?\s+|(?:and|,)\s+)(\d{1,2}½|[A-Z]\/\d{1,2}|[A-Z]-\d{1,2}|[A-Z]?\d{1,2}(?:\/\d{1,2})?)\s*[\(\[\/]?\s*$/i)?.[1]) ??
      (after.match(/^\d+(?:\.\d+)?\s*mm\s*[\)\]]?\s*[\[(]\s*(?:U\.?S\.?\s*)?([A-Z]-?\d{1,2}(?:\/\d+)?)\s*[\])]/i)?.[1]) ??
      null;
    if (!out.some((t) => t.kind === kind && t.size_mm === size)) {
      out.push({ kind, size_mm: size, size_label: label ? `US ${label.replace(/^U\.?S\.?\s*/i, "")}` : null });
    }
  }
  return out;
}

/** The yarns and tools a pattern's text states. Empty when it states none in
 *  a shape this knows; the caller then asks the AI. */
export function readPatternMaterials(text: string): PatternMaterials {
  const blocks = materialsBlocks(text);
  const weight = patternWeight(text);
  const yarns: YarnNeed[] = [];
  const tools: ToolNeed[] = [];
  for (const b of blocks) {
    for (const y of yarnsIn(b, text)) {
      const dup = yarns.some((x) => x.color === y.color && x.color_code === y.color_code && x.weight === y.weight && x.label === y.label && x.product === y.product);
      if (!dup) yarns.push(y);
    }
    for (const t of toolsIn(b)) if (!tools.some((x) => x.kind === t.kind && x.size_mm === t.size_mm)) tools.push(t);
  }
  if (weight) for (const y of yarns) if (!y.weight) y.weight = weight;
  return { yarns, tools };
}
