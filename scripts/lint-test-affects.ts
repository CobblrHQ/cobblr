#!/usr/bin/env tsx
/**
 * lint:test-affects — every api integration test says what it covers.
 *
 * `// affects: <tokens>` on the first lines of api/tests/*.test.ts is what lets
 * a module-only change run that module's tests instead of all 389 (about 4
 * minutes on the A6). A test with no header runs on every change, which is
 * safe and slow; a header with a token nobody recognises would silently mean
 * "never runs on a module change", which is why the tokens are checked here.
 *
 * Tokens: always | kernel | bundles | <modules/ directory>. See
 * scripts/test-affects.mjs (--infer proposes one) and CI_DEPLOY.md
 * "Affected tests".
 */
import { spawnSync } from "node:child_process";
const r = spawnSync(process.execPath, [new URL("./test-affects.mjs", import.meta.url).pathname, "--check"], { stdio: "inherit" });
process.exit(r.status ?? 1);
