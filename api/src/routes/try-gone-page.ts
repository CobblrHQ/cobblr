// The page a visitor sees when their sandbox link no longer opens: the hour
// ran out, the link was replaced when they added an email, or it was never
// ours. Its own file, like the arrival page, so it renders in a test without
// booting the router.
import { brandHeaderCss, brandHeaderHtml } from "../lib/brand-header.js";

export function goneHtml(reason: "expired" | "unknown" | "revoked"): string {
  const line =
    reason === "expired"
      ? "That sandbox has expired. They only last an hour, which is on purpose - nothing you did is still sitting on our server."
      : reason === "revoked"
        ? "That link was replaced when you added your email. Use the link we sent you instead."
        : "We do not recognise that link. It may have expired and been cleaned up.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" /><title>Cobblr - sandbox ended</title>
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
<h1>Your hour is up.</h1><p>${line}</p>
<a href="/api/v1/try">Start another</a><a class="ghost" href="/?mode=signup">Make an account</a>
</div></main></body></html>`;
}
