// Where to send someone who wants to talk to a human.
//
// This used to be two hardcoded slots: a GitHub URL compiled into the web
// bundle (`ISSUES_URL`) and one `discord_invite_url` string. Adding a place —
// the forum — meant editing a component, and a self-hoster could not point
// "Open an issue" anywhere but this project's own tracker. So it is a LIST,
// built from env, and adding a fourth place is a config line.
//
// Each entry is a PLACE YOU GO. The "Open an issue" button is deliberately not
// one of these: it carries the report you just typed, so it is a way of
// SENDING this, not somewhere to go. Only the tracker's base URL comes from
// here; the button composes the rest.

/** One place to take a question, in the order they should be offered. */
export interface CommunityLink {
  /** Stable id, so the UI can pick an icon without matching on the label. */
  id: "chat" | "forum" | "issues" | "docs";
  label: string;
  url: string;
  /** One short line: what you would go there FOR. Two links with no
   *  distinction just make the reader choose blind. */
  blurb: string;
}

const TRIM = (v: string | undefined): string => (v ?? "").trim();

/** Read a URL from the first env var that has one.
 *
 *  `||` and not `??`: compose passes optional env as `${VAR:-}`, so an unset
 *  var arrives as an EMPTY STRING, and `"" ?? fallback` is `""` (CLAUDE.md
 *  §14.6 — this exact bug shipped once and left every registry fetch pointed
 *  at ""). */
function firstUrl(...names: string[]): string {
  for (const n of names) {
    const v = TRIM(process.env[n]);
    if (v) return v;
  }
  return "";
}

/** Only http(s), so a mis-set var cannot put `javascript:` in an href. */
function safe(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? url : "";
  } catch {
    return "";
  }
}

/** The community places this deployment offers, in the order to show them.
 *
 *  Chat first: it is the fastest answer for a question. Forum second: it is
 *  where an answer stays findable. Issues last, because filing one is work and
 *  most questions are not bugs. */
export function communityLinks(): CommunityLink[] {
  const defs: CommunityLink[] = [
    {
      id: "chat",
      label: "Discord",
      // COBBLR_-prefixed first, bare name kept because deployments already set it.
      url: firstUrl("COBBLR_DISCORD_INVITE_URL", "DISCORD_INVITE_URL"),
      blurb: "Ask a question and get an answer the same day.",
    },
    {
      id: "forum",
      label: "Community forum",
      url: firstUrl("COBBLR_FORUM_URL"),
      blurb: "Longer questions, and answers that stay findable.",
    },
    {
      id: "issues",
      label: "Issue tracker",
      // Self-hosters can point this at their own fork. Unset means this
      // deployment does not offer a tracker, which is a real answer: a
      // self-hoster with no fork should not be sent to a stranger's repo.
      url: firstUrl("COBBLR_ISSUES_URL"),
      blurb: "Report a bug or track one you already filed.",
    },
    {
      id: "docs",
      label: "Documentation",
      url: firstUrl("COBBLR_DOCS_URL"),
      blurb: "How a feature is meant to work.",
    },
  ];
  return defs.map((d) => ({ ...d, url: safe(d.url) })).filter((d) => d.url);
}
