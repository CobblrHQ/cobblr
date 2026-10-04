// /qr/:token — the web half of the QR scan-token resolve flow
// (docs/modules/labels.md, QR half). A printed Cobblr label encodes
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
// when the visitor has no session. When the workspace's admin let its
// labels offer a join link, a signed-out scan asks "Join <club> to take
// one" first (#3801): the person holding the club's cable has no account
// to sign in with, and the wall QR they would need is across the room. Dead tokens get the no-disclosure
// "no longer active" card per the module spec — we never echo what
// the token used to point at.

import { useEffect, useRef, useState } from "react";
import { QrCode, ScanLine } from "lucide-react";
import { usePageTitle } from "@cobblr/platform-web";
import { api, getToken } from "../lib/api";
import { PublicBrand, PublicRecordCard, type PublicFrame, type PublicRecord } from "./PublicPageView";

interface ResolveResult {
  ok: boolean;
  status: "active" | "revoked" | "expired" | "not_found";
  org_slug?: string;
  entity_kind?: string;
  entity_id?: string;
  mode?: "navigate" | "action";
  detail_path?: string;
  join?: { token: string; org_name: string };
  /** A live public page opens this label to anyone who is not a member. */
  public_view?: boolean;
}

interface PublicLabel {
  page: PublicFrame & { name: string };
  record: PublicRecord;
}

/** Who scans decides what they see, by membership (#4502): a member gets the
 *  record; anyone else, signed in here or not, is a visitor. */
async function memberOf(slug: string): Promise<{ member: boolean; name: string | null }> {
  if (!getToken()) return { member: false, name: null };
  try {
    const me = await api.me();
    return { member: me.orgs.some((o) => o.slug === slug), name: me.user.display_name || null };
  } catch {
    return { member: false, name: null };
  }
}

