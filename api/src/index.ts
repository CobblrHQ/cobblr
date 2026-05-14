// Process entry point. On boot:
//   1. Run pending platform migrations against cobblr_meta
//   2. Verify DB connectivity
//   3. Start the HTTP listener
//
// Migrations crash the boot if anything fails — that's intentional.
// A half-migrated cobblr_meta is more dangerous than an offline api.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { env } from "./env.js";
import { metaPool, pingMeta } from "./db/meta.js";
import { runMigrations } from "./db/migrate.js";
import { loadAllModules } from "./modules/loader.js";
import { createServer } from "./server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function boot() {
  await pingMeta();
  // dist/index.js → dist/.. → ../migrations/platform
  // dev (tsx): src/index.ts → src/.. → ../migrations/platform
  const platformDir = resolve(__dirname, "..", "migrations", "platform");
  const result = await runMigrations({
    pool: metaPool,
    directory: platformDir,
    scope: "platform",
  });
  console.log(
    `[cobblr-api] platform migrations: ${result.applied.length} applied, ${result.alreadyApplied} already`,
  );

  await loadAllModules();

  const app = createServer();
  const server = app.listen(env.API_PORT, () => {
    console.log(`[cobblr-api] listening on :${env.API_PORT} (${env.NODE_ENV})`);
  });

  function shutdown(signal: string) {
    console.log(`[cobblr-api] ${signal} received, draining`);
    server.close(() => {
      console.log("[cobblr-api] server closed");
      metaPool.end().finally(() => process.exit(0));
    });
    setTimeout(() => {
      console.error("[cobblr-api] graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, 10_000).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

boot().catch((err) => {
  console.error("[cobblr-api] boot failed:", err);
  process.exit(1);
});
