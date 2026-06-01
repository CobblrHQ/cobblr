// Shared per-surface theme → CSS-variable helpers. Originally inline in
// AppPlayerPage; extracted so the member portal/launcher can wear the
// SAME token theme as an app (worker-navigation-and-identity.md §4 — the
// per-workspace portal is the builder's, so it carries the builder's
// brand, not Cobblr's). An unthemed surface passes `null` and every
// helper returns `undefined` → renders byte-identical to before.
//
// We publish `--app-*` vars on a wrapper and read them via inline styles
// (inline wins over Tailwind defaults, so no per-element class surgery /
// no !important). Tokens only — never raw CSS — so a hand-/AI-authored
// theme can restyle but can't inject a stylesheet.

import type { CSSProperties } from "react";
import type { AppTheme } from "./api";

export const FONT_STACKS: Record<NonNullable<AppTheme["font"]>, string> = {
  sans: "ui-sans-serif, system-ui, -apple-system, sans-serif",
  serif: "ui-serif, Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
  rounded: "'SF Pro Rounded', 'Nunito', 'Segoe UI', system-ui, sans-serif",
  slab: "'Rockwell', 'Roboto Slab', Georgia, serif",
};
export const CUSTOM_FONT_FAMILY = "cobblr-app-font";

// A custom (uploaded/hosted) font wins over the keyword stack. Guard the
// URL so it can't break out of the CSS `url("…")` string (data: URLs are
// base64; normal URLs don't contain quotes/newlines).
export function customFontUrl(t?: AppTheme | null): string | null {
  if (!t?.font_url || /["\\\n\r]/.test(t.font_url)) return null;
  return t.font_url;
}
export function fontFaceCss(t?: AppTheme | null): string | null {
  const url = customFontUrl(t);
  return url
    ? `@font-face{font-family:'${CUSTOM_FONT_FAMILY}';src:url("${url}");font-display:swap}`
    : null;
}
/** Just the `--app-*` CSS variables — no background/color/font. Publish
 *  these on a wrapper to expose the palette to child *Style helpers
 *  WITHOUT forcing the wrapper's own text colour or font (the admin shell
 *  uses this so a chrome brand can tint the background + accent without
 *  restyling every element's text/typography). */
export function themeVars(t?: AppTheme | null): CSSProperties | undefined {
  if (!t) return undefined;
  return {
    "--app-bg": t.bg ?? "#f4f2ee",
    "--app-surface": t.surface ?? "#ffffff",
    "--app-text": t.text ?? "#334155",
    "--app-muted": t.muted ?? "#8a94a6",
    "--app-accent": t.accent ?? "#3b82f6",
    "--app-accent-text": t.accent_text ?? "#ffffff",
    "--app-border": t.border ?? "#e2e8f0",
    "--app-radius": `${t.radius ?? 12}px`,
  } as CSSProperties;
}
export function themeWrapperStyle(t?: AppTheme | null): CSSProperties | undefined {
  if (!t) return undefined;
  const fontFamily = customFontUrl(t)
    ? `'${CUSTOM_FONT_FAMILY}', ui-sans-serif, system-ui, sans-serif`
    : t.font
      ? FONT_STACKS[t.font]
      : undefined;
  return { ...themeVars(t), background: "var(--app-bg)", color: "var(--app-text)", fontFamily };
}
export const cardStyle = (t?: AppTheme | null): CSSProperties | undefined =>
  t ? { background: "var(--app-surface)", borderColor: "var(--app-border)", borderRadius: "var(--app-radius)", color: "var(--app-text)" } : undefined;
export const accentStyle = (t?: AppTheme | null): CSSProperties | undefined =>
  t ? { color: "var(--app-accent)" } : undefined;
export const mutedStyle = (t?: AppTheme | null): CSSProperties | undefined =>
  t ? { color: "var(--app-muted)" } : undefined;
export const textStyle = (t?: AppTheme | null): CSSProperties | undefined =>
  t ? { color: "var(--app-text)" } : undefined;
// Tailwind `prose` colours its children via its own --tw-prose-* vars, so
// a plain `color` won't reach the markdown heading/body. Override the prose
// vars too, so themed markdown renders in the app's text colour.
export const proseStyle = (t?: AppTheme | null): CSSProperties | undefined =>
  t
    ? ({
        color: "var(--app-text)",
        "--tw-prose-body": "var(--app-text)",
        "--tw-prose-headings": "var(--app-text)",
        "--tw-prose-bold": "var(--app-text)",
        "--tw-prose-links": "var(--app-accent)",
      } as CSSProperties)
    : undefined;
export const btnStyle = (t?: AppTheme | null): CSSProperties | undefined =>
  t ? { background: "var(--app-accent)", color: "var(--app-accent-text)", borderColor: "transparent", borderRadius: "var(--app-radius)" } : undefined;

// ── Admin-shell full recolor (chrome → whole dashboard) ──────────────
// The admin UI hard-codes its palette as Tailwind utility classes
// (bg-white, text-slate-700, border-slate-200, …) across hundreds of
// components — too many to migrate to semantic tokens by hand. Instead,
// when a workspace sets `admin_theme`, we publish the `--app-*` vars on
// <html data-ws-themed> and inject THIS scoped stylesheet, which remaps
// the structural utilities the admin UI actually uses (measured by
// frequency) onto those vars. Scoped to `[data-ws-themed]`, so it's inert
// for unthemed workspaces and for the login/portal surfaces; because the
// marker sits on <html>, it also reaches modals/toasts that portal to
// <body>. `!important` beats the utility's own rule (and Tailwind's dark:
// variants, which we list explicitly so dark-mode users theme too).
//
// Deliberately NOT remapped: button fills (bg-slate-700 / bg-cobble-600)
// — leaving them keeps actions legible on an arbitrary palette; that's
// the seam where the future semantic-token migration takes over.
const ADMIN_RECOLOR: Array<[string[], string]> = [
  [["bg-white", "dark:bg-slate-900", "bg-slate-50", "bg-slate-100"], "background-color:var(--app-surface)"],
  [["bg-mortar", "bg-mortar-50", "dark:bg-slate-800"], "background-color:var(--app-bg)"],
  [["text-slate-700", "text-slate-600", "dark:text-mortar-100", "dark:text-mortar-200"], "color:var(--app-text)"],
  [["text-slate-400", "text-slate-500", "dark:text-slate-400", "dark:text-slate-500"], "color:var(--app-muted)"],
  [["border-slate-200", "border-slate-300", "border-slate-100", "dark:border-slate-700", "dark:border-slate-800"], "border-color:var(--app-border)"],
  [["divide-slate-200", "dark:divide-slate-700", "dark:divide-slate-800"], "border-color:var(--app-border)"],
  [["text-cobble-600", "text-cobble-500", "text-cobble-400"], "color:var(--app-accent)"],
];
export function adminShellCss(t?: AppTheme | null): string | null {
  if (!t) return null;
  const esc = (c: string) => "[data-ws-themed] ." + c.replace(/:/g, "\\:");
  return ADMIN_RECOLOR.map(([classes, decl]) => `${classes.map(esc).join(",")}{${decl} !important}`).join("");
}
