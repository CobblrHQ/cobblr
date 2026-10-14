#!/usr/bin/env tsx
// A set of queries that must refresh together takes its keys from one family module, so one invalidation reaches all of them
//
// THE BUG THIS PREVENTS. Twice on one day (2026-09-24), a list the person
// was looking at kept its old contents after they acted, because the write
// invalidated a sibling key and not the one the screen read:
//
// - The scan inbox. A person filed a carton of milk; the card left the list,
//   and "Recently committed" beside it kept reading 8 until a reload (#3582).
//   The committed list, the discarded list and the put-away counts were
//   sibling keys ("scan-inbox-resolved", "scan-stats") beside the pending
//   list's ["scan-inbox", slug], and each of the fifty-odd writes invalidated
//   whichever it remembered.
// - Notifications. An owner pressed Deny in the bell, closed it, reopened it,
//   and the card offered Approve and Deny again until a reload (#3594). The
//   buttons invalidated ["notifications"]; the bell read
//   ["me-notifications-list"], the page ["me-notifications-full"], the badge
//   ["me-notifications-unread"]. Nothing matched.
//
// THE RULE. Each family below has one home module whose keys all share one
// prefix, so the family's `all()` invalidation refreshes every member. A
// family's literals written anywhere else in the web app or a module's UI
// fail; for a family whose word is also ordinary vocabulary ("notifications"
// names a settings section too), only a literal that opens a query key does.
// No opt-out: a new query of the family adds a key to its home.
//
// THE BOUNDARY. Keys outside the families pass: "scan-menu",
// "scan-glance-config" and "scan-item-live" are the scanner's settings and
// one row's live state, "notification-channels" is a settings list, and
// nothing a filing or a press changes them. Tests are not judged; one that
// seeds a cache by hand may spell the key it seeds.
//
//   npx tsx scripts/lint-query-key-families.ts   (pnpm lint query-key-families)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "modules"];

interface Family {
  name: string;
  home: string;
  /** The literal, with the family's key word in group 1. */
  literal: RegExp;
}

const FAMILIES: Family[] = [
  {
    name: "scanInboxKeys",
    home: join("web", "src", "lib", "scan-inbox-keys.ts"),
    literal: /["'`](scan-inbox(?:-[a-z-]+)?|scan-stats)["'`]/,
  },
  {
    name: "notificationKeys",
    home: join("web", "src", "lib", "notification-keys.ts"),
    literal: /queryKey:\s*\[\s*["'`]((?:me-)?notifications(?:-[a-z-]+)?)["'`]/,
  },
  // Whether AI works here (#3654): saving a verified connection's route
  // refreshed "connections" and left Cobb's "ai-status" saying AI was off
  // until a reload. The "ai-..." words are distinctive, so any literal counts;
  // "connections" is ordinary vocabulary, so only one that opens a key does.
  {
    name: "aiAvailabilityKeys",
    home: join("web", "src", "lib", "ai-availability-keys.ts"),
    literal: /["'`](ai-(?:status|chat-prefs|chat-models|providers|capability-defaults|shares))["'`]|(?:queryKey:\s*|setQueryData\(\s*|\[)\[\s*["'`]((?:my-)?connections)["'`]\s*\]/,
  },
];

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

function* walk(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (const fam of FAMILIES) {
    if (file === fam.home) continue;
    for (let i = 0; i < lines.length; i++) {
      const m = fam.literal.exec(lines[i] ?? "");
      if (m) out.push({ file, line: i + 1, what: `"${m[1] ?? m[2]}" as a query key; take it from ${fam.name} (${fam.home}) so one invalidation refreshes the whole family` });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:query-key-families - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Take the key from the family's home module; add a key there when a new query joins the family.");
  process.exit(1);
}
console.log(`lint:query-key-families OK`);
