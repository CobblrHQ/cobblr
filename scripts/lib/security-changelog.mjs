// Who must say so in the release notes: a fix is exempt from a changelog entry, so a security fix
// used to ship with no line at all (#9216, a forwarded invite made a stranger an admin), and whoever runs
// an older release never learned they should move. lint:changelog asks this; a change to these files that
// has nothing to do with security says why, on a commit, rather than announcing a security fix nobody made.

/** The files that decide who gets in, and as what. */
export const WHO_GETS_IN = new Set([
  "api/src/routes/auth.ts",
  "api/src/routes/members.ts",
  "api/src/routes/admin-users.ts",
  "api/src/platform/join-invite.ts",
]);

const SECURITY_SUBJECT = /^\w+\(security\)!?:/i;

/** PURE. Why this branch owes a `type: security` entry, or [] when it doesn't. */
export function securityReasons(changed, subjects) {
  const reasons = [];
  const subject = subjects.find((s) => SECURITY_SUBJECT.test(s));
  if (subject) reasons.push(`the commit "${subject}"`);
  const files = changed.filter((f) => WHO_GETS_IN.has(f));
  if (files.length) reasons.push(`a change to ${files.join(", ")}`);
  return reasons;
}

/** PURE. A commit's `Not-security: <why>` line, or null. A commit naming itself security can't take it. */
export function notSecurityReason(messages, subjects) {
  if (subjects.some((s) => SECURITY_SUBJECT.test(s))) return null;
  for (const message of messages) {
    const why = /^Not-security:[ \t]*(\S.*)$/m.exec(message)?.[1]?.trim();
    if (why) return why;
  }
  return null;
}

/** PURE. Does an entry's frontmatter say `type: security`? */
export function isSecurityEntry(raw) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] ?? "";
  return /^type:\s*security\s*$/m.test(frontmatter);
}

/** The sections of a release's notes and the public changelog, in order. Security leads, so a
 *  person on an older release sees the reason to move first; every reader takes this list rather
 *  than its own, because one that listed only feature/improvement/fix filed #9216's line under
 *  Improvements in the notes and dropped it from the public changelog. */
export const NOTE_SECTIONS = [
  { type: "security", title: "Security" },
  { type: "feature", title: "Features" },
  { type: "improvement", title: "Improvements" },
  { type: "fix", title: "Fixes" },
];
export const NOTE_TYPES = NOTE_SECTIONS.map((s) => s.type);
