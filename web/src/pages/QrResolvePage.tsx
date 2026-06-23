// /qr/:token — the web half of the QR scan-token resolve flow
// (docs/modules/core-labels-qr.md §4). A printed Cobblr label encodes
// `https://<host>/qr/<token>`; this page asks the unauthenticated
// resolve endpoint (GET /api/v1/qr/:token) what the token points at
// and forwards a navigate-mode scan to the entity's detail page.
//
// Mounted TWICE: in PublicRoutes (bare URL — a phone camera scan,
// possibly signed out) and in the workspace routes (the in-app
// scanner navigates here, and LandingRedirect rewrites a bare
// /qr/<token> to /w/<default>/qr/<token> for signed-in users). Both
// mounts redirect with window.location so the /w/:slug basename
// difference never matters.
//
// Auth comes for free: the redirect target is /w/<org>/<detail>,
// and the workspace shell shows the login page (preserving the URL)
// when the visitor has no session. Dead tokens get the no-disclosure
// "no longer active" card per the module spec — we never echo what
// the token used to point at.

import { useEffect, useState } from "react";
import { QrCode, ScanLine } from "lucide-react";
import { usePageTitle } from "@cobblr/platform-web";

interface ResolveResult {
  ok: boolean;
  status: "active" | "revoked" | "expired" | "not_found";
  org_slug?: string;
  entity_kind?: string;
  mode?: "navigate" | "action";
  detail_path?: string;
}

export function QrResolvePage() {
  usePageTitle("QR label");
  // The token is EVERYTHING after "/qr/" — a single opaque segment OR a
  // descriptive "<kind>/<id>" with a slash. Reading the raw path keeps this
  // mount-agnostic across the two basenames (/qr/… and /w/<slug>/qr/…).
  const token = window.location.pathname.split("/qr/")[1] ?? "";

  const [state, setState] = useState<"loading" | "dead" | "action" | "error">("loading");
  const [result, setResult] = useState<ResolveResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Encode per-segment so a descriptive token's slash survives (a
        // collapsed %2F wouldn't match the multi-segment resolver route).
        const encoded = token.split("/").map(encodeURIComponent).join("/");
        const res = await fetch(`/api/v1/qr/${encoded}`, {
          headers: { accept: "application/json" },
        });
        const body = (await res.json()) as ResolveResult;
        if (cancelled) return;
        if (!body.ok || !body.org_slug) {
          setState("dead");
          return;
        }
        setResult(body);
        if (body.mode === "navigate" && body.detail_path) {
          // The whole point: a scanned label lands on the thing it's
          // stuck to. replace() keeps the token URL out of history so
          // Back doesn't bounce through the resolver.
          window.location.replace(`/w/${body.org_slug}${body.detail_path}`);
          return;
        }
        // Action-mode confirm card isn't built yet (deferred in the
        // module doc); offer the detail page so the scan still lands.
        setState("action");
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const card = (body: React.ReactNode) => (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-sm p-6 text-center space-y-3">
        {body}
      </div>
    </div>
  );

  if (state === "loading") {
    return card(
      <>
        <ScanLine size={28} className="mx-auto text-accent animate-pulse" />
        <div className="text-sm text-muted dark:text-slate-400">Resolving QR label…</div>
      </>,
    );
  }

  if (state === "action" && result) {
    const open = result.detail_path
      ? `/w/${result.org_slug}${result.detail_path}`
      : `/w/${result.org_slug}`;
    return card(
      <>
        <QrCode size={28} className="mx-auto text-accent" />
        <div className="text-sm font-medium text-content dark:text-mortar-100">
          This label triggers an action
        </div>
        <p className="text-xs text-muted dark:text-slate-400">
          Action-mode scans aren&apos;t confirmable from the web yet — you can open the
          item it&apos;s attached to instead.
        </p>
        <a
          href={open}
          className="inline-flex items-center justify-center rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-4 py-2"
        >
          Open the item
        </a>
      </>,
    );
  }

  // dead (revoked / expired / unknown) and fetch errors share the
  // no-disclosure dead-end card.
  return card(
    <>
      <QrCode size={28} className="mx-auto text-faint" />
      <div className="text-sm font-medium text-content dark:text-mortar-100">
        {state === "error" ? "Couldn't resolve this QR code" : "This QR code is no longer active"}
      </div>
      <p className="text-xs text-muted dark:text-slate-400">
        {state === "error"
          ? "Check your connection and try again."
          : "The label may have been revoked or expired. Ask a workspace admin if you think that's a mistake."}
      </p>
    </>,
  );
}
