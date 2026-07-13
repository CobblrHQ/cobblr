#!/usr/bin/env tsx
// Client-fetch-mounts lint — every CLIENT fetch path must resolve to a real
// SERVER route mount.
//
// The gap this closes: BackupPage's "Add a destination" was silently dead for
// weeks. The page fetched `${base}/destinations` with `base =
// `/api/v1/orgs/${slug}`` → `/api/v1/orgs/:slug/destinations`, but the router
// is mounted at `/api/v1/orgs/:slug/backup/destinations`. The request 404'd,
// the catch swallowed it, and the feature just… didn't appear. No type error,
// no test, no runtime crash — the whole class of "client path that points at no
// real mount" is invisible to tsc and to the eye, ESPECIALLY when the path is
// built from a `base` variable + a suffix (`${base}/…`) so you never see the
// whole string in one place. (Same shape as the earlier digifabCameraPath
// double-`/api/v1` bug.)
//
// What it does, statically, no build, no running server:
//   1. Builds the SERVER MOUNT TABLE from api/src/server.ts (`v1.use(...)`),
//      the module mount prefix (api/src/modules/mount.ts →
//      /api/v1/orgs/:slug/modules/<name>, one per module dir), and — for the
//      routers mounted at the coarse `/orgs`, `/orgs/:slug`, or the v1 root —
//      each router's own `router.METHOD("/path")` leaf routes. Deeper mounts
//      (`/orgs/:slug/backup`, `/qr`, …) are kept as OPAQUE PREFIXES: any path
//      under a real prefix is assumed served (that granularity is enough to
//      catch the backup class without parsing every leaf of every module).
//   2. Extracts CLIENT paths from web/src/**: `request(METHOD, `/…`)`,
//      `api.request(…)`, and raw `fetch(`/api/v1/…`)` — including the
//      `const base = `/api/v1/orgs/${slug}…`` + `${base}/suffix` concatenation
//      that defeated eyeballing. `${primaryBase(slug,"mod/ent",…)}` is resolved
//      to its module form too.
//   3. ASSERTS every resolved client path matches a real mount; reports the
//      ones that don't with the closest known prefix as a hint.
//   4. Dynamic segments (`${slug}`, `${id}`) match the route PATTERN (`:slug`,
//      `:id`), not by literal equality. Absolute `http(s)://` URLs, non-`/api`
//      paths, and paths whose discriminating segment is itself a variable
//      (fully-dynamic tails like `/orgs/${slug}${rel}`) are skipped — they
//      can't be statically resolved, so flagging them would only add noise.
//
// Suppression: add a `// lint-fetch-mounts-ignore` comment on the SAME line as
// the fetch/request call to exempt a single deliberate exception (document why
// in an adjacent comment). Prefer fixing the path.
//
// Run: npx tsx scripts/lint-client-fetch-mounts.ts   (pnpm run lint:client-fetch-mounts)

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

// ── 1. SERVER MOUNT TABLE ────────────────────────────────────────────────────

/** A route pattern as a list of segments. `:x` = param, "*" = wildcard tail. */
type Segs = string[];

const opaquePrefixes: Segs[] = []; // any client path UNDER one of these is valid
const leafRoutes: Segs[] = []; // exact full patterns (from coarse-mount routers)

const toSegs = (p: string): Segs => p.split("/").filter(Boolean);

/** Two segments are route-compatible: equal, or either is a param/wildcard. */
function segMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const wild = (s: string) => s === "*" || s.startsWith(":");
  return wild(a) || wild(b);
}

/** client (cs) matches server pattern (ps) as an EXACT route (same length). */
function matchesLeaf(cs: Segs, ps: Segs): boolean {
  if (cs.length !== ps.length) return false;
  return cs.every((c, i) => segMatch(c, ps[i]!));
}

/** client (cs) is UNDER opaque prefix (ps): cs at least as long, prefix aligns. */
function matchesPrefix(cs: Segs, ps: Segs): boolean {
  if (cs.length < ps.length) return false;
  return ps.every((p, i) => segMatch(p, cs[i]!));
}

