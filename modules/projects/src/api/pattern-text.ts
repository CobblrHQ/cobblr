// A pattern's words, kept for search.
//
// The materials reader extracts a pattern PDF's text when the PDF lands; this
// keeps it (projects_pattern_texts) so a search for a word inside a pattern
// ("amigurumi", "worsted", "magic ring") finds the pattern, through the list
// resolver every search reads (the palette, the search page, Cobb) and the
// Patterns page's own search box. There is no second extraction pass: the
// reader hands its text here, and the heal (heal-pattern-text.ts) runs the
// same reader's extraction for PDFs read before the text was kept.
//
// A result that matched inside the words rather than the name carries a
// snippet: the line the word is on, so "magic ring" under a pattern called
// "Baby turtles" says why it is there.

import { sql, type Expression, type Kysely, type SqlBool } from "kysely";
import { likeNeedle } from "@cobblr/platform-contract";
import type { ProjectsDB } from "../db.js";

/** The most kept per pattern. A pattern's words are a few pages; this is
 *  room for a long one without letting a 400-page book into every search. */
export const PATTERN_TEXT_MAX = 200_000;

/** Keep the text of a pattern's PDF (or nothing, for a PDF with none). */
export async function storePatternText(
  db: Kysely<ProjectsDB>,
  projectId: string,
  fileId: string | null,
  text: string | null,
): Promise<void> {
  const row = { pattern_file_id: fileId, text: text ? text.slice(0, PATTERN_TEXT_MAX) : null, pending: false, indexed_at: new Date() };
  await db
    .insertInto("projects_pattern_texts")
    .values({ project_id: projectId, ...row })
    .onConflict((oc) => oc.column("project_id").doUpdateSet(row))
    .execute();
}

/** The condition "this project's pattern text contains q", for a query on
 *  projects_projects. The expression matches the trigram index. */
export function patternTextMatches(q: string): Expression<SqlBool> {
  return sql<SqlBool>`exists (
    select 1 from projects_pattern_texts pt
    where pt.project_id = projects_projects.id
      and lower(coalesce(pt.text, '')) like ${likeNeedle(q.trim())}
  )`;
}

const SNIPPET_MAX = 140;

/** The line of `text` that holds `q`, trimmed around it to fit a result row;
 *  null when the text does not hold it. Whitespace is folded, since a PDF's
 *  lines are wherever its columns broke. */
export function snippetOf(text: string | null | undefined, q: string): string | null {
  const needle = q.trim().toLowerCase();
  if (!text || !needle) return null;
  const line = text.split(/\r?\n/).find((l) => l.toLowerCase().includes(needle));
  if (!line) {
    // The words can straddle a line break ("magic\nring").
    const flat = text.replace(/\s+/g, " ");
    return flat.toLowerCase().includes(needle) ? around(flat, needle) : null;
  }
  return around(line.replace(/\s+/g, " ").trim(), needle);
}

function around(line: string, needle: string): string {
  if (line.length <= SNIPPET_MAX) return line;
  const at = line.toLowerCase().indexOf(needle);
  const start = Math.max(0, Math.min(at - Math.floor((SNIPPET_MAX - needle.length) / 2), line.length - SNIPPET_MAX));
  const cut = line.slice(start, start + SNIPPET_MAX).trim();
  return `${start > 0 ? "…" : ""}${cut}${start + SNIPPET_MAX < line.length ? "…" : ""}`;
}

/** Why each project matched `q`, when it was not by its name: the line from
 *  its description (a pattern saved from Ask Cobb is its words) or from its
 *  PDF. One query for the page of results, reading only a window of each
 *  text around the first hit. */
export async function snippetsFor(
  db: Kysely<ProjectsDB>,
  rows: ReadonlyArray<{ id: string; name: string; description: string | null }>,
  q: string,
): Promise<Map<string, string>> {
  const needle = q.trim().toLowerCase();
  const out = new Map<string, string>();
  if (!needle) return out;
  const need: string[] = [];
  for (const r of rows) {
    if (r.name.toLowerCase().includes(needle)) continue;
    const fromDescription = snippetOf(r.description, needle);
    if (fromDescription) out.set(r.id, fromDescription);
    else need.push(r.id);
  }
  if (!need.length) return out;
  const windows = await db
    .selectFrom("projects_pattern_texts")
    .select([
      "project_id",
      sql<string>`substr(text, greatest(1, strpos(lower(text), ${needle}) - 400), 800 + ${needle.length})`.as("window"),
    ])
    .where("project_id", "in", need)
    .where(sql<SqlBool>`strpos(lower(coalesce(text, '')), ${needle}) > 0`)
    .execute();
  for (const w of windows) {
    const s = snippetOf(w.window, needle);
    if (s) out.set(w.project_id, s);
  }
  return out;
}
