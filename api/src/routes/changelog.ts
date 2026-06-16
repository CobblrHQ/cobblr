// Public, un-authenticated "What's new" feed. Reads the repo's CHANGELOG.md
// (baked into the image) and returns it as structured, date-grouped entries.
//
// CHANGELOG.md is produced by the daily digest (scripts/changelog-digest.mjs):
// dated `## YYYY-MM-DD` sections of `- **Type** (scope): text` lines. Since the
// digest commits with [skip ci] (no rebuild), the served copy refreshes on the
// next real deploy — fine for an archive; Discord is the realtime channel.
//
// Mounted at /api/v1/changelog (no auth). Same posture as calendarPublicRouter.

import { Router } from "express";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const changelogRouter = Router();

// dist/routes/changelog.js → ../../../CHANGELOG.md (repo root / image /app).
const HERE = dirname(fileURLToPath(import.meta.url));
const CHANGELOG_PATHS = [
  resolve(HERE, "../../../CHANGELOG.md"), // built: /app/api/dist/routes → /app/CHANGELOG.md
  resolve(process.cwd(), "../CHANGELOG.md"), // dev: api/ cwd → repo root
  resolve(process.cwd(), "CHANGELOG.md"),
];

type EntryType = "feature" | "improvement" | "fix" | "change";
interface Entry {
  type: EntryType;
  scope: string | null;
  text: string;
}
interface DaySection {
  date: string;
  entries: Entry[];
}

const TYPE_MAP: Record<string, EntryType> = {
  feature: "feature",
  improvement: "improvement",
  fix: "fix",
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
    const sections = md ? parseChangelog(md) : [];
    cache = { at: Date.now(), sections };
    res.json({ sections });
  } catch (err) {
    next(err);
  }
});
