#!/usr/bin/env tsx
// A form that can send an address through a bridge shows the home-network
// hint, so a home address is caught before the connection fails.
//
// THE BUG THIS PREVENTS. On the hosted app, a person typed their Part-DB's
// address, 192.168.1.50, into a form that could have gone through their
// bridge, and nothing reacted: the "on my local network" box stayed unticked
// until the import failed with a raw "fetch failed" (#3904, 2026-09-28). Two
// forms noticed home addresses and the rest did not, because noticing was
// each form's own idea.
//
// THE RULE. A file that renders <BridgePicker> (the way a form routes an
// address through a bridge) also renders <HomeNetworkHint>, or delegates to
// <EdgeConnectField>, which carries it. The hint reads the contract's
// needsBridge, the same rule the hosted egress guard applies.
//
// THE BOUNDARY. BridgePicker's own file, and a page that only lists bridges
// without taking an address, are not forms that take an address; each is
// exempted below by name with its reason, never by pattern.
//
// Proven red on the three forms as they stood before #3904: the live
// import (Part-DB, Homebox), a sync connection and the 3D printer bridge setup.
//
//   npx tsx scripts/lint-bridge-forms-say-home.ts   (pnpm lint bridge-forms-say-home)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["web/src", "packages/platform-web/src", "modules"];

const EXEMPT: Record<string, string> = {
  "web/src/components/BridgePicker.tsx": "the picker itself: it takes no address",
};

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
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) yield p;
  }
}

const violations: string[] = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    if (EXEMPT[file]) continue;
    const src = readFileSync(file, "utf8");
    const at = src.search(/<BridgePicker\b/);
    if (at < 0) continue;
    if (/<HomeNetworkHint\b/.test(src) || /<EdgeConnectField\b/.test(src)) continue;
    const line = src.slice(0, at).split("\n").length;
    violations.push(`${file}:${line}  offers a bridge but never says when an address is on the person's home network`);
  }
}

if (violations.length) {
  console.error(`lint:bridge-forms-say-home - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v}`);
  console.error("Render <HomeNetworkHint address={...} hosted={useHosted()} throughBridge={...} /> under the address field.");
  process.exit(1);
}
console.log("lint:bridge-forms-say-home OK");
