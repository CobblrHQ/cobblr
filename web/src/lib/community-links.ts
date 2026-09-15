// The community places to offer, tolerating a server that predates the list.
//
// A current server sends `community_links` (api/src/platform/community.ts).
// An older one sends only `discord_invite_url`; folding it back into a chat
// entry means a mid-upgrade deployment keeps the link it already had rather
// than showing nothing. The words come from the platform contract, the same
// table the server reads, so the fallback cannot drift from the served list
// the way it did when the account menu said "Community on Discord" and the
// feedback widget said "Discord" (#3039).
import { COMMUNITY_LINK_BLURBS, COMMUNITY_LINK_LABELS } from "@cobblr/platform-contract/community-links";
import type { CommunityLink } from "./api";

export function communityLinksFor(
  user: { community_links?: CommunityLink[] | null; discord_invite_url?: string | null } | null | undefined,
): CommunityLink[] {
  if (user?.community_links?.length) return user.community_links;
  if (user?.discord_invite_url) {
    return [{ id: "chat", label: COMMUNITY_LINK_LABELS.chat, url: user.discord_invite_url, blurb: COMMUNITY_LINK_BLURBS.chat }];
  }
  return [];
}
