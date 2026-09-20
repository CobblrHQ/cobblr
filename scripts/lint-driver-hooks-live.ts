#!/usr/bin/env tsx
// Every hook a browser driver (a tour, a clip, an e2e script) reaches the product by, a data-testid or a placeholder, still exists in the product source.
//
// THE BUG THIS PREVENTS. The design's material and hook pickers became a
// search (#3129, 2026-09-17). The e2e that shipped with that change drove the
// new picker; the guided yarn tour, which nobody knew drove the same panels,
// kept calling selectOption on a <select> that no longer existed. Every
// nightly take after that froze for sixteen seconds, twice, and the run log
// called it dead air rather than a stale selector, because the tour swallowed
// the miss and fell back to the API (#3181).
//
// Nothing that runs at PR time drives a browser, so a driver goes stale the
// moment the product moves and stays stale until a nightly (the tour, the e2e
// suite) or, for the lego tour that no nightly records, forever. What CAN be
// checked at PR time is the CONTRACT between the two: a driver names the hook
// it reaches for, and the product either still declares that hook or it does
// not. So the rule is that a driver reaches a control by a hook the product
// declares, and this lint holds the two sides together.
//
// THE RULE. In kiosk/*.mjs and e2e/*.mjs, every
//   - data-testid a locator names (`[data-testid="x"]`, `getByTestId("x")`),
//   - placeholder it types into (`getByPlaceholder("x" | /re/)`, `[placeholder*='x']`),
//   - label it fills by (`getByLabel("x" | /re/)`),
// must resolve in the product source (web/src, modules/*/src, packages/*/src;
// labels may also come from bundles/ and demo-sites/ JSON, since a field's
// label is data). A testid resolves against the literal testids the product
// renders, or a template prefix (`header-action-${name}`); a placeholder or
// label resolves if the text (or the regex) matches anywhere in that source.
// The match is deliberately loose: the lint asks "does the product still have
// this hook at all", and never fails a driver for a hook the product renders
// by a route it could not follow.
//
// A hook the product genuinely builds at runtime, that no source literal can
// witness, opts out on its line with `// hook-lint: allow <reason>`; every
// allowance is printed on every run so it is read rather than discovered.
//
// What this does NOT check: `locator("select")`, `div.rounded-xl`, a role name.
// A tag or a class is not a contract, which is exactly why the two stale calls
// above were invisible: there was nothing on the product side to hold them to.
// Drive by a hook the lint can see, and a product change that retires it fails
// the PR that retires it, with the driver's line named, instead of a take.
//
// PROVED RED 2026-09-20: against the fixed tour with the product's new panel
// testids removed again (three lines named), and against a placeholder changed
// on purpose; green with both restored.
//
//   npx tsx scripts/lint-driver-hooks-live.ts   (pnpm run lint:driver-hooks-live)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites: the browser drivers. */
const ROOTS = ["kiosk", "e2e"];
/** Where a hook must resolve: what the product renders. */
const PRODUCT_ROOTS = ["web/src", "modules", "packages"];
/** A field's label is data; a driver that fills by label may be naming one. */
const DATA_ROOTS = ["bundles", "demo-sites"];

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

function* walk(dir: string, accept: (name: string) => boolean): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name === "out" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p, accept);
    else if (accept(name)) yield p;
  }
}

const isDriver = (n: string) => /\.mjs$/.test(n);
const isProduct = (n: string) => /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) && !/\.d\.ts$/.test(n);
const isData = (n: string) => /\.json$/.test(n);

// ── the product side: what hooks exist ──
const testids = new Set<string>();
const testidPrefixes: string[] = [];
let productText = "";
let dataText = "";

/** Every string literal and template prefix inside one `{…}` expression. */
function literalsIn(expr: string): void {
  for (const m of expr.matchAll(/"([^"]+)"|'([^']+)'/g)) testids.add((m[1] ?? m[2])!);
  for (const m of expr.matchAll(/`([^`$]+)\$\{/g)) testidPrefixes.push(m[1]!);
  for (const m of expr.matchAll(/`([^`$]+)`/g)) testids.add(m[1]!);
}

for (const root of PRODUCT_ROOTS) {
  for (const file of walk(root, isProduct)) {
    // modules/<name>/src and packages/<name>/src only; a module's tests and
    // migrations render nothing.
    if (root !== "web/src" && !/^(modules|packages)\/[^/]+\/src\//.test(file)) continue;
    const src = readFileSync(file, "utf8");
    productText += "\n" + src;
    // data-testid="x" · data-testid={…} · testId="x" (a prop the component
    // forwards into data-testid) · "data-testid": "x" in a props object.
    for (const m of src.matchAll(/\b(?:data-)?test[iI]d"?\s*[=:]\s*(?:"([^"]+)"|'([^']+)'|\{([^}]*)\})/g)) {
      if (m[1]) testids.add(m[1]);
      else if (m[2]) testids.add(m[2]);
      else if (m[3]) literalsIn(m[3]);
    }
  }
}
for (const root of DATA_ROOTS) {
  for (const file of walk(root, isData)) dataText += "\n" + readFileSync(file, "utf8");
}
const labelText = productText + dataText;

// ── the driver side: what hooks are named ──
type Kind = "testid" | "placeholder" | "label";
interface Ref {
  kind: Kind;
  /** exact text, or a regex */
  needle: string | RegExp;
  /** for testids: how the attribute selector compares */
  op?: "=" | "^=" | "*=";
}

/** A /re/flags literal as written in the driver, as a RegExp with anchors
 *  dropped: the lint asks whether the text exists in the product at all. */
function regexOf(body: string, flags: string): RegExp {
  const src = body.replace(/^\^/, "").replace(/(?<!\\)\$$/, "");
  return new RegExp(src, flags.replace(/[gy]/g, ""));
}

const STR = String.raw`"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'`;
const RE = String.raw`\/((?:[^/\\\n]|\\.)+)\/([a-z]*)`;

