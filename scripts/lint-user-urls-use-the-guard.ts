#!/usr/bin/env tsx
// A plain fetch in server code names where its address comes from: the platform's pinned guard for an address a person supplies, or a recorded reason the plain fetch is right.
//
// THE BUG THIS PREVENTS. the 2026.10.0 release review found the scan import (and then the webhook channel, Spoolman and the machine drivers) checking a member's URL once and fetching it plain, 2026-10-18
//
// THE RULE. Every outbound call in server code (api/src, modules/*/src, the
// shared packages, the CLIs, the MCP server and the dev scripts under src)
// either goes through a pinned door, or says where its address comes from. The
// calls seen are not only `fetch(`: an import of an HTTP client under any alias
// (undici's request or fetch, node:http and node:https request or get, axios,
// got, ky, node-fetch, ws, superagent), a `fetch` bound to another name or
// passed along as a value, `globalThis.fetch`, a `new WebSocket(`, a raw socket
// (node:net or node:tls connect, node:dgram) and the plain `fetch(` itself. A
// call is a name's import or use, not its local alias, so renaming does not hide it.
//   - it goes through a pinned door instead (platform().egress.guardedFetch,
//     a module's own pinned fetch such as machineFetch or safeFetch), which
//     is not one of the above and so is not checked here; or
//   - it carries `// EGRESS: <class> - <why>` on its line or the line above,
//     or the file says `// EGRESS-FILE: <class> - <why>` once for everything
//     it holds. The classes are the cases where a plain call is right:
//       operator-configured   an address the operator sets in the environment
//                             or the instance's own settings (CLAUDE.md:
//                             "Staging is not prod for egress")
//       vendor-fixed          a host written in the code (a vendor's API)
//       workspace-lan-device  a device or service on the workspace's own
//                             network, reached on purpose, after the policy check
//       guarded-elsewhere     the call is made by a fetch handed in, and the
//                             door that hands it in is the pinned guard
//       own-api               the instance calling its own API
//       embedded-script       code inside a string or a bridge package, run elsewhere
//       pinned-door           this is the pinning door itself
//       test-double           replaces the client with a stub; makes no request
//     There is no class for an address a workspace user or member supplies:
//     that one goes through the guard.
// A class outside that list, or no reason after the dash, is a violation.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A prompt that tells a model
// "no fetch()" (core-authoring), a method declaration `fetch(id: string)` (mail
// sources, the service port), a fetch named in an error message or a regex
// ("fetch failed"), a local variable that happens to be called fetch (the
// service adapters) and `import("node:http").IncomingMessage` as a type are not
// outbound calls. node:http's createServer and a Response class from undici are
// not clients. The browser (platform-web, ui/, .tsx) is not walked: a fetch there
// runs on the user's own device, where a request to a private address reaches
// only what that user's own browser could already reach, so server-side request
// forgery cannot happen through it. Generated payloads are not walked either.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-user-urls-use-the-guard.ts   (pnpm lint user-urls-use-the-guard)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/src", "modules", "packages"];
/** Not walked: the browser (a fetch there runs on the user's device, so a
 *  server-side request forgery cannot happen through it), types-only output and
 *  generated payloads. Everything else is: the api, the modules, the shared
 *  packages, the CLIs, the MCP server and the dev and seed scripts under src. */
const SKIP = [/\/ui\//, /^packages\/platform-web\//, /\.tsx$/, /\/dist\//, /\.generated\.ts$/, /\.d\.ts$/];
const CLASSES = ["operator-configured", "vendor-fixed", "workspace-lan-device", "guarded-elsewhere", "own-api", "embedded-script", "pinned-door", "test-double"];

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
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !isEmbeddedPayload(p) && !SKIP.some((re) => re.test(p))) yield p;
  }
}

/** The tag on a line, if it has one: its class and whether a reason follows. */
function tagOf(text: string, marker: "EGRESS" | "EGRESS-FILE"): { cls: string; why: string } | null {
  const m = new RegExp(`//\\s*${marker}:\\s*([a-z-]+)\\s*(?:-\\s*(.*))?$`).exec(text);
  return m ? { cls: m[1]!, why: (m[2] ?? "").trim() } : null;
}

