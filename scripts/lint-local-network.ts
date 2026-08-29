// Guard: browser code reaches a local address through ONE door, or not at all.
//
// A web page contacting 127.0.0.1 is an intrusion into the machine somebody is
// sitting at, and browsers now treat it as one - the first attempt raises "this
// site wants to access other apps and services on this device". Receiving that
// before you have clicked anything is alarming out of all proportion to any
// feature behind it.
//
// It happened. The Live box polls the local print bridge and is passed a poll
// interval of 0 while closed, which its call site describes as "a closed box has
// no reason to be asking anything" - and the hook did one read before it looked
// at the interval. One request, but the box follows you across every page, so
// that was every visitor on their first screen, including strangers opening a
// try link.
//
// Fixing the call site fixes the call site. This enforces the rule: every local
// fetch goes through localFetch in platform-web's local-network.ts, which
// refuses until somebody has done something that needs it (pressed "connect a
// printer", opened the Live box, or already configured a bridge printer, which
// was consent at the time).
//
// Two shapes are caught: a literal local address next to a request call, and a
// raw fetch inside the modules that exist to talk to local hardware. The second
// is a capability row (sandbox:local-network-door) because the registry is where
// "one implementation" rules live; this script is the open-ended half, for a
// file nobody has thought of yet.
//
// Run: npx tsx scripts/lint-local-network.ts

import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Only the browser trees. The API reaching a local service is a different
 *  question with a different answer (see the egress guard). */
const ROOTS = ["web/src", "packages/platform-web/src", "modules"];
const DOOR = "packages/platform-web/src/local-network.ts";

/** A request call, on the same line as an address that belongs to the person
 *  sitting there. */
const CALL = /\b(fetch|EventSource|WebSocket|sendBeacon)\s*\(/;
const LOCAL = /(127\.0\.0\.1|\blocalhost\b|\[::1\]|192\.168\.|169\.254\.|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.)/;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full) && !full.endsWith(".d.ts") && !full.includes(".test.")) out.push(full);
  }
  return out;
}

function main(): void {
  const problems: string[] = [];
  let scanned = 0;

  for (const root of ROOTS) {
    for (const file of walk(root)) {
      // Server-side module code is not the browser; only .tsx and ui/ dirs of a
      // module ship to it, and the door itself is allowed to call fetch.
      if (file === DOOR) continue;
      if (root === "modules" && !/\/ui\//.test(file)) continue;
      scanned++;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (!CALL.test(line) || !LOCAL.test(line)) return;
          if (/\blocalFetch\s*\(/.test(line)) return; // through the door
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // a comment naming one
          problems.push(
            `  ${file}:${i + 1}\n      ${line.trim().slice(0, 110)}\n` +
              `      → use localFetch() from @cobblr/platform-web, which refuses until somebody has asked`,
          );
        });
    }
  }

  if (problems.length > 0) {
    console.error(`✗ browser code contacting a local address outside the one door:\n${problems.join("\n")}`);
    process.exit(1);
  }
  console.log(`✓ local network: ${scanned} browser files, every local request goes through localFetch`);
}

main();
