// How a lint's recorded command is run, in one place for lint:all and
// `pnpm lint <name>`.
//
// A record whose command is `node scripts/lint-x.ts` runs on Node's own type
// stripping with ts-resolve.mjs for the `.js` sibling imports: ~0.1 s to
// start, where tsx takes ~1.3 s. Startup, not the lint's own work, was most
// of what lint:all cost (#3901): 330 lints x 1.3 s. A lint whose imports use
// syntax stripping cannot handle (a constructor parameter property, an enum)
// keeps `tsx` in its record. A Node without stripping or registerHooks
// (older than 22.18) runs the same record under tsx, so it is never the
// machine that decides whether a lint runs.
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "ts-resolve.mjs");

export const NODE_RUNS_TS = Boolean(process.features?.typescript) && typeof registerHooks === "function";

/** The shell command that runs a recorded lint command. It extends, never
 *  replaces, the NODE_OPTIONS the caller set. */
export function lintCommand(cmd, nodeRunsTs = NODE_RUNS_TS) {
  if (!/^node\s+\S+\.ts(\s|$)/.test(cmd)) return cmd;
  if (!nodeRunsTs) return cmd.replace(/^node\s+/, "tsx ");
  const flags = `--import \\"${HOOK}\\" --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --disable-warning=ExperimentalWarning`;
  return `NODE_OPTIONS="$NODE_OPTIONS ${flags}" ${cmd}`;
}
