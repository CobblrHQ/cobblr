#!/usr/bin/env tsx
// A shell function that builds an auth header turns xtrace off before it does, and a traced script or run block never builds or passes a credential, because set -x prints it and the base64 form slips past Forgejo's mask and the log sink.
//
// THE BUG THIS PREVENTS. 2026-11-10: e2e-suite's showcase publish runs in a
// `( set -x … )` subshell so a silent skip is diagnosable, and it called
// git_auth_export there. The trace printed `basic=<base64 of oauth2:token>` and
// the `Authorization: Basic …` header it exported. Forgejo masks the raw secret,
// not its base64; the step's own sed masked the raw token only; the log sink
// redacted the `Authorization:` shape but not the bare `basic=` line. The token
// sat in 33 job logs and 10 sink copies (#9389).
//
// THE RULE, in .sh files and workflow run blocks under .forgejo/ and scripts/:
//   1. A function whose body builds an auth header, either an
//      `Authorization: Basic|Bearer|token $…` value or `printf '%s:%s' … | base64`,
//      starts with `{ local -; set +x; } 2>/dev/null`: silent, and `local -` (bash 4.4+)
//      gives the caller its trace back on every return path. Then no caller's set -x
//      can print it.
//   2. While a script or run block is traced (after `set -x` / `set -ex` …, before
//      `set +x`), no line builds such a header, and no line calls one of the rule-1
//      functions: the call's own trace prints its token argument raw. Turn the trace
//      off around the call.
//   A line opts out with `trace-ok: <why>` on it or on the line above.
//
// THE BOUNDARY. Node scripts are not judged: they have no xtrace, and a header
// built there reaches a log only by an explicit print, which
// lint:no-credential-urls and the sink's redaction cover. A function that only
// forwards a header it was handed (git-auth.sh's _git_auth_set) is not a
// builder; its callers are, and they hold the guard. No near-miss has tested
// the traced-region tracking yet: it follows `set -x`/`set +x` line by line
// and restarts at each workflow step, so a trace switched on inside a
// function and left on is not followed.
//
//   npx tsx scripts/lint-auth-never-traced.ts   (pnpm lint auth-never-traced)
import { readFileSync } from "node:fs";
import { repoFiles } from "./lib/repo-files.ts";
import { onlyChanged } from "./lib/lint-only-files.ts";

const ROOTS = [".forgejo", "scripts"];
const SHELL = /\.(sh|bash|ya?ml)$/;

interface Violation {
  file: string;
  line: number;
  what: string;
}

const HEADER = /Authorization:\s*(?:Basic|Bearer|token)\s+["']?\$/i;
const PAIR_B64 = /printf\s+["']%s:%s["'][^|]*\|\s*base64/;
const TRACE_ON = /(?:^|[;&|({]\s*|\s)set\s+-[A-Za-z]*x/;
const TRACE_OFF = /(?:^|[;&|({]\s*|\s)set\s+\+[A-Za-z]*x/;
const STEP = /^\s*(?:-\s+)?(?:run|name|uses):/;
const FN = /^(\s*)(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{(.*)$/;
const OPT_OUT = /trace-ok: \S/;

export function buildsHeader(line: string): boolean {
  return HEADER.test(line) || PAIR_B64.test(line);
}

interface Fn {
  name: string;
  start: number; // 0-based line of the `name() {`
  body: string[];
}

export function functions(src: string): Fn[] {
  const lines = src.split("\n");
  const out: Fn[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = FN.exec(lines[i] ?? "");
    if (!m) continue;
    const indent = m[1] ?? "";
    const rest = (m[3] ?? "").trim();
    if (/\}\s*$/.test(rest) && rest !== "") {
      out.push({ name: m[2]!, start: i, body: [rest.replace(/\}\s*$/, "")] });
      continue;
    }
    const body: string[] = rest && !rest.startsWith("#") ? [rest] : [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j] ?? "";
      if (new RegExp(`^${indent}\\}`).test(l)) break;
      body.push(l);
    }
    out.push({ name: m[2]!, start: i, body });
    i = j;
  }
  return out;
}

const guarded = (body: string[]) => {
  const first = body.map((l) => l.trim()).find((l) => l !== "" && !l.startsWith("#"));
  return !!first && TRACE_OFF.test(first);
};

/** Names of every function that builds an auth header, across the files given. */
export function builders(sources: string[]): Set<string> {
  const names = new Set<string>();
  for (const src of sources) for (const f of functions(src)) if (f.body.some(buildsHeader)) names.add(f.name);
  return names;
}

export function check(file: string, src: string, builderNames: Set<string>): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  const optedOut = (i: number) => OPT_OUT.test(lines[i] ?? "") || OPT_OUT.test(lines[i - 1] ?? "");

  for (const f of functions(src)) {
    if (!f.body.some(buildsHeader) || guarded(f.body) || optedOut(f.start)) continue;
    out.push({ file, line: f.start + 1, what: `${f.name}() builds an auth header with the caller's xtrace still on: start it with { local -; set +x; } 2>/dev/null` });
  }

  const call = builderNames.size ? new RegExp(`(?:^|[\\s;&|({])(?:${[...builderNames].join("|")})\\s[^;&|#]*\\$`) : null;
  const yaml = /\.ya?ml$/.test(file);
  let traced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const code = line.replace(/(^|\s)#.*$/, "");
    if (yaml && STEP.test(line)) traced = false;
    if (TRACE_OFF.test(code)) traced = false;
    else if (TRACE_ON.test(code)) traced = true;
    if (!traced || optedOut(i)) continue;
    if (buildsHeader(code)) out.push({ file, line: i + 1, what: "builds an auth header under set -x: the trace prints it; turn the trace off first" });
    else if (call?.test(code)) out.push({ file, line: i + 1, what: "calls an auth-header function under set -x: the call's trace prints its token argument; turn the trace off around it" });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = repoFiles(ROOTS).filter((f) => SHELL.test(f));
  const srcs = new Map(files.map((f) => [f, readFileSync(f, "utf8")] as const));
  const names = builders([...srcs.values()]);
  // The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
  const violations = files.filter((f) => onlyChanged(f)).flatMap((f) => check(f, srcs.get(f)!, names));
  if (violations.length) {
    console.error(`lint:auth-never-traced - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("A line that is genuinely safe opts out with `trace-ok: <why>` on it or the line above.");
    process.exit(1);
  }
  console.log(`lint:auth-never-traced OK (${files.length} files, ${names.size} header builders: ${[...names].join(", ")})`);
}
