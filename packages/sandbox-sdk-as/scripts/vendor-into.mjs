#!/usr/bin/env node
// AssemblyScript's module resolution doesn't follow npm package
// conventions cleanly — `import { ... } from "@cobblr/sandbox-sdk-as"`
// is interpreted as a stdlib lookup at `~lib/@cobblr/sandbox-sdk-as.ts`
// instead of a node_modules traversal. Until that's fixed (either
// via asconfig.json paths or upstream asc improvements), the
// pragmatic workaround is to vendor a copy of the SDK source into
// each AS-authored module's `assembly/` dir.
//
// This script syncs the canonical SDK file into a target module's
// vendored copy. Run it after editing the SDK:
//
//     node packages/sandbox-sdk-as/scripts/vendor-into.mjs \
//       sandboxed-modules/hello-as
//
// Idempotent. If the SDK source hasn't changed, no-op.

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_SRC = resolve(__dirname, "..", "assembly", "index.ts");

const target = process.argv[2];
if (!target) {
  console.error("usage: vendor-into.mjs <target-module-dir>");
  process.exit(1);
}

const targetAssembly = resolve(process.cwd(), target, "assembly");
const targetSdk = resolve(targetAssembly, "sdk.ts");

if (!existsSync(SDK_SRC)) {
  console.error(`SDK source missing: ${SDK_SRC}`);
  process.exit(1);
}
if (!existsSync(targetAssembly)) {
  mkdirSync(targetAssembly, { recursive: true });
}

if (existsSync(targetSdk)) {
  // Cheap content compare via mtime — exact bytes check kicks in
  // only when sizes differ.
  const srcStat = statSync(SDK_SRC);
  const dstStat = statSync(targetSdk);
  if (srcStat.size === dstStat.size && readFileSync(SDK_SRC).equals(readFileSync(targetSdk))) {
    console.log(`vendor-into: ${targetSdk} already up to date`);
    process.exit(0);
  }
}

copyFileSync(SDK_SRC, targetSdk);
console.log(`vendor-into: synced SDK → ${targetSdk}`);
