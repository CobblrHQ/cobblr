// "Viewing as Vince · Read-only · Exit": a View as through a share
// (docs/design-decisions/share-spaces.md §14). A preview of one's own share,
// not a support session (#4695): no minutes left, the grant renewed quietly
// before it runs out while the share lasts. Shown in any tab holding a
// view, portaled over every shell, with a ring round the window so it is never
// mistaken for one's own workspace. Read-only is the server's (requireAuth
// holds the grant to reads of the one share space); this is disclosure and Exit.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Eye, X } from "lucide-react";
import { BackdropLayer, FloatingChrome } from "@cobblr/platform-web";
import { api } from "../lib/api";
import { getShareViewToken, setShareViewToken } from "../lib/share-view";

const BAR_H = 36;

/** Renew this long before the grant would run out. */
const RENEW_BEFORE_MS = 5 * 60_000;

export function ShareViewBanner() {
  const viewing = !!getShareViewToken();
  const [who, setWho] = useState<string | null>(null);
  useEffect(() => {
    if (!viewing) return;
    let gone = false;
    let timer = 0;
    const renewAt = (expiresAt: string) => {
      const wait = Math.max(30_000, new Date(expiresAt).getTime() - Date.now() - RENEW_BEFORE_MS);
      timer = window.setTimeout(() => {
        void api.renewShareView()
          .then((r) => {
            if (gone) return;
            setShareViewToken(r.token);
            renewAt(r.expires_at);
          })
          // Refused: Exit or the share ended it. The next read says so.
          .catch(() => undefined);
      }, wait);
    };
    void api
      .me()
      .then((me) => {
        if (gone || !me.share_view) return;
        setWho(me.user.display_name || "them");
        renewAt(me.share_view.expires_at);
      })
      .catch(() => undefined);
    return () => {
      gone = true;
      window.clearTimeout(timer);
    };
  }, [viewing]);
  if (!viewing) return null;
  const exit = async () => {
    await api.endShareView().catch(() => undefined);
    setShareViewToken(null);
    window.close();
    window.location.assign("/");
  };
  return createPortal(
    <>
      <BackdropLayer aria-hidden className="pointer-events-none z-[2000] ring-[3px] ring-inset ring-sky-500" />
      <FloatingChrome inPlace anchor="top" reserveTop yields={false} className="z-[2001] flex items-center gap-2 bg-sky-700 px-3 text-[13px] font-medium text-white shadow" style={{ height: BAR_H }}>
        <Eye size={15} className="shrink-0" aria-hidden />
        <span className="truncate" data-testid="share-view-banner">
          Viewing as <b>{who ?? "them"}</b> · Read-only
        </span>
        <div className="flex-1" />
        <button type="button" data-testid="share-view-exit" onClick={() => void exit()} className="inline-flex items-center gap-1 rounded bg-black/25 px-2 py-0.5 hover:bg-black/40">
          <X size={13} aria-hidden /> Exit
        </button>
      </FloatingChrome>
    </>,
    document.body,
  );
}
