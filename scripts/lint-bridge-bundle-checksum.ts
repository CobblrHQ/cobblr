#!/usr/bin/env tsx
// The embedded edge-bridge bundle is the bundle it says: its version and its SHA-256 are the hash of the bytes it serves.
//
// THE BUG THIS PREVENTS. A re-embed (embed-bridge.yml) changes only api/src/platform/edge-bridge-bundle.ts,
// and since 2026-10-11 its api tests are the few that read that file, not the whole suite (the owner: a
// re-embed sat 90 minutes in the full suite while bridges went without it). What the narrower run gives
// up, this holds on every run: bridges fetch the bytes and check them against the SHA-256 core
// advertises, so a bundle whose declared hash is not its bytes' hash is one every self-updating bridge
// refuses (or, worse, a hand edit that keeps an old hash on new bytes). The version is the same hash
// (scripts/embed-bridge-bundle.mjs writes both from one digest).
//
// THE RULE. BRIDGE_BUNDLE_VERSION and BRIDGE_BUNDLE_SHA256 are equal, 64 lowercase hex, and the
// SHA-256 of the base64-decoded B64 constant. No opt-out: a bundle that is not what it says is broken.
//
// THE BOUNDARY. One generated file; nothing else is read.
//
// PROVED RED on a copy of the bundle with one byte of B64 changed (bridge-bundle-checksum.test.ts).
//
//   npx tsx scripts/lint-bridge-bundle-checksum.ts   (pnpm lint bridge-bundle-checksum)
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** PURE. What is wrong with an embedded bundle's source, or nothing. */
export function bundleProblems(src: string): string[] {
  const version = /export const BRIDGE_BUNDLE_VERSION = "([^"]*)"/.exec(src)?.[1];
  const sha = /export const BRIDGE_BUNDLE_SHA256 = "([^"]*)"/.exec(src)?.[1];
  const b64 = /const B64 = "([^"]*)"/.exec(src)?.[1];
  if (version === undefined || sha === undefined || b64 === undefined) return ["it does not declare BRIDGE_BUNDLE_VERSION, BRIDGE_BUNDLE_SHA256 and B64 (regenerate: node scripts/embed-bridge-bundle.mjs)"];
  const out: string[] = [];
  if (!/^[0-9a-f]{64}$/.test(sha)) out.push(`BRIDGE_BUNDLE_SHA256 is not a SHA-256 (${sha.slice(0, 20)})`);
  if (version !== sha) out.push(`BRIDGE_BUNDLE_VERSION (${version.slice(0, 12)}) is not BRIDGE_BUNDLE_SHA256 (${sha.slice(0, 12)})`);
  const actual = createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");
  if (actual !== sha) out.push(`the bytes hash to ${actual.slice(0, 12)}, but it declares ${sha.slice(0, 12)}: every bridge would refuse this bundle`);
  return out;
}

const FILE = process.env.BRIDGE_BUNDLE_FILE || "api/src/platform/edge-bridge-bundle.ts";
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("lint-bridge-bundle-checksum.ts")) {
  const problems = bundleProblems(readFileSync(FILE, "utf8"));
  if (problems.length) {
    console.error(`lint:bridge-bundle-checksum - ${FILE} is not the bundle it says:`);
    for (const p of problems) console.error(`  ${p}`);
    console.error("Regenerate it (node scripts/embed-bridge-bundle.mjs); never edit it by hand.");
    process.exit(1);
  }
  console.log(`lint:bridge-bundle-checksum OK (${FILE} is the bundle it says)`);
}
