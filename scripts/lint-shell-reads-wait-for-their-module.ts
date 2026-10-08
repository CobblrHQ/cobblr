#!/usr/bin/env tsx
// A surface the app shell always mounts (what AppLayout renders, or a rail tab) reads an opt-in module's routes only after checking the module is on (useEnabledModules or the nav's enabledNames), or says module-on: and why.
//
// THE BUG THIS PREVENTS. Ask Cobb opened on Pinned in a fresh workspace, which read Knowledge (off) and got 409, failing the nightly shell walk at every width (#5142, 2026-10-08)
//
// THE RULE. A file the app shell always mounts (a local import of
// web/src/components/AppLayout.tsx, or any file that registers a rail tab
// with useRailTab) that calls an api.ts helper reading an opt-in module's
// routes, or fetches `/modules/<opt-in>/` itself, also checks that the module
// is on: it uses useEnabledModules, the nav's enabledNames, or the
// configuration's enabledModules. Opt-in means the
// module's manifest is neither band "foundational" nor autoEnable: true, so a
// workspace can be without it and the route answers 409 module_not_enabled.
// A read that is safe anyway says `module-on: <why>` on the call's line or
// the one above.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only the shell: a module's
// own pages render only when the module is on (ModuleOffGate), so the 157
// digifab helpers called from digifab's pages are not judged. QuickAccess
// already gated its Knowledge read on enabledNames and passes; PinnedTab, a
// rail tab mounted for every workspace, did not.
//
// PROVED RED on PinnedTab.tsx before its read was gated (#5142).
//
//   npx tsx scripts/lint-shell-reads-wait-for-their-module.ts   (pnpm lint shell-reads-wait-for-their-module)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src"];

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
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** Modules a workspace can be without: neither foundational nor auto-enabled. */
function optInModules(): Set<string> {
  const out = new Set<string>();
  for (const name of readdirSync("modules")) {
    let src: string;
    try {
      src = readFileSync(join("modules", name, "src", "module.ts"), "utf8");
    } catch {
      continue;
    }
    if (/band:\s*"foundational"/.test(src) || /autoEnable:\s*true/.test(src)) continue;
    out.add(name);
  }
  return out;
}

/** api.ts helper name -> the module whose route it reads. */
function helperModules(): Map<string, string> {
  const out = new Map<string, string>();
  let current: string | null = null;
  for (const line of readFileSync("web/src/lib/api.ts", "utf8").split("\n")) {
    // The api object's members sit at two spaces; a deeper `if (` is not one.
    const def = /^ {2}(?:async\s+)?([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/.exec(line) ?? /^ {2}([A-Za-z_]\w*)\s*:\s*(?:async\s*)?(?:<[^>]*>)?\(/.exec(line);
    if (def && !/^(?:if|for|while|switch|return|catch)$/.test(def[1]!)) current = def[1]!;
    // A comment's example path is not the helper's route (getLive's note
    // names "/modules/labels/autoflush"; its route is the kernel's /live).
    const mod = /^\s*\/\//.test(line) ? null : /\/modules\/([a-z0-9-]+)\//.exec(line);
    if (current && mod && !out.has(current)) out.set(current, mod[1]!);
  }
  return out;
}

/** The files the shell always mounts: AppLayout's local imports and every rail tab. */
function shellFiles(): Set<string> {
  const out = new Set<string>();
  const layout = "web/src/components/AppLayout.tsx";
  for (const m of readFileSync(layout, "utf8").matchAll(/from\s+"(\.\.?\/[^"]+)"/g)) {
    // api.ts defines the helpers; it is the map, not a caller.
    if (/\/lib\/api$/.test(m[1]!)) continue;
    const base = join("web/src/components", m[1]!);
    for (const ext of [".tsx", ".ts", "/index.tsx", "/index.ts"]) {
      try {
        statSync(base + ext);
        out.add(base + ext);
        break;
      } catch {
        /* try the next spelling */
      }
    }
  }
  for (const file of walk("web/src")) {
    if (file.endsWith("SideRail.tsx")) continue;
    if (/\buseRailTab\(/.test(readFileSync(file, "utf8"))) out.add(file);
  }
  return out;
}

const OPT_IN = optInModules();
const HELPERS = helperModules();
const SHELL = shellFiles();

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  if (!SHELL.has(file)) return out;
  if (/\buseEnabledModules\(|\benabledNames\b|\benabledModules\b/.test(src)) return out;
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const reasoned = /module-on: \S/.test(line) || /module-on: \S/.test(lines[i - 1] ?? "");
    if (reasoned) continue;
    for (const m of line.matchAll(/\bapi\.([A-Za-z_]\w*)\(/g)) {
      const mod = HELPERS.get(m[1]!);
      if (mod && OPT_IN.has(mod)) out.push({ file, line: i + 1, what: `api.${m[1]}() reads ${mod}, which a workspace can be without, and this shell file never checks it is on` });
    }
    const direct = /\/modules\/([a-z0-9-]+)\//.exec(line);
    // A probe gated on the same line (`if (enabled.has("inventory")) …`) checks first.
    if (direct && OPT_IN.has(direct[1]!) && !line.includes(`.has("${direct[1]}")`)) out.push({ file, line: i + 1, what: `fetches ${direct[1]}'s route, which a workspace can be without, and this shell file never checks it is on` });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:shell-reads-wait-for-their-module - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("gate the query's enabled on useEnabledModules(slug)?.has(<module>)");
  process.exit(1);
}
console.log(`lint:shell-reads-wait-for-their-module OK`);
