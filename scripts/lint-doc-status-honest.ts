#!/usr/bin/env tsx
// A design doc whose status says it is not built yet must not document a route the API already registers
//
// THE BUG THIS PREVENTS. operator-impersonation.md read "SPEC, deliberately not
// built yet" for three months after it shipped; on 2026-09-08 an agent believed
// it, went hunting for production access that does not exist, and ssh'd into the
// deploy box and grepped inside a container to answer a question that doc's own
// endpoint answers in one request. A stale status line is worse than no doc: it
// does not merely fail to help, it actively sends people the wrong way, and it
// is invisible because everything else about the page still reads plausibly.
//
// THE RULE. A doc under docs/ whose STATUS line says the thing is not built
// (spec / proposed / not built / not implemented / when green-lit) may not
// document an HTTP route that api/src/routes already registers. Passing means
// one of two things: the status is honest and the route really does not exist,
// or the doc has been updated to say it shipped. Only a status LINE counts -
// prose that mentions an unbuilt idea is not a claim about this document's
// subject - and a doc with several statuses is judged on each of them.
//
// A genuine exception - a spec that reuses a path that already exists for
// something else - opts out on the status line itself:
//
//   **Status:** proposed, not built.
//   <!-- doc-status-ok: /orgs/:id/foo is the EXISTING read route that this spec
//   plugs into; it is not something this spec proposes building -->
//
// The opt-out counts anywhere in the status block (the status line plus the
// three lines under it), so the reason can be a real sentence.
//
// WHY ROUTES AND NOT PROSE. It has to be mechanical or it will not hold. A
// route string is unambiguous, appears verbatim in both the doc and the router,
// and only exists once somebody built it. Judging "does this doc describe
// shipped code" any more broadly means guessing, and a lint that guesses gets
// muted.
//
// PROVEN RED against docs/modules/operator-impersonation.md carrying its
// original "Status: SPEC - approved direction, deliberately not built yet"
// while /super-admin/impersonations was live.
//
//   npx tsx scripts/lint-doc-status-honest.ts   (pnpm run lint:doc-status-honest)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Docs only; the routers are read as evidence. */
const DOC_ROOTS = ["docs"];
const ROUTE_ROOT = "api/src/routes";

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

function* walk(dir: string, ext: RegExp): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p, ext);
    else if (ext.test(name)) yield p;
  }
}

/** Every route path the API registers, stored both as the raw literal and with
 *  the mount prefix a doc would write, because docs cite the caller's path. */
function registeredRoutes(): Set<string> {
  const literals = new Set<string>();
  for (const file of walk(ROUTE_ROOT, /\.ts$/)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/\.(get|post|patch|put|delete)\(\s*"([^"]+)"/g)) {
      const path = m[2]!;
      if (!path.startsWith("/")) continue;
      literals.add(path);
      // super-admin.ts mounts at /super-admin, and that is the surface these
      // operator specs describe.
      if (file.includes("super-admin")) literals.add("/super-admin" + path);
    }
  }
  return literals;
}

const STATUS_LINE = /^\s*\*{0,2}status\*{0,2}\s*:/i;
const CLAIMS_UNBUILT = /\bnot (yet )?built\b|\bnot implemented\b|\bgreen-lit\b|\bspec only\b|\bunbuilt\b/i;
const OPT_OUT = /doc-status-ok:/;

/** Route paths a doc cites. Strict on purpose: a leading slash and at least two
 *  segments, so ordinary prose does not match. */
function citedRoutes(src: string): Set<string> {
  const found = new Set<string>();
  for (const line of src.split("\n")) {
    for (const m of line.matchAll(/(?:^|[\s`"'(])(\/(?:api\/v1)?\/?[a-z][a-z0-9-]*(?:\/[a-z0-9:<>{}._-]+)+)/gi)) {
      const p = m[1]!.replace(/^\/api\/v1/, "").replace(/[.,)`"']+$/, "");
      found.add(p);
    }
  }
  return found;
}

function check(file: string, src: string, routes: Set<string>): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  // A status is often a short paragraph, and the opt-out reason needs room to
  // be a real sentence, so it counts anywhere in the status block rather than
  // only on the first line. Requiring it to fit on one line just produces
  // unreadable reasons, which is how an escape hatch turns into a rubber stamp.
  const OPT_OUT_WINDOW = 4;
  const unbuilt = lines
    .map((l, i) => ({ l, i }))
    .filter(
      ({ l, i }) =>
        STATUS_LINE.test(l) &&
        CLAIMS_UNBUILT.test(l) &&
        !lines.slice(i, i + OPT_OUT_WINDOW).some((n) => OPT_OUT.test(n)),
    );
  if (!unbuilt.length) return out;

  const live = [...citedRoutes(src)].filter((p) => routes.has(p));
  if (!live.length) return out;

  for (const { i } of unbuilt) {
    out.push({
      file,
      line: i + 1,
      what: `status says not built, but the API registers ${live.slice(0, 3).join(", ")}`,
    });
  }
  return out;
}

/** The doc map keeps its OWN one-line status per doc, so a status can rot in two
 *  places independently - and it did: docs/README.md still said "SPEC, not
 *  built" for operator-impersonation.md as well. The map is the page agents are
 *  told to consult, so a stale row there reaches MORE people than the doc's own
 *  header. Rather than ban the second copy (the map's summary is useful), check
 *  that the two agree. */
function mapRowsDisagree(routes: Set<string>): Violation[] {
  const out: Violation[] = [];
  const mapFile = join(DOC_ROOTS[0]!, "README.md");
  let src: string;
  try {
    src = readFileSync(mapFile, "utf8");
  } catch {
    return out;
  }
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.startsWith("|") || !CLAIMS_UNBUILT.test(line) || OPT_OUT.test(line)) continue;
    const link = /\]\(\.?\/?([^)]+\.md)\)/.exec(line);
    if (!link) continue;
    const target = join(DOC_ROOTS[0]!, link[1]!.replace(/^\.\//, ""));
    let doc: string;
    try {
      doc = readFileSync(target, "utf8");
    } catch {
      continue;
    }
    const docSaysUnbuilt = doc
      .split("\n")
      .some((l) => STATUS_LINE.test(l) && CLAIMS_UNBUILT.test(l));
    const live = [...citedRoutes(doc)].filter((p) => routes.has(p));
    if (!docSaysUnbuilt && live.length) {
      out.push({
        file: mapFile,
        line: i + 1,
        what: `the map says not built, but ${link[1]} says it shipped and the API registers ${live.slice(0, 2).join(", ")}`,
      });
    }
  }
  return out;
}

const routes = registeredRoutes();
const violations: Violation[] = [];
for (const root of DOC_ROOTS) {
  for (const file of walk(root, /\.md$/)) violations.push(...check(file, readFileSync(file, "utf8"), routes));
}
violations.push(...mapRowsDisagree(routes));

if (violations.length) {
  console.error(`lint:doc-status-honest - ${violations.length} doc(s) claiming to be unbuilt while their routes are live:\n`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error(
    "\nA reader trusts the status line and stops there. Either update the status to say\n" +
      "it shipped (and say where the code is), or, if the path predates this spec, put\n" +
      "<!-- doc-status-ok: <why> --> on the status line itself.\n",
  );
  process.exit(1);
}
console.log(`lint:doc-status-honest - ${routes.size} live routes checked against every unbuilt-status doc.`);
