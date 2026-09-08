// A method on the web api client that nothing in the web calls is a backend
// capability nobody can reach.
//
// The catalog-image route learned to crop the identify photo on 2026-08-11 and
// `cropScanCatalogImage` shipped in api.ts the same day. No component ever
// called it. "use as catalog" kept taking the whole frame, and the crop the
// owner asked for on 2026-09-08 had been possible, unreachable, for a month.
// CLAUDE.md calls this "an action with no surface": the client method LOOKS
// like a finished feature and hides that the UI half is missing.
//
// This reads every method name on the `api` object and fails when a method
// has no caller in web/src (outside api.ts and tests), unless it is in the
// BASELINE below. The baseline is the set that was already unreachable when
// the lint landed; shrink it by wiring a surface (or deleting the method),
// never grow it.
//
//   npx tsx scripts/lint-api-client-reachable.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const API = "web/src/lib/api.ts";
const ROOTS = ["web/src", "packages/platform-web/src", "modules"];

/** Unreachable on 2026-09-08. Each is a surface still owed or a method to
 *  delete; either way, wiring one REMOVES it from here. */
const BASELINE = new Set([
  "listMySignupInvites", "revokeMySignupInvite", "pairStart", "verifyEmail", "orgLocal",
  "addOrderItem", "markConversationRead", "placementContents", "placementContainerOf",
  "placementPlace", "placementRemove", "uninstallRenderer", "authoringContext",
  "markNotificationRead", "markAllNotificationsRead", "mintAppToken",
  "setDigifabDevicePosition", "patchDigifabChannel", "renameDigifabLibrary", "deleteInstance",
  "updateNavHeading", "updateSyncConnection", "putawayConfirm", "setupPutawayBins",
  "putawayUndo", "getPutawayCurrent", "backfillScanCatalogPhotos", "matchScanItem",
  "peekAnswer", "invokeAi", "aiChat", "aiChatWrites", "updateCatalog", "instantiateTemplate",
]);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

const apiSrc = readFileSync(API, "utf8");
const methods = [...apiSrc.matchAll(/^  ([a-zA-Z0-9_]+): (?:\(|async \(|<)/gm)].map((m) => m[1]!);

let corpus = "";
for (const root of ROOTS) for (const f of walk(root)) if (!f.endsWith(API)) corpus += readFileSync(f, "utf8") + "\n";

const called = (name: string) =>
  new RegExp(`\\bapi\\.${name}\\b`).test(corpus) || new RegExp(`\\b${name}\\b\\s*[,)}]`).test(corpus);

const orphans = methods.filter((m) => !called(m) && !BASELINE.has(m));
const healed = [...BASELINE].filter((m) => methods.includes(m) && called(m));
const gone = [...BASELINE].filter((m) => !methods.includes(m));

if (healed.length || gone.length) {
  console.log(`lint:api-client-reachable: remove from BASELINE (now reachable or deleted): ${[...healed, ...gone].join(", ")}`);
}
if (orphans.length) {
  console.error("lint:api-client-reachable: api client methods with no caller in the web (a capability nobody can reach):");
  for (const m of orphans) console.error(`  api.${m}  (${API})`);
  console.error("Wire a surface that calls it, or delete the method. Do not add it to BASELINE.");
  process.exit(1);
}
if (healed.length || gone.length) process.exit(1);
console.log(`lint:api-client-reachable OK - ${methods.length} methods, ${BASELINE.size} baselined, 0 new orphans`);
