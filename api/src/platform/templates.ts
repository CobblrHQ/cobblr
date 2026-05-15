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

const VAR_PATTERN = /\{\{\s*([a-z0-9_.]+)(?:\s*\|\s*default:\s*"((?:[^"\\]|\\.)*)")?\s*\}\}/gi;

export function render(template: string, data: Record<string, unknown>): string {
  return template.replace(VAR_PATTERN, (_match, key: string, fallback: string | undefined) => {
    const v = resolvePath(data, key);
    if (v == null || v === "") {
      return escapeHtml(unescapeDoubleQuoted(fallback ?? ""));
    }
    return escapeHtml(String(v));
  });
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
