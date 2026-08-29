// The state of the printers a local bridge is holding — for the Live box.
//
// WHY THIS IS A HOOK AND NOT A CONNECTION: the bridge owns the link, not the
// browser. It is a daemon, so it keeps the printer while tabs come and go, and
// any number of tabs on that machine see the same thing. What a tab holds is a
// VIEW, refreshed by asking. That is why nothing here opens a socket or tracks a
// session: there is no session in the browser to track.
//
// Every state reported here is something the bridge actually says. Nothing is
// inferred from a guess:
//   • "offline"    — nothing answered on the bridge address at all
//   • "per-job"    — reachable; this instance opens a link per job by design,
//                    so "connect" is not a thing it can be asked to do
//   • "idle"       — reachable, no link held
//   • "connected"  — a link is held open, so printing is immediate
//   • "printing"   — a job is in flight
//   • "unreachable"— the bridge is up but the printer did not answer an open
//
// Polling is deliberately slow and metadata-only. `/devices` on the thermal
// driver is static — it reports config, not a probe — so a tick costs one
// localhost request and never wakes a printer or takes the serial session that
// a print needs.

import { useEffect, useState } from "react";
import { LOCAL_BRIDGE_URL } from "./bridge-printer.js";
import { localFetch } from "./local-network.js";

export type BridgeLinkState = "offline" | "unreachable" | "per-job" | "idle" | "connected" | "printing";

export interface BridgeInstanceLive {
  instance: string;
  name: string;
  driver: string;
  link: BridgeLinkState;
  media?: { widthMm?: number; heightMm?: number; labelHeightMm?: number; protocol?: string };
}

export interface BridgeLive {
  /** False when nothing answered — the helper app is not running. */
  reachable: boolean;
  instances: BridgeInstanceLive[];
  /** Set while a tick is in flight, for a quiet spinner rather than a flicker. */
  checking: boolean;
}

const EMPTY: BridgeLive = { reachable: false, instances: [], checking: false };

/** One read of a bridge's instances and what it is doing about each link. */
export async function readBridgeLive(bridgeUrl = LOCAL_BRIDGE_URL): Promise<BridgeLive> {
  const base = bridgeUrl.replace(/\/+$/, "");
  let rows: Array<{ id?: string; driver?: string }>;
  try {
    const res = await localFetch(base + "/", { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return EMPTY;
    const body = (await res.json()) as { service?: string; instances?: typeof rows };
    if (body.service !== "cobblr-edge-bridge" || !Array.isArray(body.instances)) return EMPTY;
    rows = body.instances;
  } catch {
    // No bridge is the NORMAL case for most people and must never read as an
    // error — the card says "not running", not "something went wrong".
    return EMPTY;
  }

  const instances = await Promise.all(
    rows
      .filter((r) => r.id)
      .map(async (r): Promise<BridgeInstanceLive | null> => {
        try {
          const res = await localFetch(`${base}/${r.id}/devices`, {
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(8000),
          });
          if (!res.ok) return null;
          const [d] = (await res.json()) as Array<{
            name?: string; state?: string; link?: string;
            media?: BridgeInstanceLive["media"];
          }>;
          if (!d) return null;
          // The MACHINE's state wins over the link when it is printing: what you
          // want to know mid-run is that a run is happening.
          const link: BridgeLinkState =
            d.state === "printing"
              ? "printing"
              : d.link === "connected" || d.link === "idle" || d.link === "per-job"
                ? d.link
                : "idle";
          return {
            instance: r.id!,
            name: d.name || r.id!,
            driver: r.driver ?? "",
            link,
            ...(d.media ? { media: d.media } : {}),
          };
        } catch {
          // One instance that will not answer must not hide the healthy ones.
          return null;
        }
      }),
  );
  return { reachable: true, instances: instances.filter((i): i is BridgeInstanceLive => i !== null), checking: false };
}

/** Ask a bridge instance to hold its link open, or let it go. */
export async function setBridgeLink(
  instance: string,
  want: "connect" | "disconnect",
  bridgeUrl = LOCAL_BRIDGE_URL,
): Promise<{ ok: boolean; detail?: string }> {
  const base = bridgeUrl.replace(/\/+$/, "");
  try {
    const res = await localFetch(`${base}/${instance}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: want }),
      // Opening a Bluetooth link to a sleeping printer is slow, and the bridge
      // retries before giving up. A short deadline here would report failure
      // over a connection that was still being made.
      signal: AbortSignal.timeout(90_000),
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; detail?: string } | null;
    return { ok: res.ok && body?.ok !== false, ...(body?.detail ? { detail: body.detail } : {}) };
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return {
      ok: false,
      detail: timedOut
        ? "the printer did not answer in time — it is usually asleep or out of range"
        : "could not reach the bridge",
    };
  }
}

/** Live view of the local bridge, refreshed on a slow tick.
 *
 *  `pollMs = 0` means DO NOT LOOK - no tick and no first read either. That
 *  distinction is the whole point and it used to be got wrong: the effect ran
 *  one fetch before consulting pollMs, so a collapsed Live box still reached
 *  127.0.0.1:8077 exactly once on mount. This box follows you across every page,
 *  so "once on mount" meant every visitor, on their first screen.
 *
 *  In a browser that gates local-network access, one request is all it takes:
 *  someone opening a Cobblr link for the first time got "try.cobblr.xyz wants to
 *  access other apps and services on this device" before they had clicked
 *  anything. A page must not reach into somebody's machine unasked, and opening
 *  the Live box is what asking looks like. */
export function useBridgeLive(pollMs = 15_000, bridgeUrl = LOCAL_BRIDGE_URL): BridgeLive & { refresh: () => void } {
  const [live, setLive] = useState<BridgeLive>(EMPTY);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    // Nobody is looking: do not touch the local network at all.
    if (pollMs <= 0) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (!alive) return;
      setLive((cur) => ({ ...cur, checking: true }));
      const next = await readBridgeLive(bridgeUrl);
      if (!alive) return;
      setLive(next);
      timer = setTimeout(() => void tick(), pollMs);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [pollMs, bridgeUrl, nonce]);

  return { ...live, refresh: () => setNonce((n) => n + 1) };
}