function refsOn(line: string): Ref[] {
  const out: Ref[] = [];
  const arg = (m: RegExpMatchArray, s1: number, s2: number, r1: number, r2: number): string | RegExp | null => {
    if (m[s1] !== undefined) return m[s1]!;
    if (m[s2] !== undefined) return m[s2]!;
    if (m[r1] !== undefined) return regexOf(m[r1]!, m[r2] ?? "");
    return null;
  };
  for (const m of line.matchAll(new RegExp(String.raw`getByTestId\(\s*(?:${STR}|${RE})`, "g"))) {
    const n = arg(m, 1, 2, 3, 4);
    if (n !== null) out.push({ kind: "testid", needle: n, op: "=" });
  }
  for (const m of line.matchAll(/\[data-testid(\^=|\*=|=)\s*(?:"([^"]+)"|'([^']+)')\s*\]/g)) {
    out.push({ kind: "testid", needle: (m[2] ?? m[3])!, op: m[1] as Ref["op"] });
  }
  for (const m of line.matchAll(new RegExp(String.raw`getByPlaceholder\(\s*(?:${STR}|${RE})`, "g"))) {
    const n = arg(m, 1, 2, 3, 4);
    if (n !== null) out.push({ kind: "placeholder", needle: n });
  }
  for (const m of line.matchAll(/\[placeholder(?:\^=|\*=|\$=|=)\s*(?:"([^"]+)"|'([^']+)')\s*\]/g)) {
    out.push({ kind: "placeholder", needle: (m[1] ?? m[2])! });
  }
  for (const m of line.matchAll(new RegExp(String.raw`getByLabel\(\s*(?:${STR}|${RE})`, "g"))) {
    const n = arg(m, 1, 2, 3, 4);
    if (n !== null) out.push({ kind: "label", needle: n });
  }
  return out;
}

function resolves(ref: Ref): boolean {
  if (ref.kind === "testid") {
    const n = ref.needle;
    if (n instanceof RegExp) return [...testids].some((t) => n.test(t)) || testidPrefixes.some((p) => n.test(p));
    if (ref.op === "*=") return [...testids].some((t) => t.includes(n)) || testidPrefixes.some((p) => p.includes(n) || n.startsWith(p));
    if (ref.op === "^=") return [...testids].some((t) => t.startsWith(n)) || testidPrefixes.some((p) => p.startsWith(n) || n.startsWith(p));
    return testids.has(n) || testidPrefixes.some((p) => n.startsWith(p));
  }
  const hay = ref.kind === "label" ? labelText : productText;
  return ref.needle instanceof RegExp ? ref.needle.test(hay) : hay.includes(ref.needle);
}

const describe = (ref: Ref): string => {
  const n = ref.needle instanceof RegExp ? String(ref.needle) : JSON.stringify(ref.needle);
  return `${ref.kind} ${n}`;
};

/** `${NAME}` inside a driver's template literal, where NAME is a string
 *  constant of the same file: the literal it stands for. Anything else stays
 *  a template hole, which no source literal can witness. */
function inlineConsts(line: string, consts: Map<string, string>): string {
  return line.replace(/\$\{([A-Za-z_$][\w$]*)\}/g, (whole, name: string) => consts.get(name) ?? whole);
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const consts = new Map<string, string>();
  for (const m of src.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:"([^"]+)"|'([^']+)')\s*;/g)) consts.set(m[1]!, (m[2] ?? m[3])!);
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const code = raw.trim();
    if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) continue;
    const line = inlineConsts(raw, consts);
    const refs = refsOn(line).filter((r) => !(typeof r.needle === "string" && r.needle.includes("${")));
    if (!refs.length) continue;
    const allow = /\/\/\s*hook-lint:\s*allow\s+(.+)$/.exec(line);
    if (allow) {
      console.error(`[lint:driver-hooks-live] allowance honoured at ${file}:${i + 1} - ${allow[1]!.trim()}`);
      continue;
    }
    for (const ref of refs) {
      if (resolves(ref)) continue;
      out.push({
        file,
        line: i + 1,
        what: `${describe(ref)} is not rendered by the product any more (nothing under ${PRODUCT_ROOTS.join(", ")}${ref.kind === "label" ? ", " + DATA_ROOTS.join(", ") : ""} declares it)`,
      });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root, isDriver)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:driver-hooks-live - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error(
    "A driver that reaches for a hook the product retired films (or asserts) a path the product no longer has.\n" +
      "Reach the control by a hook the product still renders, or add the hook to the product; a hook the product\n" +
      "builds at runtime opts out with // hook-lint: allow <reason>.",
  );
  process.exit(1);
}
console.log(`lint:driver-hooks-live OK (${testids.size} testids + ${testidPrefixes.length} prefixes in the product)`);
