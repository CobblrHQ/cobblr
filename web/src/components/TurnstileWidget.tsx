import { useEffect, useRef } from "react";

// Renders a Cloudflare Turnstile widget and hands the solved token upward. Only
// mounted when the server reports a captcha site key (the trial tier); a normal
// deployment never sees it. No npm dependency - the script is loaded on demand.
export function TurnstileWidget({ siteKey, onToken }: { siteKey: string; onToken: (t: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    const render = () => {
      const ts = (window as unknown as { turnstile?: { render: (el: HTMLElement, o: unknown) => void } }).turnstile;
      if (ts && ref.current && !ref.current.hasChildNodes()) {
        ts.render(ref.current, {
          sitekey: siteKey,
          callback: (t: string) => onToken(t),
          "error-callback": () => onToken(""),
          "expired-callback": () => onToken(""),
        });
      }
    };
    if ((window as unknown as { turnstile?: unknown }).turnstile) {
      render();
      return;
    }
    let s = document.querySelector<HTMLScriptElement>(`script[src="${SRC}"]`);
    if (!s) {
      s = document.createElement("script");
      s.src = SRC;
      s.async = true;
      document.head.appendChild(s);
    }
    s.addEventListener("load", render);
    return () => s?.removeEventListener("load", render);
  }, [siteKey, onToken]);
  return <div ref={ref} className="mt-2 flex justify-center" />;
}
