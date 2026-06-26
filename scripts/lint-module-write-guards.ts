#!/usr/bin/env tsx
// Module write-guard lint — every module that exposes mutating HTTP routes
// (.post/.patch/.delete/.put) MUST gate them so a read-only `guest` can't
// write. The kernel mount layer (api/src/modules/mount.ts) applies only
// requireAuth + withTenant + requireModuleEnabled — it does NOT gate writes —
// so each module self-guards (via requireRole / requireCapability, or a
// router-level guard middleware). This catches the 2026-06-26 P0 regression
// where assets/machines/projects/purchases/labels shipped unguarded CRUD.
//
//   cd <repo> && npx tsx scripts/lint-module-write-guards.ts
//
// Local + CI, free, zero deps.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const MODULES_DIR = "modules";

// Justified, reviewed exceptions — a module here may have write-verb routes
// with no requireRole/requireCapability token. Keep tiny + each justified.
const ALLOW = new Map<string, string>([
  // Stateless parse/transform POSTs (XML/CSV → JSON); no DB writes, member-open.
  ["bricklink-connector", "parse endpoints are stateless transforms, no DB writes"],
  // /tick is guarded inline (checks req.tenant.role for owner/admin) rather
  // than via the requireRole helper, so the token scan doesn't see it.
  ["core-recurrence", "/tick guarded inline by tenant.role"],
]);

const WRITE_VERB = /\.(post|patch|delete|put)\s*\(/;
const GUARD = /requireRole|requireCapability/;

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (e !== "node_modules" && e !== "ui" && e !== "dist") out.push(...tsFiles(p));
    } else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

const offenders: string[] = [];
for (const m of readdirSync(MODULES_DIR)) {
  const apiDir = join(MODULES_DIR, m, "src", "api");
  if (!existsSync(apiDir)) continue;
  const files = tsFiles(apiDir).map((f) => ({ f, src: readFileSync(f, "utf8") }));
  const hasWrite = files.some(({ src }) => WRITE_VERB.test(src));
  const hasGuard = files.some(({ src }) => GUARD.test(src));
  if (hasWrite && !hasGuard && !ALLOW.has(m)) {
    offenders.push(
      `  ${m}: exposes write routes (.post/.patch/.delete) but no requireRole/requireCapability anywhere in src/api`,
    );
  }
}

if (offenders.length > 0) {
  console.error(
    "✗ module write-guard lint failed — these modules let a read-only guest mutate:\n" +
      offenders.join("\n") +
      "\n\nAdd a write guard (requireRole/requireCapability per handler, or a\n" +
      "router.use guest-block middleware like assets/machines/projects do), or — if\n" +
      "the writes are genuinely safe for any member — add a justified ALLOW entry.",
  );
  process.exit(1);
}
console.log("✓ module write-guard lint passed");
