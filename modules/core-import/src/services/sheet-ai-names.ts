// Names for the columns of a sheet that has none, asked of a model: the one
// thing the rules cannot do. A header-less sheet's columns are named from
// their values where that is certain ("ISBN", "Date"); the rest are only a
// letter, and "Column B" is not something a person can map. A model shown the
// first few rows can say "Author".
//
// Only then, and only that little: the letters that are left, the first five
// rows, one call. Without AI (not set up, not entitled, busy) the letters
// stay and nothing else changes.

import { reassignRoles, type UnderstoodSheet, type Value } from "./sheet-understand.js";

const SAMPLE_ROWS = 5;
const LETTER_HEADER = /^Column ([A-Z]+)$/;

function cell(v: Value): string {
  if (v === null) return "";
  if (Array.isArray(v)) return v.join("; ");
  if (typeof v === "object") return v.text;
  return String(v);
}

export function columnNamingPrompt(sheet: UnderstoodSheet): string | null {
  const unnamed = sheet.columns.filter((c) => !c.derived && LETTER_HEADER.test(c.header));
  if (!unnamed.length) return null;
  const cols = sheet.columns.filter((c) => !c.derived);
  const header = cols.map((c) => c.header).join(" | ");
  const rows = sheet.rows
    .slice(0, SAMPLE_ROWS)
    .map((r) => cols.map((c) => cell(r.values[sheet.columns.indexOf(c)] ?? null).slice(0, 60)).join(" | "));
  return [
    `A spreadsheet tab called "${sheet.name}" has no header row. Here are its first rows, with the columns as they are named so far:`,
    "",
    header,
    ...rows,
    "",
    `Name each column still called "Column" plus a letter (${unnamed.map((c) => c.header.replace("Column ", "")).join(", ")}) with a short plain header of one to three words that says what its values are, the way a person would head that column.`,
    'Reply with JSON only, keyed by the letter, for example {"B": "Author"}. Use null for a column you cannot tell.',
  ].join("\n");
}

function parseNames(text: string): Record<string, string | null> {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return {};
  try {
    const obj = JSON.parse(m[0]) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.trim().toUpperCase(), typeof v === "string" ? v : null]));
  } catch {
    return {};
  }
}

/** Ask, apply what came back, and say how many columns it named. `ask`
 *  throws or returns nothing when there is no AI; the sheet is then left as
 *  the rules named it. */
export async function nameColumnsWithAi(sheet: UnderstoodSheet, ask: (prompt: string) => Promise<string | null>): Promise<number> {
  if (!sheet.headerless) return 0;
  const prompt = columnNamingPrompt(sheet);
  if (!prompt) return 0;
  let reply: string | null = null;
  try {
    reply = await ask(prompt);
  } catch {
    // import-swallow-ok: no AI is an expected answer here; the columns keep their letters and the dry run shows them
    return 0;
  }
  if (!reply) return 0;
  const names = parseNames(reply);
  const taken = new Set(sheet.columns.map((c) => c.header.toLowerCase()));
  let named = 0;
  for (const col of sheet.columns) {
    const letter = LETTER_HEADER.exec(col.header)?.[1];
    if (!letter || col.derived) continue;
    const name = names[letter]?.replace(/\s+/g, " ").trim();
    if (!name || name.length > 40 || taken.has(name.toLowerCase())) continue;
    taken.add(name.toLowerCase());
    col.header = name;
    col.named_by = "ai";
    named++;
  }
  if (named) reassignRoles(sheet);
  return named;
}
