// The Cobblr cloud, and where a share or a transfer can go (#4737).
//
// One setting names the cloud for the whole product: COBBLR_CLOUD_URL. Every
// place that sends someone there (a share invite, a hand-over, a sandbox's
// "keep it in the cloud", a backup brought in from a link) reads it here,
// never a literal hostname (lint:instance-identity holds that; this file is
// its one exemption, because the default lives here).
//
// The invite dialog's "Where is their Cobblr?" reads inviteDestinations():
// COBBLR_SHARE_INVITE_DESTINATIONS when set, else this Cobblr and the cloud
// (the cloud itself offers only itself). Which Cobblrs may PAIR is a separate
// setting, COBBLR_SHARE_TRUSTED_PEERS. The cloud pairs only with the Cobblrs
// it trusts (decision (b), #4737), so a self-hoster's cloud option says so.

const DEFAULT_CLOUD = "https://app.cobblr.xyz";

const origin = (u: string): string => {
  try {
    return new URL(u).origin;
  } catch {
    return u.replace(/\/+$/, "");
  }
};

/** The Cobblr cloud's address. */
export function cloudUrl(): string {
  return origin((process.env.COBBLR_CLOUD_URL || DEFAULT_CLOUD).trim());
}

/** Where someone signs up for the cloud. */
export function cloudSignupUrl(): string {
  return (process.env.COBBLR_CLOUD_SIGNUP_URL || "").trim() || `${cloudUrl()}/signup`;
}

/** Is this Cobblr (by its public address) the cloud itself? */
export function isTheCloud(here: string): boolean {
  return !!here && origin(here) === cloudUrl();
}

/** The other Cobblrs this operator runs or trusts (COBBLR_SHARE_TRUSTED_PEERS). */
export function trustedPeers(): string[] {
  return (process.env.COBBLR_SHARE_TRUSTED_PEERS || "")
    .split(",")
    .map((s) => origin(s.trim()))
    .filter(Boolean);
}

export interface InviteDestination {
  label: string;
  origin: string;
  /** Said beside a destination that cannot take this Cobblr's invite yet. */
  note: string | null;
}

function parseDestinations(raw: string): Array<{ label: string; origin: string }> {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf("=");
      const url = eq >= 0 ? part.slice(eq + 1).trim() : part;
      const label = eq >= 0 ? part.slice(0, eq).trim() : new URL(url).host;
      return { label: label || new URL(url).host, origin: origin(url) };
    });
}

/** Where an invite from this Cobblr can be opened, in the order offered; the
 *  first is the default. */
export function inviteDestinations(here: string): InviteDestination[] {
  const self = { label: here ? new URL(here).host : "This Cobblr", origin: origin(here), note: null };
  const raw = (process.env.COBBLR_SHARE_INVITE_DESTINATIONS || "").trim();
  if (raw === "self") return [self];
  if (raw) return parseDestinations(raw).map((d) => ({ ...d, note: null }));
  if (isTheCloud(here)) return [self];
  const cloud = cloudUrl();
  const trusted = trustedPeers().includes(cloud);
  return [
    self,
    {
      label: new URL(cloud).host,
      origin: cloud,
      note: trusted ? null : "The Cobblr cloud does not take invites from other Cobblrs yet, so this link will not work there.",
    },
  ];
}

/** Boot refuses a destination the dialog would offer that could never pair:
 *  not this Cobblr, and not one of its trusted peers. */
export function destinationsProblem(here: string): string | null {
  const raw = (process.env.COBBLR_SHARE_INVITE_DESTINATIONS || "").trim();
  if (!raw || raw === "self") return null;
  let parsed: Array<{ label: string; origin: string }>;
  try {
    parsed = parseDestinations(raw);
  } catch {
    return `COBBLR_SHARE_INVITE_DESTINATIONS is not a list of Label=https://address entries: ${raw}`;
  }
  const ok = new Set([origin(here), ...trustedPeers()]);
  const bad = parsed.filter((d) => !ok.has(d.origin));
  return bad.length
    ? `COBBLR_SHARE_INVITE_DESTINATIONS names ${bad.map((d) => d.origin).join(", ")}, which is neither this Cobblr (PUBLIC_BASE_URL) nor in COBBLR_SHARE_TRUSTED_PEERS, so an invite opened there could never pair. Add it to COBBLR_SHARE_TRUSTED_PEERS or take it out.`
    : null;
}

/** Each destination's invite link, the same token for every one. */
export function inviteLinks(here: string, token: string): Array<InviteDestination & { url: string }> {
  return inviteDestinations(here).map((d) => ({ ...d, url: `${d.origin}/share/join#${token}` }));
}
