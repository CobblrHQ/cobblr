// A measured value: a number with an SI unit, as an electronics person types
// it ("10k", "4k7", "100n", "2.2µF", "16 V", "0,1 µF") and as every door reads
// it: the field editor, search, list filters and sort, imports, scan and the
// assistant. ONE parser, here, so "4k7" means 4.7 kΩ everywhere or nowhere.
//
// Stored as { value, unit, text }: `value` is the plain SI number (4700 for
// 4.7 kΩ, 1e-7 for 100 nF), `unit` the catalog code ("ohm", "farad") or null
// when the person gave none, `text` what they typed. Shown with the prefix that
// reads best ("0.0001 F" shows as "100 µF").

/** The units a measured value is in: catalog codes, with every spelling a
 *  person might type for them. The core-units catalog lists these same codes. */
export const MEASURE_UNITS = [
  { code: "ohm", symbol: "Ω", name: "ohm", plural: "ohms", category: "electrical", spellings: ["Ω", "ω", "ohm", "ohms", "Ohm", "Ohms", "R"] },
  { code: "farad", symbol: "F", name: "farad", plural: "farads", category: "electrical", spellings: ["F", "f", "farad", "farads"] },
  { code: "henry", symbol: "H", name: "henry", plural: "henries", category: "electrical", spellings: ["H", "h", "henry", "henries", "henrys"] },
  { code: "volt", symbol: "V", name: "volt", plural: "volts", category: "electrical", spellings: ["V", "v", "volt", "volts"] },
  { code: "amp", symbol: "A", name: "amp", plural: "amps", category: "electrical", spellings: ["A", "a", "amp", "amps", "ampere", "amperes"] },
  { code: "watt", symbol: "W", name: "watt", plural: "watts", category: "electrical", spellings: ["W", "w", "watt", "watts"] },
  { code: "hertz", symbol: "Hz", name: "hertz", plural: "hertz", category: "electrical", spellings: ["Hz", "hz", "HZ", "hertz"] },
  // Lengths: a socket, a bolt, a shelf. Kept in the unit they are measured
  // in, never moved to SI metres, so an inch stays an inch ("3/8 in", not
  // "9.525 mm"). The codes are the units catalog's own.
  { code: "millimeter", symbol: "mm", name: "millimetre", plural: "millimetres", category: "length", spellings: ["mm", "millimetre", "millimeter", "millimetres", "millimeters"] },
  { code: "inch", symbol: "in", name: "inch", plural: "inches", category: "length", spellings: ["in", "inch", "inches", '"', "″"] },
] as const;


/** Units counted as they are, without SI prefixes: 25.4 mm is never "2.54 cm"
 *  and an inch is shown as the fraction a tool is sold by. */
const UNPREFIXED = new Set<string>(["millimeter", "inch"]);

export type MeasureUnitCode = (typeof MEASURE_UNITS)[number]["code"];

/** A measured value as stored. */
export interface Measure {
  /** The plain SI number: 4700 for 4.7 kΩ, 1e-7 for 100 nF. */
  value: number;
  /** The unit's catalog code, or null when none was given or implied. */
  unit: string | null;
  /** What the person typed, kept for display on hover. */
  text: string;
}

const PREFIXES: Record<string, number> = {
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  µ: 1e-6,
  μ: 1e-6,
  m: 1e-3,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
};
const PREFIX_WORDS: Record<string, number> = { pico: 1e-12, nano: 1e-9, micro: 1e-6, milli: 1e-3, kilo: 1e3, mega: 1e6, giga: 1e9 };

const unitBySpelling = new Map<string, string>();
for (const u of MEASURE_UNITS) for (const s of u.spellings) unitBySpelling.set(s, u.code);
const unitByWord = new Map<string, string>();
for (const u of MEASURE_UNITS) for (const s of [u.name, u.plural, ...u.spellings.filter((x) => x.length > 2)]) unitByWord.set(s.toLowerCase(), u.code);

/** A unit spelling (any case for words, exact for one-letter symbols), to its code. */
function unitOf(s: string): string | null {
  if (!s) return null;
  return unitBySpelling.get(s) ?? unitByWord.get(s.toLowerCase()) ?? null;
}

/** A field's declared unit, as the code a measured value carries: "Ω",
 *  "ohms" and "ohm" are all "ohm". A unit outside the electrical set ("mm")
 *  is kept as written, so a length still reads as a length. */
export function measureUnitCode(unit: string | null | undefined): string | null {
  const u = unit?.trim();
  if (!u) return null;
  return unitOf(u) ?? u;
}

/** The unit a bare prefixed value means in electronics, when none is given:
 *  R, k, M and G are resistance ("10k", "4k7", "1M5"); p, n and µ are
 *  capacitance ("100n", "4n7"). A bare number means nothing in particular. */
