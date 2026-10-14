#!/usr/bin/env tsx
// A page sends a multipart form only through sendUpload (@cobblr/platform-web), so a dropped connection says what happened and is logged, and every refusal shows the server's own sentence.
//
// THE BUG THIS PREVENTS. a phone upload failed as Load failed with nothing in the server log, and other upload surfaces showed raw JSON or an HTTP code (2026-09-30)
//
// THE RULE. In browser code (web/src, packages/platform-web/src, a module's
// src/ui), a FormData is never handed to fetch as its body. It goes through
// sendUpload or uploadJson (packages/platform-web/src/upload-client.ts),
// which turn fetch's bare "Load failed" / "Failed to fetch" into
// CONNECTION_LOST_MESSAGE, report the drop to the server log, and read a
// refusal as the server's own sentence (or a proxy's 413 as the file's size).
// Before it, a phone's cut-off upload said only "Load failed", the server
// never knew, and four surfaces showed a refusal as raw JSON or "upload 413".
// Opt out, for a form that is not an upload, with
// `// form-not-an-upload: <why>` on the line that makes the FormData.
//
// THE BOUNDARY. A FormData made in server code (a module's drivers sending a
// file to a printer's own API) is outbound, not a person's upload: only UI
// directories are read. And only a form that reaches `fetch` as `body:` by
// its own name counts, so a helper that builds a form and hands it to
// sendUpload is not a violation.
//
// PROVE IT RED: run against the twelve browser upload sites as they were
// (raw fetch with the form as body), it failed on each.
//
//   npx tsx scripts/lint-page-uploads-through-one-door.ts   (pnpm lint page-uploads-through-one-door)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "packages/platform-web/src", "modules"];
const THE_DOOR = "packages/platform-web/src/upload-client.ts";

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

/** Browser code only: a module's ui directory, the web app, platform-web. */
function isPage(file: string): boolean {
  const f = file.replace(/\\/g, "/");
  if (f === THE_DOOR) return false;
  if (f.startsWith("modules/")) return /^modules\/[^/]+\/src\/ui\//.test(f);
  return true;
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (!isPage(file)) return [];
  const out: Violation[] = [];
  const lines = src.split("\n");
  const forms = new Set<string>();
  for (const line of lines) {
    const m = /\b(?:const|let|var)\s+(\w+)\s*=\s*new FormData\(/.exec(line);
    if (m && !/form-not-an-upload:\s*\S/.test(line)) forms.add(m[1]!);
  }
  if (forms.size === 0) return out;
  const sent = new RegExp(`\\bbody:\\s*(${[...forms].join("|")})\\b`);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(\/\/|\*)/.test(line)) continue;
    const m = sent.exec(line);
    if (m) out.push({ file, line: i + 1, what: `sends the form "${m[1]}" with fetch; send it with sendUpload/uploadJson (@cobblr/platform-web) so a dropped connection and a refusal read as sentences` });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:page-uploads-through-one-door - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Send a multipart form with sendUpload/uploadJson from @cobblr/platform-web; a form that is not an upload says so with // form-not-an-upload: <why>.");
  process.exit(1);
}
console.log(`lint:page-uploads-through-one-door OK`);
