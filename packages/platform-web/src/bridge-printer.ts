// Testing a bridge that lives on the USER'S OWN MACHINE.
//
// The server cannot do this one: 127.0.0.1 from the API is a different computer
// entirely, and fetching a user-supplied address from the server would be the
// SSRF hole the guards exist to prevent. So when a printer's settings carry a
// local bridgeUrl, the browser runs the same check the server-side driver runs
// over the tunnel — same client, same protocol, different transport.

import {
  EdgeBridgeClient,
  httpBridgeTransport,
  type BridgeDeviceInfo,
  type BridgePrinterSettings,
} from "@cobblr/platform-contract/edge-bridge-client";
import type { BatteryReading } from "@cobblr/thermal-print";

/** Where a bridge on this machine listens. ONE address, deliberately: probing a
 *  range of ports from a web page is indistinguishable from a port scanner, and
 *  the bridge documents this default everywhere it is installed. */
export const LOCAL_BRIDGE_URL = "http://127.0.0.1:8077";
import { localFetch } from "./local-network.js";

/** Bridge driver kinds that ARE label printers.
 *
 *  A bridge fronts whatever the operator configured — 3D printers, lasers,
 *  sensors. Listing all of them in a PRINTER picker offered a LightBurn laser
 *  as something to print labels on, which is nonsense the user then has to
 *  reason about. Those machines belong to digifab, not core-print.
 *
 *  An unknown kind is EXCLUDED rather than included: a new driver appearing in
 *  this list unannounced is worse than one missing from it, and adding a kind
 *  here is one line. */
export const LABEL_PRINTER_DRIVERS: readonly string[] = ["thermal", "cups"];

export interface DiscoveredPrinter {
  /** The bridge instance id — the segment it serves this printer under. */
  instance: string;
  /** What the bridge calls the device, e.g. "PM240 (Bluetooth Classic)". */
  name: string;
  driver: string;
  /** The device record the bridge returned, WHOLE.
   *
   *  Not a chosen field or two. The bridge holds facts that exist nowhere else
   *  (head width, label geometry, dialect), and picking them off one at a time
   *  meant every new need cost a field here, a field in the stored settings, and
   *  a release on both sides before anyone saw it. Carried intact so a consumer
   *  can resolve whatever it needs, including keys added after this shipped. */
  device: BridgeDeviceInfo;
}

/** Ask a bridge on THIS machine what printers it has.
 *
 *  Returns [] for every failure — no bridge, wrong port, CORS refused. A missing
 *  bridge is the normal case (most people have none) and must not read as an
 *  error, so the caller simply shows nothing rather than a scary message.
 *
 *  Deliberately does NOT read each printer's roll/battery here. That means
 *  waking every printer to populate a list, which costs a Bluetooth session per
 *  device and, on a printer that must run unpaired, a consent click. Status is
 *  read on demand instead, once a printer is actually added. */
