// Edge channel registry — the open-core side of the edge-bridge seam.
//
// A user-run edge agent dials the cloud and holds a pipe open; the hosted relay
// (proprietary overlay) authenticates it and calls registerChannel() with a
// sender that writes over that socket. Consumers (the "Local AI via edge bridge"
// provider) call send() to reach the workspace's device — no public URL, no
// SSRF surface, because the cloud never dials inward.
//
// In-process Map keyed by a CHANNEL KEY — the connecting user's id (the relay
// registers under the authenticated user, so one agent serves every workspace
// the user routes it to, via the personal-connections vault). SINGLE-INSTANCE
// ONLY: the socket lives on whichever api process the agent connected to, so a
// multi-replica deployment needs a shared backplane (Redis pub/sub or a
// standalone relay). That swaps THIS file while keeping the seam, so the
// provider + agent never change. One channel per key: a newer connection
// replaces an older one (the relay reaps the stale socket via unregister).

import type { EdgeChannelSender, EdgeRequest, EdgeResponse } from "@cobblr/platform-contract";

const channels = new Map<string, EdgeChannelSender>();

export function registerChannel(orgId: string, send: EdgeChannelSender): () => void {
  channels.set(orgId, send); // newest wins
  return () => {
    // Only clear if still ours — a reconnect may have already replaced it.
    if (channels.get(orgId) === send) channels.delete(orgId);
  };
}

export function hasChannel(orgId: string): boolean {
  return channels.has(orgId);
}

export async function send(orgId: string, req: EdgeRequest): Promise<EdgeResponse> {
  const ch = channels.get(orgId);
  if (!ch) {
    throw new Error(
      `no edge device connected for this workspace — start the Cobblr edge bridge and confirm it's online`,
    );
  }
  return ch(req);
}
