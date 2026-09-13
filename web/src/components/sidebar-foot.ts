// The order of the full-sidebar foot, as data.
//
// The foot is two clusters divided by a rule. TOOLS first, capture at the top:
// the Scan Inbox row above already says how much is waiting, so the tool that
// feeds it is the first thing under the nav, on its own full-width row, with
// Build under it (it used to share a half-width row with Scan, which hid the
// most-used action inside the least-used one). Then Search, Notifications, the
// label queue, the Live box, Ask Cobb. Below the rule the META rows: Feedback
// ("reach the makers", which used to head the foot and pushed every tool down
// a row), Configuration, Your account, and the account accordion last, where a
// person expects to find themselves.
//
// AppLayout renders from this list; sidebar-foot.test.ts holds the shape. So
// the order is a fact in one place, and a "quick swap" of two rows has to say
// so here rather than happen inside a 70-line JSX block.

export const SIDEBAR_FOOT_ORDER = [
  /** The simple-mode exit and the verify-email card: notices, never tools. */
  "notices",
  /** The module quick-actions, one full row each, capture first (see
   *  orderHeaderActions). */
  "actions",
  "search",
  "notifications",
  /** The label queue; renders nothing while it is empty. */
  "labels",
  /** Ongoing session modes; self-hides without a live capability. */
  "live",
  "cobb",
  "divider",
  "feedback",
  "configuration",
  "account",
  "account-menu",
] as const;

export type SidebarFootSlot = (typeof SIDEBAR_FOOT_ORDER)[number];

/** The slots a person uses to DO something in the workspace. */
export const SIDEBAR_FOOT_TOOLS: readonly SidebarFootSlot[] = [
  "actions",
  "search",
  "notifications",
  "labels",
  "live",
  "cobb",
];

/** The slots about the person and the app, not the work. */
export const SIDEBAR_FOOT_META: readonly SidebarFootSlot[] = [
  "feedback",
  "configuration",
  "account",
  "account-menu",
];
