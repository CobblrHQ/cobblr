#!/usr/bin/env tsx
/**
 * lint:oci-labels — every published self-host image declares its provenance.
 *
 * `org.opencontainers.image.source` is the label GitHub reads to attach a GHCR
 * package to its repository: with it the package page shows the README and a link
 * to the source, without it a stranger sees a bare list of tags and no way back to
 * the project. `description` and `licenses` fill in the rest of that page.
 *
 * They are plain `--label` flags on one buildx command, which makes them the
 * easiest thing in the file to lose: drop a line in a refactor and the image still
 * builds, still pushes, still runs. Nothing fails. The only symptom is a package
 * page that quietly goes back to looking abandoned, on the public-facing surface
 * of the project, months before anyone thinks to look.
 *
 * The workflow reads the label back from the registry after pushing, which catches
 * a build that lost it. This catches the edit itself, in the PR that makes it,
 * without needing a registry or a docker daemon.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const WORKFLOW = ".forgejo/workflows/publish-selfhost-images.yml";

const REQUIRED = [
  {
    label: "org.opencontainers.image.source",
    why: "GitHub uses it to link the GHCR package to the repo (README + source link on the package page)",
    expect: /org\.opencontainers\.image\.source=https:\/\/github\.com\/CobblrHQ\/cobblr\b/,
    expectWhy: "must point at the PUBLIC mirror (github.com/CobblrHQ/cobblr), not the private repo",
  },
  {
    label: "org.opencontainers.image.description",
    why: "the one-line description on the package page",
    expect: /org\.opencontainers\.image\.description=\S/,
    expectWhy: "must be non-empty",
  },
  {
    label: "org.opencontainers.image.licenses",
    why: "the licence shown on the package page",
    // LICENSE.md is FSL-1.1-ALv2. Stamping BUSL-1.1 here (nearly shipped once)
    // would publish a licence claim the repo does not make.
    expect: /org\.opencontainers\.image\.licenses=FSL-1\.1-ALv2\b/,
    expectWhy: "must match LICENSE.md (FSL-1.1-ALv2) — a wrong licence label is a false claim",
  },
  {
    label: "org.opencontainers.image.revision",
    why: "ties the image back to the commit it was built from; deploy-gap.sh reads it",
    expect: /org\.opencontainers\.image\.revision=/,
    expectWhy: "must be set from the build's commit sha",
  },
];

const text = readFileSync(join(ROOT, WORKFLOW), "utf8");
const fails: string[] = [];

for (const r of REQUIRED) {
  if (!text.includes(r.label)) {
    fails.push(`${WORKFLOW} no longer sets ${r.label} — ${r.why}.`);
  } else if (!r.expect.test(text)) {
    fails.push(`${WORKFLOW} sets ${r.label} but ${r.expectWhy}.`);
  }
}

// The registry read-back in the workflow is the runtime half of this guard: it
// catches a BUILD that lost the label, which a static check of the yaml never can.
// So the read-back itself has to be defended, or the pair silently becomes one.
//
// A plain substring, deliberately. The first attempt here was a regex with the /s
// flag, where `.` matches newlines — so `::error::.*image\.source` matched almost
// any workflow containing both strings anywhere, and the check passed while the
// read-back was gone. It reported ✓ on a file I had just broken on purpose.
const READBACK_MARKERS = [
  "--format '{{json .Image}}'", // reads the image config back from the registry
  "NO org.opencontainers.image.source label", // and fails the run when it is absent
  "label check SKIPPED, not passed", // and refuses to call an unrunnable probe a pass
];
for (const marker of READBACK_MARKERS) {
  if (!text.includes(marker)) {
    fails.push(
      `${WORKFLOW} lost part of the registry read-back (missing: ${marker}).\n` +
        `    This lint only sees the yaml, so it cannot notice a build that dropped the\n` +
        `    label at runtime — the read-back is the half that can. Keep both.`,
    );
  }
}

if (fails.length) {
  console.error("lint:oci-labels FAILED\n");
  for (const f of fails) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log(`lint:oci-labels OK (${REQUIRED.length} labels + the registry read-back)`);
