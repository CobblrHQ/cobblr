// What a self-hoster pastes into a public bug report.
//
// A self-hosted instance's feedback never leaves the box — the row lands in that
// operator's own cobblr_meta and only their own super-admin sees it. Useful when
// they have users; a note to themselves when they don't, and either way there is
// no route for a Cobblr bug to reach the Cobblr project. This endpoint is that
// route: the environment facts a maintainer always ends up asking for, gathered
// once so the reporter does not have to go find them.
//
// EVERYTHING HERE BECOMES PUBLIC. The reporter pastes it into a GitHub issue, so
// it must carry no secrets, no personal data, and nothing about anyone else on
// the instance. Deliberately absent: user counts, workspace counts, org or user
// names, emails, any env var value, connection strings, tokens. Present: the
// versions and the enabled-module list for THIS workspace, which is what
// actually narrows a bug down.
//
// The reporter sees the whole payload before sending it — it is rendered into a
// text box they copy by hand. That visibility is the point, and the reason to
// keep the field list short enough to read.

import { Router } from "express";
import { sql } from "kysely";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { meta } from "../db/meta.js";
import { listEntries } from "../modules/registry.js";

export const diagnosticsRouter = Router({ mergeParams: true });

/** Postgres reports a whole banner ("PostgreSQL 16.4 (Debian …) on x86_64…").
 *  A bug report wants the version, not the build host. */
function shortPgVersion(banner: string): string {
  return banner.match(/^PostgreSQL (\d+(?:\.\d+)*)/)?.[1] ?? banner.slice(0, 40);
}

diagnosticsRouter.get(
  "/:slug/diagnostics",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const orgId = req.tenant!.org.id;

      const enabled = new Set(
        (
          await meta
            .selectFrom("org_modules")
            .select("module_name")
            .where("org_id", "=", orgId)
            .execute()
        ).map((r) => r.module_name),
      );
      const modules = listEntries()
        .filter((e) => enabled.has(e.manifest.name))
        .map((e) => `${e.manifest.name}@${e.manifest.version}`)
        .sort();

      let postgres = "unknown";
      try {
        const row = await sql<{ version: string }>`select version() as version`.execute(meta);
        const banner = row.rows[0]?.version;
        if (banner) postgres = shortPgVersion(banner);
      } catch {
        // A diagnostics call must never be the thing that fails. An unknown
        // version is a worse bug report, not a broken page.
      }

      res.json({
        build_sha: process.env.COBBLR_BUILD_SHA || null,
        version: process.env.COBBLR_VERSION || null,
        hosted: process.env.COBBLR_HOSTED === "true",
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        postgres,
        modules,
      });
    } catch (err) {
      next(err);
    }
  },
);
