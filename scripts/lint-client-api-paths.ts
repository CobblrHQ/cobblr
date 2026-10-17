#!/usr/bin/env tsx
// Every absolute API path a shipped client hard-codes resolves against a route
// this server registers, or says in one line why it does not.
//
// THE BUG THIS PREVENTS. `cobblr-studio`'s tauri.conf shipped
// `/api/v1/desktop/updates/studio/{{target}}/{{arch}}/{{current_version}}` and
// the server only had the three-segment form, so every Studio install anywhere
// asked for an update and was told the feed does not exist, for nine weeks, on
// all three public surfaces at once. A manifest unit test sat beside it and
// passed every one of those days, because it proves the key scheme and never
// asks whether the route exists. From outside, a test at the wrong level and a
// working feature are the same picture. The same scan found a second one
// unprompted: the Edge Helper's release publisher posts to
// `/api/v1/desktop/updates/publish`, and the route is `/api/v1/desktop/publish`
// (401 versus 404, measured 2026-09-22), so its publish step had never worked.
//
// The class is every absolute path a client is BUILT with. The two sides live
// in different repos, never import each other and share no type, so nothing
// typechecks the join: a string in somebody else's config file is the whole
// contract. Neither instance was a bug in a handler; both were a path that
// nothing served.
//
// HOW IT WORKS. The set is DISCOVERED, not listed. `--record` walks the client
// repos checked out beside this one for absolute `/api/v1/...` literals, keeps
// where each came from, and writes scripts/client-api-paths.json. Every run
// then asserts each recorded path against the route table parsed out of this
// repo. A path that nothing serves is a finding naming the path, the client
// file it came from, and that nothing serves it. A path the server is not meant
// to serve (a printer's own API, a route the hosted overlay adds) is exempt by
// an entry carrying a REASON: never a bulk baseline, one line per path, and an
// exemption with no reason is itself a finding.
//
// CI has no client repos checked out, which is why the record is committed: the
// assertion runs everywhere. Where the clients ARE present, what they ship
// today is checked instead of the record, so a new unserved path fails before
// anybody re-records. A record that has merely fallen behind (a client added a
// path that IS served, or dropped one) is printed as a note, never failed: a
// client repo moves on its own schedule, and failing on that turned every
// unrelated push red the first time a client committed.
//
// Run: npx tsx scripts/lint-client-api-paths.ts [--record]

import { readdirSync, readFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { envForOtherRepo } from "./lib/git-env.mjs";
import { dirname, join, resolve } from "node:path";
import { apiDirs, familyMounts } from "./lib/manifest-sources.ts";

// Both overridable so a test can hand the lint a fixture server and fixture
// clients, and run it as a child the way CI does.
const ROOT = resolve(process.env.COBBLR_LINT_ROOT || new URL("..", import.meta.url).pathname);
const RECORD = join(ROOT, "scripts", "client-api-paths.json");
/** Where a client repo sits: beside this one, by the name it is cloned as. */
const SIBLINGS = resolve(process.env.COBBLR_CLIENT_REPOS_DIR || join(ROOT, ".."));
const API_PREFIX = "/api/v1";
/** What makes a directory a copy of this server rather than a client of it. */
const SERVER_ENTRY = "api/src/server.ts";

interface Provenance {
  repo: string;
  file: string;
  line: number;
}
interface Entry {
  /** The literal as the client ships it, placeholders and all. */
  path: string;
  /** "served": this server must have a route for it. "exempt": it must not, and says why. */
  status: "served" | "exempt";
  reason?: string;
  clients: Provenance[];
}
interface Record_ {
  /** The repos the last --record walked. A repo absent from this list was never
   *  scanned, which is a different thing from having no paths (a run on a box
   *  without it must not silently drop what it ships). */
  scanned: string[];
  paths: Entry[];
}

// ── the client side: discovery ──────────────────────────────────────────────

/** A file worth reading for a hard-coded path: config a client ships, or the
 *  script that talks to this server. Compiled output and dependencies are not
 *  the client's own source. */
const CLIENT_FILE = /\.(json|jsonc|ts|tsx|js|mjs|cjs|rs|py|toml|ya?ml|conf|service)$/;
const SKIP_DIR = /^(node_modules|target|dist|build|\.git|out|coverage|vendor|__pycache__|tests?|__tests__|e2e|fixtures|_tmp)$/;
/** A test is not shipped: its literals are fixtures for somebody else's API as
 *  often as they are ours, and a client that ships nothing from it promises nothing. */
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
/** An absolute path on this API. The trailing character class stops at a quote,
 *  a backtick or whitespace, and keeps the placeholder shapes clients use. */
const PATH_RE = /\/api\/v1\/[A-Za-z0-9{}$:/_.<>-]*/g;

function walkFiles(dir: string, acc: string[] = [], depth = 0): string[] {
  if (depth > 8) return acc;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of names) {
    if (SKIP_DIR.test(name)) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkFiles(p, acc, depth + 1);
    else if (CLIENT_FILE.test(name) && !TEST_FILE.test(name)) acc.push(p);
  }
  return acc;
}

