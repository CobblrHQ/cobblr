// Every activity feed is height-capped and scrolls. Nothing renders an
// unbounded list of an endless thing.
//
// The bug this exists for, twice: a feed renders `items.map(...)` straight into
// a <ul>. The list has no natural end (firings, calls, audit rows keep coming),
// so it grows until the page is an infinite scroll whose controls are all above
// the fold and unreachable. A shared FEED_SCROLL constant was added the first
// time this was reported, and the second report was a DIFFERENT feed that simply
// never imported it. A constant only helps the person who remembers it exists.
//
// So: if a file reads the activity log, it must reference FEED_SCROLL. That is
// the whole rule, and it is checkable.
//
// Not covered on purpose: a bounded list (a fixed set of modules, a workspace's
// roles) needs no cap, and this lint never looks at those — the trigger is
// reading an endless SOURCE, not rendering a list.

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { globSync } from "node:fs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const WEB = join(ROOT, "web/src");

/** Calls that return a feed: a list with no natural end. Add to this when a new
 *  endless source appears; the cap requirement follows automatically. */
const ENDLESS_SOURCES = [
  "listActivity(",
  "listAiCalls(",
  "listNotifications(",
];

// Any of the shared caps counts. Matching the family rather than listing the
// members is deliberate: the first extra variant (FEED_SCROLL_PAGE) was added
// weeks after the lint, and a name-by-name list would have failed the page that
// correctly used the NEW one.
const CAP = /\bFEED_SCROLL[A-Z_]*\b/;

/** Files allowed to read an endless source without capping, each with a reason.
 *  Keep this empty if you can. */
const EXEMPT: Record<string, string> = {
  "lib/api.ts": "the client that DEFINES the calls, it renders nothing",
};

const files = globSync("**/*.{ts,tsx}", { cwd: WEB })
  .filter((f) => !f.endsWith(".d.ts") && !f.includes("__tests__"));

const bad: Array<{ file: string; source: string }> = [];

for (const rel of files) {
  const src = readFileSync(join(WEB, rel), "utf8");
  if (EXEMPT[rel]) continue;
  const hit = ENDLESS_SOURCES.find((s) => src.includes(s));
  if (!hit) continue;
  // A file that reads a feed but renders no list is fine (a hook, a loader).
  if (!/<(ul|ol|tbody)\b/.test(src)) continue;
  if (CAP.test(src)) continue;
  bad.push({ file: rel, source: hit.replace("(", "") });
}

if (bad.length) {
  console.error("[lint:feed-caps] activity feed with no height cap:\n");
  for (const b of bad) {
    console.error(`  web/src/${b.file}`);
    console.error(`      reads ${b.source}() and renders a list, but never uses FEED_SCROLL.`);
  }
  console.error(`
  A feed grows forever and pushes the page's own controls off the screen.
  Import the shared cap and put it on the list element:

      import { FEED_SCROLL } from "../lib/feed";
      <ul className={"space-y-1.5 " + FEED_SCROLL}>

  Use FEED_SCROLL_INNER when a bordered wrapper must keep its rounded corners.
  If the list is genuinely bounded, add the file to EXEMPT in ${relative(ROOT, fileURLToPath(import.meta.url))} with the reason.
`);
  process.exit(1);
}

console.log(
  `[lint:feed-caps] ok — every file reading an endless source (${ENDLESS_SOURCES.map((s) => s.replace("(", "")).join(", ")}) caps its feed.`,
);
