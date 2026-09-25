// The community places, as every surface shows them: the account menu, the
// phone menu and the feedback widget. ONE component reads the list, so a
// deployment that sets a Discord invite shows it everywhere and one that
// does not shows it nowhere; the places cannot disagree about whether
// there is a community (the hosted app had it only under the feedback
// widget, and a phone had it nowhere).
//
// The list is the server's (api/src/platform/community.ts, from
// DISCORD_INVITE_URL and friends); communityLinksFor() folds an older
// server's lone discord_invite_url back into it.
import type { ReactNode } from "react";
import { BookOpen, ExternalLink, Github, MessageCircle, Users, type LucideIcon } from "lucide-react";
import type { CommunityLinkId } from "@cobblr/platform-contract/community-links";
import { communityLinksFor } from "../lib/community-links";
import type { CommunityLink } from "../lib/api";

/** The heading every menu puts over the places. */
export const COMMUNITY_HEADING = "Join the community";

const ICON: Record<CommunityLinkId, LucideIcon> = {
  chat: MessageCircle,
  forum: Users,
  issues: Github,
  docs: BookOpen,
};

type CommunityUser = { community_links?: CommunityLink[] | null; discord_invite_url?: string | null } | null | undefined;

/** One place's address, or null when this deployment does not offer it: for a
 *  surface that USES a place (the feedback widget files a report into the
 *  issue tracker) rather than listing it. */
export function communityPlaceUrl(user: CommunityUser, id: CommunityLinkId): string | null {
  return communityLinksFor(user).find((l) => l.id === id)?.url ?? null;
}

/** The places this deployment offers, or nothing at all when it offers none.
 *  `heading` renders above them only when there is something under it. */
export function CommunityLinks({
  user,
  heading,
  itemClassName,
  iconClassName = "text-faint dark:text-slate-400",
  withBlurb = false,
  role,
  onNavigate,
  containerClassName,
}: {
  user: CommunityUser;
  heading?: ReactNode;
  itemClassName: string;
  iconClassName?: string;
  /** Say what each place is for under its name (the feedback widget). */
  withBlurb?: boolean;
  role?: "menuitem";
  onNavigate?: () => void;
  /** A box around heading and places, drawn only when there are places. */
  containerClassName?: string;
}) {
  const links = communityLinksFor(user);
  if (links.length === 0) return null;
  const body = (
    <>
      {heading}
      {links.map((l) => {
        const Icon = ICON[l.id] ?? MessageCircle;
        return (
          <a
            key={l.id}
            href={l.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onNavigate}
            className={itemClassName}
            role={role}
            data-community-link={l.id}
          >
            <Icon size={withBlurb ? 15 : 14} className={`shrink-0 ${iconClassName}`} />
            {withBlurb ? (
              <span className="min-w-0">
                <span className="block text-sm text-content dark:text-mortar-100">{l.label}</span>
                <span className="block text-xs text-muted dark:text-slate-400">{l.blurb}</span>
              </span>
            ) : (
              <span className="min-w-0 truncate">{l.label}</span>
            )}
            <ExternalLink size={12} className={`ml-auto shrink-0 text-faint ${withBlurb ? "mt-1" : ""}`} />
          </a>
        );
      })}
    </>
  );
  return containerClassName ? <div className={containerClassName}>{body}</div> : body;
}