/** The client repos beside this one: a sibling git repo that is not a copy of
 *  THIS server. A worktree of this repo, or a build tree made from it, carries
 *  the server's own route declarations and tests, which are not a client's
 *  promise; they are recognised by carrying the server's entry point rather
 *  than by name, so a new copy is skipped and a new client is scanned the day
 *  either is cloned. */
export function clientRepos(siblings = SIBLINGS, self = ROOT): string[] {
  let names: string[];
  try {
    names = readdirSync(siblings);
  } catch {
    return [];
  }
  return names
    .filter((n) => {
      const p = join(siblings, n);
      if (resolve(p) === resolve(self)) return false;
      try {
        // A linked worktree (its .git is a FILE) is a branch in flight, not
        // what the client ships; its main checkout is scanned instead.
        if (!statSync(p).isDirectory() || !statSync(join(p, ".git")).isDirectory()) return false;
      } catch {
        return false;
      }
      return !existsSync(join(p, SERVER_ENTRY));
    })
    .sort();
}

/** Git run inside a client repo, with every variable that tells git WHICH
 *  repository to use removed. A git hook exports GIT_DIR (and GIT_INDEX_FILE,
 *  GIT_WORK_TREE...) for the repo it runs in, and `git -C <client>` obeys
 *  GIT_DIR over -C: under the pre-push hook every client read this server's
 *  own history, and the lint reported 109 of this repo's own paths as shipped
 *  by 17 clients. The list lives in scripts/lib/git-env.mjs. */
const CLIENT_GIT_ENV = envForOtherRepo();
function clientGit(repoDir: string, args: string[], opts: { timeout?: number; maxBuffer?: number } = {}): string {
  return execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: CLIENT_GIT_ENV, ...opts });
}

/** What a client SHIPS is its default branch, not whatever branch its checkout
 *  happens to sit on or what is uncommitted in it: the Edge Helper's checkout
 *  sat on a feature branch cut before its publish path was fixed, and reading
 *  the working tree would have re-recorded the bug. So the scan reads the
 *  remote default branch as last fetched (`--record` fetches first). */
export function shippedRef(repoDir: string): string | null {
  const tryRef = (args: string[]): string | null => {
    try {
      return clientGit(repoDir, args).trim() || null;
    } catch {
      return null;
    }
  };
  const head = tryRef(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head) return head;
  for (const r of ["origin/main", "origin/master", "main", "master"]) {
    if (tryRef(["rev-parse", "--verify", "--quiet", r])) return r;
  }
  return tryRef(["rev-parse", "--verify", "--quiet", "HEAD"]) ? "HEAD" : null;
}

/** Another service's API that shares the /api/v1 shape: the line names its host, or builds the URL on the
 *  forge's own server (a workflow's `${GITHUB_SERVER_URL}`), and it is not ours. A forge-API call in a
 *  sibling repo's CI (cloud's overlay-kit download, `/api/v1/packages/<owner>`) failed every core
 *  session's lint:all as a path core does not serve (2026-10-12). */
