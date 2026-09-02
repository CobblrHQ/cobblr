// The reading column for /me — your account's pages.
//
// This is the same fix Configuration got in the 2026-07 revamp, applied to the
// area that revamp did not reach. Nine /me pages each set their own wrapper and
// the result was five widths and three centring behaviours: max-w-xl, max-w-2xl,
// max-w-3xl and two pages with none, and five of the nine set a width without
// mx-auto, so they pinned to the left of AppLayout's already-centred region and
// left a void down the right on a wide screen. Nobody chose that; each page
// copied whichever neighbour was open at the time, which is exactly the failure
// CONFIG_COLUMN's comment describes ("six of them and both alignments").
//
// So the column lives HERE and the LAYOUT applies it. A page renders its
// content. That is the part that makes it stay fixed: a per-page wrapper is a
// decision every new page gets to make again, and re-making it is how the drift
// happened the first time.

import type { LucideIcon } from "lucide-react";
import { Bell, History, LayoutList, MessageSquare, Monitor, Moon, Plug, Printer, UserCog } from "lucide-react";

/** The reading column. Same measure as Configuration, so moving between
 *  "your account" and "this workspace" does not move the text. */
export const ACCOUNT_COLUMN = "w-full max-w-4xl mx-auto";
/** For a long list or a table that a reading column would squeeze. */
export const ACCOUNT_COLUMN_WIDE = "w-full max-w-6xl mx-auto";

/** Width is a pair, not a flag: choosing the wide column obliges you to say
 *  what needs the room. Modelled as a union so TypeScript refuses
 *  `width: "wide"` without a reason — the same shape Configuration uses,
 *  because "wide" started there as a judgement call and decayed into a
 *  default. A reason you have to type is a reason you have to have. */
type AccountWidth =
  | { width?: undefined; wideBecause?: never }
  | { width: "wide"; wideBecause: string };

export type AccountPage = { to: string } & AccountWidth;

/** Every page under /me, and how wide it reads. Longest path first is not
 *  required — the lookup below prefers the longest match, so /me does not
 *  swallow /me/activity. */
export const ACCOUNT_PAGES: AccountPage[] = [
  // "/me/s/<section>" needs no entry: the longest-prefix lookup gives it the
  // "/me" column, which is the inheritance the tests pin.
  { to: "/me" },
  { to: "/me/identity" },
  { to: "/me/appearance" },
  { to: "/me/app-settings" },
  { to: "/me/connections" },
  { to: "/me/printer" },
  { to: "/me/communication" },
  {
    to: "/me/notification-channels",
    width: "wide",
    wideBecause: "a bindings table: channel, event type, priority and per-workspace routing on one row each",
  },
  { to: "/me/drive" },
  { to: "/me/feedback" },
  {
    to: "/me/activity",
    width: "wide",
    wideBecause: "a dense log: timestamp, actor, action and target on one line each, which wraps to three lines in the reading column",
  },
  {
    to: "/me/notifications",
    width: "wide",
    wideBecause: "a list of notifications with their own timestamps and per-row actions, read by scanning rather than by reading",
  },
];

/** The sections of "Your account", mirroring Configuration's five cards.
 *
 *  The old /me was three big open forms (identity, password, appearance) with
 *  five one-line links underneath. The forms took the whole screen for settings
 *  you change once a year, and the links - the things people actually came for
 *  - were a row of small text at the bottom that nobody found. Configuration
 *  had the same problem and solved it with sections you navigate into; this is
 *  the same fix, so the two halves of settings work the same way.
 *
 *  Same rules as configuration-nav: a destination is a place you GO, leaves
 *  keep the product's existing nouns, and grouping is by the ACT. */
export type AccountSection = "you" | "notifications" | "connections" | "history";

export interface AccountSectionMeta {
  label: string;
  /** One line: what act this section serves. */
  blurb: string;
  icon: LucideIcon;
  /** This section's ONE primary do, if it has earned one. Same {label,to} shape
   *  as the card prop deliberately - see configuration-revamp.md § Section
   *  actions, where typing it as a bare string is what left Configuration's
   *  first action rendering a control that went nowhere. */
  action?: { label: string; to: string };
}