/** The outbound clients, by module. A module's NAMES that make a request; an
 *  import that brings in none of them (a Response class, createServer) is not a
 *  client. A default or namespace import counts only when the file then calls a
 *  client name on it. `null` means any non-type import of the module is a client. */
const CLIENT_MODULES: Record<string, { names: string[] | null }> = {
  undici: { names: ["fetch", "request", "stream", "pipeline", "connect", "upgrade", "Agent", "Pool", "Client", "BalancedPool", "ProxyAgent", "EnvHttpProxyAgent", "RetryAgent", "Dispatcher", "WebSocket", "EventSource", "setGlobalDispatcher"] },
  http: { names: ["request", "get", "Agent", "ClientRequest", "globalAgent"] },
  https: { names: ["request", "get", "Agent", "globalAgent"] },
  http2: { names: ["connect"] },
  net: { names: ["connect", "createConnection", "Socket"] },
  tls: { names: ["connect"] },
  dgram: { names: null },
  axios: { names: null },
  got: { names: null },
  ky: { names: null },
  "node-fetch": { names: null },
  ws: { names: null },
  superagent: { names: null },
  needle: { names: null },
  request: { names: null },
};
const moduleOf = (spec: string): string | null => {
  const bare = spec.replace(/^node:/, "");
  return CLIENT_MODULES[bare] ? bare : null;
};

/** A line's code with string, template and regex literals blanked, so words in
 *  a message or a pattern ("fetch failed") are not read as code. */