export function onAnotherService(text: string): boolean {
  return /git\.|forgejo|github\.com|gitlab/i.test(text) || /\b(?:GITHUB|GITEA|FORGEJO)_SERVER_URL\b|\bgithub\.server_url\b|\bgitea\.server_url\b|\bforgejo\.server_url\b/.test(text);
}

export function discoverPaths(repoDir: string, repoName: string): Map<string, Provenance[]> {
  const out = new Map<string, Provenance[]>();
  const ref = shippedRef(repoDir);
  if (!ref) return out;
  let grep = "";
  try {
    grep = clientGit(repoDir, ["grep", "-n", "-I", "-F", API_PREFIX + "/", ref], { maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return out; // git grep exits 1 when nothing matches
  }
  for (const raw of grep.split("\n")) {
    // <ref>:<file>:<line>:<text>
    const m = raw.match(/^[^:]+:(.+?):(\d+):(.*)$/);
    if (!m) continue;
    const [, file, lineNo, text] = m;
    const parts = file!.split("/");
    const base = parts[parts.length - 1]!;
    if (!CLIENT_FILE.test(base) || TEST_FILE.test(base)) continue;
    if (parts.slice(0, -1).some((d) => SKIP_DIR.test(d))) continue;
    if (onAnotherService(text!)) continue;
    for (const pm of text!.matchAll(PATH_RE)) {
      const p = pm[0]!;
      const at = { repo: repoName, file: file!, line: Number(lineNo) };
      const list = out.get(p) ?? [];
      if (!list.some((x) => x.file === at.file && x.line === at.line)) list.push(at);
      out.set(p, list);
    }
  }
  return out;
}

// ── the server side: the route table ────────────────────────────────────────

const VERB = /^\s*(\w+)\s*\.\s*(get|post|patch|put|delete|all|use)\s*\(\s*(?:["'`]([^"'`]*)["'`])?/;

function norm(p: string): string {
  const s = "/" + p.split("/").filter(Boolean).join("/");
  return s === "/" ? "" : s;
}

/** Every path this repo registers, as express patterns with their mount
 *  prefixes: the kernel's routers from server.ts, and each module under the one
 *  prefix the loader mounts it at (api/src/modules/mount.ts). */
export function routeTable(root = ROOT): string[] {
  const out = new Set<string>();
  const server = join(root, "api/src/server.ts");
  const mounts = new Map<string, string>();
  if (existsSync(server)) {
    const src = readFileSync(server, "utf8");
    // The router the app mounts at the API prefix itself (`app.use("/api/v1", v1)`)
    // declares routes of its own, `/healthz` among them.
    for (const m of src.matchAll(/\bapp\.use\(\s*["'`]\/api\/v1["'`]\s*,\s*(\w+)\s*\)/g)) mounts.set(m[1]!, "");
    for (const m of src.matchAll(/\b\w+\.use\(\s*(?:["'`]([^"'`]+)["'`]\s*,\s*)?(\w*[Rr]outer)\s*[,)]/g)) {
      mounts.set(m[2]!, m[1] ? norm(m[1]) : "");
    }
  }
  const collect = (dir: string, base: string, prefixOf: (v: string) => string | undefined, only?: string): void => {
    if (!existsSync(dir)) return;
    for (const f of only ? [only] : walkFiles(dir)) {
      if (!/\.ts$/.test(f) || /\.test\.ts$/.test(f)) continue;
      const lines = readFileSync(f, "utf8").split("\n");
      // A router mounted INSIDE a file (router.use("/x", otherRouter)) carries
      // its parent's prefix, which is how a module's sub-routers reach the URL.
      const local = new Map<string, string>();
      for (const line of lines) {
        const m = line.match(/^\s*(\w*[Rr]outer)\.use\(\s*(?:["'`]([^"'`]*)["'`]\s*,\s*)?(\w*[Rr]outer)\s*\)/);
        if (m) local.set(m[3]!, (prefixOf(m[1]!) ?? "") + norm(m[2] ?? ""));
      }
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i]!.match(VERB);
        if (!m) continue;
        const [, varName, verb, sub] = m;
        if (verb === "use") continue;
        if (!/[Rr]outer$/.test(varName!) && prefixOf(varName!) === undefined) continue;
        let path = sub;
        if (path === undefined) path = lines[i + 1]?.match(/^\s*["'`]([^"'`]*)["'`]/)?.[1];
        if (path === undefined) continue;
        const prefix = local.get(varName!) ?? prefixOf(varName!);
        if (prefix === undefined) continue; // a router nothing mounts serves nothing
        out.add(API_PREFIX + base + prefix + norm(path));
      }
    }
  };
  collect(join(root, "api/src/routes"), "", (v) => mounts.get(v));
  collect(join(root, "api/src"), "", (v) => mounts.get(v), server);
  const modulesDir = join(root, "modules");
  if (existsSync(modulesDir)) {
    for (const name of readdirSync(modulesDir)) {
      const api = join(modulesDir, name, "src/api");
      if (!existsSync(api)) continue;
      const idx = join(api, "index.ts");
      const modMounts = new Map<string, string>();
      if (existsSync(idx)) {
        for (const m of readFileSync(idx, "utf8").matchAll(/\.use\(\s*(?:["'`]([^"'`]+)["'`]\s*,\s*)?(\w+)\s*\)/g)) {
          modMounts.set(m[2]!, m[1] ? norm(m[1]) : "");
        }
      }
      for (const [router, path] of familyMounts(join(modulesDir, name))) modMounts.set(router, norm(path));
      for (const dir of apiDirs(join(modulesDir, name))) collect(dir, `/orgs/:slug/modules/${name}`, (v) => modMounts.get(v) ?? "");
    }
  }
  return [...out].sort();
}

/** A client's literal against an express pattern, segment by segment. A
 *  placeholder on either side ({{target}}, {slug}, :id, ${x}) is one segment,
 *  and one glued onto the last segment is a query (`/stats${q}` is `/stats`). */
export function resolves(clientPath: string, pattern: string): boolean {
  const wild = (s: string) => /^([:*]|\{|\$\{)/.test(s) || /^\{\{.*\}\}$/.test(s);
  const a = clientPath.split("/").filter(Boolean);
  // A placeholder glued onto the LAST literal segment is a query string the
  // client built in a variable (`/usage-stats${q}`, q = "?days=7" or ""): the
  // path is the literal before it. A placeholder that is the whole segment
  // stays one segment.
  const last = a.length - 1;
  if (last >= 0) a[last] = a[last]!.replace(/^([^$]+)\$\{[^}]*\}$/, "$1");
  const b = pattern.split("/").filter(Boolean);
  // A literal ending in "/" is a prefix the client concatenates onto, so it
  // only has to REACH a route, not be one.
  const prefixOnly = clientPath.endsWith("/");
  if (prefixOnly ? a.length > b.length : a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (wild(x) || wild(y)) continue;
    if (x.toLowerCase() !== y.toLowerCase()) return false;
  }
  return true;
}

function readRecord(): Record_ {
  if (!existsSync(RECORD)) return { scanned: [], paths: [] };
  return JSON.parse(readFileSync(RECORD, "utf8")) as Record_;
}

function main(): void {
  const record = !!process.argv.includes("--record");
  const prior = readRecord();
  const table = routeTable();
  const repos = clientRepos();
  if (record) {
    // Recording is deliberate, so it may reach the network: what gets recorded
    // is each client's default branch as it stands now. The check itself never
    // fetches, and reads what was last fetched.
    for (const r of repos) {
      try {
        clientGit(join(SIBLINGS, r), ["fetch", "-q", "origin"], { timeout: 30_000 });
      } catch {
        // offline or no remote: the last fetch is what gets recorded
      }
    }
  }
  const found = new Map<string, Provenance[]>();
  for (const r of repos) {
    for (const [p, at] of discoverPaths(join(SIBLINGS, r), r)) {
      found.set(p, [...(found.get(p) ?? []), ...at]);
    }
  }

  if (record) {
    const byPath = new Map(prior.paths.map((e) => [e.path, e]));
    // A path from a repo that is NOT checked out here keeps its recorded entry:
    // unreachable is not absent.
    const kept = prior.paths.filter((e) => !found.has(e.path) && e.clients.some((c) => !repos.includes(c.repo)));
    const paths: Entry[] = [
      ...[...found.entries()]
        .map(([path, clients]): Entry => {
          const was = byPath.get(path);
          return was?.status === "exempt"
            ? { path, status: "exempt", reason: was.reason, clients }
            : { path, status: "served", clients };
        })
        .sort((x, y) => x.path.localeCompare(y.path)),
      ...kept,
    ];
    mkdirSync(dirname(RECORD), { recursive: true });
    writeFileSync(RECORD, JSON.stringify({ scanned: [...new Set([...prior.scanned, ...repos])].sort(), paths }, null, 2) + "\n");
    console.log(`lint:client-api-paths recorded ${paths.length} path(s) from ${repos.length} client repo(s) beside this one`);
    return;
  }

  const findings: string[] = [];
  const behind: string[] = [];
  const whereOf = (clients: Provenance[]) => clients.map((c) => `${c.repo}/${c.file}:${c.line}`).join(", ");
  const unserved = (path: string, where: string) =>
    `${path} — nothing serves it. Shipped by ${where}. Either the route is missing here, or the client is pointed at the wrong path, or it belongs in the record as exempt with a reason.`;
  const recorded = new Map(prior.paths.map((e) => [e.path, e]));
  let checked = 0;
  let exempt = 0;

  for (const e of prior.paths) {
    if (e.status === "exempt" && !e.reason?.trim()) {
      findings.push(`${e.path} is exempt with no reason (${whereOf(e.clients)}). An exemption states why this server does not serve it.`);
    }
  }
  // A client checked out here is asked what it ships TODAY, record or not: a
  // path it just started shipping that nothing serves is the outage this lint
  // exists for, and waiting for somebody to re-record would hide it.
  for (const [p, clients] of found) {
    const e = recorded.get(p);
    if (!e) behind.push(`${p} is shipped by ${whereOf(clients)} and not yet recorded`);
    if (e?.status === "exempt") {
      exempt++;
      continue;
    }
    checked++;
    if (!table.some((r) => resolves(p, r))) findings.push(unserved(p, whereOf(clients)));
  }
  // A client that is NOT checked out here is known only by the record, which is
  // all CI ever has.
  for (const e of prior.paths) {
    if (found.has(e.path)) continue;
    if (e.clients.every((c) => repos.includes(c.repo))) {
      behind.push(`${e.path} is recorded from ${e.clients.map((c) => c.repo).join(", ")} but no longer shipped there`);
      continue;
    }
    if (e.status === "exempt") {
      exempt++;
      continue;
    }
    checked++;
    if (!table.some((r) => resolves(e.path, r))) findings.push(unserved(e.path, whereOf(e.clients)));
  }

  if (findings.length) {
    console.error(`lint:client-api-paths - ${findings.length} finding(s):`);
    for (const f of findings) console.error(`  ✗ ${f}`);
    console.error("\nThe record is scripts/client-api-paths.json; `npx tsx scripts/lint-client-api-paths.ts --record` re-derives it from the client repos beside this one.");
    process.exit(1);
  }
  console.log(
    `lint:client-api-paths OK - ${checked} client path(s) resolve against ${table.length} registered route(s); ` +
      `${exempt} exempt with a reason; ${repos.length} client repo(s) present, ${prior.scanned.length} recorded`,
  );
  // Behind is not broken: every path checked above resolves. It is said, not
  // failed, because a client repo moves on its own schedule and a commit there
  // would otherwise turn every unrelated push here red.
  if (behind.length) {
    console.log(`  note: the record is behind the clients here (${behind.length}); CI checks the record, so refresh it with --record:`);
    for (const b of behind) console.log(`    · ${b}`);
  }
}

main();