// 1a. Module mounts → /orgs/:slug/modules/<name> opaque prefix, one per module.
const MODULES_DIR = "modules";
const moduleNames: string[] = readdirSync(resolve(ROOT, MODULES_DIR)).filter((d) => {
  try {
    return statSync(resolve(ROOT, MODULES_DIR, d)).isDirectory();
  } catch {
    return false;
  }
});
for (const name of moduleNames) {
  opaquePrefixes.push(["orgs", ":slug", "modules", name]);
}
// The instance-items dispatcher (server.ts) + the primaryBase() instance form.
opaquePrefixes.push(["orgs", ":slug", "instances", ":name", "items"]);

// 1b. Parse api/src/server.ts `v1.use(...)` mounts.
const SERVER = "api/src/server.ts";
const serverSrc = read(SERVER);

// Direct routes on v1 itself (e.g. v1.get("/healthz", …)) are leaf routes.
for (const sub of routerLeafPaths(serverSrc, "v1")) leafRoutes.push(toSegs(sub));

// Map router identifier → source file, from `import { xRouter } from "./routes/y.js"`.
const routerFile = new Map<string, string>();
for (const m of serverSrc.matchAll(/import\s*\{([^}]+)\}\s*from\s*"(\.\/routes\/[^"]+)"/g)) {
  const names = m[1]!.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()!.trim());
  const file = "api/src/" + m[2]!.replace(/^\.\//, "").replace(/\.js$/, ".ts");
  for (const n of names) if (n) routerFile.set(n, file);
}

// Each `v1.use( "path"?, ...args )`. Capture the (optional) string mount path
// and the router identifiers among the args.
const V1_USE = /v1\.use\(\s*([\s\S]*?)\);/g;
for (const m of serverSrc.matchAll(V1_USE)) {
  const args = m[1]!;
  const strLit = args.match(/^\s*"([^"]*)"/);
  const mountPath = strLit ? strLit[1]! : ""; // "" = mounted at v1 root
  const mountSegs = toSegs(mountPath);
  const identArgs = [...args.matchAll(/\b([A-Za-z][A-Za-z0-9_]*Router)\b/g)].map((x) => x[1]!);

  // Classify. Coarse mounts ("", "/orgs", "/orgs/:slug") → leaf-parse their
  // routers so `/orgs/:slug/destinations` (invalid) is distinguishable from
  // `/orgs/:slug/focused` (valid). Everything deeper/dedicated → opaque prefix.
  const isCoarse =
    mountSegs.length === 0 ||
    (mountSegs.length === 1 && mountSegs[0] === "orgs") ||
    (mountSegs.length === 2 && mountSegs[0] === "orgs" && mountSegs[1]!.startsWith(":"));

  if (!isCoarse) {
    if (mountSegs.length > 0) opaquePrefixes.push(mountSegs);
    continue;
  }
  // Leaf-parse each router at this coarse mount.
  for (const ident of identArgs) {
    const file = routerFile.get(ident);
    if (!file || !existsSync(resolve(ROOT, file))) continue;
    for (const sub of routerLeafPaths(read(file), ident)) {
      leafRoutes.push([...mountSegs, ...toSegs(sub)]);
    }
  }
}

/** All `IDENT.get|post|patch|delete|put("/path", …)` route paths in a router
 *  file. The path literal is always the first arg (Express contract); it may
 *  sit on the line after `.get(`, so match across whitespace/newlines. */
function routerLeafPaths(src: string, ident: string): string[] {
  const re = new RegExp(
    `\\b${ident}\\.(?:get|post|patch|delete|put)\\(\\s*["'\`]([^"'\`]+)["'\`]`,
    "g",
  );
  const out: string[] = [];
  for (const m of src.matchAll(re)) out.push(m[1]!.split(/[?#]/)[0]!);
  return out;
}

if (leafRoutes.length === 0 || opaquePrefixes.length === 0) {
  console.error("[lint:client-fetch-mounts] built an empty mount table — parser drift in server.ts? Aborting.");
  process.exit(1);
}

// Top-level API namespaces a raw `request(...)` path (no /api/v1 prefix) can
// hit. Built from the mount table so it stays in sync.
const TOP_LEVEL = new Set([
  ...opaquePrefixes.filter((s) => s.length === 1).map((s) => s[0]!),
  "me",
  "orgs",
]);
function isTopLevelApi(tpl: string): boolean {
  const first = toSegs(tpl)[0];
  return first !== undefined && TOP_LEVEL.has(first);
}

// ── 2. CLIENT FETCH PATH EXTRACTION ──────────────────────────────────────────

const WEB_DIR = "web/src";
interface Finding {
  file: string;
  line: number;
  path: string;
}
const offenders: Finding[] = [];
const skipped: string[] = []; // unresolved-but-not-flagged, for the summary count
let checkedOk = 0; // client paths that resolved AND matched a mount

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const rel = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(rel));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel);
  }
  return out;
}

