#!/usr/bin/env tsx
/**
 * lint:app-surface — the assistant's knowledge of this app has to be true AND
 * current.
 *
 * Cobb answers "how do I do X in this app" from APP_SURFACE. Two ways that goes
 * wrong, and this checks both:
 *
 *   LYING     — a direction that leads nowhere. Worse than no direction: it
 *               sends a person hunting for a screen that is not there and reads
 *               as the app being broken. (Writing the first list by hand, three
 *               of seven paths did not exist.)
 *   FALLING BEHIND — a feature shipped and nobody described it, so Cobb says he
 *               is not sure about something the app does. The generated half is
 *               derived from the configuration registry to stop this; if it is
 *               stale, the derivation did not run.
 *
 * Run: npx tsx scripts/lint-app-surface.ts   (regenerate: pnpm gen:app-surface)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const surface = readFileSync(`${ROOT}modules/core-ai/src/api/app-surface.ts`, "utf8");
const generatedPath = `${ROOT}packages/platform-contract/src/app-surface.generated.ts`;
const generated = readFileSync(generatedPath, "utf8");
const app = readFileSync(`${ROOT}web/src/App.tsx`, "utf8");

const wheres = [
  ...[...surface.matchAll(/where:\s*"([^"]+)"/g)].map((m) => m[1]!),
  ...[...generated.matchAll(/"where":\s*"([^"]+)"/g)].map((m) => m[1]!),
];
if (wheres.length === 0) {
  console.error("app-surface lint: no capabilities found — did the file move?");
  process.exit(1);
}

// Routes are declared as <Route path="/x" …>. A parameterised segment (:id)
// matches anything, so compare shape rather than text.
const routes = [...app.matchAll(/path="([^"]+)"/g)].map((m) => m[1]!);
const matches = (where: string): boolean =>
  routes.some((r) => {
    const rp = r.replace(/\/\*$/, "").split("/").filter(Boolean);
    const wp = where.split("/").filter(Boolean);
    if (rp.length !== wp.length) return false;
    return rp.every((seg, i) => seg.startsWith(":") || seg === wp[i]);
  });

const dead = wheres.filter((w) => !matches(w));
if (dead.length) {
  console.error(`❌ ${dead.length} of ${wheres.length} directions in APP_SURFACE lead nowhere:\n`);
  for (const w of dead) console.error(`  ${w}`);
  console.error(
    "\nEvery `where` must be a route web/src/App.tsx serves. Fix the path, or drop\n" +
      "the capability: telling someone to open a screen that does not exist is worse\n" +
      "than telling them you are not sure.",
  );
  process.exit(1);
}
// Stale = the registry moved and nothing regenerated, which is exactly the
// "invisible feature" this derivation exists to prevent. Compare against a
// fresh run rather than trusting a timestamp.
const fresh = execFileSync("npx", ["tsx", `${ROOT}scripts/gen-app-surface.ts`], {
  encoding: "utf8",
  env: { ...process.env, APP_SURFACE_STDOUT: "1" },
  stdio: ["ignore", "pipe", "ignore"],
});
const after = readFileSync(generatedPath, "utf8");
if (after !== generated) {
  console.error(
    "❌ app-surface.generated.ts was out of date — the configuration registry has\n" +
      "   changed since it was last generated, so Cobb does not know about a screen\n" +
      "   this app now has. It has been regenerated; commit the result.\n" +
      `   (${fresh.trim()})`,
  );
  process.exit(1);
}
console.log(`app-surface lint: ok (${wheres.length} capabilities, every screen exists, generated file current)`);