export function impliedUnit(prefix: string | null): string | null {
  if (!prefix) return null;
  if (prefix === "R" || prefix === "k" || prefix === "K" || prefix === "M" || prefix === "G") return "ohm";
  if (prefix === "p" || prefix === "n" || prefix === "u" || prefix === "µ" || prefix === "μ") return "farad";
  return null;
}

/** "1,5" and "1.5" are the same number; a thousands separator is not read. */
function num(s: string): number {
  return Number(s.replace(",", "."));
}

/** Read a measured value, or null when the text is not one.
 *  `unit` is the field's unit: a bare number ("10") takes it, and a value in
 *  another unit is still read (and kept in that unit). */
export function parseMeasure(input: unknown, opts: { unit?: string | null } = {}): Measure | null {
  const fieldUnit = measureUnitCode(opts.unit);
  if (typeof input === "number") return Number.isFinite(input) ? { value: input, unit: fieldUnit, text: String(input) } : null;
  if (typeof input !== "string") return null;
  const text = input.trim();
  if (!text || text.length > 40) return null;
  const compact = text.replace(/\s+/g, " ");

  // A fraction, as inch sizes are written: "3/8", "3/8 in", "5/8\"", and a
  // whole number with one, "1-1/4 in". A bare fraction takes the field's unit.
  const frac = /^(?:(\d+)[- ])?(\d+)\s*\/\s*(\d+)\s*(.*)$/.exec(compact);
  if (frac) {
    const [, whole, top, bottom, unitText] = frac as unknown as [string, string | undefined, string, string, string];
    if (Number(bottom) === 0) return null;
    const unit = unitText ? unitOf(unitText.trim()) : fieldUnit;
    if (unitText && !unit) return null;
    return { value: clean(Number(whole ?? 0) + Number(top) / Number(bottom)), unit, text };
  }

  // RKM (IEC 60062): the prefix letter stands for the decimal point.
  // "4k7" = 4.7 k, "2R2" = 2.2 Ω, "1M5" = 1.5 M, "4n7" = 4.7 n.
  const rkm = /^(\d+)([RKkMGmunpµμ])(\d+)\s*([A-Za-zΩω]*)$/.exec(compact);
  if (rkm) {
    const [, whole, p, frac, unitText] = rkm as unknown as [string, string, string, string, string];
    const scale = p === "R" ? 1 : PREFIXES[p]!;
    const unit = unitText ? unitOf(unitText) : (fieldUnit ?? impliedUnit(p));
    if (unitText && !unit) return null;
    return { value: clean(Number(`${whole}.${frac}`) * scale), unit, text };
  }

  // A number, then an optional prefix (letter or word) and unit, with or
  // without a space: "100n", "100 nF", "2.2µF", "10 kilohm", "16V", "0,1 µF".
  const m = /^([+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:[eE][+-]?\d+)?)\s*(.*)$/.exec(compact);
  if (!m) return null;
  const n = num(m[1]!);
  if (!Number.isFinite(n)) return null;
  let rest = (m[2] ?? "").trim();
  if (!rest) return { value: n, unit: fieldUnit, text };

  // The whole rest is a unit ("16 V", "10 ohm", "50 Hz", "10 mm").
  const whole = unitOf(rest);
  if (whole) return { value: n, unit: whole, text };
  // A prefix word ("kilo" in "kilohm", "micro" in "microfarad").
  for (const [word, scale] of Object.entries(PREFIX_WORDS)) {
    if (rest.toLowerCase().startsWith(word)) {
      const after = rest.slice(word.length).replace(/^\s+/, "");
      const unit = after ? unitOf(after) ?? unitOf(`o${after}`) : null;
      if (after && !unit) return null;
      return { value: clean(n * scale), unit: unit ?? fieldUnit, text };
    }
  }
  // A one-letter prefix, then a unit or nothing ("100n", "100nF", "2.2µF", "10k").
  const p = rest[0]!;
  if (p in PREFIXES) {
    rest = rest.slice(1).trim();
    if (!rest) return { value: clean(n * PREFIXES[p]!), unit: fieldUnit ?? impliedUnit(p), text };
    const unit = unitOf(rest);
    if (!unit) return null;
    return { value: clean(n * PREFIXES[p]!), unit, text };
  }
  return null;
}

/** Floating point noise out: 4.7 * 1000 is 4700, not 4700.000000000001. */
function clean(v: number): number {
  return Number(v.toPrecision(12));
}

/** Inches the way a tool is labelled: 0.375 is "3/8", 1.25 is "1-1/4", and a
 *  size no 64th describes is a decimal. */
