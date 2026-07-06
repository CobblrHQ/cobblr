// Guard: a JSX element must not set an inline `style` for a property that a CSS
// ID-selector rule ALSO sets for that same `id`. Inline styles beat stylesheet
// rules (short of !important), so this is a SILENT override — and when the CSS
// rule is state/mode-conditional (e.g. `html[data-nav-fullside] #cobblr-toasts
// { bottom: ... }`), the inline value quietly breaks that variant in the mode a
// single-mode test never exercises. That's exactly the regression that shipped
// in #762: an inline `style={{ bottom }}` on #cobblr-toasts clobbered the
// full-sidebar rail positioning. A property has ONE owner — CSS or inline,
// never both — for an id-targeted element.
//
// Precise + low-false-positive, and text-based like the other lints (no web deps
// imported, no build needed):
//   - CSS side: every rule whose selector contains an `#id` contributes the
//     properties it declares to that id. @media / plain rules both count; only
//     ID selectors matter (that's the specificity trap — Tailwind utility CLASSES
//     are lower-specificity and lose to the id rule, so an inline value is the
//     ONLY thing that silently wins, and the only thing flagged).
//   - JSX side: scan starts from each STATIC `id="literal"` (rare, so cheap +
//     robust), finds the enclosing tag, and reads its inline `style={{ ... }}`
//     object keys. Dynamic ids, `style={someVar}`, and spreads are skipped
//     rather than guessed.
//   - Flags only when the SAME property (camelCase normalised to kebab) collides.
//
// Run: npx tsx scripts/lint-inline-style-overrides.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const TSX_ROOTS = ["web/src", "packages"]; // .tsx that may reference the global-css ids
const CSS_ROOTS = ["web/src"]; // global css whose id selectors own properties

function walk(dir: string, ext: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist" || e === ".vite") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

const stripComments = (css: string) => css.replace(/\/\*[^]*?\*\//g, "");
const camelToKebab = (k: string) => (k.startsWith("--") ? k : k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()));

// ── 1. CSS: id -> (prop -> an example selector that sets it) ──
// A rule is `<selector> { <decls> }`; decl bodies never contain braces, so a
// selector-with-#id followed by a brace-free body is matched directly. This also
// picks up id rules nested in @media (the inner `#id { … }` still matches).
const cssOwned = new Map<string, Map<string, string>>();
for (const rootRel of CSS_ROOTS) {
  for (const file of walk(resolve(ROOT, rootRel), ".css")) {
    const css = stripComments(readFileSync(file, "utf8"));
    for (const m of css.matchAll(/([^{}]*#[A-Za-z][\w-]*[^{}]*)\{([^{}]*)\}/g)) {
      const selector = m[1].trim();
      const ids = [...selector.matchAll(/#([A-Za-z][\w-]*)/g)].map((x) => x[1]);
      if (ids.length === 0) continue;
      const props = m[2]
        .split(";")
        .map((d) => d.split(":")[0]?.trim().toLowerCase())
        .filter((p): p is string => !!p);
      for (const id of ids) {
        const map = cssOwned.get(id) ?? new Map<string, string>();
        for (const p of props) if (!map.has(p)) map.set(p, selector);
        cssOwned.set(id, map);
      }
    }
  }
}

// ── 2. JSX: from each static id="literal" that CSS owns, read the same tag's
//         inline style keys ──
interface Hit { file: string; line: number; id: string; prop: string; sel: string }
const hits: Hit[] = [];
const ID_RE = /\bid\s*=\s*(?:"([^"]+)"|\{\s*"([^"]+)"\s*\})/g;

// Find the enclosing opening-tag substring for a position inside it: back to the
// nearest "<", forward to the ">" that closes the tag at attribute-brace-depth 0
// (so a `style={{…}}` object's inner "}" and any ">" inside it don't end it early).
function enclosingTag(src: string, at: number): string | null {
  const lt = src.lastIndexOf("<", at);
  if (lt === -1) return null;
  let depth = 0;
  for (let i = lt + 1; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
    else if (c === ">" && depth === 0) return src.slice(lt, i + 1);
  }
  return null;
}

// Keys of the FIRST `style={{ … }}` object literal in a tag (brace-matched).
function styleKeys(tag: string): string[] {
  const s = tag.search(/\bstyle\s*=\s*\{\{/);
  if (s === -1) return [];
  const open = tag.indexOf("{{", s);
  let depth = 0, end = -1;
  for (let i = open + 1; i < tag.length; i++) {
    if (tag[i] === "{") depth++;
    else if (tag[i] === "}") { if (depth === 0) { end = i; break; } depth--; }
  }
  if (end === -1) return [];
  const body = tag.slice(open + 2, end); // inside the outer {{ }}
  const keys: string[] = [];
  // top-level `key:` or `"key":` only — splitTopLevel keeps nested objects intact
  for (const seg of splitTopLevel(body)) {
    const km = seg.match(/^\s*(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/);
    if (km) keys.push((km[1] ?? camelToKebab(km[2]!)).toLowerCase());
  }
  return keys;
}

// Split an object-literal body on top-level commas only.
function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) { out.push(body.slice(start, i)); start = i + 1; }
  }
  out.push(body.slice(start));
  return out;
}

const lineAt = (src: string, idx: number) => src.slice(0, idx).split("\n").length;

for (const rootRel of TSX_ROOTS) {
  for (const file of walk(resolve(ROOT, rootRel), ".tsx")) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(ID_RE)) {
      const id = m[1] ?? m[2]!;
      const owned = cssOwned.get(id);
      if (!owned) continue;
      const tag = enclosingTag(src, m.index!);
      if (!tag) continue;
      for (const k of styleKeys(tag)) {
        if (owned.has(k)) {
          hits.push({ file: file.slice(ROOT.length + 1), line: lineAt(src, m.index!), id, prop: k, sel: owned.get(k)! });
        }
      }
    }
  }
}

// ── 3. report ──
if (hits.length === 0) {
  console.log("[lint:inline-overrides] ✓ no inline styles override a CSS id rule");
  process.exit(0);
}
console.error(`[lint:inline-overrides] ${hits.length} inline style(s) override a CSS id-selector rule:\n`);
for (const h of hits) {
  console.error(`  ${h.file}:${h.line}`);
  console.error(`    #${h.id} — inline style sets "${h.prop}", but CSS rule \`${h.sel}\` also sets it.`);
  console.error(`    Inline wins silently and breaks that rule (esp. state/mode variants). Move the value into CSS, or drop the CSS rule.\n`);
}
process.exit(1);
