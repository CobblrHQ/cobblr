#!/usr/bin/env tsx
// Guard: core must SERVE every /api/v1/hooks/<id> it sends anyone to.
//
// The bug (2026-08-15/17, and it cost days). `api/src/platform/ai.ts` mints a
// read grant for Ask-Cobb-over-a-bridge and points the bridge at
// `<origin>/api/v1/hooks/mcp`. Core shipped every other part of that feature —
// the connection flag, the grant signing, the read clamp, the bridge itself —
// but the ENDPOINT lived only in the proprietary hosted overlay. So on a
// self-hosted instance the grant aimed at a 404, the relay quietly did nothing,
// and Ask Cobb reported having no tools. Nothing errored at build or boot; a
// model with no tools does not fail, it answers, and the answer read like a
// product limitation.
//
// The class: **core advertising a capability it cannot serve.** An open-core
// repo that hands out a URL its own image does not answer is broken for every
// self-hoster, silently. Nothing was checking, and the only coupling was that
// someone would notice.
//
// The rule: every `/api/v1/hooks/<id>` referenced in api/src must have a
// matching `registerWebhook({ id: "<id>" })` in api/src. A path built for an
// overlay-only surface either moves into core or stops being built here.
//
//   cd <repo> && npx tsx scripts/lint-hooks-served.ts
//
// Local + CI, free, zero deps.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join("api", "src");

/** Every hooks id a URL in the source points at, with where it was written. */
function referencedIds(files: string[]): Map<string, string[]> {
  // `/api/v1/hooks/mcp`, and template forms like `${base}/api/v1/hooks/mcp`.
  const re = /\/api\/v1\/hooks\/([a-z0-9][a-z0-9-]*)/gi;
  const out = new Map<string, string[]>();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    src.split("\n").forEach((line, i) => {
      // Skip the seam's own docs + the router that implements /hooks/:id.
      if (/hooks\/:id|hooks\/\$\{|startsWith\(/.test(line)) return;
      for (const m of line.matchAll(re)) {
        const id = m[1]!.toLowerCase();
        if (id === "id") continue; // the route pattern itself
        const where = `${f}:${i + 1}`;
        out.set(id, [...(out.get(id) ?? []), where]);
      }
    });
  }
  return out;
}

/** Every hooks id core registers a handler for. */
function registeredIds(files: string[]): Set<string> {
  const ids = new Set<string>();
  // registerWebhook({ id: "mcp", … }) — the id may sit on the next line.
  const re = /registerWebhook\(\s*\{[\s\S]{0,200}?id:\s*["'`]([a-z0-9-]+)["'`]/gi;
  for (const f of files) {
    for (const m of readFileSync(f, "utf8").matchAll(re)) ids.add(m[1]!.toLowerCase());
  }
  return ids;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) acc.push(p);
  }
  return acc;
}

const files = walk(ROOT);
const referenced = referencedIds(files);
const registered = registeredIds(files);

const unserved = [...referenced.entries()].filter(([id]) => !registered.has(id));

if (unserved.length > 0) {
  console.error(
    `✗ hooks-served lint: ${unserved.length} webhook path(s) core sends callers to but does not serve.\n`,
  );
  for (const [id, where] of unserved) {
    console.error(`  /api/v1/hooks/${id}`);
    for (const w of where) console.error(`      referenced at ${w}`);
  }
  console.error(`
Core built a URL to a webhook id nothing in api/src registers. If the handler
lives in the hosted overlay, every SELF-HOSTED instance sends its users (or its
own bridge) to a 404 — silently, because nothing errors: the caller just gets
nothing back and reports a limitation. That exact split broke Ask-Cobb tool
relay for self-host until 2026-08-17.

Either register the handler in core (platform/hosted-mcp.ts is the precedent —
a thin face over core's own REST belongs here), or stop building the URL in
core and let the overlay own both halves.`);
  process.exit(1);
}

console.log(
  `✓ hooks-served lint: all ${referenced.size} referenced webhook path(s) are served by core.`,
);
