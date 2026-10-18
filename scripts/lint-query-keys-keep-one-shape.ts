#!/usr/bin/env tsx
// Every query that shares a key family keeps the same answer under it: the fetcher's whole response, never one reader's slice of it (a select derives that), and never a list in one place and pages in another.
//
// THE BUG THIS PREVENTS. #7149 (2026-10-17): the catalog picker kept one page and the catalog screen kept pages under one key, and the screen crashed; #7165: the station kept a bare array under core-locations and its Move picker said there were no places.
//
// THE RULE. Two queries with the same key share one cache entry, so what
// one reader stores is what the other reads. A query is read here by its
// hook (useQuery or useInfiniteQuery) and its key, with every variable in
// the key read as "any value" (["core-locations", slug] and
// ["core-locations", activeSlug] are the same entry). For one key, every
// reader must use the same hook, and no reader may reshape its fetcher's
// answer inside queryFn (a `.then(` there) while another stores it whole.
// A reader that wants a slice keeps the whole answer and uses `select`. A
// deliberate exception says `// one-shape: <why>` on its queryKey line.
//
// THE BOUNDARY. Keys that share only their first element are different
// entries (["notifications", "me", "bell"] and ["notifications", "me",
// "page"]), so the whole key is compared, not its family name. A query
// whose queryFn is not on the lines after its key is not judged.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-query-keys-keep-one-shape.ts   (pnpm lint query-keys-keep-one-shape)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "packages/platform-web/src", "modules"];

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
    // An embedded payload (a base64 build) holds no code to judge and is megabytes.
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

interface Reader {
  file: string;
  line: number;
  key: string;
  infinite: boolean;
  reshaped: boolean;
}

/** A key's text with every bare variable read as "any value". */
function keyShape(text: string): string {
  return text
    .replace(/\s+/g, "")
    .replace(/("[^"]*"|'[^']*')|[A-Za-z_$][\w$.!?]*/g, (m, lit: string | undefined) => (lit ? lit : "_"));
}

/** Every query this file reads, by its hook, its key and whether it reshapes. */
function readers(file: string, src: string): Reader[] {
  const out: Reader[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const hook = /\b(useQuery|useInfiniteQuery|useSuspenseQuery)\(\{/.exec(lines[i] ?? "");
    if (!hook) continue;
    // The call's own lines: up to its closing "})" or a dozen lines.
    const call: string[] = [];
    for (let j = i; j < Math.min(lines.length, i + 14); j++) {
      call.push(lines[j] ?? "");
      if (j > i && /^\s*\}\)/.test(lines[j] ?? "")) break;
    }
    const text = call.join("\n");
    const key = /queryKey:\s*(\[[^\]]*\])/.exec(text);
    if (!key || /one-shape: \S/.test(text)) continue;
    const fn = /queryFn:([^\n]*(?:\n[^\n]*){0,3})/.exec(text);
    if (!fn) continue;
    // Only the fetcher's own expression: stop where the next option starts.
    const body = fn[1]!.split(/\n\s*(?:enabled|staleTime|select|initialPageParam|getNextPageParam|retry|gcTime|refetch\w*|placeholderData):/)[0]!;
    out.push({ file, line: i + 1, key: keyShape(key[1]!), infinite: hook[1] === "useInfiniteQuery", reshaped: /\.then\(/.test(body) });
  }
  return out;
}

const violations: Violation[] = [];
// A rule across files: every file is read, not only the change's, since the
// reader that disagrees with a new one is usually in a file nobody touched.
const all: Reader[] = [];
for (const root of ROOTS) for (const file of walk(root)) all.push(...readers(file, readFileSync(file, "utf8")));
const byKey = new Map<string, Reader[]>();
for (const r of all) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
for (const [key, rs] of byKey) {
  if (rs.length < 2) continue;
  const where = (r: Reader) => `${r.file}:${r.line}`;
  if (rs.some((r) => r.infinite) && rs.some((r) => !r.infinite)) {
    for (const r of rs.filter((x) => x.infinite)) violations.push({ file: r.file, line: r.line, what: `pages under ${key}, which ${rs.filter((x) => !x.infinite).map(where).join(", ")} keeps as one answer` });
  }
  if (rs.some((r) => r.reshaped) && rs.some((r) => !r.reshaped)) {
    for (const r of rs.filter((x) => x.reshaped)) violations.push({ file: r.file, line: r.line, what: `reshapes its answer under ${key}, which ${rs.filter((x) => !x.reshaped).map(where).join(", ")} keeps whole` });
  }
}

if (violations.length) {
  console.error(`lint:query-keys-keep-one-shape - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Keep the fetcher's whole answer under the key and derive with select, or give the differently shaped reader its own key segment.");
  process.exit(1);
}
console.log(`lint:query-keys-keep-one-shape OK`);
