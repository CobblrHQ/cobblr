// What a stranger's browser shows when /try/start cannot give them a sandbox.
// The challenge page sends the browser straight to the API, so whatever the API
// answers IS the page: a JSON body there reads as broken software (#4848). Its
// own file, like the arrival and gone pages, so it renders in a test.
import { escHtml } from "../platform/esc-html.js";
import { productName } from "../platform/product-name.js";
import type { Request, Response } from "express";
import { brandHeaderCss, brandHeaderHtml } from "../lib/brand-header.js";

export type TryErrorKind = "captcha_failed" | "captcha_unavailable" | "sandbox_busy" | "unavailable";

export const TRY_ERROR_WORDS: Record<TryErrorKind, { title: string; line: string }> = {
  captcha_failed: {
    title: "We couldn't check you're human.",
    line: "Try again; if it keeps happening, it's on our side.",
  },
  // OUR problem, said as ours: never "you might be a bot".
  captcha_unavailable: {
    title: "Signups are briefly unavailable.",
    line: "That's on our side, not yours. Try again in a minute.",
  },
  sandbox_busy: {
    title: `A lot of people are trying ${productName()} right now.`,
    line: "Try again in a few minutes.",
  },
  unavailable: {
    title: "This isn't available right now.",
    line: "Try again in a minute.",
  },
};

export function tryErrorHtml(kind: TryErrorKind): string {
  const w = TRY_ERROR_WORDS[kind];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" /><title>${escHtml(productName())} - try again</title>
<style>
 body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:#F6F2EA;color:#2b3038;
      font:16px/1.55 Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
 main{flex:1;display:grid;place-items:center;padding:24px}
 .card{max-width:30rem;text-align:center}
 h1{font-size:1.6rem;color:#3D4451;margin:0 0 .6rem}
 p{margin:0 0 1.4rem;color:#5d5647}
 a{display:inline-block;border:2px solid #3D4451;border-radius:10px;padding:.7rem 1.3rem;
   background:#8B7355;color:#fff;font-weight:600;text-decoration:none;box-shadow:4px 4px 0 #3D4451}
 a.ghost{background:transparent;color:#3D4451;margin-left:.5rem}
 ${brandHeaderCss()}
</style></head><body>${brandHeaderHtml()}<main><div class="card">
<h1>${escHtml(w.title)}</h1><p>${escHtml(w.line)}</p>
<a href="/api/v1/try">Try again</a><a class="ghost" href="/?mode=signup">Make an account</a>
</div></main></body></html>`;
}

/** Answer a failure on a route the BROWSER navigates to: a page for a person,
 *  the JSON for anything else. A form or redirect that lands on raw JSON is a
 *  bug (scripts/lib/no-form-navigates-to-json.test.ts). */
export function tryFailure(req: Pick<Request, "accepts">, res: Response, status: number, code: TryErrorKind, message: string): void {
  if (req.accepts(["json", "html"]) === "html") {
    res.status(status).type("html").send(tryErrorHtml(code));
    return;
  }
  res.status(status).json({ error: { code, message } });
}

