// Auth-route rate-limit lint. Every UNAUTHENTICATED, MUTATING route on the auth router
// (login / signup / magic-link / password-reset / token-exchange — the credential surface)
// must carry an app-level rate limiter, or it's a free brute-force / email-spam / token-
// probing target. `POST /identity/exchange` shipped with none (a code sweep caught it); this
// makes the whole class fail at commit.
//
// SCOPE: api/src/routes/auth.ts only. That's where unauthenticated credential endpoints
// concentrate + where rate-limiting is load-bearing; broad cross-router auth linting is
// defeated by router-level `.use(requireAuth)` and by the many legitimately-unlimited
// public endpoints (health, webhooks, oauth callbacks) elsewhere.
//
// A route is OK if EITHER it is authenticated (`requireAuth` in its middleware — a session
// already gates it) OR its handler references a `…Limiter(` call. Anything else must be an
// explicit, baselined exception. Baseline = today's known-unlimited auth routes (a visible
// hardening ledger — shrink it by adding limiters, never grow it).
//
// Run: npx tsx scripts/lint-auth-rate-limits.ts   (free, local, no CI minutes)

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const AUTH_FILE = join(ROOT, "api", "src", "routes", "auth.ts");
const BASELINE_PATH = join(ROOT, "scripts", "auth-rate-limits-baseline.json");

const ROUTE_RE = /authRouter\.(post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]([^)]*)/;

interface Finding {
  method: string;
  path: string;
  line: number;
}

const src = readFileSync(AUTH_FILE, "utf8").split("\n");
// Index of each authRouter.<verb>( line, so we can bound each handler body at the next one.
const routeLineIdxs = src.map((l, i) => (/authRouter\.(get|post|put|patch|delete)\(/.test(l) ? i : -1)).filter((i) => i >= 0);

const findings: Finding[] = [];
src.forEach((line, i) => {
  const m = ROUTE_RE.exec(line);
  if (!m) return;
  const [, method, path, middleware] = m;
  if (/\brequireAuth\b|\brequirePlatformAdmin\b/.test(middleware!)) return; // session-gated
  // Body extends to the next route registration (any verb) or EOF.
  const next = routeLineIdxs.find((idx) => idx > i) ?? src.length;
  const body = src.slice(i, next).join("\n");
  // A limiter is present if the handler either calls a `…Limiter(` directly (pair/claim
  // pattern) or goes through the `overLimit(<limiter>, req)` helper (login/signup/etc).
  const hasLimiter = /\w*Limiter\(|\boverLimit\(/.test(body);
  const hasMarker = /\/\/\s*public-no-limit\b/.test(body);
  if (!hasLimiter && !hasMarker) findings.push({ method: method!, path: path!, line: i + 1 });
});

interface BaselineEntry {
  method: string;
  path: string;
  reason: string;
}
const key = (f: { method: string; path: string }) => `${f.method.toUpperCase()} ${f.path}`;

if (process.argv.includes("--update-baseline")) {
  const byKey = new Map<string, BaselineEntry>();
  for (const f of findings) {
    if (!byKey.has(key(f))) byKey.set(key(f), { method: f.method.toUpperCase(), path: f.path, reason: "baselined 2026-07-30 — unlimited at the app layer; add a per-IP limiter, never grow this list." });
  }
  const fresh = [...byKey.values()].sort((a, b) => key(a).localeCompare(key(b)));
  writeFileSync(BASELINE_PATH, JSON.stringify(fresh, null, 2) + "\n");
  console.log(`Wrote ${fresh.length} baseline entries to ${relative(ROOT, BASELINE_PATH)}`);
  process.exit(0);
}

const baseline: BaselineEntry[] = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : [];
const baselined = new Set(baseline.map(key));
const isNew = findings.filter((f) => !baselined.has(key(f)));
const found = new Set(findings.map(key));
const stale = baseline.filter((b) => !found.has(key(b)));

console.log(`auth-rate-limits lint: ${findings.length} unlimited auth route(s), ${baselined.size} baselined, ${isNew.length} NEW`);
if (stale.length) {
  console.log(`\n${stale.length} baseline entr${stale.length === 1 ? "y" : "ies"} now limited — remove from the baseline:`);
  for (const b of stale) console.log(`  - ${b.method} ${b.path}`);
}
if (isNew.length) {
  console.error(`\n❌ ${isNew.length} NEW unauthenticated auth route(s) with no rate limit:\n`);
  for (const f of isNew) console.error(`  ${f.method.toUpperCase()} ${f.path}  (auth.ts:${f.line})`);
  console.error(`\nAn unauthenticated credential endpoint with no limiter is a free brute-force / email-spam`);
  console.error(`/ token-probing target. Add the per-IP limiter (see makePairLimiter in auth.ts): guard the`);
  console.error(`handler with \`if (!<name>Limiter(req.ip ?? "unknown")) return res.status(429)…\`. If it is`);
  console.error(`genuinely safe unlimited, add a \`// public-no-limit\` comment in the handler with why.`);
  process.exit(1);
}
console.log("✓ every unauthenticated auth route is rate-limited");
