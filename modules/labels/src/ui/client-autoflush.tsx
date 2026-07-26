// Client-fired auto-print (slice 3c). A browser-Bluetooth printer can't be reached
// from the server, so its accumulate-then-print policy fires from THIS tab: while a
// BLE session is held, this loop polls the queue and fires per the user's policy,
// then records what printed (history + frozen codes + queue drop) — the same
// bookkeeping the manual Queue-page Bluetooth path does.
//
// Singleton by construction. LabelsBasket (this loop's mount) renders up to three
// times at once — sidebar foot, mobile menu, floating pill — so the loop lives at
// MODULE scope and starts exactly once; extra mounts only refresh the api handle.
// A network-printer policy never reaches here (the server owns it); this loop no-ops
// on one cheap in-memory check (heldPrinterName) until a BLE session actually exists,
// so an idle tab pays almost nothing.

import { useEffect } from "react";
import {
  heldPrinterName,
  printBatchOverBluetooth,
  tileCount,
  type BluetoothPrinterSettings,
} from "@cobblr/platform-web";
import { flushDecision } from "../flush-policy.js";
import { liveQrUrl } from "../live-qr-url.js";
import { useLabels } from "./context.js";
import type { LabelsApi } from "./api.js";

const POLL_MS = 3000;

let timer: ReturnType<typeof setInterval> | null = null;
let firing = false;
let current: LabelsApi | null = null;

async function tick(): Promise<void> {
  // A print in flight (BLE is slow) must not overlap the next tick and double-fire.
  if (firing || !current) return;
  const heldName = heldPrinterName();
  if (!heldName) return; // no BLE session in this tab — nothing to own
  const api = current;
  firing = true;
  try {
    const policy = await api.getAutoflush();
    if (!policy.enabled || !policy.client_fired || !policy.printer_id) return;
    const printer = (await api.listPrinters()).items.find((p) => p.id === policy.printer_id);
    if (!printer || (printer.driver !== "browser-bluetooth" && printer.driver !== "browser-serial")) return;
    // Fire only the printer this tab actually holds — never drive a session the
    // user connected for something else.
    if (printer.name !== heldName) return;
    const settings = (printer.settings ?? {}) as unknown as BluetoothPrinterSettings;
    if (!settings.widthDots) return;

    const { items } = await api.listQueue();
    // How many label faces fill one feed for this printer's media (n-up); 1 for a
    // plain roll. fixedPositions when >1: a partial multi-up sheet wastes its blank
    // tiles, so fill-media waits for a full sheet.
    const tiles = tileCount(settings);
    const decision = flushDecision(items.length, tiles, { mode: policy.fire_mode, count: policy.fire_count }, { fixedPositions: tiles > 1 });
    if (decision.flush < 1) return;

    let base: string | null = null;
    try {
      base = await api.qrLabelBaseUrl();
    } catch {
      base = null; // fall back to each row's stored payload
    }

    const batch = items.slice(0, decision.flush).map((it) => ({
      id: it.id,
      qrPayload: liveQrUrl(it.qr_payload, base), // the minted scan URL, never a guess
      caption: it.description || undefined,
      copies: it.qty,
    }));
    const res = await printBatchOverBluetooth(batch, settings);
    // Only the rows that actually reached paper leave the queue — a jam mid-batch
    // leaves the rest to retry on the next tick.
    const printedIds = res.printed.map((p) => p.id).filter((id): id is string => !!id);
    if (printedIds.length > 0) await api.recordPrinted(printedIds);
  } catch {
    // Best-effort: a transient BLE/network error must not wedge the loop. The next
    // tick retries; a dropped session simply no-ops (heldPrinterName goes null).
  } finally {
    firing = false;
  }
}

function ensureLoop(api: LabelsApi): void {
  current = api; // always refresh (org switch remounts with a new api)
  if (timer) return;
  timer = setInterval(() => void tick(), POLL_MS);
}

/** Headless. Mounted inside LabelsBasket (app-root, within LabelsProvider). Starts
 *  the single tab-lifetime client-fired auto-print loop; safe to mount many times. */
export function ClientAutoflushMount() {
  const { api } = useLabels();
  useEffect(() => {
    ensureLoop(api);
  }, [api]);
  return null;
}
