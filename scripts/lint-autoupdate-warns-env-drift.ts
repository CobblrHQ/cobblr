/**
 * An auto-updater that ships without the .env caveat is a trap we set for our
 * own users.
 *
 * Watchtower re-creates a container by cloning the running one's environment, so
 * it never re-reads `.env`. Someone edits `.env`, watches fresh containers come
 * up on a new image, and reasonably concludes the change is applied. It is not,
 * and no surface says so. That cost one box weeks of running with a setting it
 * had been told to change.
 *
 * So: any compose file we ship that defines a watchtower service must sit beside
 * documentation that names the caveat AND points at the check. This is the lint
 * rather than a doc note because the failure only shows up on somebody else's
 * machine, months later, and by then nobody connects the two.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const CHECK = "check-env-drift";

/** Every compose file under deploy/, recursively. */
function composeFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) composeFiles(p, out);
    else if (/^(docker-)?compose.*\.ya?ml$/.test(e.name)) out.push(p);
  }
  return out;
}

const failures: string[] = [];

for (const file of composeFiles(join(ROOT, "deploy"))) {
  const body = readFileSync(file, "utf8");
  // Either shape opts the stack into an updater: defining the service, or
  // carrying the enable label for one that runs beside the stack (prod does
  // the latter). The .env trap is identical in both, so both must say so.
  const optsIn = /^\s{2}watchtower:/m.test(body) || /centurylinklabs\.watchtower\.enable:\s*"true"/.test(body);
  if (!optsIn) continue;

  // The docs a reader of THIS compose file would actually find: its own
  // directory's README, and the file's own comments.
  const readme = join(dirname(file), "README.md");
  const nearby = existsSync(readme) ? readFileSync(readme, "utf8") : "";
  const documented = [body, nearby].some((t) => t.includes(CHECK));

  if (!documented) {
    failures.push(
      `${file.replace(ROOT, "")} opts into an image updater, but neither it nor ` +
        `${readme.replace(ROOT, "")} mentions ${CHECK}.sh.\n` +
        `    An updater never re-reads .env. Say so where the reader is, and point at the check.`,
    );
  }
}

// The check itself has to exist for any of that advice to be followable.
const SCRIPT = join(ROOT, "deploy/selfhost/standalone/check-env-drift.sh");
if (!existsSync(SCRIPT)) {
  failures.push(
    "deploy/selfhost/standalone/check-env-drift.sh is missing, so every reference to it is a dead end.",
  );
}

if (failures.length > 0) {
  console.error("lint:autoupdate-warns-env-drift FAILED\n");
  for (const f of failures) console.error(`  - ${f}\n`);
  process.exit(1);
}
console.log("lint:autoupdate-warns-env-drift: ok");
