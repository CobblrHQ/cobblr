#!/usr/bin/env tsx
/**
 * lint:env-documented — a documented setting is a setting something actually reads.
 *
 * Two failure shapes, both silent, both discovered on 2026-08-09 while wiring BIdb:
 *
 *   1. ORPHAN: the docs tell an operator to set `COBBLR_X` and nothing anywhere
 *      reads it. They follow the instructions, get the default, and have no way to
 *      tell. (BIdb was nearly this: documented with a URL that resolves to nothing.)
 *
 *   2. DEV-COMPOSE GAP: the root `.env.example` offers a var, but the dev compose
 *      enumerates env explicitly rather than using `env_file:`, so setting it in
 *      `.env` reaches nothing. Our own testing then "proves" a feature does not
 *      work when it was never switched on. The self-host stack is immune — it uses
 *      `env_file: .env` and passes whatever an operator sets.
 *
 * Scope: `COBBLR_*` only, since those are ours. A var may declare itself
 * intentionally undocumented/internal by living nowhere in the docs; this lint
 * only ever asks about vars the docs already promise.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/** Files that PROMISE a var to an operator. */
const DOC_SOURCES = [
  "SELF_HOSTING.md",
  ".env.example",
  "deploy/.env.example",
  "deploy/selfhost/.env.example",
  "deploy/selfhost/standalone/.env.example",
];

/** Trees where a var can legitimately be CONSUMED. */
const CONSUMER_DIRS = ["api/src", "web/src", "modules", "packages", "sandboxed-modules", "docker", "deploy", "scripts"];
const CONSUMER_FILES = ["docker-compose.yml"];
const CONSUMER_EXT = new Set([".ts", ".tsx", ".mjs", ".js", ".yml", ".yaml", ".sh", ".conf", ".json"]);

const VAR = /(COBBLR_[A-Z0-9_]+)/g;

function read(p: string): string {
  try {
    return readFileSync(join(ROOT, p), "utf8");
  } catch {
    return "";
  }
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(ROOT, dir));
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist" || e === ".git") continue;
    const rel = `${dir}/${e}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (CONSUMER_EXT.has(e.slice(e.lastIndexOf(".")))) out.push(rel);
  }
  return out;
}

// ── what the docs promise ──
const documented = new Map<string, string[]>(); // var -> which docs
for (const src of DOC_SOURCES) {
  const text = read(src);
  if (!text) continue;
  const found = new Set<string>();
  // A doc table cell (`COBBLR_X`) or an env line (COBBLR_X=), commented or not.
  for (const m of text.matchAll(/`(COBBLR_[A-Z0-9_]+)`/g)) found.add(m[1]!);
  for (const m of text.matchAll(/^#?\s*(COBBLR_[A-Z0-9_]+)=/gm)) found.add(m[1]!);
  for (const v of found) documented.set(v, [...(documented.get(v) ?? []), src]);
}

// ── what anything actually consumes ──
const consumerFiles = [...CONSUMER_DIRS.flatMap((d) => walk(d)), ...CONSUMER_FILES];
const consumed = new Set<string>();
for (const f of consumerFiles) {
  if (f.endsWith(".env.example")) continue; // a template is a promise, not a consumer
  for (const m of read(f).matchAll(VAR)) consumed.add(m[1]!);
}

// ── the dev compose enumerates, so it is its own question ──
const devCompose = read("docker-compose.yml");
const devDeclared = new Set<string>([
  ...[...devCompose.matchAll(/\b(COBBLR_[A-Z0-9_]+)\s*:/g)].map((m) => m[1]!),
  ...[...devCompose.matchAll(/\$\{(COBBLR_[A-Z0-9_]+)/g)].map((m) => m[1]!),
]);
const devUsesEnvFile = /^\s*env_file:/m.test(devCompose);
const rootTemplate = new Set<string>(
  [...read(".env.example").matchAll(/^#?\s*(COBBLR_[A-Z0-9_]+)=/gm)].map((m) => m[1]!),
);

const fails: string[] = [];

for (const [v, where] of documented) {
  if (!consumed.has(v)) {
    fails.push(
      `${v} is documented in ${where.join(", ")} but NOTHING reads it.\n` +
        `      An operator who follows those instructions gets the default and cannot tell.\n` +
        `      Either wire it up, or drop it from the docs.`,
    );
  }
}

if (!devUsesEnvFile) {
  for (const v of rootTemplate) {
    // Only vars the API/web actually read matter here; a compose-substitution var
    // (image tags, mount roots) is consumed by compose itself, not passed inward.
    const readByApp = CONSUMER_DIRS.slice(0, 5).some((d) =>
      walk(d).some((f) => read(f).includes(`process.env.${v}`) || read(f).includes(`env.${v}`)),
    );
    if (readByApp && !devDeclared.has(v)) {
      fails.push(
        `${v} is offered in .env.example and read by the app, but docker-compose.yml\n` +
          `      does not pass it through (that compose enumerates env; it has no env_file).\n` +
          `      Setting it in .env would silently do nothing in dev — add the line.`,
      );
    }
  }
}

if (fails.length) {
  console.error("lint:env-documented FAILED\n");
  for (const f of fails) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log(
  `lint:env-documented OK (${documented.size} documented vars, all consumed; dev compose passthrough complete)`,
);