function inchText(v: number): string {
  const sixtyfourths = Math.round(v * 64);
  if (Math.abs(sixtyfourths - v * 64) > 1e-6) return String(Number(v.toPrecision(4)));
  const whole = Math.floor(sixtyfourths / 64);
  let top = sixtyfourths % 64;
  let bottom = 64;
  while (top > 0 && top % 2 === 0) {
    top /= 2;
    bottom /= 2;
  }
  if (top === 0) return String(whole);
  return whole ? `${whole}-${top}/${bottom}` : `${top}/${bottom}`;
}

const DISPLAY_PREFIXES: Array<[number, string]> = [
  [1e9, "G"],
  [1e6, "M"],
  [1e3, "k"],
  [1, ""],
  [1e-3, "m"],
  [1e-6, "µ"],
  [1e-9, "n"],
  [1e-12, "p"],
];

/** The value with the prefix that reads best: 1e-4 F is "100 µF", 4700 Ω is
 *  "4.7 kΩ", a value with no unit "4.7k". */
export function formatMeasure(m: Pick<Measure, "value" | "unit">): string {
  if (m.unit === "inch") return `${inchText(m.value)} in`;
  if (m.unit && UNPREFIXED.has(m.unit)) return `${Number(m.value.toPrecision(4))} ${MEASURE_UNITS.find((u) => u.code === m.unit)?.symbol ?? m.unit}`;
  const sym = m.unit ? (MEASURE_UNITS.find((u) => u.code === m.unit)?.symbol ?? m.unit) : "";
  const abs = Math.abs(m.value);
  if (abs === 0) return sym ? `0 ${sym}` : "0";
  const [scale, prefix] = DISPLAY_PREFIXES.find(([s]) => abs >= s * 0.9999999) ?? DISPLAY_PREFIXES[DISPLAY_PREFIXES.length - 1]!;
  const mantissa = Number((m.value / scale).toPrecision(4));
  const shown = String(mantissa);
  return sym ? `${shown} ${prefix}${sym}` : `${shown}${prefix}`;
}

/** Search's tolerance: ±1%, so an E-series value rounded on a label still
 *  matches. A list filter compares exactly. */
export const MEASURE_SEARCH_TOLERANCE = 0.01;

/** The range a searched value matches, and the unit it must be in: the query's
 *  own unit, or the one its prefix implies ("10k" is resistance), or any. */
export function measureSearchRange(q: Measure, tolerance = MEASURE_SEARCH_TOLERANCE): { lo: number; hi: number; unit: string | null } {
  const spread = Math.abs(q.value) * tolerance;
  return { lo: q.value - spread, hi: q.value + spread, unit: q.unit };
}

/** Does a stored value answer a searched one: the same value within the
 *  tolerance, and the same unit when both have one. "10k" (resistance) never
 *  finds a 10 kHz crystal; a stored value with no unit answers any. */
export function measureMatches(query: Measure, stored: Pick<Measure, "value" | "unit">, tolerance = MEASURE_SEARCH_TOLERANCE): boolean {
  const r = measureSearchRange(query, tolerance);
  if (query.unit && stored.unit && query.unit !== stored.unit) return false;
  return stored.value >= Math.min(r.lo, r.hi) && stored.value <= Math.max(r.lo, r.hi);
}

/** A stored value read back, whatever shape it reached the field in: a
 *  measure object, a number, or text that parses. */
export function asMeasure(v: unknown, unit?: string | null): Measure | null {
  if (v && typeof v === "object" && typeof (v as { value?: unknown }).value === "number") {
    const o = v as { value: number; unit?: unknown; text?: unknown };
    // A value kept before its unit was in the list ("mm") reads as the code
    // the list gives it now ("millimeter").
    const u = typeof o.unit === "string" ? measureUnitCode(o.unit) : null;
    return { value: o.value, unit: u, text: typeof o.text === "string" ? o.text : formatMeasure({ value: o.value, unit: u }) };
  }
  return parseMeasure(v, { unit: unit ?? null });
}

/** A search query read for values: each word that is a measured value with a
 *  unit (said or implied: "10k", "100 nF", "16V"), and the words that are not.
 *  A number and the unit after it are one value ("4700 Ω", "100 nF"). A bare
 *  number is a word, never a value: "4700" might be a part number. Null when
 *  no word is a value, so a search without one runs exactly as before. */
export function measureTokens(q: string): { values: Array<{ text: string; measure: Measure }>; words: string[] } | null {
  const tokens = q.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.length > 12) return null;
  const values: Array<{ text: string; measure: Measure }> = [];
  const words: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const one = tokens[i]!;
    const next = tokens[i + 1];
    const alone = parseMeasure(one);
    if (next !== undefined && (!alone || !alone.unit)) {
      const pair = parseMeasure(`${one} ${next}`);
      // "100 in a box" is not a hundred inches: in running text a spaced
      // "in" counts after a fraction or a decimal ("3/8 in", "0.5 in") only.
      const looseIn = next === "in" && /^\d+$/.test(one);
      if (pair?.unit && !looseIn) {
        values.push({ text: `${one} ${next}`, measure: pair });
        i++;
        continue;
      }
    }
    if (alone?.unit) values.push({ text: one, measure: alone });
    else words.push(one);
  }
  return values.length ? { values, words } : null;
}

