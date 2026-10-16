import { productName } from "../platform/product-name.js";
import { escHtml } from "../platform/esc-html.js";
// The brand header for pages the api serves straight to a visitor's browser:
// the sandbox arrival page, the hour-is-up page, anything else a stranger can
// land on outside the React shell.
//
// Those pages used to carry nothing recognisable: a cream background, a
// heading, a sentence. A visitor who had just left cobblr.xyz saw none of its
// mark, wordmark or header at the exact moment they were deciding whether the
// thing was real (#3267). This is that header, drawn the way the marketing
// site draws it, so the hand-off looks like one product.
//
// The mark's geometry is the four polygons of web/src/CobblestoneMark.tsx. The
// api cannot import a React component, so it is repeated here on purpose; if
// the mark ever changes, change both and the brand kit.

export function cobblestoneMarkSvg(size = 26): string {
  return (
    `<svg viewBox="0 0 100 100" width="${size}" height="${size}" aria-hidden="true">` +
    `<polygon points="8,12 38,8 44,38 30,46 10,40" fill="#3D4451"/>` +
    `<polygon points="52,10 88,16 92,40 70,46 50,32" fill="#8B7355"/>` +
    `<polygon points="10,52 32,50 36,82 18,90 6,76" fill="#6B8E4E"/>` +
    `<polygon points="46,56 78,52 92,72 84,90 54,86" fill="#A48663"/>` +
    `</svg>`
  );
}

/** Mark + wordmark, linking back to the site the visitor came from. */
export function brandHeaderHtml(): string {
  const home = productName() === "Cobblr" ? "https://cobblr.xyz" : "/"; // PRODUCT-NAME: The default product links to its own site; other products stay on their server.
  return (
    `<header class="brand"><a href="${home}" aria-label="${escHtml(productName())}">` +
    cobblestoneMarkSvg(26) +
    `<span class="wordmark">${escHtml(productName())}</span></a></header>`
  );
}

/** The header's styling, matching cobblr.xyz's own .nav / .brand / .wordmark.
 *  Pages that set a generic a{} button style must include this AFTER it: the
 *  .brand a selector outranks a bare a, and resets the button treatment. */
export function brandHeaderCss(): string {
  return (
    `.brand{display:flex;align-items:center;padding:12px 22px;border-bottom:1px solid #cabfa9;background:#F6F2EA}` +
    `.brand a{display:flex;align-items:center;gap:9px;text-decoration:none;border:0;border-radius:0;padding:0;margin:0;background:transparent;box-shadow:none;color:#3D4451}` +
    `.brand svg{display:block;flex:none}` +
    `.wordmark{font-weight:800;font-size:1.3rem;letter-spacing:-.04em;color:#3D4451}`
  );
}
