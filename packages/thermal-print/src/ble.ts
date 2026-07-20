// Web Bluetooth transport for thermal printers. Browser-only (a top-level secure
// context — a first-party page or the standalone self-test site, NOT a sandboxed
// iframe, which strips the `bluetooth` permission-policy). Node callers use the
// protocol module directly and supply their own transport.
//
// The Web Bluetooth surface we touch is declared locally so the package needs no
// @types/web-bluetooth dependency (and stays install-free in a worktree).

import { encodePhomemo, chunkForBle, type MonoBitmap, type PhomemoOptions } from "./protocol.js";
import { rankWritePipe } from "./profiles.js";

// ── minimal Web Bluetooth typings (only what we use) ──
interface BleCharProps { write: boolean; writeWithoutResponse: boolean; notify: boolean; read: boolean }
export interface BleCharacteristic {
  readonly uuid: string;
  readonly properties: BleCharProps;
  writeValue(v: Uint8Array): Promise<void>;
  writeValueWithoutResponse(v: Uint8Array): Promise<void>;
}
export interface BleService { readonly uuid: string; getCharacteristics(): Promise<BleCharacteristic[]> }
export interface BleServer { connect(): Promise<BleServer>; getPrimaryServices(): Promise<BleService[]>; readonly connected: boolean; disconnect(): void }
export interface BleDevice {
  readonly id: string;
  readonly name?: string;
  readonly gatt?: BleServer;
  addEventListener(type: "gattserverdisconnected", cb: () => void): void;
}
interface BleRequestOpts { acceptAllDevices?: boolean; optionalServices?: (number | string)[]; filters?: unknown[] }
interface Bluetooth {
  requestDevice(opts: BleRequestOpts): Promise<BleDevice>;
  getDevices?(): Promise<BleDevice[]>;
}
function bluetooth(): Bluetooth {
  const b = (globalThis.navigator as unknown as { bluetooth?: Bluetooth } | undefined)?.bluetooth;
  if (!b) throw new Error("Web Bluetooth is unavailable. Use Chrome or Edge on desktop or Android; iOS is not supported.");
  return b;
}

export function isWebBluetoothAvailable(): boolean {
  return !!(globalThis.navigator as unknown as { bluetooth?: unknown } | undefined)?.bluetooth;
}

export interface DiscoveredChar { uuid: string; flags: string }
export interface GattNode { service: string; chars: DiscoveredChar[] }
export interface Connection {
  device: BleDevice;
  /** full GATT tree — reported for diagnostics / profile harvesting */
  tree: GattNode[];
  /** first writable characteristic, used for printing */
  writeChar: BleCharacteristic;
}

/** Present the chooser and let the user pick a printer. `candidateServices` MUST
 *  include every service you'll read post-connect (Web Bluetooth gates access to
 *  services not named here). */
export async function requestPrinter(candidateServices: (number | string)[]): Promise<BleDevice> {
  return bluetooth().requestDevice({ acceptAllDevices: true, optionalServices: candidateServices });
}

/** Reconnect to a previously-granted device without the chooser (Chrome only). */
export async function knownPrinters(): Promise<BleDevice[]> {
  const b = bluetooth();
  return b.getDevices ? b.getDevices() : [];
}

/** Connect + enumerate the GATT tree, selecting the BEST-RANKED writable
 *  characteristic (known printer pipes first — picking the first writable char in
 *  enumeration order once risked streaming into an OTA/config characteristic on
 *  unknown printers). Throws if nothing writable is found (the tree is still on
 *  the error for report). */
export async function connectAndDiscover(device: BleDevice): Promise<Connection> {
  const server = await device.gatt!.connect();
  const services = await server.getPrimaryServices();
  const tree: GattNode[] = [];
  let writeChar: BleCharacteristic | null = null;
  let bestScore = -1;
  for (const svc of services) {
    const node: GattNode = { service: svc.uuid, chars: [] };
    let chars: BleCharacteristic[] = [];
    try { chars = await svc.getCharacteristics(); } catch { tree.push(node); continue; }
    for (const ch of chars) {
      const p = ch.properties;
      const flags = [p.write && "write", p.writeWithoutResponse && "writeNR", p.notify && "notify", p.read && "read"].filter(Boolean).join(",");
      node.chars.push({ uuid: ch.uuid, flags });
      if (p.write || p.writeWithoutResponse) {
        const score = rankWritePipe(svc.uuid, ch.uuid, p.writeWithoutResponse);
        if (score > bestScore) { bestScore = score; writeChar = ch; }
      }
    }
    tree.push(node);
  }
  if (!writeChar) {
    const err = new Error("No writable characteristic found on this device.") as Error & { tree?: GattNode[] };
    err.tree = tree;
    throw err;
  }
  return { device, tree, writeChar };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Stream a raw byte buffer to a characteristic, chunked + paced. */
export async function streamToChar(
  writeChar: BleCharacteristic,
  bytes: Uint8Array,
  opts: { chunkSize?: number; paceMs?: number } = {},
): Promise<{ chunks: number; bytes: number }> {
  const chunkSize = opts.chunkSize ?? 180;
  const useNR = writeChar.properties.writeWithoutResponse;
  const paceMs = opts.paceMs ?? (useNR ? 18 : 0);
  const chunks = chunkForBle(bytes, chunkSize);
  for (const c of chunks) {
    if (useNR) await writeChar.writeValueWithoutResponse(c);
    else await writeChar.writeValue(c);
    if (paceMs) await sleep(paceMs);
  }
  return { chunks: chunks.length, bytes: bytes.length };
}

/** Encode a bitmap to the Phomemo stream and print it over BLE. */
export async function printBitmap(
  writeChar: BleCharacteristic,
  bitmap: MonoBitmap,
  opts: PhomemoOptions & { chunkSize?: number; paceMs?: number } = {},
): Promise<{ chunks: number; bytes: number }> {
  const stream = encodePhomemo(bitmap, opts);
  return streamToChar(writeChar, stream, opts);
}