/** One value read off a record: which field it came from ("name", "notes" or
 *  a custom field's key), the SI number, and its unit. */
export interface MeasureReading {
  field: string;
  value: number;
  unit: string | null;
}

/** Every measured value a record holds, read without changing it: a measure
 *  field's value, a text field that reads as a value with a unit ("10k",
 *  "100nF"), and each value named in its title or notes ("Resistor 4k7 1%").
 *  A bare number or a word is no reading: "4700" might be a part number. This
 *  is what search, sort and filter read for the records whose values are
 *  still text, so old records answer "4k7" without anybody retyping them. */
export function measureReadings(record: { texts?: Record<string, string | null | undefined>; metadata?: unknown }): MeasureReading[] {
  const out: MeasureReading[] = [];
  for (const [field, text] of Object.entries(record.texts ?? {})) {
    if (typeof text !== "string" || !text.trim()) continue;
    for (const v of measureTokens(text)?.values ?? []) out.push({ field, value: v.measure.value, unit: v.measure.unit });
  }
  const meta = record.metadata;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    for (const [field, v] of Object.entries(meta as Record<string, unknown>)) {
      if (v && typeof v === "object" && typeof (v as { value?: unknown }).value === "number") {
        const m = asMeasure(v);
        if (m) out.push({ field, value: m.value, unit: m.unit });
      } else if (typeof v === "string") {
        for (const t of measureTokens(v)?.values ?? []) out.push({ field, value: t.measure.value, unit: t.measure.unit });
      }
    }
  }
  return out;
}

/** The JSON paths that answer a searched value, for Postgres
 *  `jsonb_path_exists(<column>, path, vars)`, and their variables. `same`
 *  finds the value in range in its unit (or one with no unit); `other` finds
 *  it in range in a DIFFERENT unit, which is how "10k" refuses the 10 kHz
 *  crystal even where its title holds the text "10k". Each comes in two
 *  shapes: over a record's custom fields (measure values are objects there)
 *  and over a readings array (`measureReadings`). The SQL twin of
 *  `measureMatches`. */
export function measurePaths(q: Measure, tolerance = MEASURE_SEARCH_TOLERANCE): {
  same: { fields: string; readings: string };
  other: { fields: string; readings: string } | null;
  vars: string;
} {
  const r = measureSearchRange(q, tolerance);
  const lo = Math.min(r.lo, r.hi);
  const hi = Math.max(r.lo, r.hi);
  const inRange = `@.value.type() == "number" && @.value >= $lo && @.value <= $hi`;
  const same = r.unit ? `${inRange} && (!exists(@.unit) || @.unit == null || @.unit == $u)` : inRange;
  const other = r.unit ? `${inRange} && exists(@.unit) && @.unit != null && @.unit != $u` : null;
  const fields = (c: string) => `$.* ? (@.type() == "object" && ${c})`;
  const readings = (c: string) => `$[*] ? (${c})`;
  return {
    same: { fields: fields(same), readings: readings(same) },
    other: other ? { fields: fields(other), readings: readings(other) } : null,
    vars: JSON.stringify({ lo, hi, u: r.unit ?? "" }),
  };
}

/** The in-memory twin of `textSearchWhere`, for a page that already holds its
 *  records (#7893): every word of `q` is in one of `values`, and every value
 *  it names ("0.1uF") is one they hold ("100n", or a measure field's value),
 *  or is in their text and held there in no other unit. `values` are a
 *  record's names and field values, read as they are stored. */
export function valuesAnswer(values: ReadonlyArray<unknown>, q: string): boolean {
  const words = q.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const texts: string[] = [];
  const held: Measure[] = [];
  for (const v of values) {
    if (typeof v === "string" || typeof v === "number") {
      texts.push(String(v));
      if (typeof v === "string") for (const t of measureTokens(v)?.values ?? []) held.push(t.measure);
    } else if (v && typeof v === "object" && typeof (v as { value?: unknown }).value === "number") {
      const m = asMeasure(v);
      if (m) { held.push(m); texts.push(m.text); }
    }
  }
  const hay = texts.join(" ").toLowerCase();
  const has = (w: string) => hay.includes(w.toLowerCase());
  const read = measureTokens(q);
  if (!read) return words.every(has);
  return read.words.every(has) && read.values.every((v) =>
    held.some((h) => measureMatches(v.measure, h)) ||
    (has(v.text) && !held.some((h) => !!v.measure.unit && !!h.unit && h.unit !== v.measure.unit && measureMatches({ ...v.measure, unit: null }, h))));
}
