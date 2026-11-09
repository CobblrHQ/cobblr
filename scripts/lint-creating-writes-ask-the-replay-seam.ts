#!/usr/bin/env tsx
// A kernel POST outside the workspace door asks the replay seam (replayAccountWrite) or says in a REPLAY: line why it needs no kept answer.
//
// THE BUG THIS PREVENTS. One Idempotency-Key made two workspaces (bike-shop,
// bike-shop-2): POST /orgs ran outside withTenant, the door that asks the
// replay seam, so a Create pressed again after a lost answer made a second
// workspace, 2026-11-09 (#9373).
//
// THE RULE. Every POST under api/src/routes and api/src/auth reaches the
// replay seam (api/src/platform/request-replays.ts) one of two ways:
// withTenant, on the route, in a router.use() above it, in a middleware
// array it spreads, or where api/src/server.ts mounts its router; or
// replayAccountWrite after requireAuth, which keeps a person's answers when
// no workspace holds them. A POST that needs neither says why in a
// `// REPLAY: <why>` line above it: it signs in, it spends a one-time token,
// it sets a state a repeat sets again, its caller has no session to keep an
// answer under, or its answer is a secret a kept answer would store. A file
// the harness alone reaches says so once, `// REPLAY-FILE: <why>`.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. POST only: PUT, PATCH and
// DELETE name the thing they change, so a repeat changes it again rather than
// making a second. Kernel routes only: every module router is mounted behind
// withTenant (api/src/modules/mount.ts). The first run flagged vault's routes,
// which pass withTenant through `const gate = [...]`, and the scan stations,
// which take it from `router.use("/:slug/scan-stations", ...)`; both are read
// as covered, and a router mounted with withTenant in server.ts is too.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-creating-writes-ask-the-replay-seam.ts   (pnpm lint creating-writes-ask-the-replay-seam)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";
import { kernelMounts } from "./lib/mutating-routes.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/src/routes", "api/src/auth"];

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

/** What puts a route through a door that answers a repeat with its first
 *  answer: the workspace door (which asks the seam itself) or the account one. */
const DOOR = /\b(withTenant|replayAccountWrite)\b/;
const EXEMPT = /\/\/ REPLAY: \S/;
const EXEMPT_FILE = /^\/\/ REPLAY-FILE: \S/m;

/** A path with every parameter spelled `:x`, one leading slash, no trailing one. */
const norm = (p: string): string => ("/" + p.replace(/^\/+/, "")).replace(/:[a-zA-Z_]+/g, ":x").replace(/\/+$/, "") || "/";
const under = (path: string, prefix: string): boolean => prefix === "/" || path === prefix || path.startsWith(prefix + "/");

/** The argument list of a call whose `(` sits at `open`, to its matching `)`. */
function argsAt(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1);
}

