// A Dockerfile that declares a build ARG must be given it by every workflow
// that builds it.
//
// The miss this exists for: docker/api.Dockerfile and docker/web.Dockerfile take
// `ARG GIT_SHA` and bake it into COBBLR_BUILD_SHA, which is the version
// super-admin Health reports and the version a self-hoster's bug report carries.
// docker-build.yml (internal registry, amd64, what cobblr.me runs) passed it.
// publish-selfhost-images.yml (GHCR, multi-arch, what every SELF-HOSTED
// instance runs) did not — it set only the OCI label
// org.opencontainers.image.revision.
//
// The label looks like it does the job and does not: it is image metadata that
// `docker inspect` can read, while the process inside the container cannot. So
// hosted deployments knew their own version and self-hosted ones never did, for
// as long as that workflow has existed. The deployments hardest to debug
// remotely were exactly the ones unable to say what they were running.
//
// Nothing failed. No test went red, no page 500'd, the field was just empty —
// which is why it needs a lint rather than a test.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const DOCKER = join(ROOT, "docker");
const FLOWS = join(ROOT, ".forgejo/workflows");

/** ARGs that must reach the image, with why they matter. Add one here when a
 *  Dockerfile starts depending on a value only the builder knows. */
const REQUIRED_ARGS: Record<string, string> = {
  GIT_SHA: "baked into COBBLR_BUILD_SHA — the version Health and bug reports show",
};

/** Which Dockerfiles declare each required arg. */
const declaredBy = new Map<string, string[]>();
for (const f of readdirSync(DOCKER).filter((f) => f.endsWith(".Dockerfile"))) {
  const src = readFileSync(join(DOCKER, f), "utf8");
  for (const arg of Object.keys(REQUIRED_ARGS)) {
    if (new RegExp(`^ARG ${arg}\\b`, "m").test(src)) {
      declaredBy.set(arg, [...(declaredBy.get(arg) ?? []), f.replace(".Dockerfile", "")]);
    }
  }
}

const problems: string[] = [];

for (const file of readdirSync(FLOWS).filter((f) => f.endsWith(".yml"))) {
  const raw = readFileSync(join(FLOWS, file), "utf8");
  // Strip comment lines FIRST. Matching the raw file flagged ci.yml, which only
  // mentions "docker build" in a note about cache bloat and builds nothing —
  // a lint that cries wolf on prose gets muted, and then it guards nothing.
  const src = raw
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  // Only workflows that actually build an image.
  if (!/docker\s+(buildx\s+)?build\b/.test(src)) continue;

  for (const [arg, why] of Object.entries(REQUIRED_ARGS)) {
    const images = declaredBy.get(arg) ?? [];
    if (!images.length) continue;
    // Does this workflow build one of the Dockerfiles that declares the arg?
    const buildsIt =
      images.some((img) => src.includes(`docker/${img}.Dockerfile`)) ||
      /-f "docker\/\$\{\{\s*matrix\.image\s*\}\}\.Dockerfile"/.test(src);
    if (!buildsIt) continue;
    if (!new RegExp(`--build-arg\\s+${arg}[=\\s]`).test(src)) {
      problems.push(
        `.forgejo/workflows/${file} builds ${images.join("/")} but never passes --build-arg ${arg} (${why})`,
      );
    }
  }
}

if (problems.length) {
  console.error("[lint:build-args] an image is built without a value it declares:\n");
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error(`
  Setting the OCI label is not the same thing. A label is metadata readable with
  \`docker inspect\`; the process inside the container cannot see it. Only
  --build-arg reaches the ENV the app reads.

      docker buildx build \\
        --label "org.opencontainers.image.revision=\${{ github.sha }}" \\
        --build-arg GIT_SHA="\${{ github.sha }}" \\
        ...
`);
  process.exit(1);
}

console.log(
  `[lint:build-args] ok — every workflow building ${[...declaredBy.values()].flat().join("/")} passes its required args.`,
);
