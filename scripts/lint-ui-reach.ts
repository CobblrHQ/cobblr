#!/usr/bin/env tsx
// Every route that changes something, and every registered action, is offered by a screen, or says at its declaration why no screen offers it.
//
// THE BUG THIS PREVENTS. The fundamentals audit (2026-09, #4115) kept finding
// writes the API had and no screen offered: a maintenance schedule could be
// changed over PATCH and nowhere else (#4172), an order's lines could not be
// edited (#4196), a list could not be renamed nor an item edited (#4209). Each
// looked finished from the API and was, to a person, missing. CLAUDE.md calls
// it "backend depth without the UI": a capability nobody can reach. The
// assistant's half of the same question is lint-ai-reach-routes; this is the
// person's.
//
// THE RULE. Each write route (post/patch/put/delete on a router, every module
// and the kernel, read by scripts/lib/mutating-routes.ts, the reader both
// lints share) and each registered action (a module manifest's `actions`, the
// kernel's platform-actions.ts) is one of:
//
//   1. CALLED by a screen: some source under web/src, packages/platform-web,
//      a module's ui/ or the ops console names its path with its verb
//      (`request("PATCH", `/orgs/${slug}/modules/x/y/${id}`)`, a module ui's
//      `this.request("POST", "/categories")`, `fetch(url, { method: "DELETE" })`).
//      Found, not written down, so it cannot go stale.
//   2. An ACTION a screen offers by its nature: one that applies to records
//      shows on each record's action bar (EntityActionsBar lists every
//      user-invokable one), a wire-only one is a target on the Wires screen,
//      and any action whose id a screen names (useRunAction("x:y")).
//   3. Said at the declaration, within six lines above the route or the
//      action's `id:`:
//        // UI-SCREEN: /path   the screen that offers it, when the call is
//                              built in a way this reader cannot follow
//                              (checked: the path's first segment is a screen);
//        // UI-REACH: <why>    why no screen should offer it (a device's
//                              wire, an import's second half, a test door).
//   4. The wire: paths no person ever calls (webhooks, polls, a bridge's
//      check-in), by the same family as the assistant's lint.
//
// Anything else fails, unless it is in scripts/ui-reach-baseline.json: the
// gaps that existed when the rule landed. The baseline is a WORKLIST and may
// only shrink; a new route or action cannot join it, it says which it is on
// the day it is written.
//
// A line that is now reached is a NOTE, never a failure, and merge-pr prunes
// it on the merge tree (`--prune`, run from lib/generated-files.mjs). It used
// to fail, and that turned main red whenever two pull requests landed in the
// other order: one reached a gap, the one merging second still carried its
// line, and every pre-push in the fleet was refused over a list one line too
// long (#4358 then #4257, 2026-09-30, seven lines). Pruning can only remove a
// line nothing needs any more, so it never grants what the rule refuses.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The reader matches paths by
// their tail, since a screen builds the front from its own base
// (`${this.base()}/parts/${id}` reads as `:x/parts/:x`). A relative path is
// only credited to routes of the module whose ui/ it sits in: inventory's
// "/categories" is not a call to some other module's /categories. A kernel
// route needs a match of two segments or its whole length, so a bare
// "/move" in one screen does not reach every route that ends in move. Verb
// matters: a screen that GETs /lists/:x has not offered PATCH /lists/:x,
// which is exactly the shape #4209 had.
//
// PROVEN RED, three ways (2026-09-30). On main's tree, before their fixes,
// it names the audit's own finds: PATCH core-maintenance /schedules/:x
// (#4172), POST/PATCH/DELETE purchases /orders/:x/items (#4196) and PATCH
// lists /lists/:x (#4209); they are on the worklist. With #4196's screen
// applied, it fails until those three lines come off the worklist. And with
// the bridges page's one call removed, it names POST /edge/bridges/disconnect.
// The api-client-reachable baseline's uncalled methods (a signup invite's
// revoke, a conversation's read, putaway's confirm) are here as today's gaps
// too: a client method nothing calls is not a screen.
//
//   npx tsx scripts/lint-ui-reach.ts                    (pnpm lint ui-reach)
//   npx tsx scripts/lint-ui-reach.ts --write-baseline   (only when the rule is first turned on)
//   npx tsx scripts/lint-ui-reach.ts --prune            (drop reached lines; merge-pr runs it)
import { manifestSources } from "./lib/manifest-sources.ts";
import { readOnce } from "./lib/read-once.ts";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { METHOD_LINE, apiClientMethods, callerCorpus, isApiClientFile, isCalled } from "./lib/api-client-methods.ts";
import { DEVICE_WIRE_PATH, MODULES, kernelRoutes, moduleRoutes, routedModules, type MutatingRoute } from "./lib/mutating-routes.ts";

