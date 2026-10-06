// Approving a tablet as a station, the way the tablet and an owner do it
// (platform/station-devices.ts): the tablet asks, the owner approves the code
// it shows, the tablet's poll claims its token.
import { BASE, http, org, type TestSession } from "./helpers.js";

export interface StationAsk {
  request_id: string;
  poll_key: string;
  code: string;
}

export async function askToBeAStation(slug: string, address: string): Promise<StationAsk> {
  const r = await fetch(`${BASE}/api/v1/station/requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug, address }),
  });
  if (r.status !== 201) throw new Error(`station request: ${r.status} ${await r.text()}`);
  return (await r.json()) as StationAsk;
}

export async function pollStation(ask: StationAsk): Promise<{ status: string; token?: string; address?: string; label?: string }> {
  const r = await fetch(`${BASE}/api/v1/station/requests/${ask.request_id}?key=${encodeURIComponent(ask.poll_key)}`);
  if (!r.ok) throw new Error(`station poll: ${r.status} ${await r.text()}`);
  return (await r.json()) as { status: string; token?: string };
}

/** A station at `address`, approved by `s`, as a session the tests can call
 *  with: the tablet's own token in place of the person's. */
export async function approvedStation(s: TestSession, address: string, label?: string): Promise<TestSession> {
  const ask = await askToBeAStation(s.slug, address);
  await http(s, org(s, "/station-devices/approve"), { method: "POST", body: { code: ask.code, ...(label ? { label } : {}) }, expectStatus: 200 });
  const claimed = await pollStation(ask);
  if (claimed.status !== "approved" || !claimed.token) throw new Error(`station not approved: ${JSON.stringify(claimed)}`);
  return { ...s, token: claimed.token };
}
