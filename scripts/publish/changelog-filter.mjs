// The SINGLE definition of "is this changelog entry user-facing, or internal /
// CI / release-pipeline noise?". Used by BOTH the Discord nightly digest and the
// public CHANGELOG so the feed and the repo can never disagree the same reason
// the forbidden list is shared.
//
// The public audience is SELF-HOSTERS. Keep what helps them run it (deploy,
// rollback, self-hosting setup, build provenance, workspace backup). Drop the
// maintainer's OWN release/CI pipeline (the canary channel, the daily-release
// job, rollback-check, internal test cleanup, dev-only lints). Conservative on
// purpose: a real feature that merely mentions "deploy" must NOT be dropped, so
// the patterns target pipeline nouns, not the generic words.
export const INTERNAL_CHANGELOG_RE = [
  /\bcanary\b/i,
  /daily release|release-daily/i,
  /rollback-check/i,
  /\bwatchtower\b/i,
  /\bforgejo\b/i,
  /\bpre-push\b/i,
  /advisory lock/i,
  /a new .{0,20}lint\b/i,
  /new guardrail/i,
  /internal test|test workspace/i,
  /nightly tag/i,
  // Added 2026-08-09. "The automated nightly release works when it runs on the
  // deploy box itself" went out as a user-facing FIX on Discord and the forum.
  // It is pure maintainer plumbing: nobody outside this repo has a deploy box.
  // The list already had `daily release|release-daily` and still missed it,
  // because the entry happened to say "nightly release". Match the maintainer's
  // pipeline nouns, never the bare word "nightly" — self-hosters DO consume the
  // :nightly images, so an entry about those images must still get through.
  /\bnightly release\b/i,
  /release train|release script/i,
  /deploy box|build box/i,
  /\bworktree\b/i,
];

// Test the LEAD (headline sentence) + scope, NOT the whole body. A real feature
// can mention a pipeline word ("CI", "deploy", a tool) deep in its description
// without being pipeline noise scoping to the lead is what keeps self-hoster
// fixes (e.g. "Self-host updates no longer discard uploads") from being dropped
// because their body happens to say "CI". (Bare \bCI\b was removed for exactly
// this reason it over-matched ordinary prose.)
export function isInternalChangelogEntry(scope = "", text = "") {
  const lead = String(text).replace(/\*\*/g, "").trim().split(/\n\n/)[0].split(/(?<=[.!?])\s/)[0];
  return INTERNAL_CHANGELOG_RE.some((re) => re.test(lead) || re.test(scope));
}

// The entry types, and who each is FOR. The regex list above is a safety net for
// entries that forgot to say; `type:` is the author saying it outright, and an
// explicit type always wins.
//
//   feature / improvement / fix / security / performance
//       everyone who uses Cobblr. Rendered in the nightly post as today.
//   selfhost
//       people who RUN their own instance: image provenance, upgrade behaviour,
//       compose/env changes, backup and restore. Its own section, because "the
//       container images now carry a link to their source" is real news to a
//       self-hoster and noise to everyone on the hosted service. Filing it under
//       "Features" (2026-08-09) told both audiences the wrong thing.
//   internal
//       the maintainer's own pipeline: the release job, CI, dev tooling, lints.
//       Announced nowhere. Kept only so the repo's history records it.
export const AUDIENCE_TYPES = Object.freeze({
  USER: ["feature", "improvement", "fix", "security", "performance"],
  SELFHOST: ["selfhost"],
  INTERNAL: ["internal"],
});

export const ALL_ENTRY_TYPES = Object.freeze([
  ...AUDIENCE_TYPES.USER,
  ...AUDIENCE_TYPES.SELFHOST,
  ...AUDIENCE_TYPES.INTERNAL,
]);

/** Is this entry announced on any surface? `type: internal` never is. */
export function isAnnounceableType(type = "") {
  return !AUDIENCE_TYPES.INTERNAL.includes(String(type).trim());
}
