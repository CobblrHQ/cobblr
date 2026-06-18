// useBrowserDrive — the tab side of Feature 3 (Claude drives the app you have
// open). When the active workspace has a drive grant (navigate / navigate+observe),
// this opens an SSE stream and:
//   • drive-offer   → surfaces a blocking "Claude wants to drive — use this
//                     window?" prompt (the caller renders it from `state`)
//   • navigate      → routes this tab to the path Claude sent
//   • drive-active / drive-elsewhere → green (this is the driven window) / red
//   • with navigate+observe, batches the user's clicks + route changes back
//
// SSE auth: EventSource can't send an Authorization header, so we mint a short
// (60s) ticket via an authed POST and put it in the stream URL; on any drop we
// mint a fresh ticket and reconnect (the ticket only gates CONNECT).

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";

export type DriveMode = "off" | "navigate" | "navigate_observe";
export type DriveState = "idle" | "offer" | "active" | "elsewhere";

/** Stable per-tab id (sessionStorage). Shared by the always-mounted DriveBanner
 *  stream AND the Scan page's scan-drive opt-in, so accepting "this is my scan
 *  screen" claims the very tab whose stream receives the navigate. */
export function tabBrowserId(): string {
  const KEY = "cobblr.drive.browserId";
  let id = sessionStorage.getItem(KEY);
  if (!id) {
    id = `b_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    sessionStorage.setItem(KEY, id);
  }
  return id;
}

/** A visual presence cue from the driver — a cursor at an element/point, with an
 *  optional click ripple + label. `seq` bumps on each cue so the overlay can
 *  retrigger its animation even for the same target. */
export interface DrivePresence {
  selector?: string;
  x?: number;
  y?: number;
  label?: string;
  ripple?: boolean;
  seq: number;
}

export interface BrowserDrive {
  enabled: boolean;
  state: DriveState;
  accept: () => void;
  release: () => void;
  presence: DrivePresence | null;
}

export function useBrowserDrive(slug: string | undefined, mode: DriveMode): BrowserDrive {
  const navigate = useNavigate();
  const [state, setState] = useState<DriveState>("idle");
  const [presence, setPresence] = useState<DrivePresence | null>(null);
  const seqRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const closedRef = useRef(false);
  const browserId = useRef(tabBrowserId());
  const enabled = !!slug && mode !== "off";

  // Keep the latest navigate without re-opening the stream on every render.
  const navRef = useRef(navigate);
  navRef.current = navigate;

  const accept = useCallback(() => {
    if (slug) void api.driveTabAccept(slug, browserId.current).catch(() => {});
  }, [slug]);
  const release = useCallback(() => {
    if (slug) void api.driveTabRelease(slug, browserId.current).catch(() => {});
    setState("idle");
  }, [slug]);

  // ── the SSE stream ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !slug) {
      setState("idle");
      return;
    }
    closedRef.current = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    async function connect() {
      if (closedRef.current) return;
      let ticket: string;
      try {
        ticket = (await api.driveTabTicket(slug!)).ticket;
      } catch {
        retry = setTimeout(connect, 4000); // grant maybe just turned off; back off
        return;
      }
      if (closedRef.current) return;
      const url =
        `/api/v1/orgs/${encodeURIComponent(slug!)}/drive/tab/stream` +
        `?ticket=${encodeURIComponent(ticket)}&browser_id=${encodeURIComponent(browserId.current)}`;
      const es = new EventSource(url);
      esRef.current = es;
      es.addEventListener("drive-offer", () => setState((s) => (s === "active" ? s : "offer")));
      es.addEventListener("drive-active", () => setState("active"));
      es.addEventListener("drive-elsewhere", () => setState("elsewhere"));
      es.addEventListener("drive-available", () => setState((s) => (s === "active" ? s : "idle")));
      es.addEventListener("drive-released", () => setState("idle"));
      es.addEventListener("driver-left", () => setState("idle"));
      es.addEventListener("tab-closed", () => setState("idle"));
      es.addEventListener("navigate", (ev) => {
        try {
          const { path } = JSON.parse((ev as MessageEvent).data) as { path: string };
          if (typeof path === "string" && path.startsWith("/")) navRef.current(path);
        } catch {
          /* ignore a malformed frame */
        }
      });
      es.addEventListener("present", (ev) => {
        try {
          const p = JSON.parse((ev as MessageEvent).data) as Omit<DrivePresence, "seq">;
          seqRef.current += 1;
          setPresence({ ...p, seq: seqRef.current });
        } catch {
          /* ignore a malformed frame */
        }
      });
      es.onerror = () => {
        // EventSource would retry the SAME (now-expiring) ticket URL — close and
        // reconnect with a fresh ticket instead.
        es.close();
        esRef.current = null;
        if (!closedRef.current) retry = setTimeout(connect, 2000);
      };
    }
    void connect();

    return () => {
      closedRef.current = true;
      if (retry) clearTimeout(retry);
      esRef.current?.close();
      esRef.current = null;
    };
  }, [enabled, slug]);

  // ── telemetry (navigate+observe, only while this is the driven tab) ──────────
  useEffect(() => {
    if (!slug || mode !== "navigate_observe" || state !== "active") return;
    let buffer: unknown[] = [];
    const push = (e: unknown) => {
      buffer.push(e);
      if (buffer.length > 100) buffer = buffer.slice(-100);
    };
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      push({ kind: "click", at: Date.now(), tag: t?.tagName?.toLowerCase(), text: (t?.textContent ?? "").slice(0, 60).trim() });
    };
    document.addEventListener("click", onClick, true);
    let lastPath = location.pathname + location.search;
    const flush = setInterval(() => {
      const path = location.pathname + location.search;
      if (path !== lastPath) {
        push({ kind: "navigate", at: Date.now(), path });
        lastPath = path;
      }
      if (buffer.length === 0) return;
      const batch = buffer;
      buffer = [];
      void api.driveTabTelemetry(slug, browserId.current, batch).catch(() => {});
    }, 500);
    return () => {
      document.removeEventListener("click", onClick, true);
      clearInterval(flush);
    };
  }, [slug, mode, state]);

  // Presence cues only make sense while this is the driven tab.
  useEffect(() => {
    if (state !== "active") setPresence(null);
  }, [state]);

  return { enabled, state, accept, release, presence };
}
