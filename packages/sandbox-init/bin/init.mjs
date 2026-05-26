#!/usr/bin/env node
// @cobblr/sandbox-init — scaffold a new sandboxed Cobblr module.
//
// Usage:
//   npx @cobblr/sandbox-init <module-name>
//
// Creates ./<module-name>/ with a runnable AssemblyScript starter:
//   - manifest.json with one POST /ping handler
//   - assembly/index.ts using @cobblr/sandbox-sdk-as
//   - assembly/sdk.ts (vendored copy because AS resolver doesn't
//     traverse workspace symlinks — see vendor-into.mjs)
//   - package.json with build / vendor-sdk scripts
//   - README.md + .gitignore
//
// After `npm install && npm run build` the project produces a
// module.wasm the cobblr sandbox loads. The host runtime probes
// for cobblr_alloc/cobblr_dealloc so the re-export in
// assembly/index.ts is required, not optional.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = resolve(__dirname, "..", "templates", "default");
const SDK_SRC = resolve(__dirname, "..", "..", "sandbox-sdk-as", "assembly", "index.ts");

const name = process.argv[2];
if (!name || !/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
  console.error("usage: cobblr-sandbox-init <module-name>");
  console.error("name must be kebab/snake-case ascii, leading [a-z0-9]");
  process.exit(1);
}
const target = resolve(process.cwd(), name);
if (existsSync(target)) {
  console.error(`refusing to overwrite existing dir ${target}`);
  process.exit(1);
}

function render(template, replacements) {
  let out = template;
  for (const [k, v] of Object.entries(replacements)) {
    out = out.replaceAll(`{{${k}}}`, v);
  }
  return out;
}

function copyTemplate(rel, replacements) {
  const src = join(TEMPLATE_DIR, rel);
  const dst = join(target, rel);
  mkdirSync(dirname(dst), { recursive: true });
  const raw = readFileSync(src, "utf-8");
  writeFileSync(dst, render(raw, replacements));
}

mkdirSync(target);
const subs = {
  NAME: name,
  PASCAL: name.split(/[-_]/).map((s) => s[0].toUpperCase() + s.slice(1)).join(""),
};

copyTemplate("manifest.json", subs);
copyTemplate("package.json", subs);
copyTemplate("README.md", subs);
copyTemplate("assembly/index.ts", subs);
copyTemplate(".gitignore", subs);
// Vendor the SDK source so AS can resolve it as `./sdk` immediately.
if (existsSync(SDK_SRC)) {
  copyFileSync(SDK_SRC, join(target, "assembly", "sdk.ts"));
} else {
  console.warn(`note: ${SDK_SRC} not found — you'll need to manually copy the SDK into ${target}/assembly/sdk.ts`);
}

console.log(`✓ created ${target}`);
console.log("");
console.log("Next steps:");
console.log(`  cd ${name}`);
console.log("  npm install                     # asc + zero other deps");
console.log("  npm run build                   # writes module.wasm");
console.log("  # Drop the dir into cobblr-core/sandboxed-modules/ + restart");
console.log("  # OR sign + publish via scripts/sign-tarball.mjs +");
console.log("  #    add to cobblrhq/registry to make it install-able.");
console.log("");
console.log("Try it: POST /api/v1/orgs/:slug/modules/" + name + "/ping → { ok: true }");
