// The page a stranger lands on when they open /try in a browser.
//
// GET /try needs a captcha token, and until now the only thing that could
// produce one was the marketing site's button. That made the endpoint useless
// on its own: a human opening the link got a raw JSON 400, which reads as
// broken software rather than as a challenge. The link has to work by itself -
// it gets pasted into chats, typed off a slide, opened from a QR code.
//
// So the api draws the widget itself and submits as soon as it solves. Managed
// Turnstile passes most visitors without a click, so the usual experience is
// this page flashing by.
//
// When it does NOT pass, the page has to say so. The first version listened
// only for success: on a failure the widget showed its own small "Verification
// failed" while the heading kept saying "Setting up your sandbox", and nothing
// else was offered (review finding USE-01). A private window, an extension, a
// slow connection or an automated browser all land here. So the failure and
// expiry callbacks are wired too, the heading changes to say what happened,
// and two ways on are offered: a fresh challenge, or the ordinary signup.
// Neither bypasses the captcha; the token only ever comes from a pass.
//
// No-JS is a real ending, not a dead end: the form posts nothing, so the page
// says what happened and offers the ordinary signup instead.
//
// Lives in its own file so the page can be rendered and its script exercised
// in a test without booting the router (which needs a database).
//
// THIS PAGE OWNS ITS OWN CONTENT-SECURITY-POLICY (#3434), and it has to. The
// app's policy is `script-src 'self'`, on its way from report-only to enforced
// (#3300). This page needs four things that policy forbids: Turnstile's script
// from challenges.cloudflare.com, a second script it loads from there, an
// INLINE script of ours, and a frame of challenges.cloudflare.com; the widget
// also calls home to two Cloudflare hosts. Walking try.cobblr.xyz on
// 2026-09-22 found all of it in the report-only log -- harmless today, and the
// moment the policy is enforced NOBODY CAN GET A SANDBOX: not from the button,
// not from the QR code at a stand, not from a pasted link. The token only ever
// comes from a Turnstile pass, by design.
//
// So the widened policy lives HERE, next to the widget that needs it, rather
// than in the app's policy where it would open Cloudflare's origin for every
// page of the product. The inline script gets a per-request NONCE, not a hash:
// a hash pins the exact bytes of a script that carries prose comments, so the
// next edit to it silently closes the door again. `startPolicy(nonce)` is what
// the route sends, and `startHtml(siteKey, nonce)` stamps the same nonce onto
// the script tag -- one value, two places, from one call.
import { randomBytes } from "node:crypto";
import { brandHeaderCss, brandHeaderHtml } from "../lib/brand-header.js";

/** The hosts Turnstile needs. `brunhild.` is the one the widget calls home to;
 *  it is not guessable from the script URL and was found by reading the
 *  violations on a real phone. */
const TURNSTILE = "https://challenges.cloudflare.com";
const TURNSTILE_CONNECT = `${TURNSTILE} https://brunhild.challenges.cloudflare.com`;

/** A fresh nonce per response. A nonce is worthless if it repeats. */
export function startNonce(): string {
  return randomBytes(16).toString("base64");
}

/** The policy this page is served with: strict everywhere the app is strict,
 *  widened by exactly what the challenge needs and nothing else. */
export function startPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' ${TURNSTILE}`,
    `frame-src ${TURNSTILE}`,
    `connect-src 'self' ${TURNSTILE_CONNECT}`,
    // The page's own <style> block, and the widget's.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    "object-src 'none'",
  ].join("; ");
}

/** Where a visitor is headed once the sandbox is up, and where they came from.
 *  Both arrive in the query string (a QR on a booth display), so both are
 *  cleaned to a closed shape before they reach the page or a redirect. */
export interface StartIntent {
  /** "scan": open the camera scanner straight away (the booth). */
  start: "scan" | null;
  /** A campaign tag ("3DP2026"), folded to lower case: a QR printed in capitals
   *  and a link typed in lower case are one source. */
  source: string | null;
}

export const NO_INTENT: StartIntent = { start: null, source: null };

export function startIntentOf(query: Record<string, unknown>): StartIntent {
  const start = query.start === "scan" ? "scan" : null;
  const raw = typeof query.source === "string" ? query.source.trim().toLowerCase() : "";
  const source = /^[a-z0-9][a-z0-9-]{0,31}$/.test(raw) ? raw : null;
  return { start, source };
}

/** The query string that carries an intent on to /try/start and on to the
 *  landing, e.g. "&start=scan&source=3dp2026" ("" for none). Values are from
 *  the closed shape above, so nothing here needs escaping. */
