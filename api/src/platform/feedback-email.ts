// The two feedback emails: "Your Cobblr request is live" when a report is
// resolved, and "We replied to your Cobblr feedback" when there is a reply on
// an open one. Built here rather than inline in the super-admin route, so what
// is sent is one function a render test can call for every case.

import { cobblrEmailHtml, emailLinesText, type EmailLine } from "./email-html.js";

/** The invitation's heading in each email (#4318, the approved wording). */
export const DISCORD_ASIDE_HEADING = {
  resolved: "If you haven't already, join us on Discord",
  reply: "Want faster answers?",
} as const;

export interface FeedbackEmailInput {
  kind: "resolved" | "reply";
  greeting: string;
  /** What the person reported, as they wrote it. */
  report: string;
  /** The fix (resolved) or our reply (open). */
  body: string;
  /** Absolute link to their feedback page. */
  feedbackUrl: string;
  /** The tokenized Reply-To, when replies by email reach the report. */
  replyAddress: string | null;
  /** The Discord invitation's lines for this person; empty means no section. */
  discord: EmailLine[];
}

export interface FeedbackEmail {
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  /** Whether this email carries the Discord invitation, so its send counts
   *  as a showing. */
  discordInvite: boolean;
}

export function feedbackEmail(o: FeedbackEmailInput): FeedbackEmail {
  const bq = (s: string) => s.split("\n").map((l) => `> ${l}`).join("\n");
  const replyHere = o.replyAddress
    ? `Just reply to this email and it'll land on your report — or use your feedback page:\n  ${o.feedbackUrl}`
    : `To reply, use your feedback page — replies to this email aren't monitored yet:\n  ${o.feedbackUrl}`;
  const heading = DISCORD_ASIDE_HEADING[o.kind];
  const discordText = o.discord.length ? `${heading}\n${emailLinesText(o.discord)}\n\n` : "";
  const aside = { heading, lines: o.discord };
  const replyTo = o.replyAddress ?? undefined;
  if (o.kind === "resolved") {
    // Lead with the reporter's own words, then what we did: a "reported, then
    // fixed" record.
    const report = o.report.slice(0, 600);
    return {
      subject: "Your Cobblr request is live",
      text: `${o.greeting}\n\nYou reported:\n${bq(report)}\n\n${o.body}\n\n${discordText}Still off? ${replyHere}\n\nThanks for helping make Cobblr better.\nThe Cobblr team`,
      html: cobblrEmailHtml({
        greeting: o.greeting,
        quoteLabel: "You reported:",
        quoteText: report,
        bodyParas: [o.body],
        aside,
        ctaUrl: o.feedbackUrl,
        ctaLabel: "View your feedback",
        footerNote: o.replyAddress ? "Still off? Just reply to this email and it'll land on your report." : "Still off? Reply on your feedback page (email replies aren't monitored yet).",
      }),
      replyTo,
      discordInvite: o.discord.length > 0,
    };
  }
  const report = o.report.slice(0, 500);
  return {
    subject: "We replied to your Cobblr feedback",
    text: `${o.greeting}\n\n${o.body}\n\n${discordText}${replyHere}\n\nYou'd sent us:\n  "${report}"\n\nThe Cobblr team`,
    html: cobblrEmailHtml({
      greeting: o.greeting,
      quoteLabel: "You reported:",
      quoteText: report,
      bodyParas: [o.body],
      aside,
      ctaUrl: o.feedbackUrl,
      ctaLabel: "Open your feedback",
      footerNote: o.replyAddress ? "Reply to this email to answer, or use your feedback page." : "Reply on your feedback page; email replies aren't monitored yet.",
    }),
    replyTo,
    discordInvite: o.discord.length > 0,
  };
}
