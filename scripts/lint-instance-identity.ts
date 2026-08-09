#!/usr/bin/env tsx
/**
 * lint:instance-identity — shipping code never hardcodes ONE deployment's identity.
 *
 * The image is the same bytes for every install, so an address or hostname baked
 * into it speaks for all of them. Two of these shipped and ran for months:
 *
 *   • a vendor resolver sent the publisher's own mailbox as the contact address
 *     on every self-hoster's lookup
 *   • two User-Agents advertised the hosted deployment's URL as the contact
 *
 * Neither broke anything visibly, which is why they survived: the calls worked.
 * The costs land elsewhere — a vendor cannot reach whoever is actually calling,
 * one mailbox collects rate-limit and abuse mail for traffic it did not send, and
 * every operator is silently misrepresented.
 *
 * Two rules over shipping source (api/, web/, modules/, packages/ — the tree that
 * becomes the image and the public mirror):
 *
 *   1. No `cobblr.me` literal. It is one deployment's hostname. Say "the hosted
 *      service" in prose, use `cobblr.example.com` in an example URL, and read
 *      PUBLIC_BASE_URL at runtime when the real value is needed.
 *   2. No email literal outside a reserved example domain (RFC 2606:
 *      example.com/net/org, .test, .invalid, .localhost). A real address in
 *      shipping code is either a leak or a misattribution.
 *
 * Contact identity at runtime: @cobblr/platform-contract/outbound-identity.
 * Docs, scripts, CI config and tests are NOT covered here — internal files may
 * name real infrastructure, and the export manifest decides what ships.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/** The trees that become the image. */
const SHIPPING = ["api/src", "web/src", "modules", "packages", "sandboxed-modules"];
const SKIP_DIR = new Set(["node_modules", "dist", "build", ".turbo", "coverage", "tests", "test", "__tests__", "migrations"]);
const EXT = /\.(ts|tsx|js|jsx|mjs)$/;
// A test/fixture may legitimately assert on a real-looking value.
const SKIP_FILE = /\.(test|spec)\.[tj]sx?$/;

const EXAMPLE_DOMAIN = /@([a-z0-9-]+\.)*(example\.(com|net|org)|test|invalid|localhost)$/i;
const EMAIL = /["'`]([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})["'`]/g;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIR.has(e)) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXT.test(e) && !SKIP_FILE.test(e)) out.push(p);
  }
  return out;
}

const files = SHIPPING.flatMap((d) => walk(join(ROOT, d)));
const fails: string[] = [];

for (const abs of files) {
  const rel = relative(ROOT, abs);
  const text = readFileSync(abs, "utf8");

  text.split("\n").forEach((line, i) => {
    if (line.includes("cobblr.me")) {
      // `cobblr.me()` is an App Player DSL helper, not the hostname.
      if (/\bcobblr\.me\s*\(/.test(line)) return;
      fails.push(
        `${rel}:${i + 1} hardcodes the hosted deployment's hostname.\n` +
          `      Prose: "the hosted service". Example URL: cobblr.example.com.\n` +
          `      Real value at runtime: contactUrl() from @cobblr/platform-contract/outbound-identity.\n` +
          `      ${line.trim().slice(0, 100)}`,
      );
    }
    for (const m of line.matchAll(EMAIL)) {
      const addr = m[1]!;
      if (EXAMPLE_DOMAIN.test(addr)) continue;
      fails.push(
        `${rel}:${i + 1} hardcodes a real email address (${addr}).\n` +
          `      Shipping code is identical for every install, so this address would speak for all of them.\n` +
          `      Use operatorEmail() from @cobblr/platform-contract/outbound-identity, or a reserved\n` +
          `      example domain (you@example.com) if it is only a placeholder.`,
      );
    }
  });
}

if (fails.length) {
  console.error("lint:instance-identity FAILED\n");
  for (const f of fails) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log(`lint:instance-identity OK (${files.length} shipping source files checked)`);
