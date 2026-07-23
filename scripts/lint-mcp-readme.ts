// Guard: packages/mcp-server/README.md must document every tool the MCP server
// registers, so its "Tools" section can't drift from the code. It did once: the
// table hand-listed a subset of the operate tools and omitted the writes
// (create/update/delete) plus search_records/list_related and the template
// tools, so the README described a read-only server that had shipped read+write
// months before.
//
// The tool set has two sources of truth, both read here as TEXT (no import, so
// the lint can't be broken by a build/resolution hiccup):
//   - OPERATE tools: each `name: "<tool>"` entry in the shared
//     @cobblr/workspace-tools registry; the server registers every one as
//     `cobblr_<name>` in a loop.
//   - BUILD/DRIVE tools: literal `registerTool("cobblr_…")` calls in
//     packages/mcp-server/src/tools.ts.
// Each resulting `cobblr_*` name must appear in the README (a `cobblr_<prefix>*`
// glob, e.g. `cobblr_drive_*`, covers a whole family).
// Run: npx tsx scripts/lint-mcp-readme.ts

import { readFileSync } from "node:fs";

const README = "packages/mcp-server/README.md";
const SERVER = "packages/mcp-server/src/tools.ts";
const REGISTRY = "packages/workspace-tools/src/tools.ts";

const readme = readFileSync(README, "utf8");
const server = readFileSync(SERVER, "utf8");
const registry = readFileSync(REGISTRY, "utf8");

// OPERATE: `name: "<tool>"` in the registry array. The `name: string` interface
// field is unquoted, so it does not match.
const operate = [...registry.matchAll(/^\s*name:\s*["']([a-z0-9_]+)["']/gm)].map((m) => `cobblr_${m[1]!}`);
// BUILD/DRIVE: quoted `registerTool("cobblr_…")` names. The operate loop uses a
// backtick template (`cobblr_${tool.name}`), so it is not double-counted here.
const staticNames = [...server.matchAll(/registerTool\(\s*["'](cobblr_[a-z0-9_]+)["']/g)].map((m) => m[1]!);

// If either extraction suddenly yields almost nothing, a source file changed
// shape — fail loudly rather than green-lighting an unchecked README.
if (operate.length < 5 || staticNames.length < 5) {
  console.error(
    `✗ mcp-readme lint: extraction looks broken (${operate.length} registry + ${staticNames.length} registered names). ` +
      `A source file changed shape; update this lint's regex rather than letting it pass blind.`,
  );
  process.exit(1);
}

const required = [...new Set([...operate, ...staticNames])].sort();

// README coverage: a whole-token mention, OR a `cobblr_<prefix>*` glob that
// covers a family (so `cobblr_drive_*` documents every cobblr_drive_ tool).
const globs = [...readme.matchAll(/cobblr_[a-z0-9_]*\*/g)].map((m) => m[0].slice(0, -1));
const covered = (name: string) =>
  new RegExp(`(?<![a-z0-9_])${name}(?![a-z0-9_])`).test(readme) || globs.some((g) => name.startsWith(g));

const missing = required.filter((n) => !covered(n));

if (missing.length) {
  console.error(`✗ mcp-readme lint: ${README} omits ${missing.length} tool(s) the server registers:`);
  for (const n of missing) console.error(`    ${n}`);
  console.error(
    `\n  Operate tools come from ${REGISTRY} (registered as cobblr_<name>); build/drive tools from ${SERVER}.\n` +
      `  Document each in the README's Tools section — or cover a family with a \`cobblr_<prefix>*\` glob —\n` +
      `  so the docs can never advertise a smaller surface than the server exposes.`,
  );
  process.exit(1);
}

console.log(
  `✓ mcp-readme lint: README documents all ${required.length} registered tools ` +
    `(${operate.length} operate + ${staticNames.length} build/drive)`,
);
process.exit(0);