const BASELINE_FILE = process.env.COBBLR_UI_REACH_BASELINE || join("scripts", "ui-reach-baseline.json");
const PLATFORM_ACTIONS_FILE = join("api", "src", "platform", "platform-actions.ts");
const LOOKBACK = 6;
const SCREEN_MARK = /UI-SCREEN:\s*(\S+)/;
const REACH_MARK = /UI-REACH:\s*\S/;

/** Kernel route files that are the wire or a test door by what they are: no
 *  person is ever offered them on a screen. */
const WIRE_FILES = /^(inbound-email|discord-interactions|webhooks?|hooks|receipt-ingest|scan-drive|test-support)\b/;

// ── The screens' calls ────────────────────────────────────────────────────
const UI_ROOTS = ["web/src", "packages/platform-web/src", "ops-console/src"];

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
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts")) yield p;
  }
}

function uiFiles(): string[] {
  const out: string[] = [];
  for (const r of UI_ROOTS) out.push(...walk(r));
  for (const mod of readdirSync(MODULES)) out.push(...walk(join(MODULES, mod, "src", "ui")));
  return out;
}

interface Call {
  verb: string;
  segs: string[];
  /** Written from the root (`/orgs/${slug}/…`), not onto a base the screen
   *  built (`${base}/parts`): it must match a route whole, not by its tail. */
  anchored: boolean;
  /** The modules a relative path is credited to: the one whose ui/ it sits
   *  in, and any the same line names as a base (`primaryBase(slug,
   *  "inventory/parts")`). */
  mods: string[];
}