export const ACCOUNT_SECTIONS: Record<AccountSection, AccountSectionMeta> = {
  you: {
    label: "You",
    blurb: "Who you are, how you sign in, and how the app looks.",
    icon: UserCog,
  },
  notifications: {
    label: "Notifications",
    blurb: "What reaches you, and by which route.",
    icon: Bell,
  },
  connections: {
    label: "Connections",
    blurb: "Services and devices of your own that follow you between workspaces.",
    icon: Plug,
    // The one account section with a standing "I want to add one" intent: you
    // arrive meaning to plug in your own AI key. Notifications has an add flow
    // too (Add binding) and deliberately does NOT get a button — a per-workspace
    // routing table is something you go and manage, not something you arrive
    // wanting to create. The bar is the four tests in the design doc, and
    // "it has a create form" is not one of them.
    action: { label: "+ Add a connection", to: "/me/connections/new" },
  },
  history: {
    label: "History",
    blurb: "What you have done, and what you have asked for.",
    icon: History,
  },
};

export interface AccountDestination {
  label: string;
  description: string;
  to: string;
  section: AccountSection;
  icon: LucideIcon;
  /** Hidden inside a locked managed app ("Cobblr for Yarn"), which hides the
   *  platform: a single-app consumer needs their name, their password and how
   *  they are reached, not cross-workspace history or BYO-AI keys. Declared per
   *  destination rather than as a block of JSX around half the list, so adding
   *  a leaf means answering the question. */
  platformOnly?: boolean;
}

/** Every leaf under "Your account". Identity, password and appearance are
 *  destinations now rather than forms stacked on the hub. */
export const ACCOUNT_DESTINATIONS: AccountDestination[] = [
  { label: "Identity & password", description: "Your display name, the address you sign in with, and your password.", to: "/me/identity", section: "you", icon: UserCog },
  { label: "Appearance", description: "Light or dark, and your desktop layout - for your account and for this device.", to: "/me/appearance", section: "you", icon: Moon },
  { label: "Menu & surfaces", description: "Hide the parts of the app you do not use.", to: "/me/app-settings", platformOnly: true, section: "you", icon: LayoutList },
  { label: "Communication preferences", description: "Whether Cobblr reaches you in-app, by Discord DM, or by email.", to: "/me/communication", section: "notifications", icon: Bell },
  { label: "Notification channels", description: "Per-workspace Discord, Slack, email, SMS and webhook routes.", to: "/me/notification-channels", platformOnly: true, section: "notifications", icon: Bell },
  { label: "Your notifications", description: "Everything Cobblr has sent you.", to: "/me/notifications", platformOnly: true, section: "notifications", icon: Bell },
  { label: "Connections", description: "Your own AI keys and edge bridge, shared with the workspaces you choose.", to: "/me/connections", platformOnly: true, section: "connections", icon: Plug },
  // NOT platformOnly: a locked home app prints labels from the camera, and this
  // is the only door inside its surface where a Bluetooth printer can be paired
  // (Configuration → Devices is outside it).
  { label: "Label printer", description: "Pair a Bluetooth label printer with this phone or computer, and test it.", to: "/me/printer", section: "connections", icon: Printer },
  { label: "Browser driving", description: "Let the assistant drive the app you have open. Per workspace, off by default.", to: "/me/drive", platformOnly: true, section: "connections", icon: Monitor },
  { label: "Your activity", description: "What you have done, across every workspace you belong to.", to: "/me/activity", platformOnly: true, section: "history", icon: History },
  { label: "Your feedback", description: "What you have reported, and where it got to.", to: "/me/feedback", platformOnly: true, section: "history", icon: MessageSquare },
];

export const ACCOUNT_SECTION_ORDER: AccountSection[] = ["you", "notifications", "connections", "history"];

/** The destinations a given user can see, grouped into their sections, with
 *  empty sections dropped — so a locked managed app shows two cards rather than
 *  four, two of them empty. */
export function accountSections(opts: { appMode: boolean }): Array<{
  id: AccountSection;
  meta: AccountSectionMeta;
  items: AccountDestination[];
}> {
  return ACCOUNT_SECTION_ORDER.map((id) => ({
    id,
    meta: ACCOUNT_SECTIONS[id],
    items: ACCOUNT_DESTINATIONS.filter(
      (d) => d.section === id && !(opts.appMode && d.platformOnly),
    ),
  })).filter((s) => s.items.length > 0);
}

/** The column for a path under /me. Longest declared prefix wins, so a nested
 *  route inherits its parent's choice instead of silently reverting. */
export function accountColumnFor(pathname: string): string {
  const hit = ACCOUNT_PAGES.filter(
    (p) => pathname === p.to || pathname.startsWith(`${p.to}/`),
  ).sort((a, b) => b.to.length - a.to.length)[0];
  return hit?.width === "wide" ? ACCOUNT_COLUMN_WIDE : ACCOUNT_COLUMN;
}
