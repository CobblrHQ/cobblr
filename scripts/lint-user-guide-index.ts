#!/usr/bin/env tsx
// The user guide's index carries only the area list and moved-section stubs; a section is written on its area's page under docs/user-guide/, so two pull requests in different areas never edit one file.
//
// THE BUG THIS PREVENTS. docs/USER_GUIDE.md caused 31 merge-queue re-checks in
// the 24 h to 2026-10-18 and held four unrelated PRs behind one freeze (#7321):
// every feature appended its section to the one file, so any two collided.
//
// THE RULE. docs/USER_GUIDE.md has a fixed head (the title, its intro, "The
// guide, by area", "Maintaining the guide", "Moved sections"), and under
// "Moved sections" every heading is a stub whose body is one line, "Moved to
// [<page>](user-guide/<area>.md#<anchor>).", pointing at a heading that exists
// there. Anything else fails: a new heading, prose under a stub, a stub whose
// page or heading is gone. A failure names the area page the text belongs on,
// from docs/user-guide/areas.json. Every area page areas.json lists exists,
// and every page in docs/user-guide/ is listed, so a page is never orphaned.
//
// THE BOUNDARY. The fixed head may be edited (the intro, the maintaining
// rules): those change rarely and are not where features land. A stub may be
// deleted; nothing links to it then. Nothing has tested the edge yet beyond the
// split itself.
//
//   npx tsx scripts/lint-user-guide-index.ts   (pnpm lint user-guide-index)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { areas, GUIDE_DIR, GUIDE_INDEX } from "./lib/user-guide.mjs";

interface Violation {
  file: string;
  line: number;
  what: string;
}

const HEAD = new Set(["the guide, by area", "maintaining the guide", "moved sections"]);
const STUB = /^Moved to \[[^\]]+\]\(user-guide\/([a-z0-9-]+)\.md#([^)]+)\)\.$/;
/** The old "Maintaining this guide" became the index's own section. */
const SELF_STUB = /^This section is now \[[^\]]+\]\(#[a-z0-9-]+\) above\.$/;

/** GitHub's heading slug: lowercase, punctuation dropped, spaces to hyphens. */
function slug(t: string): string {
  return t.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\p{L}\p{N}\p{M}\- _]/gu, "").replace(/ /g, "-");
}

/** Every heading's anchor in a page, counted the way GitHub numbers repeats. */
function anchorsOf(text: string): Set<string> {
  const out = new Set<string>();
  const seen: Record<string, number> = {};
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const m = line.match(/^#{1,6}\s+(.*?)\s*$/);
    if (!m) continue;
    let s = slug(m[1]!);
    if (seen[s] !== undefined) s = `${s}-${++seen[s]!}`;
    else seen[s] = 0;
    out.add(s);
  }
  return out;
}

/** The area page a heading most likely belongs on: words shared with a page's
 *  title and scopes count three times, words found in its text count once. */
function pageFor(heading: string, all: Record<string, { title: string; scopes?: string[] }>, pages: Record<string, string | undefined>): string {
  const stem = (w: string) => w.replace(/s$/, "");
  const words = new Set(heading.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3).map(stem));
  let best: { a: string; n: number } | null = null;
  for (const [a, meta] of Object.entries(all)) {
    const named = new Set(`${a} ${meta.title} ${(meta.scopes ?? []).join(" ")}`.toLowerCase().split(/[^a-z0-9]+/).map(stem));
    const text = new Set((pages[`${GUIDE_DIR}/${a}.md`] ?? "").toLowerCase().split(/[^a-z0-9]+/).map(stem));
    let n = 0;
    for (const w of words) n += (named.has(w) ? 3 : 0) + (text.has(w) ? 1 : 0);
    if (n > (best?.n ?? 0)) best = { a, n };
  }
  return best ? `${GUIDE_DIR}/${best.a}.md` : `the right page in ${GUIDE_DIR}/ (listed in ${GUIDE_DIR}/areas.json)`;
}

export function check(index: string, pages: Record<string, string | undefined>, all: Record<string, { title: string; scopes?: string[] }>): Violation[] {
  const out: Violation[] = [];
  const lines = index.split("\n");
  let inStubs = false;
  let stub: { heading: string; line: number; body: string[] } | null = null;
  const anchors: Record<string, Set<string>> = {};
  const close = () => {
    if (!stub) return;
    const body = stub.body.filter((l) => l.trim());
    if (body.length === 1 && SELF_STUB.test(body[0]!)) {
      stub = null;
      return;
    }
    const m = body.length === 1 ? body[0]!.match(STUB) : null;
    if (!m) {
      out.push({
        file: GUIDE_INDEX,
        line: stub.line,
        what: `"${stub.heading}" is a section on the index. Write it on its area's page instead: ${pageFor(stub.heading, all, pages)}`,
      });
    } else {
      const page = `${GUIDE_DIR}/${m[1]}.md`;
      const text = pages[page];
      if (text === undefined) out.push({ file: GUIDE_INDEX, line: stub.line, what: `"${stub.heading}" points at ${page}, which does not exist` });
      else if (!(anchors[page] ??= anchorsOf(text)).has(m[2]!))
        out.push({ file: GUIDE_INDEX, line: stub.line, what: `"${stub.heading}" points at #${m[2]} in ${page}, which has no such heading` });
    }
    stub = null;
  };
  let fence: string | null = null;
  lines.forEach((line, i) => {
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) fence = fence ? (f[1]![0] === fence ? null : fence) : f[1]![0]!;
    const h = !fence && !f ? line.match(/^(#{1,6})\s+(.*?)\s*$/) : null;
    if (h) {
      close();
      const text = h[2]!.trim();
      if (h[1] === "#" && i === 0) return;
      if (h[1] === "##" && HEAD.has(text.toLowerCase())) {
        inStubs = text.toLowerCase() === "moved sections";
        return;
      }
      if (!inStubs) {
        out.push({ file: GUIDE_INDEX, line: i + 1, what: `"${text}" is a section on the index. Write it on its area's page instead: ${pageFor(text, all, pages)}` });
        return;
      }
      stub = { heading: text, line: i + 1, body: [] };
      return;
    }
    if (stub) stub.body.push(line);
  });
  close();
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const all = areas() as Record<string, { title: string; scopes?: string[] }>;
  const onDisk = readdirSync(GUIDE_DIR).filter((f) => f.endsWith(".md"));
  const pages: Record<string, string | undefined> = {};
  for (const f of onDisk) pages[`${GUIDE_DIR}/${f}`] = readFileSync(`${GUIDE_DIR}/${f}`, "utf8");
  const violations = check(readFileSync(GUIDE_INDEX, "utf8"), pages, all);
  for (const a of Object.keys(all))
    if (!existsSync(`${GUIDE_DIR}/${a}.md`)) violations.push({ file: `${GUIDE_DIR}/areas.json`, line: 1, what: `lists "${a}", but ${GUIDE_DIR}/${a}.md does not exist` });
  for (const f of onDisk)
    if (!all[f.replace(/\.md$/, "")]) violations.push({ file: `${GUIDE_DIR}/${f}`, line: 1, what: `is not listed in ${GUIDE_DIR}/areas.json, so no scope routes to it and the index does not list it` });
  if (violations.length) {
    console.error(`lint:user-guide-index - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error(`The index (${GUIDE_INDEX}) changes rarely on purpose: a feature's text goes on its area's page, so two pull requests in different areas never collide.`);
    process.exit(1);
  }
  console.log(`lint:user-guide-index OK (${Object.keys(all).length} area pages, every moved section points at a heading that exists)`);
}