export async function discoverLocalPrinters(
  bridgeUrl = LOCAL_BRIDGE_URL,
  driverKinds: readonly string[] = LABEL_PRINTER_DRIVERS,
): Promise<DiscoveredPrinter[]> {
  let instances: Array<{ id?: string; driver?: string; health?: string }>;
  try {
    const res = await localFetch(bridgeUrl.replace(/\/+$/, "") + "/", {
      headers: { accept: "application/json" },
      // The bridge health-checks every instance before answering, so this costs
      // as much as its SLOWEST driver: a LightBurn instance pinging a laser that
      // is not there takes ~3s on its own. 2.5s looked like "no bridge" on a
      // perfectly healthy one. Thermal's listDevices is static, so no printer is
      // woken by discovery.
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { service?: string; instances?: typeof instances };
    // Older bridges answer the same shape with a health field attached; the
    // extra key is harmless, so no version check is needed here.
    if (body.service !== "cobblr-edge-bridge" || !Array.isArray(body.instances)) return [];
    instances = body.instances;
  } catch {
    return [];
  }

  const found = await Promise.all(
    instances
      .filter((i) => i.id && driverKinds.includes(i.driver ?? ""))
      .map(async (i) => {
        try {
          const client = new EdgeBridgeClient(httpBridgeTransport(bridgeUrl), i.id);
          const devices = await client.devices();
          const d = devices[0];
          const name = d?.name || d?.id;
          return name && d ? { instance: i.id!, name, driver: i.driver ?? "", device: d } : null;
        } catch {
          // One unreachable instance must not hide the healthy ones.
          return null;
        }
      }),
  );
  return found.filter((x): x is DiscoveredPrinter => x !== null);
}

/** What to call a bridged printer in Cobblr.
 *
 *  A bridge names its device after the wiring it was configured with, e.g.
 *  "PM240 (Bluetooth Classic)". That parenthetical is an implementation detail
 *  of a decision the person already made and does not want restated on every
 *  screen: they chose a bridge, and how the bridge reaches the printer is the
 *  bridge's business. The model name is the part that identifies the machine. */
export function printerDisplayName(bridgeDeviceName: string): string {
  const stripped = bridgeDeviceName
    .replace(/\s*\((?:bluetooth[^)]*|serial|usb|network|rfcomm|ble)\)\s*$/i, "")
    .trim();
  // Never return an empty name: a device called exactly "(Bluetooth Classic)"
  // would otherwise become an unclickable blank row.
  return stripped || bridgeDeviceName;
}

/** True when this printer is served by a bridge on the machine running the
 *  browser, and therefore must be reached from here rather than the server. */
export function isLocalBridgePrinter(settings: unknown): settings is { bridge: BridgePrinterSettings } {
  const b = (settings as { bridge?: BridgePrinterSettings } | null)?.bridge;
  return !!b?.bridgeUrl;
}

export function clientFor(s: BridgePrinterSettings): EdgeBridgeClient {
  return new EdgeBridgeClient(httpBridgeTransport(s.bridgeUrl!, { token: s.token }), s.instance);
}

/** What the local bridge is fronting on each instance, keyed by instance id.
 *
 *  Heals printers added BEFORE these facts were recorded in their settings.
 *  Such a row carries an instance and an address and nothing that says it runs
 *  a roll or how wide that roll may be, so it funnels to sheet media and, once
 *  known to be thermal, gets offered a 4 x 6 roll it cannot feed. The bridge has
 *  always known both, so the fix is a question rather than a migration.
 *
 *  Returns an empty map for every failure, so a machine with no bridge behaves
 *  exactly as before. */
export async function bridgeInstanceInfo(
  bridgeUrl = LOCAL_BRIDGE_URL,
): Promise<Record<string, { driver: string; device: BridgeDeviceInfo }>> {
  const out: Record<string, { driver: string; device: BridgeDeviceInfo }> = {};
  for (const p of await discoverLocalPrinters(bridgeUrl)) {
    out[p.instance] = { driver: p.driver, device: p.device };
  }
  return out;
}

/** Ask a bridged printer what it currently has loaded, as NUMBERS.
 *
 *  This is what lets the label size follow the roll the printer actually
 *  reports. The bridge also renders the same reading as a sentence; that is for
 *  showing, this is for acting on, and re-parsing the sentence would be a
 *  guess about our own wording.
 *
 *  Returns `responded: false` for every no-answer case — an older bridge that
 *  sends no data, a driver with no commands (501), a printer that stays silent.
 *  None of those are errors: plenty of printers cannot say what is loaded, and
 *  the person then picks the size by hand exactly as before. */
export async function readLocalBridgeStatus(
  s: BridgePrinterSettings,
): Promise<{ widthMm?: number; heightMm?: number; battery?: BatteryReading; responded: boolean }> {
  try {
    const r = await clientFor(s).command("status");
    const d = r.data as
      | { widthMm?: unknown; heightMm?: unknown; batteryRaw?: unknown; batteryFraction?: unknown; batteryBars?: unknown; charging?: unknown }
      | undefined;
    if (!r.ok || !d) return { responded: false };
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
    const width = num(d.widthMm);
    const height = num(d.heightMm);
    // Battery goes out as a BatteryReading — the shape the status store renders.
    // The first cut returned flat batteryBars/charging fields; TypeScript let
    // that through (structural assignment checks no excess properties on a
    // variable), describePrinterStatus reads `.battery`, and the battery
    // silently never appeared anywhere in the UI.
    const bars = typeof d.batteryBars === "number" ? d.batteryBars : undefined;
    const fraction = typeof d.batteryFraction === "number" ? d.batteryFraction : undefined;
    const battery: BatteryReading | undefined =
      bars !== undefined || fraction !== undefined
        ? {
            raw: typeof d.batteryRaw === "number" ? d.batteryRaw : 0,
            fraction: fraction ?? (bars ?? 0) / 5,
            bars: bars ?? Math.round((fraction ?? 0) * 5),
            charging: d.charging === true,
          }
        : undefined;
    return {
      ...(width ? { widthMm: width } : {}),
      ...(height ? { heightMm: height } : {}),
      ...(battery ? { battery } : {}),
      // A roll with no code reports no size but the printer DID answer, and the
      // battery it sent is still worth showing.
      responded: true,
    };
  } catch {
    return { responded: false };
  }
}

/** Connect, confirm a device is there, and ask the printer what it reports about
 *  ITSELF — the loaded roll and battery on a thermal one.
 *
 *  Deliberately the same shape core-print's driver.test() returns, so the UI can
 *  render one result regardless of which side ran the check. */
export async function testLocalBridge(
  s: BridgePrinterSettings,
): Promise<{ ok: boolean; error?: string; detail?: string; deviceName?: string }> {
  if (!s.instance) return { ok: false, error: "no bridge instance set: that is the id under /<id>/ in the bridge config" };
  const client = clientFor(s);
  try {
    const devices = await client.devices();
    if (devices.length === 0) {
      return { ok: false, error: "the bridge answered but has no device on this instance. Check the instance id" };
    }
    const deviceName = devices[0]?.name || devices[0]?.id || undefined;
    // Reachable is not ready. 501 (driver has no commands) is a normal answer,
    // not a fault — the connection is still good, we just learn nothing more.
    const status = await client.command("status").catch(() => ({ ok: false, detail: undefined as string | undefined }));
    return { ok: true, ...(deviceName ? { deviceName } : {}), ...(status.detail ? { detail: status.detail } : {}) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