/** Routers that api/src/server.ts mounts behind a door: `v1.use("/p", requireAuth, withTenant, xRouter)`. */
function mountedBehindADoor(): Set<string> {
  const out = new Set<string>();
  const src = readFileSync(join("api", "src", "server.ts"), "utf8");
  for (const m of src.matchAll(/\b\w+\.use\(/g)) {
    const args = argsAt(src, (m.index ?? 0) + m[0].length - 1);
    if (!DOOR.test(args)) continue;
    for (const r of args.matchAll(/\b(\w+Router)\b/g)) out.add(r[1]!);
  }
  return out;
}
const MOUNTED = mountedBehindADoor();

/** Every POST that passes replayAccountWrite, by its router and written path. */
const SEAMED: Array<{ router: string; path: string }> = [];

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  if (EXEMPT_FILE.test(src)) return out;
  // Middleware lists kept in a const: `const gate = [requireAuth, withTenant, vaultDoor]`.
  const arrays = [...src.matchAll(/\bconst\s+(\w+)\s*=\s*\[([^\]]*)\]/g)].filter((m) => DOOR.test(m[2]!)).map((m) => m[1]!);
  const arrayDoor = arrays.length ? new RegExp(`\\b(${arrays.join("|")})\\b`) : null;
  // A router's own `.use(...)` through a door covers the routes it registers after, under its prefix.
  const uses: Array<{ router: string; prefix: string; at: number }> = [];
  for (const m of src.matchAll(/\b(\w+)\.use\(/g)) {
    const args = argsAt(src, (m.index ?? 0) + m[0].length - 1);
    if (!DOOR.test(args) && !(arrayDoor && arrayDoor.test(args))) continue;
    const prefix = args.match(/^\s*["'`]([^"'`]*)["'`]/)?.[1];
    uses.push({ router: m[1]!, prefix: norm(prefix ?? "/"), at: m.index ?? 0 });
  }
  const calls = [...src.matchAll(/\b(\w+)\.(get|post|put|patch|delete|use|all)\(\s*(?:["'`]([^"'`]*)["'`])?/g)];
  calls.forEach((m, i) => {
    if (m[2] !== "post" || m[3] === undefined) return;
    const router = m[1]!;
    if (MOUNTED.has(router)) return;
    const start = m.index ?? 0;
    const end = i + 1 < calls.length ? (calls[i + 1]!.index ?? src.length) : src.length;
    const body = src.slice(start, end);
    const handlerAt = body.search(/\basync\b|\(\s*req\b|=>/);
    const chain = handlerAt < 0 ? body : body.slice(0, handlerAt);
    const path = norm(m[3]);
    if (/\breplayAccountWrite\b/.test(chain)) SEAMED.push({ router, path });
    if (DOOR.test(chain) || (arrayDoor && arrayDoor.test(chain))) return;
    if (uses.some((u) => u.router === router && u.at < start && under(path, u.prefix))) return;
    const before = src.slice(0, start).split("\n").slice(-4).join("\n");
    if (EXEMPT.test(before) || EXEMPT.test(body)) return;
    out.push({ file, line: src.slice(0, start).split("\n").length, what: `POST ${m[3]} runs outside withTenant and asks no replay seam: sent again after a lost answer, it may run twice` });
  });
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
// Every file is read, so the seamed set below is whole; only a changed file's own findings are kept.
for (const root of ROOTS) for (const file of walk(root)) {
  const found = check(file, readFileSync(file, "utf8"));
  if (onlyChanged(file)) violations.push(...found);
}

// The client keys a person's write outside a workspace only when the server
// keeps its answer: a keyed write is kept on the device and sent again after
// a reload, so a key on a route that keeps nothing would run it twice. Each
// entry in KEPT_ACCOUNT_WRITES is a route above that asks replayAccountWrite.
const CLIENT = join("packages", "platform-web", "src", "write-identity.ts");
const mounts = kernelMounts();
const served = new Set(SEAMED.map((r) => norm((mounts.get(r.router) ?? "") + (r.path === "/" ? "" : r.path))));
const clientSrc = readFileSync(CLIENT, "utf8");
const listAt = clientSrc.indexOf("KEPT_ACCOUNT_WRITES = [");
if (listAt < 0) violations.push({ file: CLIENT, line: 1, what: "KEPT_ACCOUNT_WRITES is gone: this check cannot see which writes the client keys" });
else {
  const list = clientSrc.slice(listAt, clientSrc.indexOf("]", listAt));
  for (const m of list.matchAll(/["'`](POST) ([^"'`]+)["'`]/g)) {
    if (served.has(norm(m[2]!))) continue;
    violations.push({ file: CLIENT, line: clientSrc.slice(0, listAt + (m.index ?? 0)).split("\n").length, what: `the client keys ${m[1]} ${m[2]}, which asks no replayAccountWrite: kept on the device and sent again after a reload, it would run twice` });
  }
}

if (violations.length) {
  console.error(`lint:creating-writes-ask-the-replay-seam - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Pass replayAccountWrite after requireAuth, or write // REPLAY: <why it needs no kept answer> above the route.");
  process.exit(1);
}
console.log(`lint:creating-writes-ask-the-replay-seam OK`);
