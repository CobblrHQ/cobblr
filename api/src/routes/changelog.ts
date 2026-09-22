// Public, un-authenticated "What's new" feed. Returns structured, date-grouped
// entries from TWO sources, merged:
//   1. changelog.d/*.md  — the LIVE archive. One changeset file per change, with
//      `type`, `scope`, `date` frontmatter, committed by the same feature PR that
//      ships it. Never consolidated, never cleared — the entries ARE the archive.
//   2. CHANGELOG.md      — FROZEN history from before the changelog.d cutover
//      (dated `## YYYY-MM-DD` sections). Read-only; nothing writes it anymore.
//
// Nothing here (or in the digest) writes to the repo: the digest only posts to
// Discord, and the page reads the committed changesets live. Served copy refreshes
// on the next deploy — fine for an archive; Discord is the realtime channel.
//
// Mounted at /api/v1/changelog (no auth). Same posture as calendarPublicRouter.

import { Router } from "express";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

export const changelogRouter = Router();

// dist/routes/changelog.js → ../../../<name> (repo root / image /app).
const HERE = dirname(fileURLToPath(import.meta.url));
const roots = [
  resolve(HERE, "../../.."), // built: /app/api/dist/routes → /app
  resolve(process.cwd(), ".."), // dev: api/ cwd → repo root
  process.cwd(),
];
const CHANGELOG_PATHS = roots.map((r) => join(r, "CHANGELOG.md"));
const CHANGESET_DIRS = roots.map((r) => join(r, "changelog.d"));

type EntryType = "feature" | "improvement" | "fix" | "selfhost" | "change";
interface Entry {
  type: EntryType;
  scope: string | null;
  text: string;
}
interface DaySection {
  date: string;
  entries: Entry[];
}

// The map decides WHETHER a changeset is published as well as what it is
// called. changelog.d/README.md: `internal` is "announced nowhere", and an
// unrecognised type is a typo nobody has read yet. Both used to fall through
// to "change" and go out on the public What's new page, which is how 65
// entries about CI, lints and worktrees ended up where a stranger could read
// them (#3444). A type that is not here is dropped, loudly enough that the
// test below catches a new one.
const TYPE_MAP: Record<string, EntryType> = {
  feature: "feature",
  improvement: "improvement",
  fix: "fix",
  // Same audience as the rest of the post, its own heading in it.
  selfhost: "selfhost",
  // In the README's user-facing list; they read as fixes on the page.
  security: "fix",
  performance: "improvement",
};

export function parseChangelog(md: string): DaySection[] {
  const byDate = new Map<string, Entry[]>();
  const order: string[] = [];
  let current: string | null = null;

  for (const raw of md.split(/\r?\n/)) {
    const head = raw.match(/^##\s+(.+?)\s*$/);
    if (head) {
      current = head[1]!.trim();
      if (!byDate.has(current)) {
        byDate.set(current, []);
        order.push(current); // first-seen order preserves newest-first
      }
      continue;
    }
    if (!current) continue;
    // - **Type** (scope): text   |   - **Type**: text
    const m = raw.match(/^[-*]\s+\*\*([^*]+)\*\*(?:\s*\(([^)]+)\))?:\s*(.+?)\s*$/);
    if (!m) continue;
    byDate.get(current)!.push({
      type: TYPE_MAP[m[1]!.trim().toLowerCase()] ?? "change",
      scope: m[2]?.trim() || null,
      text: m[3]!.trim(),
    });
  }

  // Merge same-date sections (the digest can emit two on a double-run day).
  return order.map((date) => ({ date, entries: byDate.get(date)! })).filter((d) => d.entries.length > 0);
}

/** Parse one changeset file's frontmatter + body into a dated Entry. Undated
 *  entries (shouldn't happen — lint requires `date`) bucket under "Unreleased". */
export function parseChangeset(raw: string): { date: string; entry: Entry } | null {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  const fm: Record<string, string> = {};
  if (m) {
    for (const line of m[1]!.split(/\r?\n/)) {
      const i = line.indexOf(":");
      if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  // The blurb is everything BEFORE the staged "## docs" section — that section
  // is the feature's user manual, published by scripts/docs-flush.mjs at
  // release; it must never leak into the changelog feed.
  const text = (m ? m[2]! : raw).split(/^## docs\s*$/m)[0]!.trim().replace(/\s+/g, " ");
  const type = TYPE_MAP[(fm.type || "").toLowerCase()];
  if (!type) return null;                       // internal, or a type nobody has read
  return {
    date: fm.date?.trim() || "Unreleased",
    entry: { type, scope: fm.scope?.trim() || null, text },
  };
}

async function readChangesets(): Promise<DaySection[]> {
  let dir: string | null = null;
  let names: string[] = [];
  for (const d of CHANGESET_DIRS) {
    try {
      names = (await readdir(d)).filter((f) => f.endsWith(".md") && f !== "README.md");
      dir = d;
      break;
    } catch {
      /* try next */
    }
  }
  if (!dir) return [];
  const byDate = new Map<string, Entry[]>();
  for (const f of names) {
    try {
      const parsed = parseChangeset(await readFile(join(dir, f), "utf8"));
      if (!parsed) continue;                    // not for anybody outside this repo
      const { date, entry } = parsed;
      (byDate.get(date) ?? byDate.set(date, []).get(date)!).push(entry);
    } catch {
      /* skip unreadable */
    }
  }
  return [...byDate.entries()].map(([date, entries]) => ({ date, entries }));
}

/** Merge the live changesets with the frozen CHANGELOG.md, combine same-date
 *  sections, and sort newest-first ("Unreleased" floats to the very top). */
function mergeSections(a: DaySection[], b: DaySection[]): DaySection[] {
  const byDate = new Map<string, Entry[]>();
  for (const s of [...a, ...b]) {
    const cur = byDate.get(s.date) ?? byDate.set(s.date, []).get(s.date)!;
    cur.push(...s.entries);
  }
  return [...byDate.entries()]
    .map(([date, entries]) => ({ date, entries }))
    .filter((d) => d.entries.length > 0)
    .sort((x, y) => {
      if (x.date === "Unreleased") return -1;
      if (y.date === "Unreleased") return 1;
      return x.date < y.date ? 1 : x.date > y.date ? -1 : 0; // ISO dates → lexical desc
    });
}

let cache: { at: number; sections: DaySection[] } | null = null;
const TTL_MS = 60_000;

changelogRouter.get("/", async (_req, res, next) => {
  try {
    if (cache && Date.now() - cache.at < TTL_MS) {
      res.json({ sections: cache.sections });
      return;
    }
    let md: string | null = null;
    for (const p of CHANGELOG_PATHS) {
      try {
        md = await readFile(p, "utf8");
        break;
      } catch {
        /* try next */
      }
    }
    const frozen = md ? parseChangelog(md) : [];
    const live = await readChangesets();
    const sections = mergeSections(live, frozen);
    cache = { at: Date.now(), sections };
    res.json({ sections });
  } catch (err) {
    next(err);
  }
});
