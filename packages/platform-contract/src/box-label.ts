// A box's own label, read with no model (#5764). A filament box prints its
// product line ("PETG Basic"), its colour ("Dark Blue (深蓝色)"), a SKU and a
// batch number. Read off a photo of the box by the OCR engine, that text is
// the best source of what the box holds: better than a photo of a whole pack,
// and free. OCR misreads in known ways ("NPETGO87" for NPETG087, "832051101"
// for B32051101), so the reader normalises them; what it cannot read it says
// is unread, never a guess.
//
// Which colour a box is comes from what it can be: the units a known pack
// holds, or the single colours its store sells, each with its SKU. A SKU names
// one of them outright; the colour words must equal a unit's colour exactly,
// so "Green" is never "Grass Green".

export interface BoxLabel {
  /** The product line printed on the box ("PETG Basic"), or null. */
  line: string | null;
  /** The colour words before the bracketed translation ("Dark Blue"). */
  colour_words: string | null;
  /** The SKU, normalised ("KR-PETG019Y-1CH", "NPETG087"), or null. */
  sku: string | null;
  /** The batch number, normalised ("B32051101"), or null when unreadable. */
  batch: string | null;
  /** The reading's letters and digits only, upper case: where a SKU too
   *  broken to read whole can still be found as a known SKU's tail. */
  plain?: string;
}

/** One thing a box can be: its colour as the store sells it, the colour the
 *  box prints when it differs, and its SKU when known. */
export interface BoxChoice {
  colour: string;
  label_colour?: string | null;
  sku?: string | null;
}

const LINE = /\b(PETG|PLA\+?|ABS|ASA|TPU|PETG-CF|PLA-CF)\s*(Basic|Plus|Pro|Silk|Matte|HF|Rapid)?\b/i;

/** OCR's letter-for-digit mistakes, undone inside a number. */
function digits(s: string): string {
  return s.replace(/[OQD]/g, "0").replace(/[Il|]/g, "1").replace(/S/g, "5").replace(/B/g, "8");
}

/** A SKU as the store writes it: letters, then digits, then an optional
 *  letter and suffix ("KR-PETG019Y-1CH", "NPETG087"). OCR's spaces inside it
 *  are taken out and its letter-for-digit mistakes undone. */
function readSku(text: string): string | null {
  const at = text.search(/S\s*K\s*U/i);
  if (at < 0) return null;
  const rest = text.slice(at).split(/\n/)[0]!.replace(/^S\s*K\s*U\s*[:.\-]?\s*/i, "").toUpperCase().replace(/\s+/g, "");
  // Three digits, sometimes behind a stray letter OCR saw in front of them
  // ("KR-PETGQO26Y" is 026).
  const m = rest.match(/^([A-Z]+(?:-[A-Z]+)*?)([0-9OQDISB]{3,4})([A-Z])?(?:-?1[C0O][H])?/);
  if (!m) return null;
  const prefix = m[1]!;
  const num = digits(m[2]!.slice(-3));
  if (!/^\d{3}$/.test(num) || prefix.length < 3) return null;
  const suffix = m[3] ?? "";
  return `${prefix}${num}${suffix}${/-?1[C0O]H/.test(rest) ? "-1CH" : ""}`;
}

/** The batch after "Batch No.", a B and seven or more digits; an 8 OCR read
 *  for the B is put back. */
