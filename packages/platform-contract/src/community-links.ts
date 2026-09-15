// The names of the community places, spelled once.
//
// The account menu, the feedback widget and the server each carried their own
// copy of the chat link's label, and the three read "Discord", "Community on
// Discord" and "Discord" (#3039). The server's list (api/src/platform/
// community.ts) is what a current deployment shows; the web keeps a fallback
// for a server that predates the list and sends only discord_invite_url. When
// the owner asked for "Discord Community", the rename was three edits, so the
// copy now lives here and both sides import it: a label cannot differ by
// surface again.
//
// Buildless subpath: no runtime import of a sibling.

/** The stable ids, so the UI picks an icon without matching on the label. */
export type CommunityLinkId = "chat" | "forum" | "issues" | "docs";

/** What each place is called, wherever it is listed. */
export const COMMUNITY_LINK_LABELS: Readonly<Record<CommunityLinkId, string>> = {
  chat: "Discord Community",
  forum: "Community forum",
  issues: "Issue tracker",
  docs: "Documentation",
};

/** One short line per place: what you would go there FOR. Two links with no
 *  distinction just make the reader choose blind. */
export const COMMUNITY_LINK_BLURBS: Readonly<Record<CommunityLinkId, string>> = {
  chat: "Ask a question and get an answer the same day.",
  forum: "Longer questions, and answers that stay findable.",
  issues: "Report a bug or track one you already filed.",
  docs: "How a feature is meant to work.",
};
