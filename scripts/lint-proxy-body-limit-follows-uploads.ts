#!/usr/bin/env tsx
// Every proxy in front of the api lets through the largest upload body the api takes (UPLOAD_CEILING_BYTES), so the api's own refusal, naming the size, is what a person sees.
//
// THE BUG THIS PREVENTS. nginx's 50m limit closed the connection on bigger uploads and the browser said only Load failed (2026-09-30)
//
// THE RULE. An nginx `location` that proxies the api's routes (a path under
// /api) sets `client_max_body_size` to at least UPLOAD_CEILING_BYTES
// (@cobblr/platform-contract/upload, the biggest body any upload route takes:
// a backup restore), in the block itself or at the server/http level of the
// same file. The api then refuses a file over ITS limit with a 413 that
// names the size and the limit. A proxy that stops the body first closes the
// connection mid-upload, and a phone's browser reports only "Load failed".
// No opt-out: a proxy that must cap lower is a deployment decision, made by
// lowering COBBLR_UPLOAD_DESIGN_MAX_MB under it, never by the proxy.
//
// THE BOUNDARY. Only locations under /api. The OAuth discovery location
// (/.well-known/oauth-) also proxies to the api, but takes no uploads, and
// holding it to 1 GB would widen a door for nothing. Proxies outside this
// repo's reach (Cloudflare's 100 MB request cap on the hosted app) are why
// the design-file limit is a per-deployment setting.
//
// PROVE IT RED: run against docker/nginx.conf at 50m (the value that cut the
// uploads off), it failed on the /api/ location.
//
//   npx tsx scripts/lint-proxy-body-limit-follows-uploads.ts   (pnpm lint proxy-body-limit-follows-uploads)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { UPLOAD_CEILING_BYTES } from "../packages/platform-contract/src/upload.ts";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["docker", "deploy"];

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
    else if (/nginx.*\.conf(\.template)?$/.test(name)) yield p;
  }
}

/** "50m", "1024m", "1g", "0" (nginx: no limit) to bytes. */
function bytesOf(v: string): number {
  const m = /^(\d+)([kmg]?)$/i.exec(v.trim());
  if (!m) return NaN;
  const n = Number(m[1]);
  if (n === 0) return Infinity;
  const unit = (m[2] ?? "").toLowerCase();
  return n * (unit === "g" ? 1024 ** 3 : unit === "m" ? 1024 ** 2 : unit === "k" ? 1024 : 1);
}

/** The text of every `location` block, with where it starts. */
function locations(src: string): Array<{ path: string; body: string; start: number; end: number }> {
  const out: Array<{ path: string; body: string; start: number; end: number }> = [];
  const re = /\blocation\s+(?:[=~^*]+\s*)?(\S+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
    }
    out.push({ path: m[1]!, body: src.slice(re.lastIndex, i - 1), start: m.index, end: i });
  }
  return out;
}

const SIZE = /^\s*client_max_body_size\s+([^;\s]+)\s*;/m;

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, raw: string): Violation[] {
  const src = raw.replace(/#[^\n]*/g, (c) => " ".repeat(c.length));
  const blocks = locations(src);
  let outside = src;
  for (const b of blocks) outside = outside.slice(0, b.start) + " ".repeat(b.end - b.start) + outside.slice(b.end);
  const fileLevel = SIZE.exec(outside)?.[1];
  const out: Violation[] = [];
  for (const b of blocks) {
    if (!b.path.startsWith("/api") || !/proxy_pass\s/.test(b.body)) continue;
    const own = SIZE.exec(b.body)?.[1] ?? fileLevel;
    const line = src.slice(0, b.start).split("\n").length;
    const bytes = own === undefined ? 1024 * 1024 : bytesOf(own);
    if (!(bytes >= UPLOAD_CEILING_BYTES)) {
      out.push({
        file,
        line,
        what: `location ${b.path} lets through ${own ?? "1m (nginx's default)"}, under the ${UPLOAD_CEILING_BYTES / 1024 / 1024}m an upload route takes; set client_max_body_size ${UPLOAD_CEILING_BYTES / 1024 / 1024}m`,
      });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:proxy-body-limit-follows-uploads - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("A proxy that stops a body first turns the api's named refusal into \"Load failed\". Lower COBBLR_UPLOAD_DESIGN_MAX_MB instead of the proxy.");
  process.exit(1);
}
console.log(`lint:proxy-body-limit-follows-uploads OK`);