export function intentQuery(intent: StartIntent): string {
  return (intent.start ? `&start=${intent.start}` : "") + (intent.source ? `&source=${intent.source}` : "");
}

export function startHtml(siteKey: string, nonce = "", intent: StartIntent = NO_INTENT): string {
  const booth = intent.start === "scan";
  // The booth (a QR at a stand, a phone on cellular): one big button, and the
  // challenge runs on that tap. The tap is a person saying "yes, make me one",
  // and it is the gesture a phone likes to see before the camera asks.
  // Turnstile still decides: the button only asks it to run.
  const heading = booth ? "Scan something on the table" : "Setting up your sandbox";
  const lede = booth
    ? "One tap opens a sandbox and your camera. It lasts an hour, and you do not need an account."
    : "It lasts an hour, and you do not need an account.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" /><title>Cobblr - starting your sandbox</title>
<script src="${TURNSTILE}/turnstile/v0/api.js" async defer></script>
<style>
 body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:#F6F2EA;color:#2b3038;
      font:16px/1.55 Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
 main{flex:1;display:grid;place-items:center;padding:24px}
 .card{max-width:30rem;text-align:center}
 h1{font-size:1.6rem;color:#3D4451;margin:0 0 .6rem}
 p{margin:0 0 1.2rem;color:#5d5647}
 .w{display:flex;justify-content:center;min-height:70px}
 .spin{width:34px;height:34px;margin:0 auto;border-radius:50%;
       border:3px solid rgba(61,68,81,.18);border-top-color:#8B7355;
       animation:sp .9s linear infinite}
 @keyframes sp{to{transform:rotate(360deg)}}
 .bar{height:6px;width:min(19rem,80vw);margin:1.1rem auto 0;border-radius:999px;
      background:rgba(61,68,81,.12);overflow:hidden}
 .bar i{display:block;height:100%;width:0;border-radius:999px;background:#8B7355;
        transition:width .6s ease}
 .step{margin-top:.8rem;color:#5d5647;min-height:1.4em;
       transition:opacity .25s ease}
 @media (prefers-reduced-motion:reduce){.spin{animation:none;border-top-color:#8B7355}}
 a,button{display:inline-block;border:2px solid #3D4451;border-radius:10px;padding:.7rem 1.3rem;
   background:transparent;color:#3D4451;font:inherit;font-weight:600;text-decoration:none;
   margin-top:1rem;cursor:pointer}
 button.primary{background:#8B7355;color:#fff;box-shadow:4px 4px 0 #3D4451;margin-right:.5rem}
 button.big{font-size:1.25rem;padding:1rem 1.6rem;width:min(20rem,86vw);margin:.4rem 0 .2rem}
 .hint{font-size:.9rem;margin:.6rem 0 0}
 [hidden]{display:none!important}
 noscript p{color:#8B3A3A}
 ${brandHeaderCss()}
 /* The one page in the product the app's stylesheet never reaches: the api
    serves it before any of that exists, so the dark theme is written here,
    from the same tokens index.css uses (canvas #1E293B, content #F4EFE5,
    muted #B4BAC2, line #475569 since #3232). Without it a visitor with a dark
    phone met a light page with a dark Cloudflare widget pasted into it, on the
    first Cobblr screen anybody at a stand sees (#3435). */
 @media (prefers-color-scheme:dark){
  body{background:#1E293B;color:#F4EFE5}
  h1{color:#F4EFE5}
  p,.step{color:#B4BAC2}
  .bar{background:rgba(244,239,229,.14)}
  .spin{border-color:rgba(244,239,229,.18);border-top-color:#BD9F77}
  .bar i,button.primary{background:#BD9F77;color:#1E293B}
  button.primary{box-shadow:4px 4px 0 #475569}
  a,button{border-color:#475569;color:#F4EFE5}
  noscript p{color:#F6B9B9}
  .brand{background:#1E293B;border-bottom-color:#475569}
  .brand a,.wordmark{color:#F4EFE5}
 }
</style></head><body>${brandHeaderHtml()}<main><div class="card">
<h1 id="h">${heading}</h1>
<p id="lede">${lede}</p>
${booth ? `<button type="button" id="go" class="primary big">Try it: scan something</button>
<p class="hint" id="camhint">Your phone will ask to use the camera. Tap Allow.</p>` : ""}
<div class="w"><div class="cf-turnstile" data-sitekey="${siteKey}" data-callback="cobblrGo" data-error-callback="cobblrFail" data-expired-callback="cobblrExpired"${booth ? ` data-execution="execute" data-appearance="interaction-only"` : ""}></div></div>
<div id="work" hidden>
  <div class="spin"></div>
  <div class="bar"><i id="fill"></i></div>
  <p class="step" id="step">Creating your workspace</p>
</div>
<div id="recover" hidden>
  <p id="why">Nothing was set up.</p>
  <button type="button" id="retry" class="primary">Try again</button><a href="/?mode=signup">Make an account instead</a>
</div>
<noscript><p>This needs JavaScript to check you are not a robot.</p>
<a href="/?mode=signup">Make an account instead</a></noscript>
</div></main>
<script${nonce ? ` nonce="${nonce}"` : ""}>
 // Between the challenge passing and the workspace appearing the server is
 // making a database, running migrations, installing two bundles and fetching
 // book covers. That is a real few seconds, and with the widget gone and
 // nothing in its place the page just sits there looking broken.
 //
 // These lines are the actual order of work, not decoration, and the bar is
 // deliberately asymptotic: it never reaches the end on a timer, because the
 // only thing that finishes it is the page arriving.
 var INTENT = ${JSON.stringify(intentQuery(intent))};
 var BOOTH = ${booth ? "true" : "false"};
 var STEPS = [
   [0,    'Creating your workspace',   12],
   [900,  'Setting up your shelves',   34],
   [2200, 'Adding a shelf of books',   58],
   [3800, 'Stocking the kitchen',      76],
   [5600, 'Almost there',              90]
 ];
 function $(id){ return document.getElementById(id); }
 function show(el, on){ if (el) el.hidden = !on; }
 function cobblrGo(token){
   show(document.querySelector('.w'), false);
   show($('recover'), false);
   show($('go'), false);
   var lede = $('lede');
   if (lede) lede.textContent = 'This takes a few seconds. It lasts an hour once it is up.';
   show($('work'), true);
   var step = $('step'), fill = $('fill');
   STEPS.forEach(function(s){
     setTimeout(function(){
       if (step) step.textContent = s[1];
       if (fill) fill.style.width = s[2] + '%';
     }, s[0]);
   });
   window.location.replace('/api/v1/try/start?captcha=' + encodeURIComponent(token) + INTENT);
 }
 // The two ways the widget gives up. The token never exists on either path,
 // so nothing here can reach /try/start: the only exits are a fresh challenge
 // or the ordinary signup.
 function failed(heading, lede){
   var h = $('h'); if (h) h.textContent = heading;
   var l = $('lede'); if (l) l.textContent = lede;
   show($('work'), false);
   show($('go'), false);
   show($('recover'), true);
 }
 function cobblrFail(){
   failed('We could not confirm you are a person',
          'The check did not pass. That can happen in a private window, with some browser extensions, or on a slow connection.');
 }
 function cobblrExpired(){
   failed('That check timed out',
          'The challenge expired before it was used. Try again and it is usually instant.');
 }
 function retry(){
   var h = $('h'); if (h) h.textContent = BOOTH ? 'Scan something on the table' : 'Setting up your sandbox';
   var l = $('lede'); if (l) l.textContent = BOOTH
     ? 'One tap opens a sandbox and your camera. It lasts an hour, and you do not need an account.'
     : 'It lasts an hour, and you do not need an account.';
   show($('recover'), false);
   show(document.querySelector('.w'), true);
   var box = document.querySelector('.cf-turnstile');
   if (window.turnstile && box) { window.turnstile.reset(box); }
   else { window.location.reload(); return; }
   // In execute mode a reset does not run the challenge again; the booth's
   // button does, so it comes back rather than leaving an idle widget.
   if (BOOTH) {
     var b = $('go');
     if (b) { b.disabled = false; b.textContent = 'Try it: scan something'; show(b, true); }
   }
 }
 var r = $('retry'); if (r) r.addEventListener('click', retry);
 // The booth's one tap: ask the challenge to run now. It may pass silently or
 // show its checkbox; either way the token only comes from a pass.
 var go = $('go');
 if (go) go.addEventListener('click', function(){
   go.disabled = true;
   go.textContent = 'Checking you are a person';
   var box = document.querySelector('.cf-turnstile');
   if (window.turnstile && box) { window.turnstile.execute(box); }
   else { go.disabled = false; go.textContent = 'Try it: scan something'; }
 });
 window.cobblrGo = cobblrGo; window.cobblrFail = cobblrFail; window.cobblrExpired = cobblrExpired;
</script>
</body></html>`;
}
