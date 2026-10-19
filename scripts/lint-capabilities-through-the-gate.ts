#!/usr/bin/env tsx
// A page asks what its viewer may do only through the one gate (useCan, useCapabilities, useRoleAtLeast in platform-web's can.ts): no page calls getMyCapabilities or keys a capabilities query of its own.
//
// THE BUG THIS PREVENTS. Five pages offered or probed what their viewer's
// role could not use: a calendar feed's Rotate for a member (#7507), control
// of an arm (#7522), a list deletion (#7524), embroidery's station lists and
// permissions (#7509, #7510). Each page answered "may this person do it?"
// its own way or not at all, and the ones that asked did so under two cache
// keys ("me-capabilities", "my-capabilities"), so one page's answer was not
// another's (#7552, 2026-10-19).
//
// THE RULE. Outside the gate (packages/platform-web/src/can.ts, the web's
// door web/src/lib/can.ts, and the hosts that hand the gate its client), no
// source calls getMyCapabilities( and no source names a capabilities query
// key of its own ("me-capabilities" or "my-capabilities"). A page asks
// useCan(<action>), useCapabilities() or useRoleAtLeast(<contract list>).
// A loader outside React that must fill the same cache (waitingScans.ts)
// keys it with myCapabilitiesKey(slug), the gate's own key.
//
// THE BOUNDARY. The client method's own definition (web/src/lib/api) is
// where the read is made, not a page asking it; tests mock it by name. Both
// are outside the rule. Nothing else has tested the boundary yet.
//
// PROVED RED on main before the gate: 16 violations, a call and a key each
// in robotArm, scanViewer, waitingScans, PortalHomePage, PortalViewPage,
// PortalLayout and AppPlayerPage (twice).
//
//   npx tsx scripts/lint-capabilities-through-the-gate.ts   (pnpm lint capabilities-through-the-gate)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "packages", "modules"];

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

/** The gate and the hosts that hand it the client: the only places a
 *  capabilities read is written. */
const ALLOWED = new Set([
  "packages/platform-web/src/can.ts",
  "packages/platform-web/src/types.ts",
  "web/src/lib/can.ts",
  "web/src/WorkspacePlatformWeb.tsx",
]);

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  if (ALLOWED.has(file) || file.startsWith("web/src/lib/api/")) return out;
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/\bgetMyCapabilities\s*\(/.test(line)) out.push({ file, line: i + 1, what: "calls getMyCapabilities itself: ask useCan / useCapabilities (web/src/lib/can.ts)" });
    if (/["'`]m[ye]-capabilities["'`]/.test(line)) out.push({ file, line: i + 1, what: "keys a capabilities query of its own: use the gate's myCapabilitiesKey(slug)" });
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:capabilities-through-the-gate - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("ask useCan(<action>) or useRoleAtLeast(<contract list>) from web/src/lib/can.ts or @cobblr/platform-web");
  process.exit(1);
}
console.log(`lint:capabilities-through-the-gate OK`);