export function QrResolvePage() {
  usePageTitle("QR label");
  // The token is EVERYTHING after "/qr/" — a single opaque segment OR a
  // descriptive "<kind>/<id>" with a slash. Reading the raw path keeps this
  // mount-agnostic across the two basenames (/qr/… and /w/<slug>/qr/…).
  // An action label (#3897) prints `/a/<code>`; the same resolver finds its
  // workspace, then sends the phone to that workspace's label page.
  const path = window.location.pathname;
  const token = (path.includes("/a/") && !path.includes("/qr/") ? path.split("/a/")[1] : path.split("/qr/")[1]) ?? "";

  const [state, setState] = useState<"loading" | "dead" | "action" | "join" | "error" | "public" | "elsewhere">("loading");
  const [result, setResult] = useState<ResolveResult | null>(null);
  const [visitor, setVisitor] = useState<{ view: PublicLabel | null; name: string | null }>({ view: null, name: null });
  const opened = useRef<string | undefined>(undefined);

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
          setResult(body);
          setState("dead");
          return;
        }
        setResult(body);
        if (body.mode === "navigate") {
          const who = await memberOf(body.org_slug);
          if (cancelled) return;
          if (!who.member && body.public_view) {
            const visit = opened.current !== token;
            opened.current = token;
            const r = await fetch(`/api/v1/public/label?t=${encodeURIComponent(token)}`, {
              headers: { "X-Cobblr-Visit": visit ? "1" : "0" },
            });
            if (r.ok && !cancelled) {
              setVisitor({ view: (await r.json()) as PublicLabel, name: who.name });
              setState("public");
              return;
            }
          }
          // Signed in to someone else's workspace, and nothing here is public:
          // say whose it is, never "no access", never their switcher.
          if (!who.member && who.name && !body.join) {
            setVisitor({ view: null, name: who.name });
            setState("elsewhere");
            return;
          }
        }
        if (body.mode === "navigate" && body.detail_path && body.join && !getToken()) {
          setState("join");
          return;
        }
        if (body.mode === "navigate" && body.detail_path) {
          if (body.org_slug && body.entity_kind && body.entity_id && getToken()) {
            await api.requestLight(body.org_slug, { kind: body.entity_kind, id: body.entity_id }, "label-scanned").catch(() => undefined);
          }
          // The whole point: a scanned label lands on the thing it's
          // stuck to. replace() keeps the token URL out of history so
          // Back doesn't bounce through the resolver.
          window.location.replace(`/w/${body.org_slug}${body.detail_path}`);
          return;
        }
        if (body.mode === "action") {
          // An action label: its page shows what will happen and waits for
          // Confirm. Signed out, the workspace shell asks for a sign-in at
          // that same URL and comes back to it.
          window.location.replace(`/w/${body.org_slug}/a/${token}`);
          return;
        }
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

  if (state === "public" && visitor.view) {
    const v = visitor.view;
    return (
      <PublicBrand frame={v.page} className="min-h-screen">
      <div className="mx-auto max-w-3xl space-y-3 p-4" data-testid="label-public">
        {visitor.name && (
          <p className="text-xs text-muted" data-testid="label-visitor">
            Viewing as a visitor · you&apos;re signed in as {visitor.name} ·{" "}
            <a href="/" className="text-accent hover:underline">
              your workspace
            </a>
          </p>
        )}
        <PublicRecordCard record={v.record} frame={v.page} skinFrom={`/api/v1/public/label/skin?t=${encodeURIComponent(token)}`} />
      </div>
      </PublicBrand>
    );
  }

  if (state === "elsewhere") {
    return card(
      <>
        <QrCode size={28} className="mx-auto text-faint" />
        <div className="text-sm font-medium text-content dark:text-mortar-100" data-testid="label-elsewhere">
          This belongs to someone else&apos;s Cobblr
        </div>
        <p className="text-xs text-muted dark:text-slate-400">They have not made it public. You&apos;re signed in as {visitor.name}.</p>
        <a href="/" className="inline-flex items-center justify-center rounded-md bg-cobble-600 px-4 py-2 text-sm font-medium text-white hover:bg-cobble-700">
          Your workspace
        </a>
      </>,
    );
  }

  if (state === "join" && result?.join) {
    const item = `/w/${result.org_slug}${result.detail_path ?? ""}`;
    return card(
      <>
        <QrCode size={28} className="mx-auto text-accent" />
        <div className="text-sm font-medium text-content dark:text-mortar-100">
          Join {result.join.org_name} to take one
        </div>
        <p className="text-xs text-muted dark:text-slate-400">
          You do this once. After that, scanning a label opens the thing and you press -1.
        </p>
        <a
          href={`/invite/${encodeURIComponent(result.join.token)}?next=${encodeURIComponent(item)}`}
          className="inline-flex w-full items-center justify-center rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-4 py-2"
          data-testid="label-join"
        >
          Join {result.join.org_name}
        </a>
        <a href={item} className="block text-xs text-accent hover:underline" data-testid="label-sign-in">
          I already have an account: sign in
        </a>
      </>,
    );
  }

  // A live label whose thing has no page to open here: its kind has no detail
  // route (the module that shows it is off, or it never had a page). Action
  // labels never land here; they go to /a/ above.
  if (state === "action" && result) {
    return card(
      <>
        <QrCode size={28} className="mx-auto text-accent" />
        <div className="text-sm font-medium text-content dark:text-mortar-100" data-testid="label-no-page">
          This label&apos;s {kindNoun(result.entity_kind)} has no page to open
        </div>
        <p className="text-xs text-muted dark:text-slate-400">
          The label still works. The part of your workspace that shows it may be turned off.
        </p>
        <a
          href={`/w/${result.org_slug}`}
          className="inline-flex items-center justify-center rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-4 py-2"
        >
          Open the workspace
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
        {state === "error"
          ? "Couldn't resolve this QR code"
          : result?.status === "revoked"
            ? "This label has been turned off"
            : "This QR code is no longer active"}
      </div>
      <p className="text-xs text-muted dark:text-slate-400">
        {state === "error"
          ? "Check your connection and try again."
          : result?.status === "revoked"
            ? "Scanning it does nothing now, and nothing was changed. If it should still work, someone in the workspace can turn it back on in Action labels."
            : "The label may have been revoked or expired. Ask a workspace admin if you think that's a mistake."}
      </p>
    </>,
  );
}

/** "part" from "inventory:part", "thing" when there is no kind. */
function kindNoun(kind: string | undefined): string {
  const k = (kind ?? "").split(":").pop()?.replace(/[-_]/g, " ").trim();
  return k || "thing";
}
