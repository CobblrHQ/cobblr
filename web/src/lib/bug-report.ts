// Turn a feedback submission into a markdown bug report a self-hoster can paste
// into a public GitHub issue.
//
// Kept apart from the widget so the FORMAT is testable. A bug report is a
// contract with whoever reads it: if the environment block silently loses the
// build sha, nobody notices until a maintainer is asking for it by hand.
//
// Everything here is written by the reporter or gathered from their own
// instance, and all of it goes public. Do not add fields that identify the
// instance, its users, or its data. See api/src/routes/diagnostics.ts.

export interface ServerDiagnostics {
  build_sha: string | null;
  hosted: boolean;
  node: string;
  platform: string;
  postgres: string;
  modules: string[];
}

export interface ReportInput {
  type: "bug" | "confusing" | "idea" | "other";
  message: string;
  /** Route only, never the full URL: a path can carry record ids, and the query
   *  string more so. The reporter can add specifics themselves. */
  route: string;
  userAgent: string;
  viewport: { w: number; h: number };
  server?: ServerDiagnostics | null;
}

const TITLES: Record<ReportInput["type"], string> = {
  bug: "Bug",
  confusing: "Confusing",
  idea: "Idea",
  other: "Report",
};

/** A one-line title for the issue, from the first sentence of the message. */
export function reportTitle(input: ReportInput): string {
  const first = input.message.trim().split(/\n|(?<=[.!?])\s/)[0] ?? "";
  const trimmed = first.length > 72 ? `${first.slice(0, 69).trimEnd()}…` : first;
  return `${TITLES[input.type]}: ${trimmed || "(no description)"}`;
}

/** The issue body. Markdown, because that is what GitHub renders. */
export function reportBody(input: ReportInput): string {
  const s = input.server;
  const env: Array<[string, string]> = [
    ["Version", s?.build_sha ? s.build_sha.slice(0, 12) : "unknown (no build sha)"],
    ["Deployment", s ? (s.hosted ? "hosted" : "self-hosted") : "self-hosted"],
    ["Node", s?.node ?? "unknown"],
    ["Postgres", s?.postgres ?? "unknown"],
    ["Server", s?.platform ?? "unknown"],
    ["Route", input.route],
    ["Viewport", `${input.viewport.w}x${input.viewport.h}`],
    ["Browser", input.userAgent],
  ];

  const lines = [
    "### What happened",
    "",
    input.message.trim(),
    "",
    "### Environment",
    "",
    ...env.map(([k, v]) => `- **${k}:** ${v}`),
  ];

  if (s?.modules.length) {
    lines.push(
      "",
      "<details><summary>Enabled modules</summary>",
      "",
      ...s.modules.map((m) => `- ${m}`),
      "",
      "</details>",
    );
  }

  return lines.join("\n");
}

/** The public issue tracker. Issues live on GitHub because it is the only
 *  surface a self-hoster can reach: Forgejo carries the PRs and CI but sits on a
 *  private tailnet. */
export const ISSUES_URL = "https://github.com/CobblrHQ/core/issues/new";

/** A prefilled "new issue" link. GitHub truncates a very long querystring, and
 *  the reporter has the full text on their clipboard either way, so the link is
 *  a convenience and the copy button is the reliable path. */
export function newIssueUrl(input: ReportInput): string {
  const u = new URL(ISSUES_URL);
  u.searchParams.set("title", reportTitle(input));
  u.searchParams.set("body", reportBody(input));
  if (input.type === "bug") u.searchParams.set("labels", "bug");
  return u.toString();
}
