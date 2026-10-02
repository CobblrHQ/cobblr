// What a record's own name already says about it.
//
// A vehicle named "Yamaha YZF-R3, Blue" with Make = Yamaha says its model is
// YZF-R3; "2019 Honda CB500X" says its year. The owner typed the name; the
// Model box beside it sat empty (#4518). Pure, and it only reads: the caller
// fills EMPTY fields with what this returns and never a value a person typed.
//
// The make is required. Without it there is no telling where a model starts
// ("Blue Bird Vision" is a bus maker and a model), so a name with no known make
// says nothing about the model.

import { measureTokens, measureUnitCode } from "@cobblr/platform-contract/measure";

export interface NameFacts {
  model?: string;
  year?: number;
}

const YEAR_RE = /\b(19[5-9]\d|20\d\d)\b/;

export function factsFromName(name: string | null | undefined, make: string | null | undefined, now: Date = new Date()): NameFacts {
  const out: NameFacts = {};
  let rest = (name ?? "").trim().replace(/\s+/g, " ");
  if (!rest) return out;
  const y = rest.match(YEAR_RE);
  if (y && Number(y[1]) <= now.getUTCFullYear() + 1) {
    out.year = Number(y[1]);
    rest = rest.replace(YEAR_RE, " ").replace(/\s+/g, " ").trim();
  }
  const m = (make ?? "").trim();
  if (!m) return out;
  if (rest.toLowerCase().startsWith(m.toLowerCase() + " ")) {
    // The model runs from after the make to the first thing that is plainly
    // not part of it: a comma, a dash between words, a bracket.
    const model = rest.slice(m.length).split(/,| [-–] |\(/)[0]!.trim();
    if (model && model.length <= 40) out.model = model;
  }
  return out;
}

/** A field a name can fill: a measure ("Size", "Drive") or a text field with
 *  choices ("Type": socket, deep socket, ratchet). */
export interface NameField {
  name: string;
  label: string;
  type: string;
  unit?: string | null;
  choices?: readonly string[] | null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What a name says for each of these fields, by the field's own words.
 *
 *  "Deep impact 10 mm socket, 3/8 in drive" with Size, Drive and Type says
 *  Drive = 3/8 in (the value its label follows), Size = 10 mm (the first value
 *  no label claimed) and Type = deep socket (the longest choice it contains).
 *  A field the name does not answer is left out, and nothing is guessed: a
 *  measure in another unit than the field's is not taken. Pure. */
export function fieldsFromName(name: string | null | undefined, fields: readonly NameField[]): Record<string, string> {
  const out: Record<string, string> = {};
  const text = (name ?? "").replace(/\s+/g, " ").trim();
  if (!text) return out;
  const lower = text.toLowerCase();

  for (const f of fields) {
    if (f.type !== "text" || !f.choices?.length) continue;
    const hit = [...f.choices]
      .filter((c) => c.trim() && new RegExp(`(^|[^a-z0-9])${escapeRe(c.trim().toLowerCase())}([^a-z0-9]|$)`).test(lower))
      .sort((a, b) => b.length - a.length)[0];
    if (hit) out[f.name] = hit;
  }

  const values = measureTokens(text)?.values ?? [];
  if (!values.length) return out;
  const claimed = new Set<number>();
  const fits = (f: NameField, i: number) => {
    const want = f.unit ? measureUnitCode(f.unit) : null;
    return !want || values[i]!.measure.unit === want;
  };
  const measures = fields.filter((f) => f.type === "measure");
  // A value its field's label follows: "3/8 in drive" is the Drive.
  for (const f of measures) {
    const word = f.label.trim().toLowerCase();
    if (!word) continue;
    let at = 0;
    for (let i = 0; i < values.length; i++) {
      const pos = lower.indexOf(values[i]!.text.toLowerCase(), at);
      if (pos < 0) continue;
      at = pos + values[i]!.text.length;
      if (claimed.has(i) || !fits(f, i)) continue;
      if (new RegExp(`^[\\s-]*(?:sq(?:uare)?\\.?\\s*)?${escapeRe(word)}\\b`).test(lower.slice(at))) {
        out[f.name] = values[i]!.text;
        claimed.add(i);
        break;
      }
    }
  }
  // The rest take the first value no label claimed, in the field's unit; a
  // field with no unit (a Size) first, so "7/16 in socket" is a size, never
  // a drive nobody named.
  for (const f of [...measures].sort((a, b) => Number(!!a.unit) - Number(!!b.unit))) {
    if (out[f.name] !== undefined) continue;
    const i = values.findIndex((_, j) => !claimed.has(j) && fits(f, j));
    if (i >= 0) {
      out[f.name] = values[i]!.text;
      claimed.add(i);
    }
  }
  return out;
}