// A path template we pulled out of a call site, with the source position.
interface Raw {
  tpl: string; // the backtick/quoted contents, e.g. "/orgs/${slug}/backup/destinations"
  line: number;
  ignored: boolean;
}

// Match: fetch(`…`) | request("M", `…`) | api.request("M", `…`)  — path is a
// template/quoted literal. We only care about the PATH argument.
const CALL_RE =
  /(?:\bfetch\(|\b(?:api\.)?request(?:<[^>]*>)?\(\s*"[A-Z]+"\s*,)\s*([`"'])((?:\\.|(?!\1).)*)\1/g;

for (const file of walk(WEB_DIR)) {
  const src = read(file);
  const lineStarts = buildLineIndex(src);
  const raws: Raw[] = [];
  for (const m of src.matchAll(CALL_RE)) {
    const tpl = m[2]!;
    const idx = m.index ?? 0;
    const line = lineStarts.findIndex((s, i) => idx >= s && (i === lineStarts.length - 1 || idx < lineStarts[i + 1]!)) + 1;
    const lineText = src.slice(lineStarts[line - 1] ?? 0, lineStarts[line] ?? src.length);
    raws.push({ tpl, line, ignored: /lint-fetch-mounts-ignore/.test(lineText) });
  }
  if (raws.length === 0) continue;

  // Per-file base-variable table: `const IDENT = `<path-ish template>``.
  const bases = new Map<string, string[]>();
  for (const bm of src.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*`([^`]*)`/g)) {
    const val = bm[2]!;
    if (/^\/(api\/v1\/)?orgs\b|^\/api\/v1\b/.test(val)) {
      const list = bases.get(bm[1]!) ?? [];
      list.push(val);
      bases.set(bm[1]!, list);
    }
  }

  for (const raw of raws) {
    if (raw.ignored) continue;
    for (const resolved of resolveTemplate(raw.tpl, bases)) {
      const verdict = classify(resolved);
      if (verdict === "ok") {
        checkedOk++;
        continue;
      }
      if (verdict === "skip") {
        skipped.push(`${file}:${raw.line} — ${resolved}`);
        continue;
      }
      offenders.push({ file, line: raw.line, path: resolved });
    }
  }
}

/** Resolve a raw template to zero or more effective server paths (strings that
 *  still contain `${…}` interpolations — normalization happens in classify()).
 *  Returns [] when the head is an absolute/external URL we should ignore. */
function resolveTemplate(tpl: string, bases: Map<string, string[]>): string[] {
  // External / non-API → ignore.
  if (/^https?:\/\//.test(tpl)) return [];

  // Head is `${primaryBase(slug, "mod/ent", …)}` → module form.
  const pb = tpl.match(/^\$\{primaryBase\(\s*[^,]+,\s*"([^"]+)"/);
  if (pb) {
    const rest = tpl.slice(tpl.indexOf("}") + 1);
    return [`/orgs/:slug/modules/${pb[1]!}${rest}`];
  }

  // Head is `${IDENT}…` where IDENT is a known base variable.
  const bm = tpl.match(/^\$\{([A-Za-z_$][\w$]*)\}/);
  if (bm && bases.has(bm[1]!)) {
    const rest = tpl.slice(bm[0]!.length);
    return bases.get(bm[1]!)!.map((v) => v + rest);
  }
  // Head is some OTHER `${…}` (unknown var / expression) → can't resolve.
  if (tpl.startsWith("${")) return [];

  // Literal head. Must be an API path to be in scope.
  if (tpl.startsWith("/api/v1") || tpl.startsWith("/orgs") || isTopLevelApi(tpl)) return [tpl];
  return [];
}

/** ok | skip | bad. Normalizes `${…}` segments to wildcards and matches the
 *  mount table. `skip` = not statically resolvable (fully-dynamic tail). */
function classify(path0: string): "ok" | "skip" | "bad" {
  let path = path0.split(/[?#]/)[0]!; // drop query/hash
  if (path.startsWith("/api/v1")) path = path.slice("/api/v1".length) || "/";

  const rawSegs = toSegs(path);
  const segs: Segs = [];
  let dynamicTail = false;
  for (const s of rawSegs) {
    if (!s.includes("${")) {
      segs.push(s);
      continue;
    }
    // Pure `${expr}` = one wildcard segment. Anything more complex (glued
    // interpolations, path-like vars that may carry their own slashes) makes
    // the rest of the path un-resolvable.
    if (/^\$\{[^${}]*\}$/.test(s)) segs.push("*");
    else {
      dynamicTail = true;
      break;
    }
  }

  if (segs.length === 0) return "skip";

  // A fully-dynamic tail means we only know a PREFIX. Only usable if that
  // concrete prefix already resolves to a known opaque prefix; otherwise skip
  // (can't prove it's broken without guessing what the variable holds).
  if (dynamicTail) {
    return opaquePrefixes.some((p) => matchesPrefix(segs, p)) ? "ok" : "skip";
  }

  // If the discriminating segment (after /orgs/:slug) is itself a wildcard, we
  // can't tell a real route from a typo → skip.
  if (segs[0] === "orgs" && segs.length >= 3 && segs[2] === "*") return "skip";

  if (opaquePrefixes.some((p) => matchesPrefix(segs, p))) return "ok";
  if (leafRoutes.some((p) => matchesLeaf(segs, p))) return "ok";
  // Some coarse leaf routers legitimately serve deeper trees we didn't fully
  // parse; if the client path is a valid PREFIX of a known leaf, accept it.
  if (leafRoutes.some((p) => matchesPrefix(p, segs))) return "ok";
  return "bad";
}

function buildLineIndex(src: string): number[] {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
  return starts;
}

/** Closest known prefix, purely for the "did you mean" hint. */
function closest(segs: Segs): string {
  let best = "";
  let bestScore = -1;
  for (const p of [...opaquePrefixes, ...leafRoutes]) {
    let score = 0;
    for (let i = 0; i < Math.min(p.length, segs.length); i++) {
      if (segMatch(p[i]!, segs[i]!)) score++;
      else break;
    }
    if (score > bestScore) {
      bestScore = score;
      best = "/" + p.join("/");
    }
  }
  return best;
}

// ── 3. REPORT ────────────────────────────────────────────────────────────────

if (process.env.DEBUG_FETCH_MOUNTS) for (const s of skipped) console.error("SKIP", s);

// Guard against a silently-broken extractor going vacuously green: this repo
// has ~200 client call sites, so a healthy run resolves dozens. If we suddenly
// resolve almost nothing, the regex drifted — fail loudly rather than pass.
const CHECKED_FLOOR = 40;
if (checkedOk < CHECKED_FLOOR) {
  console.error(
    `[lint:client-fetch-mounts] only ${checkedOk} client paths resolved (floor ${CHECKED_FLOOR}) — the extractor regex likely drifted. Aborting rather than pass vacuously.`,
  );
  process.exit(1);
}

const summary = `[lint:client-fetch-mounts] scanned web/src — ${moduleNames.length} modules, ${leafRoutes.length} leaf routes, ${opaquePrefixes.length} prefixes; ${checkedOk} client paths OK, ${skipped.length} dynamic paths skipped.`;

if (offenders.length > 0) {
  console.error(summary);
  console.error(
    `\n✗ ${offenders.length} client fetch path(s) resolve to NO server mount:\n`,
  );
  for (const o of offenders) {
    const segs = toSegs(o.path.replace(/^\/api\/v1/, "").split(/[?#]/)[0]!).map((s) =>
      /\$\{/.test(s) ? "*" : s,
    );
    console.error(`  ${o.file}:${o.line} — ${o.path}\n      no server mount (did you mean ${closest(segs)}?)`);
  }
  console.error(
    `\nEither the client path is wrong (fix it), or the route really isn't mounted (add the mount in api/src/server.ts).\n` +
      `Deliberate exception? Put \`// lint-fetch-mounts-ignore\` on the call's line and say why.`,
  );
  process.exit(1);
}

console.log(summary);
console.log("✓ every resolvable client fetch path maps to a real server mount.");
process.exit(0);