const VERB_ON_LINE = /["'`](GET|POST|PATCH|PUT|DELETE)["'`]/g;
const METHOD_KEY = /method\s*:\s*["'`](GET|POST|PATCH|PUT|DELETE|get|post|patch|put|delete)["'`]/;
// A helper named for its verb, or an upload (web's `upload`, platform-web's
// `uploadJson`, #4328), or a body lookup (web's `lookupInBody`, #4673), each
// always a POST.
const HELPER_VERB = /(?:^|[^\w])(post|patch|put|delete|del|upload|uploadJson|lookupInBody)\s*(?:<[^>]*>)?\(\s*$/;
/** The same helper opening a generic type that runs over several lines, the
 *  path on the line after `}>(`. */
const HELPER_OPENS = /(?:^|[^\w.])(post|patch|put|delete|del|upload|uploadJson|lookupInBody)\s*<\s*(?:\{|$)/;
const LITERAL = /`((?:[^`\\]|\\.)*)`|"([^"\n\\]*)"|'([^'\n\\]*)'/g;

/** A literal as path segments, parameters and interpolations as `:x`, or null
 *  when it is not a path. */
function pathSegs(lit: string): { segs: string[]; anchored: boolean } | null {
  // A template nested inside an interpolation (`${id ? `?x=${id}` : ""}`)
  // ends the outer literal early for this reader; what came before it is the
  // path.
  const s = lit.replace(/\$\{[^}]*\}/g, ":x").replace(/\$\{.*$/, "");
  if (!/^(:x)*\//.test(s) && !/\/orgs\//.test(s)) return null;
  if (/\s/.test(s) || s.length < 2) return null;
  const path = s.replace(/[?#].*$/, "").replace(/^(:x)*\/api\/v1(?=\/)/, "");
  const segs = path.split("/").filter(Boolean);
  const anchored = path.startsWith("/");
  // Leading interpolations are a base the screen builds; the tail is the route.
  while (segs[0] === ":x") segs.shift();
  return segs.some((x) => x !== ":x") ? { segs, anchored } : null;
}

function readCalls(): Call[] {
  const calls: Call[] = [];
  const moduleNames = new Set(readdirSync(MODULES));
  // A client method nothing calls opens no screen, however well its path
  // reads (lint-api-client-reachable fails it; its baseline is today's gaps).
  const corpus = callerCorpus();
  const uncalled = new Set(apiClientMethods().filter((m) => !isCalled(m, corpus)));
  for (const f of uiFiles()) {
    const mod = f.startsWith(`${MODULES}/`) ? f.split("/")[1]! : null;
    const lines = readOnce(f).split("\n");
    let method: string | null = null;
    for (let i = 0; i < lines.length; i++) {
      // The client's record paths start from primaryBase(slug, "<module>/<path>",
      // instance), which is /orgs/:slug/modules/<module>/<path> (or the
      // instance's items, the same route under another door).
      const line = lines[i]!
        .replace(/\$\{primaryBase\(\s*\w+\s*,\s*["'`]([^"'`]+)["'`][^)]*\)\}/g, "/orgs/${slug}/modules/$1")
        .replace(/\bprimaryBase\(\s*\w+\s*,\s*["'`]([^"'`]+)["'`][^)]*\)/g, "`/orgs/${slug}/modules/$1`");
      if (isApiClientFile(f)) {
        method = line.match(METHOD_LINE)?.[1] ?? method;
        if (method && uncalled.has(method)) continue;
      }
      if (!line.includes("/") && !/Request\s*[<(]/.test(line)) continue;
      // Quoted anywhere on the line, a base's module is often inside the
      // template itself: `${primaryBase(slug, "inventory/parts")}/…`.
      const named = [...line.matchAll(/["'`]([a-z0-9-]+)(?:\/[^"'`]*)?["'`]/g)].map((m) => m[1]!).filter((w) => moduleNames.has(w));
      const mods = [...new Set([...(mod ? [mod] : []), ...named])];
      for (const m of line.matchAll(LITERAL)) {
        const before = line.slice(0, m.index);
        // A module's client names a collection's base in its helper:
        // `this.projectsRequest("POST", "")`, `this.partsRequest("PATCH", `/${id}`)`
        // are /projects and /parts/:x under the module.
        const helper = mod ? before.match(/\b([a-z][a-zA-Z]*?)Request\s*(?:<[^>]*>)?\(\s*["'`](?:GET|POST|PATCH|PUT|DELETE)["'`]\s*,\s*$/)?.[1] : undefined;
        const lit = m[1] ?? m[2] ?? m[3] ?? "";
        const read = helper ? pathSegs(`/${helper}${lit.startsWith("/") || lit === "" ? lit : `/${lit}`}`) : pathSegs(lit);
        if (!read) continue;
        const { segs } = read;
        const anchored = helper ? false : read.anchored;
        const verbs = [...before.matchAll(VERB_ON_LINE)];
        let verb = verbs.length ? verbs[verbs.length - 1]![1]! : null;
        if (!verb) verb = before.match(HELPER_VERB)?.[1] ?? (i > 0 ? lines[i - 1]!.match(HELPER_VERB)?.[1] : undefined) ?? null;
        if (!verb && /^\s*\}?>?\(\s*$/.test(before)) {
          for (let j = i - 1; !verb && j >= Math.max(0, i - 8); j--) verb = lines[j]!.match(HELPER_OPENS)?.[1] ?? null;
        }
        // `request(\n  "POST",\n  `/path`,`: the verb is its own line above.
        for (let j = i - 1; !verb && !before.trim() && j >= Math.max(0, i - 2); j--) {
          const prev = lines[j]!;
          if (prev.includes("/")) break;
          const vs = [...prev.matchAll(VERB_ON_LINE)];
          if (vs.length) verb = vs[vs.length - 1]![1]!;
        }
        if (!verb) {
          for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 8) && !verb; j++) verb = lines[j]!.match(METHOD_KEY)?.[1] ?? null;
        }
        if (!verb) verb = [...line.slice(m.index! + m[0].length).matchAll(VERB_ON_LINE)][0]?.[1] ?? "GET";
        const V = verb.toUpperCase();
        calls.push({ verb: V === "DEL" ? "DELETE" : V === "UPLOAD" || V === "UPLOADJSON" || V === "LOOKUPINBODY" ? "POST" : V, segs, anchored, mods });
      }
    }
  }
  return calls;
}

/** Does `call` name `route` whole, position by position (a parameter on
 *  either side matching any one segment)? */
function wholeMatches(route: string[], call: string[]): boolean {
  return route.length === call.length && call.every((t, k) => t === ":x" || route[k] === ":x" || route[k] === t);
}

/** Does `tail` match the end of `full`, `:x` matching anything either way? */
function tailMatches(full: string[], tail: string[]): boolean {
  if (tail.length > full.length) return false;
  const off = full.length - tail.length;
  return tail.every((t, k) => t === ":x" || full[off + k] === ":x" || full[off + k] === t);
}

function reachedByCall(r: MutatingRoute, calls: Call[]): boolean {
  // Below /orgs/:x/modules/<name>: the route as the module serves it.
  const own = r.served.split("/").filter(Boolean).slice(4);
  if (r.area === "kernel") {
    const served = r.served.split("/").filter(Boolean);
    return calls.some(
      (c) =>
        c.verb === r.verb &&
        (c.anchored ? wholeMatches(served, c.segs) : (c.segs.length >= 2 || c.segs.length === served.length) && tailMatches(served, c.segs)),
    );
  }
  const underModule = ["orgs", ":x", "modules", r.area, ...own];
  const underInstance = ["orgs", ":x", "instances", ":x", ...own];
  return calls.some((c) => {
    if (c.verb !== r.verb) return false;
    if (c.anchored && c.segs[0] === "orgs") return wholeMatches(underModule, c.segs) || wholeMatches(underInstance, c.segs);
    const absolute = c.segs.includes("modules") || c.segs.includes("instances");
    if (absolute) return tailMatches(underModule, c.segs) || tailMatches(underInstance, c.segs);
    // Relative to the module's own base, from its ui/ or a line that names it.
    return c.mods.includes(r.area) && tailMatches(own, c.segs);
  });
}

// ── The screens themselves, for checking a UI-SCREEN claim ───────────────
/** Every screen's path pattern: a <Route> in web/src, or a module's declared
 *  route. A pattern's `:param` matches any one segment and a trailing `*`
 *  the rest. */
function screenPatterns(): string[][] {
  const out: string[][] = [[]];
  const add = (p: string) => out.push(p.replace(/^\/w\/:[a-zA-Z]+/, "").split("/").filter(Boolean));
  for (const f of walk("web/src")) {
    for (const m of readOnce(f).matchAll(/<Route\s+path=["'`]([^"'`]+)["'`]/g)) add(m[1]!);
  }
  for (const mod of readdirSync(MODULES)) {
    for (const man of manifestSources(join(MODULES, mod))) {
      for (const m of readOnce(man).matchAll(/\b(?:route|path)\s*:\s*["'`](\/[^"'`]*)["'`]/g)) add(m[1]!);
    }
  }
  return out;
}

function isScreen(path: string, patterns: string[][]): boolean {
  const segs = path.split("/").filter(Boolean);
  return patterns.some((p) => {
    for (let k = 0; k < p.length; k++) {
      if (p[k] === "*") return true;
      if (k >= segs.length) return false;
      if (!p[k]!.startsWith(":") && p[k] !== segs[k]) return false;
    }
    return p.length === segs.length;
  });
}

// ── Registered actions ────────────────────────────────────────────────────
interface Action {
  id: string;
  file: string;
  line: number;
  above: string;
  scope: "entity" | "workspace";
  userInvokable: boolean;
  wireOnly: boolean;
  internal: boolean;
}

/** The index just past the bracket that closes the one at `open`, skipping
 *  strings, template literals and comments. */
function closeOf(src: string, open: number): number {
  const pair: Record<string, string> = { "[": "]", "{": "}", "(": ")" };
  const stack = [pair[src[open]!]!];
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i]!;
    if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      if (i < 0) return src.length;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2) + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (pair[c]) stack.push(pair[c]!);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return i + 1;
    }
  }
  return src.length;
}

/** The top-level `{ … }` objects of the array literal opening at `open`. */
function objectsIn(src: string, open: number): Array<{ start: number; body: string }> {
  const end = closeOf(src, open);
  const out: Array<{ start: number; body: string }> = [];
  for (let i = open + 1; i < end; i++) {
    const c = src[i]!;
    if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < end && src[i] !== c; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (c === "{") {
      const close = closeOf(src, i);
      out.push({ start: i, body: src.slice(i, close) });
      i = close - 1;
    }
  }
  return out;
}

function actionsOf(file: string, arrayOpeners: RegExp): Action[] {
  const src = readOnce(file);
  const out: Action[] = [];
  for (const m of src.matchAll(arrayOpeners)) {
    const open = src.indexOf("[", m.index! + m[0].length - 1);
    for (const o of objectsIn(src, open)) {
      const id = o.body.match(/^\{\s*(?:\/\/[^\n]*\n\s*)*[^]*?\bid:\s*["'`]([a-z0-9-]+:[a-z0-9-]+)["'`]/)?.[1];
      if (!id) continue;
      const idAt = src.indexOf(id, o.start);
      const line = src.slice(0, idAt).split("\n").length;
      const lines = src.split("\n");
      out.push({
        id,
        file,
        line,
        above: lines.slice(Math.max(0, line - 1 - LOOKBACK), line).join("\n"),
        scope: /\bscope:\s*["'`]workspace["'`]/.test(o.body) ? "workspace" : "entity",
        userInvokable: !/\buserInvokable:\s*false/.test(o.body),
        wireOnly: /\bwireOnly:\s*true/.test(o.body),
        internal: /\binternal:\s*true/.test(o.body),
      });
    }
  }
  return out;
}

function allActions(): Action[] {
  const out: Action[] = [];
  // module.ts, its action files and its families' manifest pieces (lib/manifest-sources.ts):
  // an action declared in a family is judged like one in module.ts.
  for (const mod of readdirSync(MODULES)) for (const man of manifestSources(join(MODULES, mod))) out.push(...actionsOf(man, /\bactions:\s*\[/g));
  if (existsSync(PLATFORM_ACTIONS_FILE)) out.push(...actionsOf(PLATFORM_ACTIONS_FILE, /PlatformActionDecl\s*\[\s*\]\s*=\s*\[/g));
  return out;
}

// ── Judge ─────────────────────────────────────────────────────────────────
interface Gap {
  key: string;
  where: string;
  what: string;
}
const gaps: Gap[] = [];
const problems: string[] = [];
const screens = screenPatterns();
const calls = readCalls();
let routesChecked = 0;
let actionsChecked = 0;

function annotated(above: string, where: string): boolean {
  const screen = above.match(SCREEN_MARK)?.[1];
  if (screen) {
    if (!screen.startsWith("/") || !isScreen(screen, screens)) {
      problems.push(`${where}  UI-SCREEN names "${screen}", which is not a screen (a <Route> path in web/src, or a module's route)`);
    }
    return true;
  }
  return REACH_MARK.test(above);
}

const routes = [...routedModules().flatMap((m) => moduleRoutes(m, LOOKBACK)), ...kernelRoutes(LOOKBACK)];
for (const r of routes) {
  if (DEVICE_WIRE_PATH.test(r.served)) continue;
  if (r.area === "kernel" && WIRE_FILES.test(r.file.replace(/^api\/src\/routes\//, ""))) continue;
  routesChecked++;
  const where = `${r.file}:${r.line}`;
  if (annotated(r.above, where)) continue;
  if (reachedByCall(r, calls)) continue;
  gaps.push({ key: `${r.file} ${r.verb} ${r.path}`, where, what: `${r.verb} ${r.path}: no screen calls it` });
}

let uiCorpus = "";
for (const f of uiFiles()) uiCorpus += readOnce(f) + "\n";
for (const a of allActions()) {
  if (a.internal) continue; // the way back for another action, run by Undo
  actionsChecked++;
  const where = `${a.file}:${a.line}`;
  if (annotated(a.above, where)) continue;
  if (uiCorpus.includes(`"${a.id}"`) || uiCorpus.includes(`'${a.id}'`) || uiCorpus.includes(`\`${a.id}\``)) continue;
  if (a.scope === "entity") continue; // a record's action bar, or a wire's target on Wires
  gaps.push({ key: `action ${a.id}`, where, what: `action ${a.id}: runs on the workspace, and no screen offers it` });
}

// ── The worklist ──────────────────────────────────────────────────────────
if (process.argv.includes("--write-baseline")) {
  const keys = [...new Set(gaps.map((g) => g.key))].sort();
  writeFileSync(
    BASELINE_FILE,
    `${JSON.stringify(
      {
        _why:
          "Writes and actions no screen offered when lint:ui-reach landed (2026-09-30). A WORKLIST, not an " +
          "allowance: it may only shrink. Each line is something the API can do that a person cannot. Give it " +
          "a screen, or say at the route why it should have none (// UI-REACH: <why>), then delete its line. " +
          "A new route or action cannot be added here.",
        gaps: keys,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`ui-reach: wrote ${keys.length} gap(s) to ${BASELINE_FILE}`);
  process.exit(0);
}

const worklist = existsSync(BASELINE_FILE) ? (JSON.parse(readOnce(BASELINE_FILE)) as { _why?: string; gaps: string[] }) : { gaps: [] };
const baseline = new Set<string>(worklist.gaps);
const open = gaps.filter((g) => !baseline.has(g.key));
const stillGaps = new Set(gaps.map((g) => g.key));
const healed = [...baseline].filter((k) => !stillGaps.has(k));

// Only removes: a line nothing needs any more. Never adds, so running it on a
// merge can never let a new gap in.
if (process.argv.includes("--prune")) {
  if (healed.length) {
    const keep = worklist.gaps.filter((k) => stillGaps.has(k));
    writeFileSync(BASELINE_FILE, `${JSON.stringify({ ...worklist, gaps: keep }, null, 2)}\n`);
    console.log(`ui-reach: pruned ${healed.length} reached line(s) from ${BASELINE_FILE}`);
  }
  process.exit(0);
}

let failed = false;
if (problems.length) {
  failed = true;
  console.error(`✗ lint:ui-reach: ${problems.length} UI-SCREEN claim(s) name no screen:\n${problems.map((p) => `  ${p}`).join("\n")}`);
}
if (open.length) {
  failed = true;
  console.error(
    `✗ lint:ui-reach: ${open.length} write(s) or action(s) no screen offers:\n` +
      open.map((g) => `  ${g.where}  ${g.what}`).join("\n") +
      "\n\nGive it a screen that calls it (the usual answer: this is the UI half of the feature), or say at the " +
      "route or the action's id, within six lines above:\n" +
      "  // UI-SCREEN: /the/screen    when a screen does offer it in a way this reader cannot follow\n" +
      "  // UI-REACH: <why>           when no screen should (a device's wire, a test door)\n",
  );
}
if (failed) process.exit(1);
if (healed.length) {
  // A note: merge-pr prunes these on the merge (`--prune`); failing here
  // turned main red whenever another change reached one first.
  console.log(
    `  note: ${healed.length} worklist line(s) are reached now; the next merge drops them ` +
      `(npx tsx scripts/lint-ui-reach.ts --prune does it by hand):\n${healed.map((k) => `    ${k}`).join("\n")}`,
  );
}
console.log(
  `✓ lint:ui-reach: ${routesChecked} write route(s) and ${actionsChecked} action(s), each offered by a screen or ` +
    `saying why not (${baseline.size} still on the worklist in ${BASELINE_FILE}).`,
);
