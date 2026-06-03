// Template rendering for wire payloads. The user authors a template
// like "{{name}} · {{qty}} {{unit}}" or "Bin #{{set_id | default: ?}}".
//
// Why custom and not mustache/handlebars: this surface is intended
// for community-published bundles + per-tenant user authoring, so
// it has to be safe for untrusted input. The custom implementation:
//
//   1. Supports {{key}} substitution
//   2. Supports {{key | default: "fallback"}} for empty/missing values
//   3. Allows nested key paths via dotted notation: {{part.name}}
//   4. Does NOT execute arbitrary code, conditionals, or loops
//   5. HTML-encodes values so a template injected into a hostile
//      bundle can't smuggle script tags into the rendered output
//
// Upgrade path: if real users need conditionals/loops, we swap the
// implementation for mustache.js (logicless) or LiquidJS (Shopify's
// sandboxed templating). The render() function is the seam.

// Two filter shapes after the key:
//   {{ key | default: "fallback" }}   — value-or-fallback (the original)
//   {{ key | relative }}              — format a date/timestamp as
//                                       "in 3 days" / "2 days ago" / "today"
// The pattern captures the key, an optional `default:"…"` fallback, and an
// optional bare filter name (currently only `relative`). default + a bare
// filter are mutually exclusive in practice; the bare filter wins if both
// somehow appear.
const VAR_PATTERN =
  /\{\{\s*([a-z0-9_.]+)(?:\s*\|\s*default:\s*"((?:[^"\\]|\\.)*)"|\s*\|\s*([a-z_]+))?\s*\}\}/gi;

export interface RenderOptions {
  /** Enable the `| relative` date filter. Off by default so the wire /
   *  label rendering surface is unchanged; computed fields opt in. */
  relative?: boolean;
}

export function render(
  template: string,
  data: Record<string, unknown>,
  opts?: RenderOptions,
): string {
  return template.replace(
    VAR_PATTERN,
    (_match, key: string, fallback: string | undefined, filter: string | undefined) => {
      const v = resolvePath(data, key);
      if (filter === "relative" && opts?.relative) {
        const rel = relativeTime(v);
        return rel == null ? "" : escapeHtml(rel);
      }
      if (v == null || v === "") {
        return escapeHtml(unescapeDoubleQuoted(fallback ?? ""));
      }
      return escapeHtml(String(v));
    },
  );
}

/** Format a date-ish value as a coarse relative phrase. Accepts a Date,
 *  an ISO string, or epoch millis. Returns null for unparseable / empty
 *  input so the caller can render nothing. Granularity is day-level —
 *  computed fields are presentation, not stopwatches. */
export function relativeTime(value: unknown, nowMs = Date.now()): string | null {
  if (value == null || value === "") return null;
  let t: number;
  if (value instanceof Date) t = value.getTime();
  else if (typeof value === "number") t = value;
  else if (typeof value === "string") t = Date.parse(value);
  else return null;
  if (!Number.isFinite(t)) return null;
  const day = 86_400_000;
  const diffDays = Math.round((t - nowMs) / day);
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "tomorrow";
  if (diffDays === -1) return "yesterday";
  const n = Math.abs(diffDays);
  const unit = (count: number, label: string) =>
    `${count} ${label}${count === 1 ? "" : "s"}`;
  let phrase: string;
  if (n < 7) phrase = unit(n, "day");
  else if (n < 31) phrase = unit(Math.round(n / 7), "week");
  else if (n < 365) phrase = unit(Math.round(n / 30), "month");
  else phrase = unit(Math.round(n / 365), "year");
  return diffDays > 0 ? `in ${phrase}` : `${phrase} ago`;
}

/** Resolve a dotted key against a nested object. `a.b.c` → data.a.b.c.
 *  Stops at the first undefined link. */
function resolvePath(data: Record<string, unknown>, key: string): unknown {
  const parts = key.split(".");
  let cur: unknown = data;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Templates author defaults in JSON-like quoted strings. Unescape
 *  `\"` → `"` and `\\` → `\` so the user can include literal
 *  quotes inside the default value. */
function unescapeDoubleQuoted(s: string): string {
  return s.replace(/\\(.)/g, (_m, ch: string) => ch);
}