function readBatch(text: string): string | null {
  const m = text.match(/Batch\s*N[o0]\s*[.,:;'‘’"°\s]*([B8][0-9OQDIS]{6,}[0-9A-Z]?)/i);
  if (!m) return null;
  const raw = m[1]!.toUpperCase();
  const body = digits(raw.slice(1, raw.length - (/[A-Z]$/.test(raw) && !/[OQDIS]$/.test(raw) ? 1 : 0)));
  const tail = /[A-Z]$/.test(raw) && !/[OQDIS]$/.test(raw) ? raw.slice(-1) : "";
  return /^\d{7,}$/.test(body) ? `B${body}${tail}` : null;
}

/** The colour words: the letters before a bracket on their own line, the
 *  line under the product line. */
function readColourWords(text: string): string | null {
  for (const raw of text.split(/\n/)) {
    const line = raw.trim();
    if (!line || LINE.test(line) || /SKU|Batch|Temp|Diameter/i.test(line)) continue;
    // OCR reads an l as ! or | inside a word ("Ye! low" is Yellow).
    const m = line.replace(/(?<=[A-Za-z])[!|](?=\s*[A-Za-z])/g, "l").match(/^([A-Za-z][A-Za-z ]{1,30}?)\s*[(（]/);
    if (m) return m[1]!.replace(/\s+/g, " ").trim();
  }
  return null;
}

export function readBoxLabel(text: string | null | undefined): BoxLabel {
  const t = text ?? "";
  const line = t.match(LINE);
  return {
    line: line ? `${line[1]!.toUpperCase()}${line[2] ? ` ${line[2][0]!.toUpperCase()}${line[2].slice(1).toLowerCase()}` : ""}` : null,
    colour_words: readColourWords(t),
    sku: readSku(t),
    batch: readBatch(t),
    plain: t.toUpperCase().replace(/[^A-Z0-9]/g, ""),
  };
}

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
/** The part of a SKU that names the colour ("PETG019Y", "NPETG087"): the
 *  store's own image files and the box agree on it, whatever the suffix. */
export const skuCore = (s: string | null | undefined): string => norm(s).replace(/^kr/, "").replace(/1ch$/, "");

/** Which of `choices` this box is, or null. The SKU first (it names one
 *  outright), then the colour words, equal to a choice's colour or the
 *  colour its box prints, whole: "Green" never matches "Grass Green". */
export function boxChoice(label: BoxLabel, choices: readonly BoxChoice[]): BoxChoice | null {
  if (label.sku) {
    const bySku = choices.filter((c) => c.sku && skuCore(c.sku) === skuCore(label.sku));
    if (bySku.length === 1) return bySku[0]!;
  }
  // A SKU too broken to read whole ("G016Y-1CH" with its front cut off):
  // a known SKU's last five, found in the reading, settles it only when no
  // other choice's would.
  if (label.plain) {
    const tails = choices.filter((c) => c.sku && skuCore(c.sku).length >= 5 && label.plain!.includes(skuCore(c.sku).slice(-5).toUpperCase()));
    if (tails.length === 1) return tails[0]!;
  }
  if (label.colour_words) {
    const w = norm(label.colour_words);
    const byWords = choices.filter((c) => norm(c.label_colour) === w || norm(c.colour) === w);
    if (byWords.length === 1) return byWords[0]!;
  }
  return null;
}

/** A store's single-colour variants as box choices: the SKU is the variant
 *  photo's file name ("KR-PETG019Y-1CH-_-10.jpg" is Blue's), the colour its
 *  option value. */
export function storeChoices(variants: ReadonlyArray<{ colour: string; photo: string | null }>): BoxChoice[] {
  return variants.map((v) => {
    const sku = v.photo?.match(/\b((?:KR-)?[A-Z]+\d{3}[A-Z]?(?:-1CH)?)[-_]/i)?.[1] ?? null;
    return { colour: v.colour, ...(sku ? { sku: sku.toUpperCase() } : {}) };
  });
}

/** One box from two independent readings of its label (frame and fine),
 *  settled against what the box can be: each reading names a choice on its
 *  own, and a box the two readings name differently is unread. The batch
 *  counts only where both readings read it the same, because one reading can
 *  turn a 1 into a 2 and still look like a batch. The part number is the
 *  settled choice's SKU, never one reading's. */
export function boxFromReadings(frame: string | null | undefined, fine: string | null | undefined, choices: readonly BoxChoice[]): { choice: BoxChoice | null; batch: string | null; line: string | null } {
  const a = readBoxLabel(frame);
  const b = readBoxLabel(fine);
  const ca = boxChoice(a, choices);
  const cb = boxChoice(b, choices);
  return {
    choice: ca && cb ? (ca === cb ? ca : null) : (ca ?? cb),
    batch: a.batch && b.batch && a.batch === b.batch ? a.batch : null,
    line: a.line ?? b.line,
  };
}
