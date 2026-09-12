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
export function startHtml(siteKey: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" /><title>Cobblr - starting your sandbox</title>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<style>
 body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F6F2EA;color:#2b3038;
      font:16px/1.55 Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:24px}
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
 [hidden]{display:none!important}
 noscript p{color:#8B3A3A}
</style></head><body><div class="card">
<h1 id="h">Setting up your sandbox</h1>
<p id="lede">It lasts an hour, and you do not need an account.</p>
<div class="w"><div class="cf-turnstile" data-sitekey="${siteKey}" data-callback="cobblrGo" data-error-callback="cobblrFail" data-expired-callback="cobblrExpired"></div></div>
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
</div>
<script>
 // Between the challenge passing and the workspace appearing the server is
 // making a database, running migrations, installing two bundles and fetching
 // book covers. That is a real few seconds, and with the widget gone and
 // nothing in its place the page just sits there looking broken.
 //
 // These lines are the actual order of work, not decoration, and the bar is
 // deliberately asymptotic: it never reaches the end on a timer, because the
 // only thing that finishes it is the page arriving.
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
   window.location.replace('/api/v1/try/start?captcha=' + encodeURIComponent(token));
 }
 // The two ways the widget gives up. The token never exists on either path,
 // so nothing here can reach /try/start: the only exits are a fresh challenge
 // or the ordinary signup.
 function failed(heading, lede){
   var h = $('h'); if (h) h.textContent = heading;
   var l = $('lede'); if (l) l.textContent = lede;
   show($('work'), false);
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
   var h = $('h'); if (h) h.textContent = 'Setting up your sandbox';
   var l = $('lede'); if (l) l.textContent = 'It lasts an hour, and you do not need an account.';
   show($('recover'), false);
   show(document.querySelector('.w'), true);
   var box = document.querySelector('.cf-turnstile');
   if (window.turnstile && box) { window.turnstile.reset(box); }
   else { window.location.reload(); }
 }
 var r = $('retry'); if (r) r.addEventListener('click', retry);
 window.cobblrGo = cobblrGo; window.cobblrFail = cobblrFail; window.cobblrExpired = cobblrExpired;
</script>
</body></html>`;
}
