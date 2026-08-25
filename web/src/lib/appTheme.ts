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
import { isSafeFontUrl } from "@cobblr/platform-contract/safe-font-url";
import type { AppTheme } from "./api";

// The @font-face safety predicate lives in the contract so the write sites
// (portal + core-apps theme routes) enforce the SAME rule — one source, no
// drift. Re-exported here for the render-side tests + callers.
export { isSafeFontUrl };

export const FONT_STACKS: Record<NonNullable<AppTheme["font"]>, string> = {
  sans: "ui-sans-serif, system-ui, -apple-system, sans-serif",
  serif: "ui-serif, Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
  rounded: "'SF Pro Rounded', 'Nunito', 'Segoe UI', system-ui, sans-serif",
  slab: "'Rockwell', 'Roboto Slab', Georgia, serif",
};
export const CUSTOM_FONT_FAMILY = "cobblr-app-font";

// A custom (uploaded/hosted) font wins over the keyword stack. Two guards:
// (1) it can't break out of the CSS `url("…")` string (no quotes/newlines/
// backslashes — data: URLs are base64, normal URLs don't carry these), and
// (2) it can only point at a safe origin (isSafeFontUrl) so a workspace admin
// can't turn the theme into an off-site tracking beacon.
export function customFontUrl(t?: AppTheme | null): string | null {
  if (!t?.font_url || /["\\\n\r]/.test(t.font_url)) return null;
  if (!isSafeFontUrl(t.font_url)) return null;
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

// ── Admin-shell brand → semantic tokens ─────────────────────────────
// The admin UI is built on the semantic role tokens (bg-surface,
// text-content, border-line, …) defined in tailwind.config + index.css
// :root. Those are CSS-variable-backed, so branding the dashboard is just
// overriding the `--c-*` vars — no `!important`, no per-class remap, no
// drift. AppLayout sets these (as `R G B` triplets, for `<alpha-value>`)
// on `<html>` when a workspace `admin_theme` is set; on <html> so they
// also reach modals/toasts that portal to <body>. We publish the `--app-*`
// hex vars too, for the few inline `var(--app-*)` uses in the shell
// (accent strip, logo border). Button fills + form inputs stay neutral
// (their own non-semantic classes) so actions read on any palette.
function hexTriplet(hex: string): string {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}
/** The CSS custom properties to set on `<html>` to brand the admin shell.
 *  Returns null when unthemed (caller leaves :root defaults in place). */
export function adminHtmlVars(t?: AppTheme | null): Record<string, string> | null {
  if (!t) return null;
  const tri = (hex: string | undefined, fb: string) => hexTriplet(hex ?? fb);
  return {
    // Semantic role tokens (triplets) — the workspace has one of each,
    // so the dashboard's shade tiers collapse onto them when themed.
    "--c-surface": tri(t.surface, "#ffffff"),
    "--c-canvas": tri(t.bg, "#f4f2ee"),
    "--c-subtle": tri(t.surface, "#ffffff"),
    "--c-content": tri(t.text, "#334155"),
    "--c-muted": tri(t.muted, "#8a94a6"),
    "--c-faint": tri(t.muted, "#8a94a6"),
    "--c-line": tri(t.border, "#e2e8f0"),
    "--c-accent": tri(t.accent, "#3b82f6"),
    // Hex vars for inline var(--app-*) uses in the shell.
    "--app-bg": t.bg ?? "#f4f2ee",
    "--app-surface": t.surface ?? "#ffffff",
    "--app-text": t.text ?? "#334155",
    "--app-muted": t.muted ?? "#8a94a6",
    "--app-accent": t.accent ?? "#3b82f6",
    "--app-accent-text": t.accent_text ?? "#ffffff",
    "--app-border": t.border ?? "#e2e8f0",
    "--app-radius": `${t.radius ?? 12}px`,
  };
}
