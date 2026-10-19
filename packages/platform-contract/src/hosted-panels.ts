import type { OrgRoleName } from "@cobblr/platform-contract/org-roles";

// ── Hosted settings panels ───────────────────────────────────────────────────
// Lets a module/overlay contribute a SETTINGS PAGE to the web app WITHOUT
// shipping any frontend code into the open-core web bundle. The overlay returns
// a small DECLARATIVE view (text / status / buttons / a select) + handles the
// actions; the open-core web app renders it with one generic renderer. Open core
// registers no panels, so a self-hoster sees nothing — none of the panel's
// labels, logic, or even its name exist in core. Used for the hosted-only
// billing + Slack panels, which therefore live entirely in the closed overlay.

export type HostedPanelBlock =
  | { kind: "text"; text: string; tone?: "muted" | "warning" }
  | { kind: "status"; label: string; value: string; active?: boolean }
  // A text field. Its current value is collected by `key` and submitted together
  // when a `kind:"button"` with `submit:true` is clicked (input values arrive on
  // runAction's `input.values`). `secret:true` renders a password field and the
  // panel should not echo the stored value back.
  | { kind: "input"; key: string; label: string; placeholder?: string; secret?: boolean; value?: string }
  | {
      kind: "button";
      label: string;
      action: string;
      style?: "primary" | "default" | "danger";
      confirm?: string;
      /** Gather every input block's value and pass them as `input.values`. */
      submit?: boolean;
    }
  | {
      kind: "select";
      label: string;
      action: string;
      value: string | null;
      options: Array<{ value: string; label: string }>;
      placeholder?: string;
      hint?: string;
    };
export interface HostedPanelView {
  blocks: HostedPanelBlock[];
}
/** What a button/select action returns: optionally redirect the browser (OAuth /
 *  checkout), re-fetch the view, and/or show a toast. */
export interface HostedPanelActionResult {
  redirect?: string;
  refresh?: boolean;
  toast?: string;
}
export interface HostedPanelContext {
  orgId: string;
  userId: string;
  slug: string;
  /** The caller's role in the workspace. The kernel has already refused
   *  anyone below the panel's `minRole`; a panel may narrow further. */
  role: string;
}
export interface HostedPanel {
  /** URL segment + key, e.g. "billing", "slack". */
  id: string;
  label: string;
  /** Generic icon NAME (e.g. "credit-card"); the web maps a small allowlist. */
  icon?: string;
  group?: "modules" | "data" | "access" | "extend" | "admin";
  /** The least role that may see and use the panel. Unset means owner or
   *  admin: a settings panel is configuration unless it says otherwise. */
  minRole?: Exclude<OrgRoleName, "guest">;
  getView(ctx: HostedPanelContext): Promise<HostedPanelView>;
  runAction(
    ctx: HostedPanelContext,
    action: string,
    input?: { value?: string | null; values?: Record<string, string> },
  ): Promise<HostedPanelActionResult>;
}
export interface HostedPanelSummary {
  id: string;
  label: string;
  icon?: string;
  group?: string;
}
export interface PlatformHostedPanels {
  /** Hosted overlay registers a settings panel. Last registration per id wins. */
  register(panel: HostedPanel): void;
  /** Summaries for building tiles/routes (no handlers). Empty in open core. */
  list(): HostedPanelSummary[];
  get(id: string): HostedPanel | undefined;
}