function withoutLiterals(code: string): string {
  return code
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""')
    .replace(/(?<=[=(,:!&|?{;]|^)\s*\/(?![/*])(?:[^/\\\n]|\\.)+\/[gimsuy]*/g, " /re/");
}

/** The file has a name `fetch` of its own (a variable, a parameter, a function),
 *  so a bare `fetch` in it is not the global. */
function declaresFetch(src: string): boolean {
  return /\b(?:const|let|var|function)\s+fetch\b|\b(?:const|let|var)\s*\{[^}]*\bfetch\b[^}]*\}\s*=|[(,]\s*fetch\s*[:,)]/.test(src);
}

/** What a line does that reaches out, in words; null when it does not. The file's
 *  whole text is read for the calls made on a default or namespace import. */
function reach(code: string, src: string): string | null {
  // import ... from "mod" (static), including `import x, { y } from`.
  const imp = /^\s*(?:import|export)\s+(type\s+)?(.+?)\s+from\s+["']([^"']+)["']/.exec(code);
  if (imp) {
    const mod = moduleOf(imp[3]!);
    if (!mod || imp[1]) return null;
    const spec = CLIENT_MODULES[mod]!;
    const clause = imp[2]!;
    const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? "";
    const imported = named.split(",").map((n) => n.trim()).filter((n) => n && !n.startsWith("type ")).map((n) => n.split(/\s+as\s+/)[0]!.trim());
    if (spec.names === null) return `imports ${imp[3]}, an HTTP client`;
    if (imported.some((n) => spec.names!.includes(n))) return `imports ${imp[3]}'s ${imported.filter((n) => spec.names!.includes(n)).join(", ")}`;
    // default or namespace: a client only if a client name is then called on it.
    const local = /(?:^|,)\s*(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause.replace(/\{[^}]*\}/, ""))?.[1];
    if (local && new RegExp(`\\b${local}\\.(?:${spec.names.join("|")})\\b`).test(src)) return `calls ${local}.${spec.names.find((n) => new RegExp(`\\b${local}\\.${n}\\b`).test(src))} from ${imp[3]}`;
    return null;
  }
  // require("mod") and import("mod"): the names cannot be read off a line, so any is a client.
  const dyn = /(?:\brequire\(|\bawait\s+import\(|\bimport\([^)]*\)\.then)\s*["']([^"']+)["']\s*\)/.exec(code);
  if (dyn && moduleOf(dyn[1]!)) return `loads ${dyn[1]}, an HTTP client`;
  const bare = withoutLiterals(code);
  if (/\bnew\s+(?:WebSocket|EventSource)\s*\(/.test(bare)) return "opens a WebSocket or EventSource";
  if (/(?:globalThis|global|window|self)\.fetch\b/.test(bare)) return "reaches the global fetch by property";
  // A fetch used as a value: bound to another name, put in an object, passed on.
  const value = /(?<![.\w$])fetch(?![\w$(:?])/.exec(bare);
  if (value && !declaresFetch(src) && !/typeof\s+fetch/.test(bare.slice(Math.max(0, value.index - 8), value.index + 5))) return "binds or passes the global fetch as a value";
  return null;
}

/** The check. Return every violation in one file; an empty array is a pass. */
export function check(file: string, src: string, counter?: { seen: number }): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  const fileTag = lines.map((l) => tagOf(l, "EGRESS-FILE")).find((t) => t !== null) ?? null;
  const judge = (tag: { cls: string; why: string }, at: number): boolean => {
    if (!CLASSES.includes(tag.cls)) out.push({ file, line: at + 1, what: `EGRESS class "${tag.cls}" is not one of ${CLASSES.join(", ")}` });
    else if (!tag.why) out.push({ file, line: at + 1, what: "EGRESS tag has no reason after the dash" });
    else return true;
    return false;
  };
  if (fileTag) judge(fileTag, lines.findIndex((l) => tagOf(l, "EGRESS-FILE")));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    let code = line.replace(/\/\/.*$/, "");
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    // An import whose names run over several lines is read as one statement, at its first line.
    if (/^\s*(?:import\s[^"';(]*|export\s+(?:type\s+)?)\{[^}]*$/.test(code)) {
      let j = i;
      while (j + 1 < lines.length && j - i < 40 && !/\bfrom\s+["']/.test(code)) code += " " + (lines[++j] ?? "").replace(/\/\/.*$/, "");
      if (/\bfrom\s+["']/.test(code)) i = j;
    }
    // A call: `fetch(` not preceded by a dot or a word, with arguments that are
    // not an empty list (prose) or a typed parameter (a declaration).
    const call = /(^|[^.\w$])fetch\s*\((?!\s*\))(?!\s*\w+\s*[?:])/.test(code) ? "calls the plain fetch()" : null;
    const what = call ?? reach(code, src);
    if (!what) continue;
    if (counter) counter.seen++;
    const own = tagOf(line, "EGRESS") ?? tagOf(lines[i - 1] ?? "", "EGRESS");
    if (own) {
      judge(own, own === tagOf(line, "EGRESS") ? i : i - 1);
      continue;
    }
    if (fileTag) continue;
    out.push({ file, line: i + 1, what: `${what} with no EGRESS reason: use the pinned guard, or say why a plain call is right` });
  }
  return out;
}

function main() {
const counter = { seen: 0 };
const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8"), counter));

// A lint that finds nothing to judge is green by being blind (a changed layout,
// a renamed root). The tree holds dozens of plain fetches; fewer than this on a
// whole-tree run means the walk or the pattern broke. A pre-push run over a
// handful of changed files is exempt.
const wholeTree = !process.env.COBBLR_LINT_ONLY_FILES && !process.argv.includes("--only");
if (wholeTree && counter.seen < 30) violations.push({ file: "scripts/lint-user-urls-use-the-guard.ts", line: 1, what: `only ${counter.seen} plain fetch call(s) found; the walk or the pattern is blind` });

if (violations.length) {
  console.error(`lint:user-urls-use-the-guard - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Send it through the pinned guard (platform().egress.guardedFetch, or the module's own pinned door); only an address the operator sets, a fixed vendor host or a device on the workspace's own network keeps the plain fetch, with `// EGRESS: <class> - <why>` (or one `// EGRESS-FILE:` line for the file).");
  process.exit(1);
}
console.log(`lint:user-urls-use-the-guard OK`);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
